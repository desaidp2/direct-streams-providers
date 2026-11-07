# 7Movies for Nuvio

[![Version](https://img.shields.io/badge/version-1.0.3-blue.svg)](manifest.json)
[![Platform](https://img.shields.io/badge/platform-Nuvio%20(Android%20TV%20%7C%20Fire%20TV%20%7C%20Mobile)-green.svg)](https://nuvioapp.space)
[![Playback Verified](https://img.shields.io/badge/playback-verified%20live%20✅-brightgreen.svg)](docs/assets/live_playback_osd.png)

A high-performance, low-memory Nuvio plugin provider that adds **7movies.ac** as a stream source.

7Movies is a TMDB-keyed catalog (`/movie/{tmdbId}/watch`, `/tv/{tmdbId}/watch`). Because Nuvio hands the scraper the clean TMDB ID, **zero search latency is required**. The provider resolves direct MP4 and HLS streams (up to 1080p) complete with localized subtitle tracks and ExoPlayer native header forwarding.

---

## 📺 Live Android TV Verification

Tested and verified live on **onn. 4K Plus Streaming (Android TV)** running Nuvio TV:

| Stream Discovery | Hardware-Accelerated Playback |
| :---: | :---: |
| ![Streams Modal](docs/assets/streams_screen.png) | ![Playback Active](docs/assets/live_playback_osd.png) |
| *Stream selection sheet with 1080p, 480p, 360p MP4s* | *Live playback with subtitles, hardware decoding, and zero buffer stalls* |

---

## ✨ Features & Engineering Optimizations

### 1. ExoPlayer Native Header Forwarding (`behaviorHints`)
- **Fixes HTTP 428 Precondition Required / Stream Blocked**: Media CDNs (`bcdn.hakunaymatata.com`) reject desktop browser `Mozilla/5.0` User-Agents on byte-range requests without browser bot challenge cookies.
- **Decompiled DEX Architecture**: Reverse engineering of Nuvio TV's DEX (`com.nuvio.tv`) revealed that ExoPlayer's `OkHttpDataSource$Factory` extracts custom request headers from `StreamDto.behaviorHints.proxyHeaders.request` (via `ProxyHeadersDto(request=...)`), not bare top-level headers.
- Streams and HLS variants are bundled with:
  ```json
  "behaviorHints": {
    "notWebReady": true,
    "proxyHeaders": {
      "request": {
        "User-Agent": "okhttp/4.12.0",
        "Referer": "https://vidlink.pro/",
        "Origin": "https://vidlink.pro"
      }
    }
  }
  ```

### 2. Rate-Limit Resilience (HTTP 429 & HTTP 492)
- Integrates `fetchWithRetry` with exponential backoff and randomized jitter to smoothly handle upstream CDN rate limits (`HTTP 429` and Cloudflare/Fastly `HTTP 492 Too Many Requests`).
- Automatically honors the HTTP standard `Retry-After` header when present.

### 3. $O(1)$ Time & Auxiliary Space Complexity
- **Constrained Hardware Optimization**: Android TV streaming devices typically operate with limited RAM (1.5 GB – 2 GB).
- **Bounded LRU/FIFO In-Memory Caches**:
  - `encCache`: Caches encrypted TMDB hashes for 10 minutes to eliminate redundant HTTP calls to `enc-dec.app`.
  - `streamCache`: Caches resolved stream lists to serve instant re-plays.
- **Streaming HLS Master Parser**: Parses HLS variants using single-pass regex scans rather than splitting multi-megabyte playlist strings into large in-memory arrays, preventing GC pauses in QuickJS / Hermes runtime.

---

## 🚀 Installation

> **Note:** Plugins require the **sideloaded** Nuvio build (Google Play Store builds have plugins disabled by policy).

### Repository Manifest URL:
```text
https://raw.githubusercontent.com/phuanh004/nuvio-7movies/refs/heads/main/manifest.json
```

### Method 1: Remote Install via Web Dashboard (Recommended)
1. On your phone or computer, visit [nuvioapp.space/account](https://nuvioapp.space/account) and sign in.
2. Navigate to **Plugins** → **Add plugin**.
3. Paste the manifest URL above and save.
4. The provider syncs to your TV immediately.

### Method 2: In-App on Android TV
1. Open Nuvio TV → Navigate to **Settings** → **Content & Discovery** → **Plugins**.
2. Click **Manage from phone** (scan QR code) OR paste the manifest URL directly into the **URL or short code** box and click **+ Add**.

> ⚠️ **Important Android TV Setting:**
> In Nuvio TV under **Settings → Content & Discovery → Plugins**, ensure **"Enable plugin providers globally"** is toggled **ON**. If this toggle is disabled, Nuvio will hide all plugin streams during discovery.

---

## 🛠️ Development & Testing

### Prerequisites
- Node.js 18+ (tested up to Node 26)

### Build & Run Tests
```bash
# Clone the repository
git clone https://github.com/phuanh004/nuvio-7movies.git
cd nuvio-7movies

# Install dependencies (esbuild)
npm install

# Bundle src/7movies/index.js -> providers/7movies.js
npm run build

# Run end-to-end integration tests
npm test
```

### Test Suite Output
The test runner queries live movie and TV show titles, verifying resolution, subtitle counts, and `behaviorHints` structure:
```text
== Oppenheimer (movie 872585): 1 stream(s)
- [480p] https://bcdnxw.hakunaymatata.com/... subs=11

== Breaking Bad S01E01 (tv 1396): 4 stream(s)
- [1080p] https://bcdn.hakunaymatata.com/... subs=8
- [720p] https://bcdn.hakunaymatata.com/... subs=8
- [480p] https://bcdn.hakunaymatata.com/... subs=8
- [360p] https://bcdn.hakunaymatata.com/... subs=8

== Nonexistent (movie 999999999): 0 stream(s)

✓ All assertion tests passed! SUMMARY movie: 1 tv: 4 missing: 0
```

---

## 🔍 Technical Architecture

```
[Nuvio TV App]
     │
     │ 1. Passes clean TMDB ID (e.g. 1423191)
     ▼
[7Movies Scraper (QuickJS)]
     │
     │ 2. GET https://enc-dec.app/api/enc-vidlink?text={tmdbId}
     │    (Encrypted Hash Cached in Memory O(1))
     ▼
[VidLink Upstream API]
     │
     │ 3. GET https://vidlink.pro/api/b/{movie|tv}/{hash}
     │    (Resolves qualities, direct signed CDN URLs & VTT captions)
     ▼
[Nuvio ExoPlayer (AndroidX Media3)]
     │
     │ 4. Receives stream + behaviorHints.proxyHeaders.request
     │    (User-Agent: okhttp/4.12.0)
     ▼
[HakunaMatata CDN (bcdn.hakunaymatata.com)]
     │
     │ 5. Returns HTTP 206 Partial Content (Bypasses bot-block)
     ▼
[Hardware Video Decoder (c2.amlogic.avc.decoder)]
     │
     └─► Smooth 1080p Playback + Synced Subtitles
```

---

## 📄 License
MIT License. Created and maintained for Nuvio community streaming.
