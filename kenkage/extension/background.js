// Kenkage Network Bridge — background service worker.
//
// Relays a fetch() for pages/notebooks using kenkage's `fetchFn` override,
// running the actual request in the extension's background context, which
// Chromium documents as exempt from page-level CORS restrictions. Nothing
// here talks to any server of ours — every request goes straight from this
// browser, on this machine, to the URL the caller asked for.

const MAX_RESPONSE_BYTES = 10 * 1024 * 1024; // 10MB cap
const REQUEST_TIMEOUT_MS = 15000;
const RATE_LIMIT_WINDOW_MS = 60000;
const RATE_LIMIT_MAX_REQUESTS = 30;
const ALLOWED_METHODS = new Set(['GET', 'HEAD']);

// Sliding-window request timestamps, kept in memory only (per browser session).
let requestTimestamps = [];

function isRateLimited() {
  const now = Date.now();
  requestTimestamps = requestTimestamps.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  if (requestTimestamps.length >= RATE_LIMIT_MAX_REQUESTS) return true;
  requestTimestamps.push(now);
  return false;
}

/**
 * Blocks obvious SSRF targets (loopback, private/link-local ranges, literal
 * localhost). This is a string/literal-IP check only — it cannot catch DNS
 * rebinding (a hostname that resolves to a private IP only at connect time),
 * which no purely JS-level check can fully defend against. Documented as a
 * known residual risk, not silently claimed as solved.
 */
function isBlockedHost(hostname) {
  const h = hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return true;
  if (h === '0.0.0.0' || h === '::1' || h === '[::1]') return true;

  const ipv4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    if (a === 127) return true; // loopback
    if (a === 10) return true; // private
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 192 && b === 168) return true; // private
    if (a === 169 && b === 254) return true; // link-local / cloud metadata
    if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  }

  if (h.startsWith('fc') || h.startsWith('fd')) return true; // IPv6 unique local
  if (h.startsWith('fe80')) return true; // IPv6 link-local

  return false;
}

function validateUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, error: 'Invalid URL' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: 'Only http/https URLs are allowed' };
  }
  if (isBlockedHost(parsed.hostname)) {
    return { ok: false, error: 'Requests to local/private network addresses are blocked' };
  }
  return { ok: true, url: parsed.toString() };
}

async function fetchWithLimits(url, method) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { method, signal: controller.signal, redirect: 'follow' });
    const reader = res.body ? res.body.getReader() : null;
    const decoder = new TextDecoder();
    let body = '';
    let bytesRead = 0;
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytesRead += value.byteLength;
        if (bytesRead > MAX_RESPONSE_BYTES) {
          controller.abort();
          throw new Error('Response exceeded ' + MAX_RESPONSE_BYTES + ' byte cap');
        }
        body += decoder.decode(value, { stream: true });
      }
      body += decoder.decode();
    } else {
      body = await res.text();
    }
    return { status: res.status, statusText: res.statusText, body, url: res.url };
  } finally {
    clearTimeout(timeout);
  }
}

async function recordActivity(entry) {
  const { activity = [] } = await chrome.storage.local.get('activity');
  activity.unshift({ ...entry, at: Date.now() });
  await chrome.storage.local.set({ activity: activity.slice(0, 50) });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== 'KBOOK_BRIDGE_FETCH') return false;

  (async () => {
    const { enabled = true } = await chrome.storage.local.get('enabled');
    if (!enabled) {
      sendResponse({ error: 'Kenkage Network Bridge is disabled (see extension popup)' });
      return;
    }

    const method = (msg.method || 'GET').toUpperCase();
    if (!ALLOWED_METHODS.has(method)) {
      sendResponse({ error: 'Method not allowed: ' + method + ' (only GET/HEAD)' });
      return;
    }

    if (isRateLimited()) {
      sendResponse({ error: 'Rate limit exceeded (' + RATE_LIMIT_MAX_REQUESTS + ' requests/min)' });
      return;
    }

    const validation = validateUrl(msg.url);
    if (!validation.ok) {
      await recordActivity({ url: msg.url, ok: false, error: validation.error });
      sendResponse({ error: validation.error });
      return;
    }

    try {
      const result = await fetchWithLimits(validation.url, method);
      await recordActivity({ url: validation.url, ok: true, status: result.status });
      sendResponse(result);
    } catch (err) {
      await recordActivity({ url: validation.url, ok: false, error: err.message });
      sendResponse({ error: err.message });
    }
  })();

  return true; // keep the message channel open for the async response
});
