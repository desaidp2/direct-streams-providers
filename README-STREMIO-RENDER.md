# Direct Streams Stremio Add-on

Stremio-compatible add-on server for direct HTTP sources. It responds to the Stremio Add-on Protocol at `/manifest.json` and `/stream/{type}/{id}.json`.

## Providers
- Cinejoy — resolves a Cinejoy HLS master playlist using its public web gateway flow; title/episode matching is via TMDB ID.
- Movy — direct HLS when its upstream API is reachable.
- 7Movies — direct MP4/HLS.
- FlyStream — direct HLS where its upstream session can be established.

Only direct HTTP media URLs are returned. This add-on does not return torrents or P2P sources. Resolution availability and quality vary by title and upstream service; 4K is shown only when the provider actually returns a 4K source.

## Run locally
```sh
npm install --omit=optional
npm run serve
```
Open `http://localhost:7070/manifest.json`.

## Render deployment
Create a new Render Web Service from this repository, branch `stremio-cinejoy-render`:
- Runtime: Node
- Build command: `npm install --omit=optional`
- Start command: `node server.js`
- Region: Singapore (closest available Render region to New Zealand)
- Health check path: `/health`
- Environment: `PORT=10000`, `CINEJOY_TIMEOUT_MS=14000`, `PROVIDER_DEADLINE_MS=15000`

No persistent disk is required; caches are in memory. Free Render instances may spin down when idle.

After deploy, install `https://YOUR-SERVICE.onrender.com/manifest.json` in Stremio.

## Tests
```sh
npm run test:offline
```
