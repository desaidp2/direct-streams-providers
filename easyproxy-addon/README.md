# TMDB + EasyProxy Stremio Add-on

Portable Node.js Stremio add-on. The same folder can run on Render (Docker) or Vercel (Node functions).

## Environment

- `TMDB_ACCESS_TOKEN` — TMDB v4 Read Access Token.
- `SOURCE_DISCOVERY_URL` — optional trusted source-discovery API. It must implement `GET /sources?type=movie|tv&tmdbId=...&season=...&episode=...` and return `{"sources":[{"url":"https://...","name":"...","quality":"1080p"}]}`. Only include streams you are authorized to distribute.
- `SOURCE_DISCOVERY_TOKEN` — optional bearer token for the discovery API.
- `EASYPROXY_URL` — optional base URL of an EasyProxy instance.

Without the optional source-discovery and EasyProxy settings, catalog/search work and stream responses are empty. TMDB is metadata/catalog only; it does not supply playable video sources.

## Run locally

```sh
npm start
```

Open `http://localhost:7000/manifest.json` and add that URL to Stremio.

## Deploy

- **Vercel:** set Root Directory to `easyproxy-addon`, framework preset to Other, and add the environment variables.
- **Render:** create a Docker web service using `easyproxy-addon/Dockerfile` with Docker Context Directory `easyproxy-addon`. Set `TMDB_ACCESS_TOKEN` and any optional source service variables.

## Routes

- `/manifest.json`
- `/catalog/movie/tmdb-movies.json`
- `/catalog/series/tmdb-series.json`
- `/meta/movie/tmdb:movie:<id>.json`
- `/stream/movie/tmdb:movie:<id>.json`
- `/health`
