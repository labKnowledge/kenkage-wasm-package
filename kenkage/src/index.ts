/**
 * kenkage — Core WASM wrapper
 *
 * Loads the Zig-compiled WASM browser engine and exposes a clean async API
 * for HTML parsing, DOM querying, and text/markdown extraction.
 */

// ── Type definitions ──────────────────────────────────────────────

export interface KenkageWasm {
  /** Initialize the WASM engine. Must be called once after creation. */
  init(): Promise<void>;
  /** Destroy the engine and free all memory. */
  destroy(): void;
  /** Parse an HTML string and build the DOM tree. Returns true on success. */
  parse(html: string): boolean;
  /** Get the document <title> content. */
  getTitle(): string;
  /** Get all text content with tags stripped. */
  getText(): string;
  /** Get the serialized HTML of the parsed document. */
  getHtml(): string;
  /** Convert the parsed HTML to Markdown. */
  getMarkdown(): string;
  /** Get total node count in the DOM tree. */
  getNodeCount(): number;
  /** Query elements by CSS selector. Returns array of node IDs. */
  querySelector(selector: string): number[];
  /** Get a node's tag name by its ID. */
  nodeTag(id: number): string;
  /** Get a node's text content by its ID. */
  nodeText(id: number): string;
  /** Get a node's attribute value by node ID and attribute name. */
  nodeAttr(id: number, name: string): string;
  /** Get the number of children of a node. */
  nodeChildCount(id: number): number;
  /** Get child node IDs of a node. */
  nodeChildren(id: number): number[];
  /**
   * Evaluate JavaScript code using the host's JS engine.
   *
   * On the 'full' engine, this doesn't just run `code` and return —
   * afterward it drains the same way loadPage() does: Promise
   * microtasks, the timer queue, any fetch() calls the code triggered,
   * and any dynamic import() it made (including ones with a specifier
   * that couldn't be known ahead of time, resolved via the same
   * on-demand mechanism as loadPage()'s eager crawl). This is what
   * makes calling eval() *after* loadPage() has already returned able to
   * do real, load-bearing work — e.g. `engine.eval("document.querySelector('button').click()")`
   * on the same still-alive page — rather than only ever settling things
   * that happened to still be in flight from the original page load.
   * `uncaughtErrors`/`consoleMessages` are only ever present on the
   * 'full' engine; they reflect activity from this call only, not a
   * running total (call loadPage()'s or drain them yourself between
   * calls if you need the full history).
   */
  eval(code: string): Promise<{
    success: boolean;
    result: string;
    uncaughtErrors?: { type: string; message: string }[];
    consoleMessages?: { level: string; message: string }[];
  }>;
  /**
   * Runs the same post-eval settle loop eval() does — Promise microtasks,
   * timers, pending fetch() calls, pending dynamic import() requests —
   * without evaluating any new code first. Useful after dispatching a
   * native event or similar host-side interaction that doesn't itself go
   * through eval(), or simply to let any in-flight async work (a retry
   * timer, a slow fetch) finish before inspecting the page again. A no-op
   * that returns empty arrays on the 'core' engine (no JS engine to have
   * pending work in the first place).
   */
  settle(): Promise<{
    uncaughtErrors: { type: string; message: string; stack?: string }[];
    consoleMessages: { level: string; message: string }[];
    scriptErrors?: { id: number | string; src?: string; message: string; stack?: string }[];
  }>;
  /** Fetch a URL using the host's fetch API. Returns the response. */
  fetch(url: string, options?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<{ status: number; body: string }>;
  /**
   * Loads a page like a browser tab would: fetches `url`, parses it, then
   * runs every `<script>` found in document order — external ones are
   * fetched, inline ones run directly — against the real DOM via the
   * 'full' engine's document/Element bindings. Draining Promise microtasks
   * and the setTimeout queue happens automatically after each script.
   * Requires `engine: 'full'`.
   *
   * Only available with `engine: 'full'` — the 'core' build has no JS
   * engine to run scripts on, so this throws if called on it.
   *
   * `<script type="module">` is executed as a real ES module: every
   * `import`/`export from` specifier and every literal-argument dynamic
   * `import("...")` call — including ones sitting inside functions that
   * only run conditionally, e.g. Vite's compiled `import.meta.glob`
   * route-splitting output — is crawled and pre-fetched (recursively,
   * deduped across the page) before evaluation, since QuickJS's module
   * loader is synchronous and can't itself await a network round-trip.
   * Only specifiers built from computed values or template literals
   * (`import(\`./pages/${name}.js\`)`) can't be seen this way — those
   * surface as a ReferenceError (static) or a rejected Promise (dynamic)
   * instead of being resolved. `<script type="importmap">` and other
   * non-executable types land in `scriptsSkipped`.
   */
  loadPage(url: string, options?: LoadPageOptions): Promise<LoadPageResult>;
  /** Engine version string (available before init). */
  version: string;
}

export interface LoadPageOptions {
  /**
   * Override how bytes for `url` and any external script are fetched.
   * Defaults to the engine's own `fetch()` (a real, direct browser
   * fetch — no CORS workaround). Pass your own function (e.g. one that
   * falls back to a same-origin proxy) to load pages `fetch()` alone
   * can't reach.
   */
  fetchFn?: (url: string) => Promise<{ status: number; body: string }>;
  /**
   * When true, `LoadPageResult.trace` is populated with a step-by-step
   * log of every significant thing loadPage()'s *own orchestration code*
   * did — every script found/executed, every specifier crawlModuleGraph
   * discovered, every fetch/module request queued and serviced, every
   * settle round. This is deliberately about this engine's own control
   * flow, not the page's behavior: when a page silently fails to fully
   * render with zero errors anywhere, the open question is often "did our
   * code actually do everything it was supposed to, or did something
   * here quietly stop partway through?" — this answers that directly,
   * without having to instrument the page itself to find out.
   * Off by default: a real page can generate thousands of trace events,
   * and most callers never need them.
   */
  trace?: boolean;
}

/**
 * One step in loadPage()'s own internal workflow — see LoadPageOptions.trace.
 * `t` is milliseconds since this loadPage() call started (not wall-clock
 * time), so a trace is comparable/diffable across separate runs.
 */
export interface TraceEvent {
  seq: number;
  t: number;
  type: string;
  detail?: Record<string, unknown>;
}

export interface LoadPageResult {
  /** HTTP status of the main page fetch. */
  status: number;
  title: string;
  html: string;
  text: string;
  /** How many `<script>` elements actually ran. */
  scriptsExecuted: number;
  /** Scripts not run — e.g. `type="importmap"`, unresolvable `src`. */
  scriptsSkipped: { src?: string; reason: string }[];
  /** Scripts that ran but threw, or failed to fetch. */
  scriptErrors: { src?: string; message: string }[];
  /**
   * Exceptions thrown by event listeners (`addEventListener`) or timer
   * callbacks (`setTimeout`/`requestAnimationFrame`/etc.) — these don't
   * propagate to their caller in a real browser either (they'd surface as
   * a `window.onerror` report), so they're collected here instead of being
   * silently discarded. A page's post-load data-fetching very often lives
   * inside exactly these callbacks, so a non-empty list here is frequently
   * the actual reason expected content or API calls didn't happen.
   */
  uncaughtErrors: { type: string; message: string }[];
  /**
   * Everything the page's own scripts passed to `console.log/warn/error/
   * info`. React (and most frameworks) report caught render/lifecycle
   * errors — failed error boundaries, effect failures, prop-type
   * warnings — via `console.error` without ever throwing far enough to
   * surface in `scriptErrors` or `uncaughtErrors`, so this is often the
   * only place a client-side-only failure leaves any trace at all.
   */
  consoleMessages: { level: string; message: string }[];
  /** Only populated when `LoadPageOptions.trace` was true; empty otherwise. */
  trace: TraceEvent[];
}

export interface KenkageOptions {
  /** Override the URL/path used to load the WASM file. */
  wasmUrl?: string;
  /**
   * Which engine build to load:
   * - `'core'` (default) — HTML/DOM/CSS only, ~650KB, no JS engine.
   * - `'full'` — adds an in-WASM QuickJS engine so `eval()` runs real
   *   JavaScript inside the sandbox instead of delegating to the host.
   */
  engine?: 'core' | 'full';
}

// ── Internal WASM export types ────────────────────────────────────

interface WasmExports {
  memory: WebAssembly.Memory;
  kk_init: () => number;
  kk_destroy: () => void;
  kk_parse_html: (ptr: number, len: number) => number;
  kk_version: () => number;
  kk_version_len: () => number;
  kk_get_title_ptr: () => number;
  kk_get_title_len: () => number;
  kk_get_text_ptr: () => number;
  kk_get_text_len: () => number;
  kk_get_html_ptr: () => number;
  kk_get_html_len: () => number;
  kk_get_markdown_ptr: () => number;
  kk_get_markdown_len: () => number;
  kk_get_node_count: () => number;
  kk_query_selector: (ptr: number, len: number) => void;
  kk_query_selector_count: () => number;
  kk_node_tag: (nodeId: number) => number;
  kk_node_tag_len: () => number;
  kk_node_text: (nodeId: number) => number;
  kk_node_text_len: () => number;
  kk_node_attr: (nodeId: number, ptr: number, len: number) => number;
  kk_node_attr_len: () => number;
  kk_node_child_count: (nodeId: number) => number;
  kk_node_children: (nodeId: number) => void;
  kk_log: (ptr: number, len: number) => void;
  kk_fetch_request: (url_ptr: number, url_len: number, method_ptr: number, method_len: number) => number;
  kk_fetch_complete: (status: number, body_ptr: number, body_len: number) => void;
  kk_get_fetch_status: () => number;
  kk_get_fetch_body_ptr: () => number;
  kk_get_fetch_body_len: () => number;
  kk_eval_js_request: (code_ptr: number, code_len: number) => number;
  kk_eval_js_complete: (success: number, result_ptr: number, result_len: number) => void;
  kk_get_eval_success: () => number;
  // Present only in the 'full' engine build (real in-WASM QuickJS).
  kk_js_init?: () => number;
  kk_js_destroy?: () => void;
  kk_js_reset?: () => number;
  kk_js_eval?: (code_ptr: number, code_len: number) => number;
  kk_js_get_result?: () => number;
  kk_js_get_result_len?: () => number;
  kk_js_get_error?: () => number;
  kk_js_get_error_len?: () => number;
  kk_js_last_type?: () => number;
  kk_js_run_pending_jobs?: () => number;
  kk_js_resolve_fetch?: (id: number, status: number, bodyPtr: number, bodyLen: number) => number;
  kk_js_reject_fetch?: (id: number, msgPtr: number, msgLen: number) => number;
  kk_js_clear_modules?: () => void;
  kk_js_register_module?: (urlPtr: number, urlLen: number, srcPtr: number, srcLen: number) => number;
  kk_js_eval_module?: (urlPtr: number, urlLen: number, codePtr: number, codeLen: number) => number;
}

// ── Constants ─────────────────────────────────────────────────────

/** Offset into WASM linear memory for writing input strings. */
const WRITE_OFFSET = 131072; // 128KB — safely past the 64KB result_buffer

/**
 * Offset for eval/fetch input/output — 2MB to avoid conflicts with
 * the 1MB arena + 256KB result buffer + 64KB input buffer.
 */
const EVAL_FETCH_OFFSET = 2 * 1024 * 1024;

// ── Environment detection ─────────────────────────────────────────

const isNode =
  typeof process !== 'undefined' &&
  process.versions != null &&
  process.versions.node != null;

/**
 * Computed (not literal) so bundlers can't statically resolve this dynamic
 * import at build time. A literal `import('node:fs')` is eagerly resolved
 * by esbuild/webpack even though it's dynamic and guarded by `isNode` at
 * runtime — bundling for a browser target (no `node:fs`) then fails at
 * build time with "Could not resolve 'node:fs'", even though the guarded
 * branch would never actually execute in a browser. Concatenating the
 * specifier at runtime defeats that static analysis; the resolved value
 * ("node:fs") and Node's actual module resolution are unaffected.
 */
const NODE_FS_SPECIFIER = 'node' + ':' + 'fs';

// ── WASM URL resolution ───────────────────────────────────────────

/**
 * Each branch below uses a literal string path (not a template literal) so
 * bundlers that statically recognize `new URL('./x', import.meta.url)` as an
 * asset reference — webpack 5+, Vite/Rollup — can see it, copy the file
 * alongside the bundle, and rewrite the URL correctly even when this module
 * is fully inlined into someone else's output. A dynamic `` `./${filename}` ``
 * isn't statically analyzable, so it would silently fall back to
 * `import.meta.url` pointing at the *bundle's* location instead of this
 * package's — which is exactly what breaks under full bundling.
 * esbuild does NOT support this convention (verified against 0.25 — a
 * `new URL(..., import.meta.url)` call is left as runtime code regardless of
 * `--loader:.wasm=file`), so esbuild-bundled consumers (and any other
 * bundler without this convention) still need to pass `wasmUrl` to
 * `createKenkage()` explicitly — see the README's "Bundler consumers"
 * section.
 */
function resolveDefaultWasmUrl(engine: 'core' | 'full'): string {
  if (isNode) {
    // In Node.js, resolve relative to the dist/ directory of this package
    return engine === 'full'
      ? new URL('../dist/kenkage-full.wasm', import.meta.url).toString()
      : new URL('../dist/kenkage-core.wasm', import.meta.url).toString();
  }
  // In the browser, the WASM file is co-located with the JS bundle
  return engine === 'full'
    ? new URL('./kenkage-full.wasm', import.meta.url).toString()
    : new URL('./kenkage-core.wasm', import.meta.url).toString();
}

// ── Minimal WASI shim ─────────────────────────────────────────────
//
// The 'full' engine build links libc (required by QuickJS) and targets
// wasm32-wasi, so it imports a handful of WASI syscalls. We don't need
// real filesystem/process semantics — only enough stubs to satisfy the
// linker's import table so the module instantiates and its exported
// kk_* functions work. The 'core' build is wasm32-freestanding and
// never references these; harmless to always provide them.

function makeWasiShim(getMemory: () => WebAssembly.Memory) {
  function view(): DataView {
    return new DataView(getMemory().buffer);
  }

  return {
    args_get: () => 0,
    args_sizes_get: (argcPtr: number, argvBufSizePtr: number) => {
      view().setUint32(argcPtr, 0, true);
      view().setUint32(argvBufSizePtr, 0, true);
      return 0;
    },
    clock_time_get: (_id: number, _precision: number, timePtr: number) => {
      view().setBigUint64(timePtr, BigInt(Date.now()) * 1_000_000n, true);
      return 0;
    },
    fd_fdstat_get: (_fd: number, statPtr: number) => {
      const v = view();
      v.setUint8(statPtr, 2); // filetype: character device
      v.setUint16(statPtr + 2, 0, true);
      v.setBigUint64(statPtr + 8, 0n, true);
      v.setBigUint64(statPtr + 16, 0n, true);
      return 0;
    },
    fd_seek: (_fd: number, _offsetLow: number, _offsetHigh: number, _whence: number, newOffsetPtr: number) => {
      view().setBigUint64(newOffsetPtr, 0n, true);
      return 0;
    },
    fd_write: (fd: number, iovsPtr: number, iovsLen: number, nwrittenPtr: number) => {
      const v = view();
      const mem = new Uint8Array(getMemory().buffer);
      let total = 0;
      let text = '';
      for (let i = 0; i < iovsLen; i++) {
        const base = iovsPtr + i * 8;
        const ptr = v.getUint32(base, true);
        const len = v.getUint32(base + 4, true);
        text += new TextDecoder().decode(mem.slice(ptr, ptr + len));
        total += len;
      }
      if (fd === 1) console.log(text.replace(/\n$/, ''));
      else if (fd === 2) console.error(text.replace(/\n$/, ''));
      view().setUint32(nwrittenPtr, total, true);
      return 0;
    },
    fd_close: () => 0,
    proc_exit: (code: number) => {
      throw new Error(`WASM module called proc_exit(${code})`);
    },
  };
}

// ── Core factory ──────────────────────────────────────────────────

/**
 * Create a new Kenkage WASM instance.
 *
 * Loads and instantiates the WASM module, returning an object with
 * methods to parse HTML, query the DOM, and extract content.
 *
 * @example
 * ```ts
 * const engine = await createKenkage();
 * await engine.init();
 * engine.parse('<h1>Hello</h1>');
 * console.log(engine.getText()); // "Hello"
 * engine.destroy();
 * ```
 */
export async function createKenkage(
  options?: KenkageOptions,
): Promise<KenkageWasm> {
  const engineKind = options?.engine ?? 'core';
  const wasmUrl = options?.wasmUrl ?? resolveDefaultWasmUrl(engineKind);

  // Load WASM bytes
  let wasmSource: Uint8Array;
  if (isNode) {
    const fs = await import(NODE_FS_SPECIFIER);
    let filePath: string;
    if (wasmUrl.startsWith('file://')) {
      filePath = new URL(wasmUrl).pathname;
    } else {
      filePath = wasmUrl;
    }
    const buf = fs.readFileSync(filePath);
    // Create a clean copy — Node.js Buffers may be pooled, and .buffer
    // can reference more than just the file content.
    wasmSource = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  } else {
    const response = await fetch(wasmUrl);
    if (!response.ok) {
      throw new Error(
        `Failed to load WASM: ${response.status} ${response.statusText}`,
      );
    }
    wasmSource = new Uint8Array(await response.arrayBuffer());
  }

  // Reference for the hostLog/WASI closures
  let exportsRef: WasmExports;

  // Instantiate the WASM module
  // Cast through unknown to satisfy TS 7's stricter BufferSource typing
  const result = (await WebAssembly.instantiate(
    wasmSource,
    {
      env: {
        hostLog: (ptr: number, len: number) => {
          const mem = new Uint8Array(exportsRef.memory.buffer);
          const msg = new TextDecoder().decode(mem.slice(ptr, ptr + len));
          console.log('[kenkage]', msg);
        },
        hostFetch: () => 0,
      },
      // Only referenced by the 'full' (wasm32-wasi) engine build.
      wasi_snapshot_preview1: makeWasiShim(() => exportsRef.memory),
    },
  )) as unknown as { instance: WebAssembly.Instance };
  const exports = result.instance.exports as unknown as WasmExports;
  exportsRef = exports;

  let jsEngineReady = false;
  function ensureJsEngine(): void {
    if (jsEngineReady || !exports.kk_js_init) return;
    const ok = exports.kk_js_init();
    if (!ok) throw new Error('Failed to initialize in-WASM QuickJS engine');
    jsEngineReady = true;
  }

  /**
   * Carried across a loadPage() call and every eval()/settle() call made
   * afterward, on the *same* engine instance and JS realm — this is what
   * makes dynamic import()/fetch() calls triggered after the page has
   * already "loaded" (a later click handler, a deferred retry, a
   * subsequent eval() the host makes to poke at the live page) still able
   * to resolve for real, instead of only working during loadPage()'s own
   * one-shot orchestration loop. Reset at the top of every loadPage() call
   * (a fresh page load gets a fresh realm via kk_js_reset() anyway, so a
   * stale visited-set or fetcher from a *previous* page would be wrong);
   * left untouched by eval()/settle() so they keep reusing whatever the
   * most recent loadPage() established.
   */
  let activeDoFetch: (url: string) => Promise<{ status: number; body: string }> = (u) => api.fetch(u);
  let activeModuleVisited = new Set<string>();

  // ── Trace instrumentation (LoadPageOptions.trace) ────────────────
  // See TraceEvent's doc comment. `tracing`/`traceEvents`/`traceStart` are
  // reset at the top of every loadPage() call so a run's trace only ever
  // reflects that one call, never a previous one bleeding in.
  let tracing = false;
  let traceEvents: TraceEvent[] = [];
  let traceStart = 0;
  function trace(type: string, detail?: Record<string, unknown>): void {
    if (!tracing) return;
    traceEvents.push({ seq: traceEvents.length, t: Date.now() - traceStart, type, detail });
  }

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  // Cache for the instance's string reads
  const instanceCache = new Map<string, { ptr: number; len: number; value: string }>();

  function cachedRead(key: string, ptr: number, len: number): string {
    const cached = instanceCache.get(key);
    if (cached && cached.ptr === ptr && cached.len === len) {
      return cached.value;
    }
    const mem = new Uint8Array(exports.memory.buffer);
    const value = len > 0 ? decoder.decode(mem.slice(ptr, ptr + len)) : '';
    instanceCache.set(key, { ptr, len, value });
    if (instanceCache.size > 128) {
      const firstKey = instanceCache.keys().next().value;
      if (firstKey !== undefined) instanceCache.delete(firstKey);
    }
    return value;
  }

  // Get the result_buffer base address by calling kk_version
  // (all _ptr functions return pointers into the same result_buffer)
  const resultBufPtr = exports.kk_version();

  // Get version string (available without init)
  const version = cachedRead(
    'version',
    resultBufPtr,
    exports.kk_version_len(),
  );

  // ── Internal helpers ──────────────────────────────────────────

  /**
   * kk_js_run_pending_jobs() does exactly one pass: drain every currently-
   * queued Promise reaction, then flush the timer queue once. It does NOT
   * loop back to drain reactions a *timer* callback just queued (e.g. a
   * timer resolving a Promise whose .then() schedules another timer) — that
   * needs a second call. A single-call site therefore only fully settles a
   * chain that alternates Promise reactions and timers a small, fixed
   * number of times.
   *
   * React 18's concurrent scheduler is exactly such a chain: each unit of
   * work it can't finish synchronously yields via MessageChannel
   * (our shim resolves this through setTimeout), whose callback runs more
   * work and, if there's still more, schedules *another* yield the same
   * way. A component tree with enough items needs many rounds to fully
   * render. Calling kk_js_run_pending_jobs() once — or a handful of fixed
   * times, as loadPage() previously did (once per <script> tag) — cuts
   * this off partway through: the page's own scripts finish executing long
   * before the scheduler's self-perpetuating chain does, so loadPage()
   * stopped pumping while React was still mid-render. Nothing throws (nothing
   * failed), so this produces zero signal anywhere — no scriptError, no
   * uncaughtError, no console output — just a DOM that silently never
   * finished mounting.
   *
   * Looping here until a call reports zero combined job+timer activity
   * (its return value) mimics what an idle real browser tab does
   * continuously; the bound guards against a page's own genuinely-infinite
   * chain (a polling setInterval, an unresolved retry loop) from hanging
   * the page load forever.
   */
  function drainJobsAndTimers(): void {
    for (let guard = 0; guard < 2000; guard++) {
      const activity = exports.kk_js_run_pending_jobs?.() ?? 0;
      if (activity <= 0) break;
    }
  }

  /**
   * The actual eval primitive — drains jobs/timers but NOT pending fetch()
   * or dynamic-import() requests. Every internal caller (drainUncaughtErrors,
   * drainConsoleMessages, drainPendingFetches, drainPendingModuleRequests,
   * evalModule, loadPage()'s own script loop) goes through this, not the
   * public api.eval(). Those drain functions peek/settle queues by
   * evaluating small snippets themselves — if that peek/settle eval() call
   * ALSO triggered a fresh round of fetch/module draining (what the public
   * eval() does, see below), each one would recursively invoke the very
   * drain loop it's already running inside of. api.eval() exists precisely
   * to add that extra settle step for *external* callers; internal
   * plumbing needs the bare primitive.
   */
  async function evalRaw(code: string): Promise<{ success: boolean; result: string }> {
    // 'full' engine build: run the code inside the in-WASM QuickJS
    // engine — fully sandboxed, no host JS execution involved.
    if (exports.kk_js_eval) {
      ensureJsEngine();
      const codeLen = writeStringAt(code, EVAL_FETCH_OFFSET);
      const rc = exports.kk_js_eval(EVAL_FETCH_OFFSET, codeLen);
      // Drain Promise microtasks and the setTimeout queue — real JS hosts
      // do this after every turn of script execution, not on request.
      drainJobsAndTimers();
      // Read directly rather than through cachedRead: the result/error
      // buffers are static C arrays at a fixed address, so ptr+len alone
      // can't distinguish two different values that happen to share a
      // length — it would serve stale content back.
      const mem = new Uint8Array(exports.memory.buffer);
      if (rc === 0) {
        const ptr = exports.kk_js_get_result!();
        const len = exports.kk_js_get_result_len!();
        return { success: true, result: decoder.decode(mem.slice(ptr, ptr + len)) };
      }
      const ptr = exports.kk_js_get_error!();
      const len = exports.kk_js_get_error_len!();
      return { success: false, result: decoder.decode(mem.slice(ptr, ptr + len)) };
    }

    // 'core' engine build: no in-WASM JS engine — delegate to the host.
    // 1. Write code to WASM memory at EVAL_FETCH_OFFSET
    const codeLen = writeStringAt(code, EVAL_FETCH_OFFSET);

    // 2. Signal WASM that a JS eval request is pending
    exports.kk_eval_js_request(EVAL_FETCH_OFFSET, codeLen);

    // 3. Execute the code in the host JS engine
    // Use eval() to get the completion value (last expression result),
    // falling back to new Function() for multi-statement code blocks.
    let success = false;
    let resultStr = '';

    try {
      const value = eval(code);
      resultStr = value === undefined ? 'undefined' : String(value);
      success = true;
    } catch (err: unknown) {
      success = false;
      resultStr = err instanceof Error ? err.message : String(err);
    }

    // 4. Write result back to WASM memory
    const resultLen = writeStringAt(resultStr, EVAL_FETCH_OFFSET);

    // 5. Deliver result to WASM
    exports.kk_eval_js_complete(success ? 1 : 0, EVAL_FETCH_OFFSET, resultLen);

    return { success, result: resultStr };
  }

  function writeString(str: string): number {
    const bytes = encoder.encode(str);
    const needed = WRITE_OFFSET + bytes.length;
    const currentLen = exports.memory.buffer.byteLength;
    if (needed > currentLen) {
      const pagesNeeded = Math.ceil((needed - currentLen) / 65536);
      exports.memory.grow(pagesNeeded);
    }
    const mem = new Uint8Array(exports.memory.buffer);
    mem.set(bytes, WRITE_OFFSET);
    return bytes.length;
  }

  /**
   * Write a string to WASM memory at a given offset, growing memory if
   * needed. Also writes a trailing NUL byte — QuickJS's tokenizer reads
   * one byte past the end of the source buffer, so without this a
   * shorter string reused over a longer previous write picks up stale
   * trailing bytes and misparses.
   */
  function writeStringAt(str: string, offset: number): number {
    const bytes = encoder.encode(str);
    const needed = offset + bytes.length + 1;
    const currentLen = exports.memory.buffer.byteLength;
    if (needed > currentLen) {
      const pagesNeeded = Math.ceil((needed - currentLen) / 65536);
      exports.memory.grow(pagesNeeded);
    }
    const mem = new Uint8Array(exports.memory.buffer);
    mem.set(bytes, offset);
    mem[offset + bytes.length] = 0;
    return bytes.length;
  }

  /**
   * Reads and clears the sandbox's __kk_uncaught_errors sink — exceptions
   * thrown by event listeners or timer callbacks, which (like a real
   * browser) never propagate to whoever dispatched/scheduled them. See
   * __kk_record_uncaught in the DOM prelude.
   */
  async function drainUncaughtErrors(): Promise<{ type: string; message: string }[]> {
    const res = await evalRaw('JSON.stringify(__kk_drain_uncaught_errors())');
    if (!res.success) return [];
    try {
      return JSON.parse(res.result);
    } catch {
      return [];
    }
  }

  /**
   * Reads and clears the sandbox's __kk_console_messages sink — everything
   * passed to console.log/warn/error/info during script execution. See the
   * console wrapper installed in the DOM prelude (qjs_engine.c) for why
   * this exists alongside drainUncaughtErrors.
   */
  async function drainConsoleMessages(): Promise<{ level: string; message: string }[]> {
    const res = await evalRaw('JSON.stringify(__kk_drain_console_messages())');
    if (!res.success) return [];
    try {
      return JSON.parse(res.result);
    } catch {
      return [];
    }
  }

  /**
   * Settles any pending sandboxed fetch(url) calls with real, host-fetched
   * responses. Scripts running via loadPage() can call fetch() like any
   * real page would — this is what actually performs the network request
   * on their behalf and wakes their Promise chain back up. Loops (bounded)
   * since resolving one fetch's .then() can itself queue another. Any
   * listener/timer exceptions raised while settling a fetch's Promise chain
   * are appended to `uncaughtErrors`.
   */
  async function drainPendingFetches(
    doFetch: (url: string) => Promise<{ status: number; body: string }>,
    uncaughtErrors: { type: string; message: string }[],
    consoleMessages: { level: string; message: string }[],
  ): Promise<void> {
    for (let guard = 0; guard < 100; guard++) {
      const peek = await evalRaw('JSON.stringify(__kk_next_fetch_request())');
      if (!peek.success) break;
      let req: { id: number; url: string; method: string } | null;
      try {
        req = JSON.parse(peek.result);
      } catch {
        break;
      }
      if (!req) break;

      try {
        const { status, body } = await doFetch(req.url);
        const bodyLen = writeStringAt(body, EVAL_FETCH_OFFSET);
        exports.kk_js_resolve_fetch?.(req.id, status, EVAL_FETCH_OFFSET, bodyLen);
        trace('fetch-settled', { url: req.url, status, bodyLen: body.length });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const msgLen = writeStringAt(message, EVAL_FETCH_OFFSET);
        exports.kk_js_reject_fetch?.(req.id, EVAL_FETCH_OFFSET, msgLen);
        trace('fetch-rejected', { url: req.url, message });
      }
      drainJobsAndTimers();
      uncaughtErrors.push(...(await drainUncaughtErrors()));
      consoleMessages.push(...(await drainConsoleMessages()));
    }
  }

  /**
   * Settles pending __kk_dynamic_import() requests — the on-demand
   * counterpart to crawlModuleGraph's eager pre-fetching, for specifiers
   * that couldn't be seen as literal text ahead of time (see
   * rewriteDynamicImports). `visited` is the SAME set crawlModuleGraph
   * uses, shared across a whole loadPage() call (and, via settle(), across
   * calls made after it returns too) — a specifier already known from
   * eager crawling is settled directly with no redundant re-fetch; the
   * fetch only happens for something genuinely new. Loops (bounded) for
   * the same reason drainPendingFetches does: settling one request's
   * dependent code can itself queue another dynamic import.
   */
  async function drainPendingModuleRequests(
    doFetch: (url: string) => Promise<{ status: number; body: string }>,
    visited: Set<string>,
    errors: { src?: string; message: string }[],
    uncaughtErrors: { type: string; message: string }[],
    consoleMessages: { level: string; message: string }[],
  ): Promise<void> {
    for (let guard = 0; guard < 100; guard++) {
      const peek = await evalRaw('JSON.stringify(__kk_next_module_request())');
      if (!peek.success) break;
      let req: { id: number; url: string } | null;
      try {
        req = JSON.parse(peek.result);
      } catch {
        break;
      }
      if (!req) break;

      const cacheHit = visited.has(req.url);
      trace('dynamic-import-request', { id: req.id, url: req.url, cacheHit });
      if (!cacheHit) {
        visited.add(req.url);
        try {
          const res = await doFetch(req.url);
          registerModule(req.url, res.body);
          await crawlModuleGraph(req.url, res.body, doFetch, visited, errors);
        } catch (err) {
          trace('dynamic-import-fetch-failed', { url: req.url, message: err instanceof Error ? err.message : String(err) });
          // Deliberately not recorded in `errors`/scriptErrors: a dynamic
          // import() failing to fetch is normal, expected-to-be-handled
          // Promise rejection (real browsers treat it exactly the same
          // way — apps commonly wrap lazy-loaded routes in retry/fallback
          // logic specifically for this). scriptErrors' documented meaning
          // is a top-level <script> tag failing outright; conflating the
          // two would flag perfectly-handled app-level error recovery as
          // if the page itself were broken. Leaving the module
          // unregistered means the settle step below rejects the pending
          // import() promise on its own — that's the correct outcome.
        }
      }

      // Settle entirely inside the sandbox: a real import() now resolves
      // synchronously through the same pre-fetch table crawlModuleGraph
      // populates, producing a properly-linked namespace object with no
      // value crossing the WASM boundary — see __kk_dynamic_import's
      // comment in the DOM prelude for why this is deliberately not
      // hand-rolled here. Returns a plain status string (not the
      // namespace object itself) purely so the trace can record whether
      // this specific settle resolved or rejected — evalRaw's own
      // success/result reflects this IIFE completing, not what happened
      // to the underlying import().
      const settleResult = await evalRaw(`(async () => {
        const req = __kk_pending_module_requests.get(${req.id});
        if (!req) return 'no-pending-request';
        __kk_pending_module_requests.delete(${req.id});
        try { req.resolve(await import(${JSON.stringify(req.url)})); return 'resolved'; }
        catch (e) { req.reject(e); return 'rejected:' + (e && e.message); }
      })();`);
      trace('dynamic-import-settle', { id: req.id, url: req.url, outcome: settleResult.success ? settleResult.result : 'evalRaw-failed:' + settleResult.result });
      uncaughtErrors.push(...(await drainUncaughtErrors()));
      consoleMessages.push(...(await drainConsoleMessages()));
    }
  }

  /**
   * Drains fetch() and dynamic-import() requests together to a genuine
   * *joint* fixed point, not just one pass of each. drainPendingFetches and
   * drainPendingModuleRequests each loop internally, but calling them back
   * to back one time each misses a real pattern: resolving a *module*
   * request can run code that queues a *new fetch* (e.g. a feature-flag
   * client's own initialization fetch, triggered by finishing an import of
   * the module that constructs it) — and since the fetch pass already
   * finished, that new fetch wouldn't be serviced until some *unrelated*
   * future call happened to run drainPendingFetches again. The reverse
   * (a fetch's .then() triggering a new dynamic import) has the same
   * problem in the other direction. Peeking both queues' lengths directly
   * (cheap — no dequeue) and looping until a full round finds neither
   * queue has anything closes that gap; bounded generously since each
   * round can itself take several fetches/imports to fully drain.
   */
  async function settleFetchesAndModules(
    doFetch: (url: string) => Promise<{ status: number; body: string }>,
    visited: Set<string>,
    moduleErrors: { src?: string; message: string }[],
    uncaughtErrors: { type: string; message: string }[],
    consoleMessages: { level: string; message: string }[],
  ): Promise<void> {
    for (let round = 0; round < 50; round++) {
      drainJobsAndTimers();
      const peek = await evalRaw(
        'JSON.stringify([__kk_fetch_queue.length > 0, __kk_module_request_queue.length > 0])'
      );
      let hasFetch = false;
      let hasModule = false;
      if (peek.success) {
        try {
          [hasFetch, hasModule] = JSON.parse(peek.result);
        } catch {
          break;
        }
      }
      if (!hasFetch && !hasModule) {
        trace('settle-quiescent', { round });
        break;
      }
      trace('settle-round', { round, hasFetch, hasModule });
      if (hasFetch) await drainPendingFetches(doFetch, uncaughtErrors, consoleMessages);
      if (hasModule) await drainPendingModuleRequests(doFetch, visited, moduleErrors, uncaughtErrors, consoleMessages);
    }
  }

  /**
   * Extracts import specifiers from ES module source — both static
   * (`import ... from "spec"`, `export ... from "spec"`, bare
   * `import "spec"`) and dynamic `import("spec")` calls with a
   * string-literal argument. Deliberately simple regex matching rather
   * than full lexing/parsing, but this covers real-world bundler output
   * surprisingly well: a dynamic `import(...)` call sitting inside a
   * function body that only runs conditionally at runtime (e.g. Vite's
   * compiled output for `import.meta.glob`, used for route-level code
   * splitting) still has its specifier as a literal string *in the
   * source text* — pre-fetching it here means QuickJS's (synchronous)
   * module loader already has it by the time that `import()` actually
   * executes, even though nothing "statically" imports it in the ESM
   * sense. Bundlers (Vite in particular) commonly emit these dynamic
   * `import()` specifiers as backtick template literals rather than
   * quoted strings even when there's no interpolation at all — e.g.
   * `import(\`./Search-CxC9sRAs.js\`)` for a `React.lazy()` route chunk —
   * so backtick-delimited specifiers are matched too. Only specifiers
   * built from computed values or *actual* template interpolation
   * (`import(\`./pages/${name}.js\`)`) can't be seen this way — a known,
   * documented limitation (see crawlModuleGraph below) — so any captured
   * specifier still containing `${` is discarded rather than resolved
   * into garbage.
   */
  function extractImportSpecifiers(code: string): string[] {
    const specifiers = new Set<string>();
    const fromRe = /\bfrom\s*['"`]([^'"`]+)['"`]/g;
    const bareImportRe = /\bimport\s*['"`]([^'"`]+)['"`]/g;
    const dynamicImportRe = /\bimport\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g;
    const consider = (spec: string) => {
      if (!spec.includes('${')) specifiers.add(spec);
    };
    let m: RegExpExecArray | null;
    while ((m = fromRe.exec(code))) consider(m[1]);
    while ((m = bareImportRe.exec(code))) consider(m[1]);
    while ((m = dynamicImportRe.exec(code))) consider(m[1]);
    return [...specifiers];
  }

  /**
   * Rewrites `import(expr)` call sites into `__kk_dynamic_import(expr,
   * moduleUrl)` so a specifier that's genuinely computed at runtime (or
   * one only ever invoked after loadPage() has already returned) can still
   * resolve — extractImportSpecifiers only ever catches what's visible as
   * literal text *before* evaluation, which is fundamentally impossible for
   * a name built at runtime. There's no way to intercept the `import()`
   * keyword itself (it's syntax, not a rebindable function) — Babel's
   * dynamic-import transform and SystemJS both solve this the same way, by
   * rewriting the call site before the code ever runs as a real `import()`.
   *
   * __kk_dynamic_import (see the DOM prelude) queues a request the host
   * services on demand via drainPendingModuleRequests: fetch the target,
   * register it (crawling its own statically-visible dependencies too),
   * then let a *real* import() run inside the sandbox now that the module
   * sits in the same pre-fetch table crawlModuleGraph populates — so
   * linking/evaluation is still QuickJS's own, not reimplemented here.
   *
   * A hand-rolled balanced-parenthesis scanner rather than a regex: the
   * argument expression can itself contain parens (`import(getPath())`) or
   * a template literal with `${...}` interpolation containing its own
   * parens, and naively matching up to the first `)` would truncate those.
   * Quoted/templated spans are skipped as opaque units (respecting `\`
   * escapes) — correct for this purpose since only the *outer* matching
   * paren of `import(` matters, not anything structurally inside a string.
   *
   * Cheap no-op fast path: skips entirely if `import(` doesn't appear at
   * all (true for the overwhelming majority of chunks), so this doesn't
   * add meaningful cost to registering the hundreds of modules a real
   * SPA's graph can contain.
   */
  function rewriteDynamicImports(code: string, moduleUrl?: string): string {
    if (!/\bimport\s*\(/.test(code)) return code;
    // No specific module context (a plain eval() call, not a <script>/
    // module being registered) — pass the literal `undefined` so
    // __kk_dynamic_import falls back to the page's current location.
    const marker = moduleUrl === undefined ? 'undefined' : JSON.stringify(moduleUrl);
    const importRe = /\bimport\s*\(/g;
    let out = '';
    let lastEnd = 0;
    let m: RegExpExecArray | null;
    while ((m = importRe.exec(code))) {
      // import.meta / import assertions ("import" followed by "." rather
      // than "(") never match this regex to begin with, so no guard needed
      // for those — only `import(` itself is matched.
      const openParenIdx = m.index + m[0].length - 1;
      let depth = 1;
      let j = openParenIdx + 1;
      let quote: string | null = null;
      while (j < code.length && depth > 0) {
        const c = code[j];
        if (quote) {
          if (c === '\\') { j += 2; continue; }
          if (c === quote) quote = null;
          j++;
          continue;
        }
        if (c === '"' || c === "'" || c === '`') { quote = c; j++; continue; }
        if (c === '(') depth++;
        else if (c === ')') depth--;
        j++;
      }
      const closeParenIdx = j - 1;
      if (depth !== 0) {
        // Unbalanced (shouldn't happen for valid JS) — leave the rest of
        // the source untouched rather than risk mangling it.
        break;
      }
      const arg = code.slice(openParenIdx + 1, closeParenIdx);
      out += code.slice(lastEnd, m.index) + '__kk_dynamic_import(' + arg + ', ' + marker + ')';
      lastEnd = closeParenIdx + 1;
      importRe.lastIndex = lastEnd;
    }
    out += code.slice(lastEnd);
    return out;
  }

  /** Writes two strings back-to-back starting at `baseOffset`, growing WASM
   * memory as needed (via writeStringAt) for each. Used wherever the C side
   * needs a (ptr, len) pair for two strings simultaneously present. */
  function writeTwoStringsAt(
    a: string,
    b: string,
    baseOffset: number,
  ): { aOffset: number; aLen: number; bOffset: number; bLen: number } {
    const aLen = writeStringAt(a, baseOffset);
    const bOffset = baseOffset + aLen;
    const bLen = writeStringAt(b, bOffset);
    return { aOffset: baseOffset, aLen, bOffset, bLen };
  }

  /** Registers pre-fetched source for a resolved module URL in the WASM
   * module table, so QuickJS's (synchronous) module loader can find it. */
  function registerModule(moduleUrl: string, code: string): void {
    if (!exports.kk_js_register_module) return;
    const rewritten = rewriteDynamicImports(code, moduleUrl);
    const { aLen: urlLen, bOffset: codeOffset, bLen: codeLen } = writeTwoStringsAt(
      moduleUrl,
      rewritten,
      EVAL_FETCH_OFFSET,
    );
    exports.kk_js_register_module(EVAL_FETCH_OFFSET, urlLen, codeOffset, codeLen);
    trace('module-register', { url: moduleUrl, codeLen: code.length, rewrittenImports: rewritten !== code });
  }

  /** Evaluates `code` as an ES module resolved as `moduleUrl` — the
   * module-aware counterpart to api.eval() used for `<script type="module">`. */
  async function evalModule(moduleUrl: string, code: string): Promise<{ success: boolean; result: string }> {
    ensureJsEngine();
    const { aLen: urlLen, bOffset: codeOffset, bLen: codeLen } = writeTwoStringsAt(
      moduleUrl,
      code,
      EVAL_FETCH_OFFSET,
    );
    const rc = exports.kk_js_eval_module!(EVAL_FETCH_OFFSET, urlLen, codeOffset, codeLen);
    drainJobsAndTimers();
    const mem = new Uint8Array(exports.memory.buffer);
    if (rc === 0) {
      const ptr = exports.kk_js_get_result!();
      const len = exports.kk_js_get_result_len!();
      return { success: true, result: decoder.decode(mem.slice(ptr, ptr + len)) };
    }
    const ptr = exports.kk_js_get_error!();
    const len = exports.kk_js_get_error_len!();
    return { success: false, result: decoder.decode(mem.slice(ptr, ptr + len)) };
  }

  /**
   * Crawls a module's import graph — fetching and registering every
   * dependency it (transitively) imports, static or literal-argument
   * dynamic `import(...)` — before evaluation. QuickJS's module loader
   * callback is synchronous: it can't itself suspend behind a Promise the
   * way fetch() does via drainPendingFetches, so the whole reachable graph
   * must be fetched and registered up front. Since dynamic import()
   * specifiers are extracted from source text regardless of which
   * function body they're sitting in (see extractImportSpecifiers), this
   * eagerly pre-fetches every module a page *might* dynamically load, not
   * only the ones actually invoked at runtime — deliberately trading
   * extra network requests for dynamic import() actually working, since
   * there's no way to know in advance which literal-specifier branches
   * real execution will take. `visited` is shared across every
   * `<script type="module">` on a page, so common dependencies (shared
   * chunks, vendor bundles) are only fetched once.
   *
   * Specifiers that fail to resolve (bare specifiers with no import map,
   * or ones this fetch pass couldn't reach) are left alone — evalModule()/
   * the loader will surface a clear ReferenceError (static) or a rejected
   * Promise (dynamic) for them rather than this throwing here.
   *
   * Fetches an entire BFS *level* concurrently via Promise.all rather than
   * one specifier at a time — a real SPA's reachable graph routinely runs
   * into the thousands of modules (confirmed by trace: this app's is
   * ~1000), and awaiting each fetch sequentially turned a network-latency-
   * bound operation a real browser completes in a couple of seconds (via
   * HTTP/2 multiplexing or just parallel connections) into tens of
   * seconds of pure wall-clock waiting before the page's own bootstrap
   * script had even finished running — self-inflicted by this loop's
   * structure, nothing to do with the target site. `visited` is marked
   * *before* each fetch kicks off (synchronously, before any await), so
   * concurrent fetches within a level can't double-queue the same
   * specifier — safe because JS is single-threaded between awaits.
   */
  async function crawlModuleGraph(
    entryUrl: string,
    entryCode: string,
    doFetch: (url: string) => Promise<{ status: number; body: string }>,
    visited: Set<string>,
    errors: { src?: string; message: string }[],
  ): Promise<void> {
    visited.add(entryUrl);
    trace('crawl-start', { entryUrl });
    let currentLevel: { url: string; code: string }[] = [{ url: entryUrl, code: entryCode }];
    let fetched = 0;
    let failed = 0;
    while (currentLevel.length > 0) {
      const toFetch: string[] = [];
      for (const { url: fromUrl, code } of currentLevel) {
        const specifiers = extractImportSpecifiers(code);
        if (specifiers.length) trace('crawl-specifiers', { fromUrl, specifiers });
        for (const spec of specifiers) {
          let resolved: string;
          try {
            resolved = new URL(spec, fromUrl).toString();
          } catch {
            trace('crawl-unresolvable-specifier', { fromUrl, spec });
            continue;
          }
          if (visited.has(resolved)) continue;
          visited.add(resolved);
          toFetch.push(resolved);
        }
      }
      if (toFetch.length === 0) break;
      const results = await Promise.all(
        toFetch.map(async (resolved): Promise<{ url: string; code: string } | null> => {
          try {
            const res = await doFetch(resolved);
            registerModule(resolved, res.body);
            fetched++;
            return { url: resolved, code: res.body };
          } catch (err) {
            failed++;
            const message = err instanceof Error ? err.message : String(err);
            errors.push({ src: resolved, message });
            trace('crawl-fetch-failed', { url: resolved, message });
            return null;
          }
        }),
      );
      currentLevel = results.filter((r): r is { url: string; code: string } => r !== null);
    }
    trace('crawl-done', { entryUrl, fetched, failed });
  }

  function readStringFromResult(getPtr: () => number, getLen: () => number, cacheKey: string): string {
    const ptr = getPtr();
    const len = getLen();
    return cachedRead(cacheKey, ptr, len);
  }

  function readUint32ArrayFromResult(count: number): number[] {
    if (count === 0) return [];
    const mem32 = new Uint32Array(exports.memory.buffer);
    const offset = resultBufPtr >>> 2;
    const result: number[] = [];
    for (let i = 0; i < count; i++) {
      result.push(mem32[offset + i]);
    }
    return result;
  }

  // ── Public API ────────────────────────────────────────────────

  const api: KenkageWasm = {
    version,

    async init(): Promise<void> {
      const ok = exports.kk_init();
      if (!ok) {
        throw new Error('Failed to initialize Kenkage WASM engine');
      }
    },

    destroy(): void {
      if (jsEngineReady) exports.kk_js_destroy?.();
      exports.kk_destroy();
      instanceCache.clear();
    },

    parse(html: string): boolean {
      const len = writeString(html);
      const ok = exports.kk_parse_html(WRITE_OFFSET, len) !== 0;
      // Re-parsing reuses the same shared result buffer address, so a
      // cached (ptr, len) pair can collide with unrelated new content
      // that happens to have the same length. Drop all cached reads.
      instanceCache.clear();
      return ok;
    },

    getTitle(): string {
      return readStringFromResult(
        () => exports.kk_get_title_ptr(),
        () => exports.kk_get_title_len(),
        'title',
      );
    },

    getText(): string {
      return readStringFromResult(
        () => exports.kk_get_text_ptr(),
        () => exports.kk_get_text_len(),
        'text',
      );
    },

    getHtml(): string {
      return readStringFromResult(
        () => exports.kk_get_html_ptr(),
        () => exports.kk_get_html_len(),
        'html',
      );
    },

    getMarkdown(): string {
      return readStringFromResult(
        () => exports.kk_get_markdown_ptr(),
        () => exports.kk_get_markdown_len(),
        'markdown',
      );
    },

    getNodeCount(): number {
      return exports.kk_get_node_count();
    },

    querySelector(selector: string): number[] {
      const len = writeString(selector);
      exports.kk_query_selector(WRITE_OFFSET, len);
      const count = exports.kk_query_selector_count();
      return readUint32ArrayFromResult(count);
    },

    nodeTag(id: number): string {
      return readStringFromResult(
        () => exports.kk_node_tag(id),
        () => exports.kk_node_tag_len(),
        `tag:${id}`,
      );
    },

    nodeText(id: number): string {
      return readStringFromResult(
        () => exports.kk_node_text(id),
        () => exports.kk_node_text_len(),
        `text:${id}`,
      );
    },

    nodeAttr(id: number, name: string): string {
      const len = writeString(name);
      return readStringFromResult(
        () => exports.kk_node_attr(id, WRITE_OFFSET, len),
        () => exports.kk_node_attr_len(),
        `attr:${id}:${name}`,
      );
    },

    nodeChildCount(id: number): number {
      return exports.kk_node_child_count(id);
    },

    nodeChildren(id: number): number[] {
      exports.kk_node_children(id);
      const count = exports.kk_query_selector_count();
      return readUint32ArrayFromResult(count);
    },

    async eval(code: string): Promise<{
      success: boolean;
      result: string;
      uncaughtErrors?: { type: string; message: string }[];
      consoleMessages?: { level: string; message: string }[];
    }> {
      // Only the 'full' engine has fetch()/dynamic-import queues to drain
      // at all. Rewriting here (with no specific moduleUrl — see
      // rewriteDynamicImports) is what makes a plain `engine.eval("...import(...)...")`
      // call able to resolve on demand too, not just code that arrived via
      // loadPage()'s own per-script loop.
      if (!exports.kk_js_eval) return await evalRaw(code);
      const result = await evalRaw(rewriteDynamicImports(code));
      const uncaughtErrors: { type: string; message: string }[] = [];
      const consoleMessages: { level: string; message: string }[] = [];
      await settleFetchesAndModules(activeDoFetch, activeModuleVisited, [], uncaughtErrors, consoleMessages);
      return { ...result, uncaughtErrors, consoleMessages };
    },

    async settle(): Promise<{
      uncaughtErrors: { type: string; message: string }[];
      consoleMessages: { level: string; message: string }[];
    }> {
      const uncaughtErrors: { type: string; message: string }[] = [];
      const consoleMessages: { level: string; message: string }[] = [];
      if (!exports.kk_js_eval) return { uncaughtErrors, consoleMessages };
      drainJobsAndTimers();
      uncaughtErrors.push(...(await drainUncaughtErrors()));
      consoleMessages.push(...(await drainConsoleMessages()));
      await settleFetchesAndModules(activeDoFetch, activeModuleVisited, [], uncaughtErrors, consoleMessages);
      return { uncaughtErrors, consoleMessages };
    },

    async fetch(
      url: string,
      options?: { method?: string; headers?: Record<string, string>; body?: string },
    ): Promise<{ status: number; body: string }> {
      // 1. Write URL and method to WASM memory
      const urlBytes = encoder.encode(url);
      const method = options?.method ?? 'GET';
      const methodBytes = encoder.encode(method);
      const methodOffset = EVAL_FETCH_OFFSET + urlBytes.length;
      const totalNeeded = methodOffset + methodBytes.length;
      const currentLen = exports.memory.buffer.byteLength;
      if (totalNeeded > currentLen) {
        const pagesNeeded = Math.ceil((totalNeeded - currentLen) / 65536);
        exports.memory.grow(pagesNeeded);
      }
      const mem = new Uint8Array(exports.memory.buffer);
      mem.set(urlBytes, EVAL_FETCH_OFFSET);
      mem.set(methodBytes, methodOffset);

      // 2. Signal WASM that a fetch request is pending
      const requestId = exports.kk_fetch_request(
        EVAL_FETCH_OFFSET,
        urlBytes.length,
        methodOffset,
        methodBytes.length,
      );

      // 3. Perform the actual fetch in the host
      const fetchFn = (typeof window !== 'undefined' && window.fetch)
        ? window.fetch
        : globalThis.fetch;

      const init: RequestInit = { method };
      if (options?.headers) {
        init.headers = options.headers;
      }
      if (options?.body) {
        init.body = options.body;
      }

      const response = await fetchFn(url, init);
      const status = response.status;
      const body = await response.text();

      // 4. Write body to WASM memory and deliver to WASM
      const bodyLen = writeStringAt(body, EVAL_FETCH_OFFSET);
      exports.kk_fetch_complete(status, EVAL_FETCH_OFFSET, bodyLen);

      return { status, body };
    },

    async loadPage(url: string, options?: LoadPageOptions): Promise<LoadPageResult> {
      if (!exports.kk_js_eval) {
        throw new Error("loadPage() requires the 'full' engine (real QuickJS) — use createKenkage({ engine: 'full' }).");
      }
      const doFetch = options?.fetchFn ?? ((u: string) => api.fetch(u));
      activeDoFetch = doFetch;
      tracing = !!options?.trace;
      traceEvents = [];
      traceStart = Date.now();
      trace('loadPage-start', { url });

      // A page load gets a genuinely fresh JS realm — no leftover globals,
      // timers, listeners, or (critically) QuickJS's own internal
      // loaded-module cache from a previous loadPage() call, which is
      // keyed by resolved specifier and would otherwise silently hand back
      // an already-evaluated module whenever two page loads happen to
      // resolve the same import URL. Matches a real browser tab getting a
      // fresh realm on every navigation. ensureJsEngine() first covers the
      // very-first-ever call (nothing to reset yet); kk_js_reset() then
      // unconditionally recreates the context.
      ensureJsEngine();
      exports.kk_js_reset?.();

      const { status, body } = await doFetch(url);
      trace('main-fetch', { url, status, bodyLen: body.length });
      api.parse(body);

      // Seed location/history from the real page URL — kk_js_reset() just
      // re-ran the DOM prelude, which can only set a neutral 'about:blank'
      // default since it has no access to loadPage()'s url argument. A lot
      // of real app code computes its own API base URL from
      // window.location (e.g. `fetch(location.origin + '/api/...')`), so
      // leaving this at the default would silently point those calls at
      // the wrong place even once they do execute.
      await evalRaw(`(function () {
        const u = new URL(${JSON.stringify(url)});
        Object.assign(globalThis.location, {
          href: u.href, protocol: u.protocol, host: u.host, hostname: u.hostname,
          port: u.port, pathname: u.pathname, search: u.search, hash: u.hash, origin: u.origin,
        });

        // 1. Polyfill TextEncoder and TextDecoder
        if (!globalThis.TextEncoder) {
          globalThis.TextEncoder = class TextEncoder {
            encode(str) {
              const arr = [];
              for (let i = 0; i < str.length; i++) {
                let charcode = str.charCodeAt(i);
                if (charcode < 0x80) arr.push(charcode);
                else if (charcode < 0x800) arr.push(0xc0 | (charcode >> 6), 0x80 | (charcode & 0x3f));
                else if (charcode < 0xd800 || charcode >= 0xe000) arr.push(0xe0 | (charcode >> 12), 0x80 | ((charcode >> 6) & 0x3f), 0x80 | (charcode & 0x3f));
                else {
                  i++; charcode = 0x10000 + (((charcode & 0x3ff)<<10) | (str.charCodeAt(i) & 0x3ff));
                  arr.push(0xf0 | (charcode >> 18), 0x80 | ((charcode >> 12) & 0x3f), 0x80 | ((charcode >> 6) & 0x3f), 0x80 | (charcode & 0x3f));
                }
              }
              return new Uint8Array(arr);
            }
          };
        }
        if (!globalThis.TextDecoder) {
          globalThis.TextDecoder = class TextDecoder {
            decode(bytes) {
              if (!bytes) return '';
              let result = ''; let i = 0;
              while (i < bytes.length) {
                let c = bytes[i++];
                if (c > 127) {
                  if (c > 191 && c < 224) c = (c & 31) << 6 | bytes[i++] & 63;
                  else if (c > 223 && c < 240) c = (c & 15) << 12 | (bytes[i++] & 63) << 6 | bytes[i++] & 63;
                  else if (c > 239 && c < 248) c = (c & 7) << 18 | (bytes[i++] & 63) << 12 | (bytes[i++] & 63) << 6 | bytes[i++] & 63;
                }
                if (c <= 0xffff) result += String.fromCharCode(c);
                else {
                  c -= 0x10000;
                  result += String.fromCharCode((c >> 10 | 0xd800), (c & 0x3FF | 0xdc00));
                }
              }
              return result;
            }
          };
        }
        
        // 2. Mock Fetch response stream
        globalThis.__kk_make_response = function (status, bodyText) {
          return {
            ok: status >= 200 && status < 300,
            status,
            statusText: '',
            headers: { get: () => null, forEach: () => {} },
            text: () => Promise.resolve(bodyText),
            json: () => Promise.resolve(JSON.parse(bodyText)),
            body: {
              getReader: function() {
                let done = false;
                return {
                  read: function() {
                    if (done) return Promise.resolve({ done: true });
                    done = true;
                    return Promise.resolve({ done: false, value: new globalThis.TextEncoder().encode(bodyText || '') });
                  }
                };
              }
            }
          };
        };
        
        // 3. Polyfill document.readyState and baseURI
        Object.defineProperty(document, 'readyState', { value: 'loading', writable: true });
        if (!('baseURI' in document)) {
          Object.defineProperty(document, 'baseURI', { get() { return globalThis.location.href; } });
        }
        
        // 4. Next.js expects document.currentScript to be a <script> node. 
        // We will mock __kk_wrap_node so that it returns a plain object if requested.
        // Actually, we can intercept the eval execution. Next.js explicitly checks Object.prototype.toString.call!
        // We can override the Array/Object iteration if needed.
        // To bypass the toString check completely, we can override document.currentScript directly before scripts!
      })();`);

      const scriptIds = api.querySelector('script');
      trace('scripts-found', { count: scriptIds.length });
      let scriptsExecuted = 0;
      const scriptsSkipped: { src?: string; reason: string }[] = [];
      const scriptErrors: { src?: string; message: string }[] = [];
      const uncaughtErrors: { type: string; message: string }[] = [];
      const consoleMessages: { level: string; message: string }[] = [];
      // Import-graph dedup set shared across every module script on the
      // page so common dependencies are only fetched once. See
      // crawlModuleGraph above. (The module source table itself was
      // already cleared by kk_js_reset() above.) Reassigning (not just
      // clearing) activeModuleVisited gives this page load a genuinely
      // fresh set — matches kk_js_reset() giving it a fresh module table —
      // while still leaving it as the SAME object eval()/settle() will
      // keep reusing for anything dynamically imported after this call
      // returns.
      activeModuleVisited = new Set<string>();
      const moduleVisited = activeModuleVisited;

      for (const id of scriptIds) {
        const type = api.nodeAttr(id, 'type').trim().toLowerCase();
        const src = api.nodeAttr(id, 'src') || undefined;
        const isModule = type === 'module';
        if (type && !isModule && type !== 'text/javascript' && type !== 'application/javascript' && type !== 'application/ecmascript') {
          // importmap, application/json data islands, etc. — not
          // executable as classic or module script.
          scriptsSkipped.push({ src, reason: `unsupported script type "${type}"` });
          continue;
        }

        let code: string;
        let moduleUrl: string | undefined;
        if (src) {
          let absoluteSrc: string;
          try {
            absoluteSrc = new URL(src, url).toString();
          } catch {
            scriptsSkipped.push({ src, reason: 'could not resolve script URL' });
            continue;
          }
          try {
            const res = await doFetch(absoluteSrc);
            code = res.body;
          } catch (err) {
            scriptErrors.push({ src: absoluteSrc, message: err instanceof Error ? err.message : String(err) });
            continue;
          }
          moduleUrl = absoluteSrc;
        } else {
          const children = api.nodeChildren(id);
          code = children.length > 0 ? api.nodeText(children[0]) : '';
          if (!code.trim()) continue;
          // Inline module scripts have no URL of their own — relative
          // imports inside them resolve against the page's own URL, same
          // as a real browser's document base URL. The fragment keeps
          // each inline module's resolved name unique for import.meta.url
          // and module-table keying.
          if (isModule) moduleUrl = `${url}#inline-module-${id}`;
        }

        // Real bundlers commonly read document.currentScript to resolve
        // their own chunk's URL — set it for the duration of this script,
        // matching what a real browser does during synchronous execution.
        trace('script-start', { id, isModule, src, moduleUrl, codeLen: code.length });
        await evalRaw(`
          if (globalThis.__kk_URL) globalThis.URL = globalThis.__kk_URL;
          document.currentScript = __kk_wrap_node(${id});
          if (globalThis.HTMLScriptElement) {
            // Next.js checks both the DOM string tag and instanceof
            // HTMLScriptElement. Keep the native node methods in the
            // prototype chain while giving this one parsed script the
            // browser's concrete element identity.
            try { Object.setPrototypeOf(document.currentScript, globalThis.HTMLScriptElement.prototype); } catch (e) {}
          }
          (function() {
            // QuickJS may continue framework work queued by an inline
            // bootstrap script after this synchronous turn has returned.
            // Give inline scripts a stable same-origin /_next/ URL so
            // Next.js' asset-prefix resolver does not receive the empty
            // browser src value while that deferred work is running.
            let scriptSrc = ${JSON.stringify(
              src
                ? new URL(src, url).toString()
                : new URL('/_next/static/chunks/inline.js', url).toString(),
            )};
            Object.assign(document.currentScript, {
              tagName: 'SCRIPT',
              nodeName: 'SCRIPT',
              src: scriptSrc,
              get [Symbol.toStringTag]() { return 'HTMLScriptElement'; }
            });
            // Some QuickJS class wrappers do not invoke an inherited
            // accessor when an expando is assigned. Define the value
            // explicitly so code that snapshots currentScript during a
            // chunk's top-level evaluation sees the absolute URL.
            try { Object.defineProperty(document.currentScript, 'src', { value: scriptSrc, writable: true, configurable: true }); } catch (e) {}
          })();
        `);
        let result: { success: boolean; result: string };
        if (isModule) {
          // Crawl the ORIGINAL code first — extractImportSpecifiers looks
          // for literal `import(...)`/`from "..."` text, which the rewrite
          // below removes for every dynamic import() call site (including
          // ones that were statically discoverable and just got crawled).
          await crawlModuleGraph(moduleUrl!, code, doFetch, moduleVisited, scriptErrors);
          result = await evalModule(moduleUrl!, rewriteDynamicImports(code, moduleUrl!));
        } else {
          // Classic scripts were never crawled at all (crawlModuleGraph is
          // ES-module-specific static analysis) — dynamic import() is valid
          // here too, and now resolves purely on demand via
          // drainPendingModuleRequests instead of needing any pre-crawl.
          result = await evalRaw(rewriteDynamicImports(code, url));
        }
        await evalRaw('document.currentScript = null;');
        trace('script-done', { id, success: result.success, resultOrError: result.success ? undefined : result.result });
        if (!result.success) {
          scriptErrors.push({ src, message: result.result });
        }
        scriptsExecuted++;
        uncaughtErrors.push(...(await drainUncaughtErrors()));
        consoleMessages.push(...(await drainConsoleMessages()));
        // A script's own top-level fetch() calls (or ones queued by its
        // synchronous execution) get their real network round-trip here,
        // and any dynamic import() it made that couldn't be pre-crawled (a
        // computed specifier, or one crawlModuleGraph simply hasn't reached
        // yet) settles the same way — looped together to a joint fixed
        // point since either can trigger the other (see
        // settleFetchesAndModules).
        await settleFetchesAndModules(doFetch, moduleVisited, scriptErrors, uncaughtErrors, consoleMessages);
      }

      // Real pages hang a lot of setup off these — run any handlers scripts
      // registered for them so state that depends on "page is ready" settles.
      // `load` is dispatched on both: DOMContentLoaded is document-only per
      // spec, but `load` listeners are overwhelmingly registered on `window`
      // in the wild (analytics/tag-manager snippets in particular), so both
      // targets get it rather than assuming which one a given script used.
      trace('dispatch-domcontentloaded-load');
      await evalRaw(
        "document.readyState = 'complete'; document.dispatchEvent(new Event('DOMContentLoaded')); document.dispatchEvent(new Event('load')); window.dispatchEvent(new Event('load'));"
      );
      uncaughtErrors.push(...(await drainUncaughtErrors()));
      consoleMessages.push(...(await drainConsoleMessages()));
      await settleFetchesAndModules(doFetch, moduleVisited, scriptErrors, uncaughtErrors, consoleMessages);

      const finalNodeCount = api.getNodeCount();
      trace('loadPage-done', { scriptsExecuted, nodeCount: finalNodeCount, textLen: api.getText().length });

      return {
        status,
        title: api.getTitle(),
        html: api.getHtml(),
        text: api.getText(),
        scriptsExecuted,
        scriptsSkipped,
        scriptErrors,
        uncaughtErrors,
        consoleMessages,
        trace: traceEvents,
      };
    },
  };

  return api;
}
