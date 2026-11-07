# 7Movies for Nuvio

A Nuvio plugin repository that adds **7movies.ac** as a source.
7Movies is a TMDB-keyed site (`/movie/{tmdbId}/watch`,
`/tv/{tmdbId}/watch`), so the provider needs no search: Nuvio hands
it the TMDB id and it resolves one of the site's own player
upstreams (VidLink) through its JSON API, returning direct MP4
links (360p–1080p depending on the title) with subtitle tracks.

## Install in Nuvio (Android TV / Fire TV / mobile)

Plugins only work in the **sideloaded** Nuvio build (store builds
disable plugins).

Easiest path — do it from your phone/computer, not the TV remote:

1. Open https://nuvioapp.space/account and sign in with the same
   account as the app.
2. Go to **Plugins** → **Add plugin**.
3. Paste this repo's manifest URL:

   `https://raw.githubusercontent.com/phuanh004/nuvio-7movies/refs/heads/main/manifest.json`

4. Name it `7Movies`, save. It appears in the app immediately.
5. Open any movie/episode in Nuvio → sources list shows
   `7Movies - 1080p` / `720p` / … entries with subtitles.

In-app alternative: Settings → Plugins → Add Plugin, paste the
same URL.

## Develop

```bash
npm install
npm run build     # src/7movies/index.js -> providers/7movies.js
npm test          # live test: Oppenheimer, Breaking Bad S01E01, a bogus id
```

Source lives in `src/7movies/index.js`; `providers/7movies.js` is
the built bundle (esbuild, ES2016 target for the app's JS engine).
Edit the source, rebuild, commit both.

## Notes

- The resolver chain is: `enc-dec.app` (TMDB-id encryption for
  VidLink) → `vidlink.pro/api/b/{movie|tv}/...` → signed CDN MP4s.
  If either service changes shape, the provider returns an empty
  list rather than bad links.
- VidLink flags these files `requiresProxy` — its own web player
  fetches them via a proxy, and the CDN refuses some datacenter
  IPs outright (seen during testing from a cloud VM). On a home
  connection the links are served with the per-file Referer/Origin
  headers the provider attaches. If a title fails on the TV while
  others play, that title's CDN is the reason, not the plugin.
- 7movies.ac also embeds VidRift (its own token-gated player),
  VAPlayer, Cinezo, Atlantic, VidBolt and Vidy. Those upstreams
  are SPA-only and are not resolved yet; VidLink covers the same
  catalog because the site keys everything by TMDB id.
