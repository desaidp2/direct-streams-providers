import http from "node:http";
import { URL } from "node:url";

const PORT = Number(process.env.PORT || 7000);
const TMDB_BASE = "https://api.themoviedb.org/3";
const ADDON_ID = "community.easyproxy.tmdb";
const manifest = {
  id: ADDON_ID,
  version: "0.1.0",
  name: "TMDB + EasyProxy (authorized sources)",
  description: "TMDB movie and series catalogs with optional authorized source discovery and EasyProxy resolution.",
  resources: ["catalog", "meta", "stream"],
  types: ["movie", "series"],
  catalogs: [
    { type: "movie", id: "tmdb-movies", name: "TMDB Movies", extra: [{ name: "search", isRequired: false }] },
    { type: "series", id: "tmdb-series", name: "TMDB Series", extra: [{ name: "search", isRequired: false }] }
  ],
  idPrefixes: ["tmdb:"]
};

const json = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*" });
  res.end(JSON.stringify(body));
};

async function tmdb(path) {
  const token = process.env.TMDB_ACCESS_TOKEN;
  if (!token) throw new Error("TMDB_ACCESS_TOKEN is not configured");
  const response = await fetch(TMDB_BASE + path, {
    headers: { Authorization: `Bearer ${token}`, accept: "application/json" },
    signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) throw new Error(`TMDB returned HTTP ${response.status}`);
  return response.json();
}

function toMeta(item, type) {
  const isMovie = type === "movie";
  const title = item.title || item.name || "Untitled";
  const date = item.release_date || item.first_air_date || "";
  return {
    id: `tmdb:${type}:${item.id}`,
    type: isMovie ? "movie" : "series",
    name: title,
    poster: item.poster_path ? `https://image.tmdb.org/t/p/w500${item.poster_path}` : undefined,
    background: item.backdrop_path ? `https://image.tmdb.org/t/p/w1280${item.backdrop_path}` : undefined,
    description: item.overview || "",
    releaseInfo: date.slice(0, 4),
    imdbRating: item.vote_average ? item.vote_average.toFixed(1) : undefined
  };
}

async function catalog(type, search) {
  const kind = type === "movie" ? "movie" : "tv";
  const path = search
    ? `/search/${kind}?query=${encodeURIComponent(search)}&include_adult=false`
    : `/trending/${kind}/week`;
  const data = await tmdb(path);
  return (data.results || []).map(item => toMeta(item, type));
}

async function meta(type, id) {
  const kind = type === "movie" ? "movie" : "tv";
  const item = await tmdb(`/${kind}/${encodeURIComponent(id)}`);
  return toMeta(item, type);
}

async function streams(type, id) {
  const match = /^tmdb:(movie|series):(\d+)(?::(\d+):(\d+))?$/.exec(id);
  if (!match) return [];
  const tmdbType = match[1] === "movie" ? "movie" : "tv";
  const tmdbId = match[2];
  const season = match[3];
  const episode = match[4];

  // Source discovery is deliberately a separate, user-configured service.
  // It must return only sources the operator is authorized to distribute.
  const discoveryUrl = process.env.SOURCE_DISCOVERY_URL;
  const easyProxyUrl = process.env.EASYPROXY_URL;
  if (!discoveryUrl || !easyProxyUrl) return [];

  const query = new URLSearchParams({ type: tmdbType, tmdbId });
  if (season && episode) {
    query.set("season", season);
    query.set("episode", episode);
  }
  const discovery = await fetch(`${discoveryUrl.replace(/\/$/, "")}/sources?${query}`, {
    headers: process.env.SOURCE_DISCOVERY_TOKEN
      ? { Authorization: `Bearer ${process.env.SOURCE_DISCOVERY_TOKEN}` }
      : {},
    signal: AbortSignal.timeout(10000)
  });
  if (!discovery.ok) return [];
  const payload = await discovery.json();
  const sources = Array.isArray(payload.sources) ? payload.sources : [];

  const resolved = await Promise.all(sources.slice(0, 8).map(async source => {
    if (!source?.url || !/^https?:\/\//i.test(source.url)) return null;
    // The discovery service is the trust boundary: only return authorized source URLs.
    const resolver = new URL("/extractor/video", easyProxyUrl);
    resolver.searchParams.set("d", source.url);
    resolver.searchParams.set("redirect_stream", "true");
    const response = await fetch(resolver, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) return null;
    const result = await response.json().catch(() => null);
    const streamUrl = result?.url || result?.stream_url || result?.data?.url;
    if (!streamUrl || !/^https?:\/\//i.test(streamUrl)) return null;
    return {
      name: source.name || "EasyProxy",
      title: [source.quality, source.title].filter(Boolean).join(" · ") || "Direct stream",
      url: streamUrl,
      behaviorHints: source.headers ? { proxyHeaders: { request: source.headers } } : undefined
    };
  }));
  return resolved.filter(Boolean);
}

async function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname.replace(/^\\/api(?=\\/)/, "") || "/";
  const parts = pathname.split("/").filter(Boolean);
  try {
    if (pathname === "/health" || pathname === "/healthz") return json(res, 200, { ok: true });
    if (pathname === "/manifest.json") return json(res, 200, manifest);
    if (parts[0] === "catalog" && parts.length >= 3) {
      const type = parts[1] === "series" ? "series" : "movie";
      const search = url.searchParams.get("search") || (parts[3]?.startsWith("search=") ? decodeURIComponent(parts[3].slice(7).replace(/\\.json$/, "")) : "");
      return json(res, 200, { metas: await catalog(type, search) });
    }
    if (parts[0] === "meta" && parts.length >= 3) {
      const type = parts[1] === "series" ? "series" : "movie";
      const id = decodeURIComponent(parts[2]).replace(/^tmdb:(movie|series):/, "");
      return json(res, 200, { meta: await meta(type, id) });
    }
    if (parts[0] === "stream" && parts.length >= 3) {
      const type = parts[1] === "series" ? "series" : "movie";
      return json(res, 200, { streams: await streams(type, decodeURIComponent(parts[2])) });
    }
    return json(res, 404, { error: "Not found" });
  } catch (error) {
    return json(res, 502, { error: error.message || "Upstream request failed" });
  }
}

if (process.env.VERCEL) {
  // Vercel Node function entrypoint is provided by api/[...path].js.
} else {
  http.createServer(handler).listen(PORT, "0.0.0.0", () => {
    console.log(`TMDB Stremio add-on listening on ${PORT}`);
  });
}

export default handler;
