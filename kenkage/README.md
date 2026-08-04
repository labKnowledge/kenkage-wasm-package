# kenkage

A sandboxed browser engine — real DOM parsing and a real JavaScript engine
(QuickJS) — compiled to WebAssembly. It runs entirely on-device: in the
browser tab, in a Node process, or inside an AI agent's own sandbox. No
headless Chrome, no server round-trip, no host JS `eval()` required.

```ts
import { createKenkage } from 'kenkage';

const engine = await createKenkage({ engine: 'full' });
await engine.init();

const page = await engine.loadPage('https://example.com');
console.log(page.title, page.text);
```

## Why

Letting an AI agent "browse the web" today usually means driving a full
headless browser (Chromium via Puppeteer/Playwright) or shipping raw HTML to
an LLM and hoping it's structured enough to reason about. Both are heavy,
server-bound, and give an agent's untrusted, model-generated JavaScript a
real browser's full attack surface to run in.

kenkage is a different shape: a real DOM tree and a real JS engine, compiled
to WASM, so they run **on-device** — in a browser tab, an Electron/CLI
agent process, or a Node worker. There is no browser binary to install, no
server to proxy through, and untrusted code executes inside a memory-isolated
WASM sandbox instead of the host's JS runtime.

## Features

- **Real DOM** — HTML parsing, CSS selector queries, node traversal, text and
  Markdown extraction.
- **Real JavaScript** — an in-WASM QuickJS engine (`engine: 'full'`) runs
  arbitrary JS against `document`/`Element` bindings, fully isolated from the
  host's own JS realm.
- **`loadPage()`** — fetches a URL, parses it, and runs every classic
  `<script>` on the page in document order (external and inline), draining
  promise microtasks and timers the way a real page load would.
- **No Chromium.** The entire engine — parser, DOM, CSS, JS — is ~4MB of
  WASM. No spawned browser process, no server-side rendering farm.
- **Two builds** — `core` (~650KB, HTML/DOM/CSS only) and `full` (adds
  QuickJS) — so callers that only need parsing don't pay for a JS engine.
- **Runs anywhere** — browser, Node, or Next.js (client, server component,
  or API route), via one package with three entry points.

## Install

```sh
npm install kenkage
```

## Quick start

### Vanilla JS / TS

```ts
import { createKenkage } from 'kenkage';

const engine = await createKenkage(); // engine: 'core' by default
await engine.init();

engine.parse('<h1>Hello</h1><p>World</p>');
engine.getTitle();          // ''
engine.getText();           // 'Hello World'
engine.getMarkdown();       // '# Hello\n\nWorld'
engine.querySelector('p');  // [nodeId]

engine.destroy();
```

### Running real JavaScript (`full` engine)

```ts
const engine = await createKenkage({ engine: 'full' });
await engine.init();

const { success, result } = await engine.eval('1 + 2');
// success: true, result: '3'
```

### Loading a live page like a browser tab

```ts
const engine = await createKenkage({ engine: 'full' });
await engine.init();

const page = await engine.loadPage('https://example.com');
page.title;             // parsed <title>
page.scriptsExecuted;   // number of <script> tags that ran
page.scriptErrors;      // any that threw
```

### React

```tsx
import { useKenkage } from 'kenkage/react';

function Page({ html }: { html: string }) {
  const { title, text, loading } = useKenkage(html);
  if (loading) return <p>Loading engine…</p>;
  return <div>{title}: {text}</div>;
}
```

A `KenkageProvider` / `useKenkageContext()` pair is also available for
sharing one engine instance across a component tree.

### Next.js (Server Components / API routes)

```ts
import { createKenkagePage } from 'kenkage/next';

export default async function Page() {
  const html = await fetch('https://example.com').then(r => r.text());
  const engine = await createKenkagePage(html);
  return <div>{engine.getTitle()}</div>;
}
```

`createKenkagePage` loads the WASM module once via `fs.readFileSync` and
reuses the instance across requests.

## `core` vs `full`

| | `core` | `full` |
|---|---|---|
| Size | ~650KB | ~4MB |
| HTML parsing, DOM, CSS selectors | ✅ | ✅ |
| `eval()` | delegates to the host's JS (`eval`/`Function`) | runs in an isolated in-WASM QuickJS engine |
| `loadPage()` (execute page `<script>`s) | ❌ | ✅ |

Pick `core` when you only need to parse and query HTML. Pick `full` when an
agent needs to execute page (or model-generated) JavaScript without handing
it your host's `eval()`.

## API

The full typed surface is in [`src/index.ts`](src/index.ts); the shape:

- `createKenkage(options?)` — instantiate the WASM engine.
- `engine.init()` / `engine.destroy()`
- `engine.parse(html)` → `boolean`
- `engine.getTitle() / getText() / getHtml() / getMarkdown() / getNodeCount()`
- `engine.querySelector(selector)` → node IDs
- `engine.nodeTag(id) / nodeText(id) / nodeAttr(id, name) / nodeChildCount(id) / nodeChildren(id)`
- `engine.eval(code)` → `{ success, result }`
- `engine.fetch(url, options?)` → `{ status, body }`
- `engine.loadPage(url, options?)` → parsed page + script execution report

## Architecture

- **Zig → WASM.** The engine (HTML tokenizer, DOM tree, CSS selector matcher,
  Markdown serializer) is written in Zig and compiled to
  `wasm32-freestanding` (`core`) or `wasm32-wasi` (`full`, since QuickJS
  needs libc). See [`src/zig/`](src/zig).
- **QuickJS in WASM.** The `full` build vendors and compiles
  [QuickJS](https://bellard.org/quickjs/) (MIT) as WASM alongside the Zig
  DOM engine, wired to `document`/`Element` bindings — see
  [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
  Network access stays in the host: the WASM module raises a fetch request,
  the JS wrapper performs the real `fetch()`, and the response is delivered
  back into the sandbox.
- **Host bridge.** [`src/index.ts`](src/index.ts) instantiates the module,
  manages the shared linear-memory buffers used to pass strings across the
  WASM boundary, and exposes a typed async API over it.

## Building from source

Prebuilt WASM binaries ship in `src/dist/` and in the published npm package,
so `npm install` alone is enough to use kenkage. To rebuild the engine
itself you'll need [Zig 0.16+](https://ziglang.org/download/) on your `PATH`
(or set `ZIG=/path/to/zig`):

```sh
npm install
npm run build          # bundles src/ + copies src/dist/*.wasm → dist/
scripts/build-core.sh  # rebuild the 'core' WASM from Zig
scripts/build-full.sh  # rebuild the 'full' WASM (Zig + vendored QuickJS)
```

## Testing

```sh
npm test
```

Vitest exercises the compiled `core` WASM directly (parsing, selectors,
attributes, edge cases) — see [`src/__tests__/`](src/__tests__).

## Interactive demo

[`examples/browser-demo.html`](examples/browser-demo.html) is a static page
exercising both engine builds (HTML parsing, JS eval, fetch) in a browser.
Build first (`npm run build`), then serve `kenkage/` with any static file
server and open `examples/browser-demo.html`.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md).

## License

MIT — see [`LICENSE`](LICENSE). Vendors QuickJS (MIT); see
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
