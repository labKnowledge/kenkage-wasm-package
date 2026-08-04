/**
 * Tests for loadPage()'s <script type="module"> support — the in-WASM
 * QuickJS engine's real ES module loader, fed by a host-side static
 * import-graph crawler (see crawlModuleGraph in ../index.ts).
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

/**
 * A fetchFn backed by an in-memory URL → body map. Throws for anything not
 * in the map (simulating a real network failure) rather than returning a
 * fabricated 404 body, so unresolvable-import tests exercise the crawler's
 * and loader's actual error paths instead of silently "succeeding" with
 * empty content.
 */
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

describe('loadPage — ES module scripts', () => {
  it('executes an inline <script type="module"> and mutates the DOM', async () => {
    const html = `<html><head><title>t</title></head><body>
      <script type="module">
        document.body.setAttribute('data-ran', 'inline');
      </script>
    </body></html>`;
    const { fetchFn } = makeFetchMock({ 'https://example.com/': html });

    const result = await engine.loadPage('https://example.com/', { fetchFn });

    expect(result.scriptErrors).toEqual([]);
    expect(result.scriptsExecuted).toBe(1);
    expect(result.html).toContain('data-ran="inline"');
  });

  it('resolves and executes a static import from an external module', async () => {
    const html = `<html><body>
      <script type="module" src="/main.js"></script>
    </body></html>`;
    const mainJs = `
      import { mark } from './helper.js';
      mark();
    `;
    const helperJs = `
      export function mark() {
        document.body.setAttribute('data-ran', 'imported');
      }
    `;
    const { fetchFn, calls } = makeFetchMock({
      'https://example.com/': html,
      'https://example.com/main.js': mainJs,
      'https://example.com/helper.js': helperJs,
    });

    const result = await engine.loadPage('https://example.com/', { fetchFn });

    expect(result.scriptErrors).toEqual([]);
    expect(result.html).toContain('data-ran="imported"');
    expect(calls['https://example.com/helper.js']).toBe(1);
  });

  it('recursively resolves a multi-level import chain', async () => {
    const html = `<html><body>
      <script type="module" src="/main.js"></script>
    </body></html>`;
    const mainJs = `import { run } from './mid.js'; run();`;
    const midJs = `import { leafMark } from './leaf.js'; export function run() { leafMark(); }`;
    const leafJs = `export function leafMark() { document.body.setAttribute('data-depth', '3'); }`;
    const { fetchFn } = makeFetchMock({
      'https://example.com/': html,
      'https://example.com/main.js': mainJs,
      'https://example.com/mid.js': midJs,
      'https://example.com/leaf.js': leafJs,
    });

    const result = await engine.loadPage('https://example.com/', { fetchFn });

    expect(result.scriptErrors).toEqual([]);
    expect(result.html).toContain('data-depth="3"');
  });

  it('dedups a shared dependency imported by two separate module scripts', async () => {
    const html = `<html><body>
      <script type="module" src="/a.js"></script>
      <script type="module" src="/b.js"></script>
    </body></html>`;
    const aJs = `import { count } from './shared.js'; count();`;
    const bJs = `import { count } from './shared.js'; count();`;
    const sharedJs = `
      globalThis.__kk_test_count = globalThis.__kk_test_count || 0;
      export function count() {
        globalThis.__kk_test_count++;
        document.body.setAttribute('data-count', String(globalThis.__kk_test_count));
      }
    `;
    const { fetchFn, calls } = makeFetchMock({
      'https://example.com/': html,
      'https://example.com/a.js': aJs,
      'https://example.com/b.js': bJs,
      'https://example.com/shared.js': sharedJs,
    });

    const result = await engine.loadPage('https://example.com/', { fetchFn });

    expect(result.scriptErrors).toEqual([]);
    expect(calls['https://example.com/shared.js']).toBe(1);
    expect(result.html).toContain('data-count="2"');
  });

  it('reports a clean error for an unresolvable import instead of crashing', async () => {
    const html = `<html><body>
      <script type="module">
        import { x } from 'left-pad';
        document.body.setAttribute('data-ok', 'true');
      </script>
    </body></html>`;
    const { fetchFn } = makeFetchMock({ 'https://example.com/': html });

    const result = await engine.loadPage('https://example.com/', { fetchFn });

    expect(result.scriptErrors.length).toBeGreaterThan(0);
    expect(result.scriptErrors.some((e) => /not pre-fetched|mock fetch/i.test(e.message))).toBe(true);
    // The script itself never got to run its own body (import failed to link).
    expect(result.html).not.toContain('data-ok="true"');
  });

  it('still reports type="importmap" as skipped, not executed', async () => {
    const html = `<html><body>
      <script type="importmap">{"imports":{}}</script>
    </body></html>`;
    const { fetchFn } = makeFetchMock({ 'https://example.com/': html });

    const result = await engine.loadPage('https://example.com/', { fetchFn });

    expect(result.scriptsExecuted).toBe(0);
    expect(result.scriptsSkipped).toHaveLength(1);
    expect(result.scriptsSkipped[0].reason).toBe('unsupported script type "importmap"');
  });

  it('does not leak modules registered by one loadPage() call into the next', async () => {
    const htmlA = `<html><body><script type="module" src="/x.js"></script></body></html>`;
    const xJsA = `export const val = 'A';`;
    const { fetchFn: fetchA } = makeFetchMock({
      'https://a.example.com/': htmlA,
      'https://a.example.com/x.js': xJsA,
    });
    await engine.loadPage('https://a.example.com/', { fetchFn: fetchA });

    // A second, unrelated page must not be able to see A's registered
    // modules — it has to fetch (and register) its own from scratch.
    const htmlB = `<html><body>
      <script type="module">
        import { val } from './x.js';
        document.body.setAttribute('data-val', val);
      </script>
    </body></html>`;
    const xJsB = `export const val = 'B';`;
    const { fetchFn: fetchB, calls } = makeFetchMock({
      'https://b.example.com/': htmlB,
      'https://b.example.com/x.js': xJsB,
    });
    const result = await engine.loadPage('https://b.example.com/', { fetchFn: fetchB });

    expect(result.scriptErrors).toEqual([]);
    expect(result.html).toContain('data-val="B"');
    expect(calls['https://b.example.com/x.js']).toBe(1);
  });
});
