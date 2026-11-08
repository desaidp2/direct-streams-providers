/**
 * Private-network gate for the companion routes.
 *
 * `/companion/flystream` and `/companion/flystream/cookies` hand out the challenge browser's
 * live session cookies. server.js listens on 0.0.0.0, so without a gate anyone who can reach
 * the port (a port-forward, a public reverse proxy, a Worker deploy) could read them. These
 * routes answer only clients on loopback, RFC 1918, link-local, CGNAT / Tailscale (100.64/10)
 * and IPv6 ULA / link-local addresses. Set COMPANION_ALLOW_PUBLIC=1 to opt out.
 *
 * Pure string checks, O(1) per request, no Node built-ins (also loads on edge runtimes).
 */

function ipv4Octets(ip) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const o = m.slice(1).map(Number);
  return o.every((n) => n <= 255) ? o : null;
}

function isPrivateAddress(raw) {
  if (!raw) return false;
  let ip = String(raw).trim().toLowerCase();
  if (ip.startsWith("[") && ip.endsWith("]")) ip = ip.slice(1, -1);
  if (ip.startsWith("::ffff:")) ip = ip.slice(7); // IPv4-mapped IPv6 (Node dual-stack sockets)

  const o = ipv4Octets(ip);
  if (o) {
    const [a, b] = o;
    return (
      a === 127 || // loopback
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) || // link-local
      (a === 100 && b >= 64 && b <= 127) // CGNAT, Tailscale
    );
  }
  if (!ip.includes(":")) return false;
  return ip === "::1" || /^f[cd][0-9a-f]{0,2}:/.test(ip) || /^fe[89ab][0-9a-f]?:/.test(ip);
}

/**
 * The address to judge. Behind a reverse proxy the socket peer is the proxy, so the
 * RIGHTMOST X-Forwarded-For entry (the one the nearest proxy appended) is used; the
 * leftmost entries are client-controlled and are never trusted.
 */
function effectiveClientAddress(remoteAddress, forwardedFor) {
  if (forwardedFor) {
    const hops = String(forwardedFor).split(",").map((h) => h.trim()).filter(Boolean);
    if (hops.length) return hops[hops.length - 1];
  }
  return remoteAddress || "";
}

function companionAllowed(clientAddress) {
  const allowPublic = typeof process !== "undefined" && process.env && process.env.COMPANION_ALLOW_PUBLIC === "1";
  return allowPublic || isPrivateAddress(clientAddress);
}

module.exports = { isPrivateAddress, effectiveClientAddress, companionAllowed };
