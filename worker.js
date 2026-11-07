/**
 * Direct Streams Providers - Cloudflare Workers / Edge Runtime Entrypoint
 *
 * Deploy to Cloudflare Workers for free zero-maintenance 24/7 hosting.
 */

import { route, CORS_HEADERS } from "./src/stremio/router.js";

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: CORS_HEADERS,
      });
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response(JSON.stringify({ error: "Method not allowed" }), {
        status: 405,
        headers: CORS_HEADERS,
      });
    }

    const url = new URL(request.url);
    const result = await route(url.pathname);

    return new Response(request.method === "HEAD" ? null : result.body, {
      status: result.status,
      headers: result.headers,
    });
  },
};
