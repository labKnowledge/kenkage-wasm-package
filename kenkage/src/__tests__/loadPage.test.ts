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

describe('loadPage — dynamic import()', () => {
  it('resolves and executes a literal-argument dynamic import()', async () => {
    const html = `<html><body>
      <script type="module">
        const mod = await import('./lazy.js');
        mod.mark();
      </script>
    </body></html>`;
    const lazyJs = `export function mark() { document.body.setAttribute('data-ran', 'dynamic'); }`;
    const { fetchFn, calls } = makeFetchMock({
      'https://example.com/': html,
      'https://example.com/lazy.js': lazyJs,
    });

    const result = await engine.loadPage('https://example.com/', { fetchFn });

    expect(result.scriptErrors).toEqual([]);
    expect(result.html).toContain('data-ran="dynamic"');
    expect(calls['https://example.com/lazy.js']).toBe(1);
  });

  it('eagerly pre-fetches every literal dynamic-import candidate reachable in source, even ones never invoked', async () => {
    // Mirrors how Vite compiles import.meta.glob()-based route splitting:
    // a lookup object of `() => import('literal/path.js')` thunks, only
    // one of which actually runs at runtime.
    const html = `<html><body>
      <script type="module" src="/router.js"></script>
    </body></html>`;
    const routerJs = `
      const pages = {
        home: () => import('./pages/home.js'),
        about: () => import('./pages/about.js'),
      };
      const mod = await pages['home']();
      mod.render();
    `;
    const homeJs = `export function render() { document.body.setAttribute('data-page', 'home'); }`;
    const aboutJs = `export function render() { document.body.setAttribute('data-page', 'about'); }`;
    const { fetchFn, calls } = makeFetchMock({
      'https://example.com/': html,
      'https://example.com/router.js': routerJs,
      'https://example.com/pages/home.js': homeJs,
      'https://example.com/pages/about.js': aboutJs,
    });

    const result = await engine.loadPage('https://example.com/', { fetchFn });

    expect(result.scriptErrors).toEqual([]);
    expect(result.html).toContain('data-page="home"');
    // Both candidates get pre-fetched even though only "home" actually ran
    // — the documented eager-prefetch trade-off that makes dynamic
    // import() work without knowing in advance which branch executes.
    expect(calls['https://example.com/pages/home.js']).toBe(1);
    expect(calls['https://example.com/pages/about.js']).toBe(1);
  });

  it('rejects (catchably, not a crash) a computed dynamic import specifier the crawler could not see', async () => {
    const html = `<html><body>
      <script type="module">
        const name = 'home';
        try {
          await import(\`./pages/\${name}.js\`);
          document.body.setAttribute('data-outcome', 'resolved');
        } catch (e) {
          document.body.setAttribute('data-outcome', 'rejected');
        }
      </script>
    </body></html>`;
    const { fetchFn } = makeFetchMock({ 'https://example.com/': html });

    const result = await engine.loadPage('https://example.com/', { fetchFn });

    expect(result.scriptErrors).toEqual([]);
    expect(result.html).toContain('data-outcome="rejected"');
  });

  it('resolves a computed dynamic import specifier on demand when the target genuinely exists', async () => {
    // Same shape as the rejection test above, but the mock DOES have the
    // computed target this time — proving the on-demand path (rewriteDynamicImports
    // + __kk_dynamic_import + drainPendingModuleRequests) actually completes
    // successfully end-to-end, not just fails gracefully.
    const html = `<html><body>
      <script type="module">
        const name = 'home';
        const mod = await import(\`./pages/\${name}.js\`);
        document.body.setAttribute('data-page', mod.render());
      </script>
    </body></html>`;
    const homeJs = `export function render() { return 'home-rendered'; }`;
    const { fetchFn, calls } = makeFetchMock({
      'https://example.com/': html,
      'https://example.com/pages/home.js': homeJs,
    });

    const result = await engine.loadPage('https://example.com/', { fetchFn });

    expect(result.scriptErrors).toEqual([]);
    expect(result.uncaughtErrors).toEqual([]);
    expect(result.html).toContain('data-page="home-rendered"');
    expect(calls['https://example.com/pages/home.js']).toBe(1);
  });

  it('resolves a dynamic import triggered via eval() after loadPage() has already returned', async () => {
    // The "lazy loading after page loading" case: nothing in the initial
    // page ever imports pages/late.js — it's only requested by a
    // completely separate eval() call made once loadPage() has already
    // settled and returned, simulating a later click handler or
    // navigation. This only works because activeDoFetch/activeModuleVisited
    // persist on the engine instance beyond a single loadPage() call.
    const html = `<html><body></body></html>`;
    const lateJs = `export function render() { return 'late-rendered'; }`;
    const { fetchFn, calls } = makeFetchMock({
      'https://example.com/': html,
      'https://example.com/pages/late.js': lateJs,
    });

    const loadResult = await engine.loadPage('https://example.com/', { fetchFn });
    expect(loadResult.scriptErrors).toEqual([]);
    expect(calls['https://example.com/pages/late.js']).toBeUndefined();

    // eval()'s own return value reflects the top-level expression's state
    // at the point evalRaw finishes — a pending Promise still waiting on a
    // host-serviced dynamic import hasn't settled yet at that instant (the
    // servicing happens in eval()'s *subsequent* drain step), so this
    // follows the same side-effect-then-reread idiom the loadPage() tests
    // above use via document.body/result.html, rather than relying on the
    // async IIFE's return value being captured directly.
    const evalResult = await engine.eval(`(async () => {
      const mod = await import('./pages/late.js');
      globalThis.__testLateResult = mod.render();
    })()`);
    expect(evalResult.uncaughtErrors).toEqual([]);
    expect(calls['https://example.com/pages/late.js']).toBe(1);

    const readResult = await engine.eval('globalThis.__testLateResult');
    expect(readResult.result).toBe('late-rendered');
  });

  it('settles a fetch->dynamic-import->fetch ping-pong chain, not just one pass of each', async () => {
    // Mirrors the real-world pattern this was built for: a fetch's .then()
    // triggers a dynamic import, and THAT module's own top-level code makes
    // a second fetch — e.g. a feature-flag client's init fetch resolving,
    // then lazily importing the component it gates, which itself fetches
    // its own data. A single drainPendingFetches-then-drainPendingModuleRequests
    // pass (the old behavior) would settle the first fetch and the import,
    // but never revisit the fetch queue for the second one.
    const html = `<html><body>
      <script type="module">
        const configRes = await fetch('/config.json');
        const config = await configRes.json();
        const mod = await import('./pages/' + config.page + '.js');
        const dataRes = await mod.fetchData();
        document.body.setAttribute('data-final', dataRes);
      </script>
    </body></html>`;
    const pageJs = `export async function fetchData() {
      const res = await fetch('/data.json');
      return await res.text();
    }`;
    const { fetchFn } = makeFetchMock({
      'https://example.com/': html,
      'https://example.com/config.json': JSON.stringify({ page: 'ping' }),
      'https://example.com/pages/ping.js': pageJs,
      'https://example.com/data.json': 'pong-data',
    });

    const result = await engine.loadPage('https://example.com/', { fetchFn });

    expect(result.scriptErrors).toEqual([]);
    expect(result.uncaughtErrors).toEqual([]);
    expect(result.html).toContain('data-final="pong-data"');
  });
});
