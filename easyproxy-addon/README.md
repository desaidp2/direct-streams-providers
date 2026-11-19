# TMDB + EasyProxy Stremio Add-on

Node.js Stremio add-on hosted on Render. It provides TMDB catalogs and a small **Open Licensed Movies** catalog with a real playable test stream.

## Test playback now

After installing the add-on, open the **Open Licensed Movies** catalog and play **Big Buck Bunny**. This is the Blender Foundation open movie, licensed under Creative Commons Attribution 3.0. Attribution: © copyright 2008, Blender Foundation / www.bigbuckbunny.org. License details: https://peach.blender.org/about/

The test stream is served from the Google public sample-video bucket. It verifies Stremio stream response and playback; it is not a source for commercial movies.

## Environment

- `TMDB_ACCESS_TOKEN` — TMDB v4 Read Access Token.
- `SOURCE_DISCOVERY_URL` — optional trusted source-discovery API. It must implement `GET /sources?type=movie|tv&tmdbId=...&season=...&episode=...` and return `{"sources":[{"url":"https://...","name":"...","quality":"1080p"}]}`. Only include sources you are authorized to distribute.
- `SOURCE_DISCOVERY_TOKEN` — optional bearer token for the discovery API.
- `EASYPROXY_URL` — optional base URL of an EasyProxy instance.

TMDB supplies metadata/catalog information, not playable video. Commercial movie playback requires a provider/API that is authorized to supply those streams. The addon does not scrape pirate sources or bypass DRM.

## Run locally

```sh
npm start
```

Open `http://localhost:7000/manifest.json` and add that URL to Stremio.

## Deploy

Render Docker service uses `easyproxy-addon/Dockerfile` with Docker Context Directory `easyproxy-addon`.

## Routes

- `/manifest.json`
- `/catalog/movie/tmdb-movies.json`
- `/catalog/series/tmdb-series.json`
- `/catalog/movie/open-movies.json`
- `/meta/movie/open:bigbuckbunny.json`
- `/stream/movie/open:bigbuckbunny.json`
- `/health`
