#!/usr/bin/env python3
"""
Netlog Probe — Network Layer Inspector & Reverse-Engineering Tool

Captures network traffic (XHR, fetch, WebSocket, GraphQL, Media, HTML)
and full-page screenshots using Patchright to reverse-engineer streaming upstreams
without fragile DOM scraping.

Usage:
    ~/.claude/skills/.venv/bin/python3 scripts/netlog_probe.py --url "https://example.com"
"""

import argparse
import asyncio
import json
import os
import sys
from datetime import datetime
from urllib.parse import urlparse

from patchright.async_api import async_playwright

OUTPUT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "output")


async def inspect_url(url: str, timeout_sec: int = 15, headless: bool = True):
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    domain = urlparse(url).netloc.replace(":", "_")
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    screenshot_path = os.path.join(OUTPUT_DIR, f"{domain}_{timestamp}.png")
    log_path = os.path.join(OUTPUT_DIR, f"{domain}_{timestamp}_netlog.json")

    captured_events = []
    summary = {
        "target_url": url,
        "timestamp": datetime.now().isoformat(),
        "xhr_fetch": [],
        "websockets": [],
        "graphql": [],
        "media_streams": [],
        "documents": [],
    }

    print(f"[*] Launching Patchright browser for: {url}")

    async with async_playwright() as p:
        browser = await p.chromium.launch(
            headless=headless,
            args=[
                "--no-sandbox",
                "--disable-setuid-sandbox",
                "--disable-dev-shm-usage",
                "--disable-blink-features=AutomationControlled",
            ],
        )
        context = await browser.new_context(
            user_agent="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
            viewport={"width": 1920, "height": 1080},
        )
        page = await context.new_page()

        # Listen to WebSocket connections
        def on_websocket(ws):
            ws_url = ws.url
            print(f"[WS OPEN] {ws_url}")
            summary["websockets"].append({"url": ws_url, "opened_at": datetime.now().isoformat()})

            def on_frame_received(payload):
                if isinstance(payload, str) and len(payload) < 2000:
                    summary["websockets"].append({"event": "received", "data": payload})

            ws.on("framereceived", on_frame_received)

        page.on("websocket", on_websocket)

        # Listen to HTTP responses (XHR, Fetch, Media, Document)
        async def on_response(response):
            try:
                req = response.request
                res_type = req.resource_type
                r_url = req.url
                status = response.status

                entry = {
                    "method": req.method,
                    "url": r_url,
                    "status": status,
                    "resource_type": res_type,
                    "headers": dict(req.headers),
                }

                # Categorize traffic
                if "graphql" in r_url.lower() or "gql" in r_url.lower():
                    entry["category"] = "graphql"
                    summary["graphql"].append(entry)
                    print(f"  [GQL {status}] {req.method} {r_url[:120]}")
                elif res_type in ["xhr", "fetch"]:
                    entry["category"] = "xhr_fetch"
                    summary["xhr_fetch"].append(entry)
                    print(f"  [API {status}] {req.method} {r_url[:120]}")
                elif res_type == "media" or any(ext in r_url.lower() for ext in [".m3u8", ".mp4", ".ts", ".m4s", "bcdn"]):
                    entry["category"] = "media"
                    summary["media_streams"].append(entry)
                    print(f"  [STREAM {status}] {r_url[:120]}")
                elif res_type == "document":
                    entry["category"] = "document"
                    summary["documents"].append(entry)

                captured_events.append(entry)
            except Exception as e:
                pass

        page.on("response", on_response)

        try:
            print(f"[*] Navigating to {url}...")
            await page.goto(url, wait_until="domcontentloaded", timeout=timeout_sec * 1000)
            print("[*] DOM Loaded. Waiting for dynamic network traffic (5s)...")
            await asyncio.sleep(5)

            # Look for iframe players if present
            frames = page.frames
            print(f"[*] Detected {len(frames)} active frames.")
            for f in frames:
                if f != page.main_frame:
                    print(f"    -> Child frame: {f.url[:100]}")

            # Capture screenshot
            await page.screenshot(path=screenshot_path, full_page=False)
            print(f"[+] Screenshot captured: {screenshot_path}")

        except Exception as e:
            print(f"[-] Navigation notice: {e}")
            await page.screenshot(path=screenshot_path, full_page=False)

        await browser.close()

    # Save structured netlog JSON
    with open(log_path, "w", encoding="utf-8") as f:
        json.dump(summary, f, indent=2)

    print("\n" + "=" * 50)
    print(f"[*] Netlog Summary for: {url}")
    print(f"    - XHR / Fetch API Calls: {len(summary['xhr_fetch'])}")
    print(f"    - Media Streams:        {len(summary['media_streams'])}")
    print(f"    - WebSockets:           {len(summary['websockets'])}")
    print(f"    - GraphQL Requests:     {len(summary['graphql'])}")
    print(f"    - Full Log Written:     {log_path}")
    print(f"    - Screenshot:           {screenshot_path}")
    print("=" * 50)


def main():
    parser = argparse.ArgumentParser(description="Netlog probe via Patchright")
    parser.add_argument("--url", required=True, help="Target URL to inspect")
    parser.add_argument("--timeout", type=int, default=15, help="Navigation timeout in seconds")
    parser.add_argument("--no-headless", action="store_true", help="Run with visible browser UI")
    args = parser.parse_args()

    asyncio.run(inspect_url(args.url, timeout_sec=args.timeout, headless=not args.no_headless))


if __name__ == "__main__":
    main()
