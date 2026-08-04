/**
 * kenkage — Browser Network Bridge
 *
 * Optional integration with the "Kenkage Network Bridge" browser extension
 * (see `extension/` in this repo), which lets on-device code fetch real
 * cross-origin URLs from the browser's own unrestricted extension context —
 * bypassing the CORS wall that blocks a plain page's `fetch()` for most
 * third-party sites. Nothing routes through any server of ours; every
 * request goes straight from the browser, on the user's machine, to the URL
 * requested.
 *
 * This is a strict opt-in upgrade: `isBridgeAvailable()` resolves `false`
 * quickly if the extension isn't installed, so callers can fall back to a
 * plain `fetch()` (or skip real-network features) in that case.
 */

export interface BridgeFetchResult {
  status: number;
  body: string;
}

interface BridgeRequestMessage {
  type: 'KBOOK_BRIDGE_FETCH_REQUEST';
  id: number;
  url: string;
  method?: string;
}

interface BridgeResponseMessage {
  type: 'KBOOK_BRIDGE_FETCH_RESPONSE';
  id: number;
  response: { status: number; statusText?: string; body: string; url?: string } | { error: string };
}

function isBridgeMessage(data: unknown): data is BridgeResponseMessage {
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as { type?: unknown }).type === 'KBOOK_BRIDGE_FETCH_RESPONSE'
  );
}

function bridgeRequest(url: string, method: string | undefined, timeoutMs: number): Promise<BridgeFetchResult> {
  return new Promise((resolve, reject) => {
    const id = Math.random();
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      window.removeEventListener('message', handler);
      reject(new Error('Kenkage Network Bridge did not respond (extension not installed or inactive?)'));
    }, timeoutMs);

    function handler(event: MessageEvent): void {
      if (event.source !== window) return;
      if (!isBridgeMessage(event.data) || event.data.id !== id) return;
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      window.removeEventListener('message', handler);
      const response = event.data.response;
      if ('error' in response) {
        reject(new Error(response.error));
      } else {
        resolve({ status: response.status, body: response.body });
      }
    }

    window.addEventListener('message', handler);
    const message: BridgeRequestMessage = { type: 'KBOOK_BRIDGE_FETCH_REQUEST', id, url, method };
    window.postMessage(message, '*');
  });
}

/**
 * Checks whether the Kenkage Network Bridge extension is installed and
 * active on the current page. Resolves quickly (default 300ms) rather than
 * hanging if it isn't — safe to call before every `loadPage()` that wants
 * real network access.
 *
 * @example
 * ```ts
 * const fetchFn = (await isBridgeAvailable()) ? createBridgeFetch() : undefined;
 * const page = await engine.loadPage(url, { fetchFn });
 * ```
 */
export async function isBridgeAvailable(timeoutMs = 300): Promise<boolean> {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return false;
  }
  if (document.documentElement.dataset.kbookBridge === 'true') {
    return true;
  }
  // The content script may not have run yet (e.g. this module loaded before
  // it was injected) — do one real round trip before giving up.
  try {
    await bridgeRequest('https://example.com', 'HEAD', timeoutMs);
    return true;
  } catch {
    return false;
  }
}

/**
 * Creates a `fetchFn` for `engine.loadPage(url, { fetchFn })` (or manual
 * use) that routes through the Kenkage Network Bridge extension instead of
 * the page's own (CORS-restricted) `fetch()`. Requires the extension —
 * check {@link isBridgeAvailable} first and fall back to plain `fetch()`
 * if it isn't installed.
 */
export function createBridgeFetch(options?: { timeoutMs?: number }) {
  const timeoutMs = options?.timeoutMs ?? 15000;
  return async function bridgeFetch(url: string): Promise<BridgeFetchResult> {
    return bridgeRequest(url, 'GET', timeoutMs);
  };
}
