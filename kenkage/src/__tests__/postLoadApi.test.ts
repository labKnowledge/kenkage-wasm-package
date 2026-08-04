/**
 * Tests for the "API calls after load" fix: dispatchEvent/timer callbacks no
 * longer silently swallow exceptions (they land in LoadPageResult.uncaughtErrors),
 * and a batch of previously-missing browser globals (requestAnimationFrame,
 * IntersectionObserver, localStorage, Headers/Response/Blob/FormData, location,
 * etc.) now exist as non-throwing, pragmatic stubs — so a real app's boot
 * sequence (very often gated behind a `load` listener or a scheduler callback)
 * doesn't die on first touch of one of them before it gets to its own
 * post-load fetch() calls.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createKenkage, type KenkageWasm } from '../index';
import { join } from 'node:path';

const WASM_PATH = join(process.cwd(), 'dist', 'kenkage-full.wasm');

let engine: KenkageWasm;

beforeAll(async () => {
  engine = await createKenkage({ wasmUrl: WASM_PATH, engine: 'full' });
  await engine.init();
});

afterAll(() => {
  engine.destroy();
});

function makeFetchMock(pages: Record<string, string>) {
  const calls: Record<string, number> = {};
  const fetchFn = async (url: string) => {
    calls[url] = (calls[url] ?? 0) + 1;
    if (!(url in pages)) {
      throw new Error(`mock fetch: no such page ${url}`);
    }
    return { status: 200, body: pages[url] };
  };
  return { fetchFn, calls };
}

describe('loadPage — uncaught listener/timer errors surface instead of vanishing', () => {
  it('records a load-listener exception in uncaughtErrors instead of discarding it', async () => {
    const html = `<html><body>
      <script>
        window.addEventListener('load', () => {
          thisFunctionDoesNotExist();
          document.body.setAttribute('data-reached-end', 'true');
        });
      </script>
    </body></html>`;
    const { fetchFn } = makeFetchMock({ 'https://example.com/': html });

    const result = await engine.loadPage('https://example.com/', { fetchFn });

    expect(result.uncaughtErrors.length).toBeGreaterThan(0);
    expect(result.uncaughtErrors[0].type).toBe('load');
    expect(result.uncaughtErrors[0].message).toMatch(/thisFunctionDoesNotExist/);
    // The rest of the listener after the throw never ran — same as a real browser.
    expect(result.html).not.toContain('data-reached-end="true"');
  });

  it('lets a load listener reach its own fetch() call even after a sibling listener threw', async () => {
    const html = `<html><body>
      <script>
        window.addEventListener('load', () => { thisFunctionDoesNotExist(); });
        window.addEventListener('load', async () => {
          const res = await fetch('/api/data');
          const data = await res.json();
          document.body.setAttribute('data-value', data.value);
        });
      </script>
    </body></html>`;
    const { fetchFn } = makeFetchMock({
      'https://example.com/': html,
      'https://example.com/api/data': JSON.stringify({ value: 'loaded' }),
    });

    const result = await engine.loadPage('https://example.com/', { fetchFn });

    expect(result.uncaughtErrors.length).toBe(1);
    expect(result.html).toContain('data-value="loaded"');
  });
});

describe('loadPage — deferred (post-load) fetch patterns actually run', () => {
  it('runs a fetch queued from inside a requestAnimationFrame callback registered on load', async () => {
    const html = `<html><body>
      <script>
        window.addEventListener('load', () => {
          requestAnimationFrame(async () => {
            const res = await fetch('/api/rendered');
            document.body.setAttribute('data-rendered', await res.text());
          });
        });
      </script>
    </body></html>`;
    const { fetchFn } = makeFetchMock({
      'https://example.com/': html,
      'https://example.com/api/rendered': 'yes',
    });

    const result = await engine.loadPage('https://example.com/', { fetchFn });

    expect(result.uncaughtErrors).toEqual([]);
    expect(result.html).toContain('data-rendered="yes"');
  });

  it('fires IntersectionObserver callbacks so lazy/observed fetches run', async () => {
    const html = `<html><body><div id="target"></div>
      <script>
        const io = new IntersectionObserver((entries) => {
          entries.forEach(async (entry) => {
            if (!entry.isIntersecting) return;
            const res = await fetch('/api/lazy');
            document.body.setAttribute('data-lazy', await res.text());
          });
        });
        io.observe(document.getElementById('target'));
      </script>
    </body></html>`;
    const { fetchFn } = makeFetchMock({
      'https://example.com/': html,
      'https://example.com/api/lazy': 'visible',
    });

    const result = await engine.loadPage('https://example.com/', { fetchFn });

    expect(result.uncaughtErrors).toEqual([]);
    expect(result.html).toContain('data-lazy="visible"');
  });

  it('seeds window.location/document.location from the loaded URL', async () => {
    const html = `<html><body>
      <script>
        document.body.setAttribute('data-origin', location.origin);
        document.body.setAttribute('data-path', location.pathname);
      </script>
    </body></html>`;
    const { fetchFn } = makeFetchMock({ 'https://example.com/some/page': html });

    const result = await engine.loadPage('https://example.com/some/page', { fetchFn });

    expect(result.html).toContain('data-origin="https://example.com"');
    expect(result.html).toContain('data-path="/some/page"');
  });

  it('lets a script build its API URL from location.origin and successfully fetch it', async () => {
    const html = `<html><body>
      <script>
        window.addEventListener('load', async () => {
          const res = await fetch(location.origin + '/api/me');
          document.body.setAttribute('data-me', await res.text());
        });
      </script>
    </body></html>`;
    const { fetchFn } = makeFetchMock({
      'https://example.com/': html,
      'https://example.com/api/me': 'me',
    });

    const result = await engine.loadPage('https://example.com/', { fetchFn });

    expect(result.uncaughtErrors).toEqual([]);
    expect(result.html).toContain('data-me="me"');
  });
});

describe('eval — previously-missing globals now exist and behave pragmatically', () => {
  it('no longer reports any of the previously-missing globals as undefined', async () => {
    const names = [
      'requestAnimationFrame', 'cancelAnimationFrame', 'IntersectionObserver', 'ResizeObserver',
      'MutationObserver', 'matchMedia', 'localStorage', 'sessionStorage', 'crypto', 'structuredClone',
      'Worker', 'WebSocket', 'queueMicrotask', 'AbortController', 'AbortSignal', 'Blob', 'FormData',
      'Headers', 'Request', 'Response', 'history', 'location', 'navigator',
      'performance', 'customElements', 'getComputedStyle', 'MessageChannel', 'WeakRef',
      'FinalizationRegistry', 'requestIdleCallback', 'ReadableStream', 'btoa', 'atob',
    ];
    const result = await engine.eval(
      `JSON.stringify([${names.map((n) => `typeof ${n} === 'undefined' ? '${n}' : null`).join(', ')}].filter(Boolean))`,
    );
    expect(result.success).toBe(true);
    expect(JSON.parse(result.result)).toEqual([]);
  });

  it('localStorage persists a value across get/set', async () => {
    const result = await engine.eval(
      "localStorage.setItem('k', 'v'); JSON.stringify([localStorage.getItem('k'), localStorage.getItem('missing')])",
    );
    expect(result.success).toBe(true);
    expect(JSON.parse(result.result)).toEqual(['v', null]);
  });

  it('btoa/atob round-trip a string', async () => {
    const result = await engine.eval("atob(btoa('hello, kenkage!'))");
    expect(result).toEqual({ success: true, result: 'hello, kenkage!' });
  });

  it('crypto.randomUUID returns a v4-shaped string', async () => {
    const result = await engine.eval('crypto.randomUUID()');
    expect(result.success).toBe(true);
    expect(result.result).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('Headers normalizes case and Response exposes json()/text()', async () => {
    const result = await engine.eval(`(async () => {
      const h = new Headers({ 'Content-Type': 'text/plain' });
      const r = new Response(JSON.stringify({ ok: true }), { status: 201 });
      const data = await r.json();
      return JSON.stringify([h.get('content-type'), r.status, data.ok]);
    })()`);
    expect(result.success).toBe(true);
    expect(JSON.parse(result.result)).toEqual(['text/plain', 201, true]);
  });

  it('AbortController.abort() flips signal.aborted and fires the abort event', async () => {
    const result = await engine.eval(`(function () {
      const c = new AbortController();
      let fired = false;
      c.signal.addEventListener('abort', () => { fired = true; });
      c.abort();
      return JSON.stringify([c.signal.aborted, fired]);
    })()`);
    expect(result.success).toBe(true);
    expect(JSON.parse(result.result)).toEqual([true, true]);
  });

  it('MessageChannel delivers a postMessage from port1 to port2', async () => {
    const result = await engine.eval(`(async () => {
      const ch = new MessageChannel();
      const received = new Promise((resolve) => { ch.port2.onmessage = (e) => resolve(e.data); });
      ch.port1.postMessage('hi');
      __kk_flush_timers();
      return await received;
    })()`);
    expect(result).toEqual({ success: true, result: 'hi' });
  });

  it('a real DOM node exposes ownerDocument and document exposes defaultView (legacy React mount path)', async () => {
    const result = await engine.eval(
      "JSON.stringify([document.body.ownerDocument === document, document.defaultView === globalThis])",
      '<html><body></body></html>',
    );
    expect(result.success).toBe(true);
    expect(JSON.parse(result.result)).toEqual([true, true]);
  });

  it('instanceof checks against common Event/HTMLElement subclasses no longer throw', async () => {
    const result = await engine.eval(`(function () {
      const e = new Event('click');
      const div = document.createElement('div');
      return JSON.stringify([
        e instanceof MouseEvent,
        e instanceof KeyboardEvent,
        div instanceof HTMLIFrameElement,
        div instanceof HTMLInputElement,
      ]);
    })()`, '<html><body></body></html>');
    expect(result.success).toBe(true);
    // None of these are actually true for our generic node/Event objects —
    // the fix is that checking no longer throws, not that type detection
    // becomes fully accurate.
    expect(JSON.parse(result.result)).toEqual([false, false, false, false]);
  });
});

describe('loadPage — XMLHttpRequest (still common in the wild alongside fetch)', () => {
  it('resolves a relative-URL XHR GET and fires load/readystatechange', async () => {
    const html = `<html><body>
      <script>
        window.addEventListener('load', () => {
          const xhr = new XMLHttpRequest();
          xhr.open('GET', '/api/legacy');
          xhr.onload = () => {
            document.body.setAttribute('data-xhr-status', String(xhr.status));
            document.body.setAttribute('data-xhr-body', xhr.responseText);
          };
          xhr.send();
        });
      </script>
    </body></html>`;
    const { fetchFn } = makeFetchMock({
      'https://example.com/': html,
      'https://example.com/api/legacy': 'xhr-ok',
    });

    const result = await engine.loadPage('https://example.com/', { fetchFn });

    expect(result.uncaughtErrors).toEqual([]);
    expect(result.html).toContain('data-xhr-status="200"');
    expect(result.html).toContain('data-xhr-body="xhr-ok"');
  });

  it('reports an XHR error via onerror instead of an unhandled rejection when the fetch fails', async () => {
    const html = `<html><body>
      <script>
        window.addEventListener('load', () => {
          const xhr = new XMLHttpRequest();
          xhr.open('GET', '/api/missing');
          xhr.onerror = () => { document.body.setAttribute('data-xhr-errored', 'true'); };
          xhr.send();
        });
      </script>
    </body></html>`;
    const { fetchFn } = makeFetchMock({ 'https://example.com/': html });

    const result = await engine.loadPage('https://example.com/', { fetchFn });

    expect(result.html).toContain('data-xhr-errored="true"');
  });
});
