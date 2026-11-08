# Movy server fallback

How the Movy provider (`src/movy/index.js`) picks movy.sx servers, and how to keep it in step with the site. Background: issue #1 (`/movie/1644912` only streams from the 900p server Reno).

## The site's servers

movy.sx's player script holds a server registry: one `{ name, tag, note, get, flag }` entry per server, plus a fetcher per server calling `${STREAM_API_URL}/<server>/sources`. As of 2026-11-08 it lists:

| Order | Servers | Note | Asked by us |
|---|---|---|---|
| 1–2 | Miami, Boise | Original audio. May have 4K | yes, together |
| 3–13 | Nashville, Chicago, Vegas, **Reno**, Oakland, Seattle, Phoenix, Atlanta, Portland, Austin, Dallas | Original audio | yes, sliding window |
| — | Munich, Berlin (German), Paris (French), Delhi (Hindi), Cancun (Spanish) | dubbed | no |
| — | Anikoto | anime | no |

`ORIGINAL_AUDIO_SERVERS` in `src/movy/index.js` mirrors rows 1–13 in this order.

## Request

Every `/sources` request carries the fields the site sends: `title` (already `encodeURIComponent`-ed, so double-encoded on the wire, as the site's `ofetch` does), `mediaType`, `year`, `totalSeasons`, `episodeId`, `seasonId`, `tmdbId`, `imdbId`, plus `enc=2` and `seed`. For a movie the site sends season/episode `1` and `totalSeasons=0`. Title, year and IMDb id come from the movy.sx title page (`__NEXT_DATA__`), waited for at most 1.5 s.

## Walk

1. One seed per title (`/seed?mediaId=`), shared by every request; concurrent 401s cause a single re-seed.
2. Miami + Boise in parallel.
3. If both are empty: the remaining 11 servers in site order through a **sliding window of 3**. A failure frees its slot at once, so a slow failure (Vegas took 4.8 s live) never holds back a working server. Launching stops at the first server with sources; servers already running get 300 ms to add theirs.
4. One attempt per server (the site uses `retry: 0`). A `429` on `/seed` asks no server; a `429` from a server stops the walk. Both are cached for 30 s.
5. The whole lookup has an 8 s budget (router deadline 9 s); the subtitle search runs in parallel from the start.

## Labels

- A source with a numeric quality keeps its height (`900p` stays `900p`; the shared sort places it between 1080p and 720p).
- `quality: "Auto"` is a master playlist. It is read once: a single variant is labelled by its height (Reno: 1600×900 → `Movy Reno - 900p`), several variants give `Auto (up to X)`, an unreadable master stays `Auto`.
- Any other non-numeric quality is treated as a language label: `Unknown (<label>)`.

## When the site changes

1. Open any title on movy.sx, load the player script chunk and search for `STREAM_API_URL}/` (the fetchers) and `{name:"` (the registry).
2. Update `ORIGINAL_AUDIO_SERVERS` to the original-audio entries in registry order.
3. Run `node test-movy-offline.js` (offline, 12 cases), then one live lookup. Keep live checks to single lookups: a burst of probes got the network rate-limited (`/seed` → 429) on 2026-11-08.
