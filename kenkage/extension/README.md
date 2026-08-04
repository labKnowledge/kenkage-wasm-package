# Kenkage Network Bridge

A small browser extension that lets on-device code using `kenkage` fetch
real cross-origin pages — bypassing the same-origin/CORS wall that blocks a
plain page's own `fetch()` from reading most third-party sites — without
routing through any server. Chromium documents extension background
contexts as exempt from page-level CORS restrictions; this extension's
entire job is relaying a page's fetch request into that context and back.

See [`PRIVACY.md`](PRIVACY.md) for exactly what data this touches (short
answer: none leaves your machine) and the safety limits it enforces
(URL/method restrictions, private-network blocking, rate limiting, response
size caps — and an honest note on what those limits don't cover).

## Why this exists

`kenkage`'s `loadPage()`/`fetch()` need real network access to be useful for
their actual purpose — an on-device agent parsing and running real pages.
A plain browser tab's `fetch()` is blocked by CORS for any site that
doesn't explicitly opt in via `Access-Control-Allow-Origin`, which is most
of the web. That's not a kenkage bug or a bypassable bug at all — it's the
browser's same-origin policy working as designed. Extensions get a
narrow, deliberate exemption from that policy in their own background
context; this is what that exemption is for.

## Install (unpacked, for now)

1. `chrome://extensions` → enable **Developer mode** → **Load unpacked**.
2. Select this `extension/` folder.
3. The bridge icon appears in the toolbar; click it to see status, toggle
   it on/off, and view recent activity.

## Using it from kenkage

```ts
import { createBridgeFetch, isBridgeAvailable } from 'kenkage/bridge';

if (await isBridgeAvailable()) {
  const page = await engine.loadPage(url, { fetchFn: createBridgeFetch() });
}
```

`isBridgeAvailable()` resolves `false` quickly if the extension isn't
installed, so code can fall back to plain `fetch()` — the extension is a
strict opt-in upgrade, never a hard dependency.

## Architecture

```
page (kenkage's bridgeFetch)
  --window.postMessage-->
content script (content.js, injected into the page)
  --chrome.runtime.sendMessage-->
background service worker (background.js)
  --real fetch(), no CORS in this context-->
  the actual URL requested
```

## What's implemented vs. what's a known gap

Implemented: URL/protocol validation, GET/HEAD only, private/loopback/
link-local address blocking, 15s timeout, 10MB response cap, 30 req/min
rate limit, local-only activity log, on/off toggle.

Known gap, documented rather than hidden: the private-address blocklist is
a string/literal-IP check and cannot catch DNS rebinding. Full protection
would need control over the resolved IP at connect time, which browser
extension APIs don't expose. Treat this as a real, if narrow, residual
risk — not something this extension claims to have solved.

## Publishing

This repo ships the extension unpacked (for `chrome://extensions` →
Load unpacked). Submitting it to the Chrome Web Store / Firefox Add-ons
requires a developer account we don't have programmatic access to — that
step is on whoever owns those accounts.
