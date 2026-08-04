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
  /** Evaluate JavaScript code using the host's JS engine. */
  eval(code: string): Promise<{ success: boolean; result: string }>;
  /** Fetch a URL using the host's fetch API. Returns the response. */
  fetch(url: string, options?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<{ status: number; body: string }>;
  /**
   * Loads a page like a browser tab would: fetches `url`, parses it, then
   * runs every classic (non-module) `<script>` found — external ones are
   * fetched and executed in document order, inline ones run directly —
   * against the real DOM via the 'full' engine's document/Element
   * bindings. Draining Promise microtasks and the setTimeout queue happens
   * automatically after each script. Requires `engine: 'full'`.
   *
   * Only available with `engine: 'full'` — the 'core' build has no JS
   * engine to run scripts on, so this throws if called on it.
   *
   * `<script type="module">` is not executed (no ES module loader yet) and
   * is reported in `scriptsSkipped` instead of silently vanishing.
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
}

export interface LoadPageResult {
  /** HTTP status of the main page fetch. */
  status: number;
  title: string;
  html: string;
  text: string;
  /** How many `<script>` elements actually ran. */
  scriptsExecuted: number;
  /** Scripts not run — e.g. `type="module"`, unresolvable `src`. */
  scriptsSkipped: { src?: string; reason: string }[];
  /** Scripts that ran but threw, or failed to fetch. */
  scriptErrors: { src?: string; message: string }[];
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
  kk_js_eval?: (code_ptr: number, code_len: number) => number;
  kk_js_get_result?: () => number;
  kk_js_get_result_len?: () => number;
  kk_js_get_error?: () => number;
  kk_js_get_error_len?: () => number;
  kk_js_last_type?: () => number;
  kk_js_run_pending_jobs?: () => number;
  kk_js_resolve_fetch?: (id: number, status: number, bodyPtr: number, bodyLen: number) => number;
  kk_js_reject_fetch?: (id: number, msgPtr: number, msgLen: number) => number;
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
   * Settles any pending sandboxed fetch(url) calls with real, host-fetched
   * responses. Scripts running via loadPage() can call fetch() like any
   * real page would — this is what actually performs the network request
   * on their behalf and wakes their Promise chain back up. Loops (bounded)
   * since resolving one fetch's .then() can itself queue another.
   */
  async function drainPendingFetches(
    doFetch: (url: string) => Promise<{ status: number; body: string }>,
  ): Promise<void> {
    for (let guard = 0; guard < 100; guard++) {
      const peek = await api.eval('JSON.stringify(__kk_next_fetch_request())');
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
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const msgLen = writeStringAt(message, EVAL_FETCH_OFFSET);
        exports.kk_js_reject_fetch?.(req.id, EVAL_FETCH_OFFSET, msgLen);
      }
      exports.kk_js_run_pending_jobs?.();
    }
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

    async eval(code: string): Promise<{ success: boolean; result: string }> {
      // 'full' engine build: run the code inside the in-WASM QuickJS
      // engine — fully sandboxed, no host JS execution involved.
      if (exports.kk_js_eval) {
        ensureJsEngine();
        const codeLen = writeStringAt(code, EVAL_FETCH_OFFSET);
        const rc = exports.kk_js_eval(EVAL_FETCH_OFFSET, codeLen);
        // Drain Promise microtasks and the setTimeout queue — real JS hosts
        // do this after every turn of script execution, not on request.
        exports.kk_js_run_pending_jobs?.();
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

      const { status, body } = await doFetch(url);
      api.parse(body);

      const scriptIds = api.querySelector('script');
      let scriptsExecuted = 0;
      const scriptsSkipped: { src?: string; reason: string }[] = [];
      const scriptErrors: { src?: string; message: string }[] = [];

      for (const id of scriptIds) {
        const type = api.nodeAttr(id, 'type').trim().toLowerCase();
        const src = api.nodeAttr(id, 'src') || undefined;
        if (type && type !== 'text/javascript' && type !== 'application/javascript' && type !== 'application/ecmascript') {
          // module, importmap, application/json data islands, etc. —
          // not executable as classic script (no ES module loader yet).
          scriptsSkipped.push({ src, reason: `unsupported script type "${type}"` });
          continue;
        }

        let code: string;
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
        } else {
          const children = api.nodeChildren(id);
          code = children.length > 0 ? api.nodeText(children[0]) : '';
          if (!code.trim()) continue;
        }

        // Real bundlers commonly read document.currentScript to resolve
        // their own chunk's URL — set it for the duration of this script,
        // matching what a real browser does during synchronous execution.
        await api.eval(`document.currentScript = __kk_wrap_node(${id});`);
        const result = await api.eval(code);
        await api.eval('document.currentScript = null;');
        if (!result.success) {
          scriptErrors.push({ src, message: result.result });
        }
        scriptsExecuted++;
        // A script's own top-level fetch() calls (or ones queued by its
        // synchronous execution) get their real network round-trip here.
        await drainPendingFetches(doFetch);
      }

      // Real pages hang a lot of setup off these — run any handlers scripts
      // registered for them so state that depends on "page is ready" settles.
      // `load` is dispatched on both: DOMContentLoaded is document-only per
      // spec, but `load` listeners are overwhelmingly registered on `window`
      // in the wild (analytics/tag-manager snippets in particular), so both
      // targets get it rather than assuming which one a given script used.
      await api.eval(
        "document.dispatchEvent('DOMContentLoaded'); document.dispatchEvent('load'); window.dispatchEvent('load');"
      );
      await drainPendingFetches(doFetch);

      return {
        status,
        title: api.getTitle(),
        html: api.getHtml(),
        text: api.getText(),
        scriptsExecuted,
        scriptsSkipped,
        scriptErrors,
      };
    },
  };

  return api;
}


