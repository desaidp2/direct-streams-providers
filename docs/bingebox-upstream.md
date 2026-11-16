# BingeBox / BingeBang upstream provider references

This branch now supports two distinct upstream flows. The BingeBox unified API is retained as a compatibility fallback; the preferred path is the dedicated BingeBang player extractor.

## FMHY Stremio addon

- Repository: https://github.com/RisPNG/fmhywebstremio
- Search implementation: https://github.com/RisPNG/fmhywebstremio/blob/main/src/extractors/sources/bingebang-family.ts
- Player implementation: https://github.com/RisPNG/fmhywebstremio/blob/main/src/extractors/hosts/bingebang-host-architecture.ts
- Tests and fixtures: https://github.com/RisPNG/fmhywebstremio/tree/main/src/extractors/__fixtures__/bingebang

The FMHY flow searches `/api/search/movie|tv`, matches the exact title and media type, opens the resulting `play_url`, decodes the page's XOR-obfuscated player configuration to obtain its ticket, requests `/api/player/sources`, decrypts the server envelope, then resolves each server through `/api/player/resolve?src=...`. The server list and resolve responses use a ticket-derived SHA-256 keystream. This is materially different from the old `/api/sources` endpoint.

## Second Stremio integration project

- Repository: https://github.com/arthurpetroli/HPmovies
- Stremio integration notes: https://github.com/arthurpetroli/HPmovies/blob/main/docs/STREMIO-INTEGRATION.md
- Validation record: https://github.com/arthurpetroli/HPmovies/blob/main/docs/validation/2026-11-08-stremio-recovery.json

HPmovies documents a working Stremio integration of the FMHY addon flow and records BingeBang-labelled sources for both a movie and a native Stremio anime episode. Its local compatibility patch raises the BingeBang server-attempt cap to nine and preserves the provider's native server labels. The validation record is historical evidence from 2026-11-08, not a guarantee that every current request or host works today.

## Port in this repository

`src/bingebox/bingebang.js` ports the search, player-ticket, encrypted source-list and per-server resolve flow into this repository's existing Stremio provider contract. It now tries the current official `https://bingebang.sx` domain first and `https://bingebang.st` second (the latter redirects to `.sx`); `bingebang.tv` is retired. Set `BINGEBANG_BASE_URL` to override the host. The existing `https://bingebox.ac/api/sources` integration remains as a fallback.

The port uses the original FMHY player-envelope algorithm, validates movie/episode coordinates, keeps the player Referer on playback headers, and attempts up to nine advertised servers. Offline tests cover movie and episode discovery, ticket propagation, envelope decryption and resolved HLS streams.

## Verification and safety

Offline adapter tests do not prove that BingeBang is currently reachable from the deployed host. Earlier live checks of the separate BingeBox `/api/sources` endpoint returned HTTP 403; that does not by itself prove the independent BingeBang player flow is blocked. The new BingeBang live result must be read from the current CI run before claiming live playback works.

This work stays on the isolated `add-popcornmovies-bingebox` branch. CineJoy and 7Movies provider code and the production Render service are not changed or deployed.
