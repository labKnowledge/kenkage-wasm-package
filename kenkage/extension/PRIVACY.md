# Privacy Policy — Kenkage Network Bridge

This extension does not collect, store, or transmit any data to any server
operated by us or anyone else. There is no analytics, no telemetry, no
remote logging.

## What it does

When a page you're viewing (using the `kenkage` library's bridge helper)
asks this extension to fetch a URL, the extension's background script makes
that HTTP(S) request directly, using your browser's own network connection,
and returns the response to the page that asked for it. The request goes
straight from your machine to the URL requested — never through any server
of ours.

## What it stores, and where

- An on/off toggle (`enabled`), stored locally via `chrome.storage.local`.
- A rolling log of the last 50 fetches (URL, status, timestamp), stored
  locally via `chrome.storage.local`, shown in the extension's popup so you
  can see what it's been asked to do. This log never leaves your device and
  is not read by anything except the popup UI.

Uninstalling the extension deletes this data along with it.

## Permissions

- `host_permissions: <all_urls>` — needed to fetch arbitrary URLs on a
  page's behalf; this is the extension's entire purpose.
- `storage` — for the local-only toggle and activity log described above.

## Safety limits enforced by this extension

- Only `http://`/`https://` URLs, and only `GET`/`HEAD` requests.
- Requests to localhost, private (RFC 1918), link-local, and other
  internal/reserved address ranges are blocked outright.
- Responses are capped at 10MB and requests time out after 15 seconds.
- No more than 30 requests per minute.

These limits exist to keep a page from turning this bridge into an open
network relay. They do **not** fully defend against DNS rebinding (a
hostname that resolves to a private address only at connection time) —
no purely JS-level check can, since resolved IPs aren't visible to
extension code before the request completes. Don't install this if that
residual risk isn't acceptable for your use case.
