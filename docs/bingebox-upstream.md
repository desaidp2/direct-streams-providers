# BingeBox upstream provider reference

The BingeBox provider implementation was cross-checked against the public Sora module:

- Upstream repository: https://github.com/MXFia19/module-sora
- Upstream implementation: https://github.com/MXFia19/module-sora/blob/main/bingebox/bingebox.js
- Upstream source config: https://github.com/MXFia19/module-sora/blob/main/bingebox/bingebox.json

## What the upstream module does

The upstream script resolves metadata through TMDB and requests the unified BingeBox endpoint:

`GET https://bingebox.ac/api/sources?tmdbId=...&mediaType=movie|show&title=...&year=...[&season=...&episode=...]`

It reads `success` and `sources[]`, then maps `stream.playlist` (or `stream.url`) and `stream.captions[]` into playable results. It uses the BingeBox origin as Referer and supports the Sora/Nuvio `fetchv2` transport.

## Port in this repository

`src/bingebox/index.js` is the Stremio/Node port of that same API flow. It retains the unified endpoint, TMDB metadata lookup, playlist/url fallback, captions, Referer/Origin headers, and native `fetchv2` support. It additionally adapts the result shape to Stremio streams and supports the repository's optional browser-session transport.

The upstream Sora script itself is not copied verbatim into the Stremio runtime because its catalog/search/details/episode callbacks use the Sora plugin contract, not Stremio's stream-handler contract.

## Live availability note

A passing offline test only validates the adapter. The CI live checks currently receive HTTP 403 from the BingeBox API (including the browser-session attempt), so this provider must be treated as unverified until the upstream grants a successful response. No proxy or access-control bypass is included.

This reference is documentation only and does not change CineJoy or 7Movies.
