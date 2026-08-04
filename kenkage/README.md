# kenkage

**We believe an agent's isolation shouldn't depend on how carefully you
babysit it — it should be a property of where its code physically runs.**

Right now, giving an AI agent the ability to read and act on a web page
means picking one of two trades: hand it a full browser process (Chromium
via Playwright/Puppeteer, or a cloud browser behind an API) and accept the
weight, the server, and the latency — or hand it a lightweight in-process DOM
shim (jsdom, happy-dom) and accept that it was never built to contain code
it didn't write. That second option isn't a small gap: happy-dom's own
maintainers have documented that untrusted JavaScript can escape its
sandbox via prototype pollution, even with `eval`/`Function` disabled. A DOM
implementation that merely *behaves* like a browser doesn't get a browser's
isolation for free.

kenkage closes that gap instead of picking a side of it. It compiles a real
DOM engine and a real JavaScript engine (QuickJS) to WebAssembly, so the
isolation comes from WASM's linear memory model — not from a spawned
process, not from a shim's best-effort discipline. That means it runs
**on-device**: inside a browser tab, inside an agent's own Node/Electron
process, at the edge — anywhere V8 or a WASM runtime already lives, with
no browser binary to install and no server in the loop.

```ts
import { createKenkage } from 'kenkage';

const engine = await createKenkage({ engine: 'full' });
await engine.init();

const page = await engine.loadPage('https://example.com');
console.log(page.title, page.text);
```

## Why

Most of the field has converged on the same two answers to "how does an
agent touch the web": scale up Chromium (Playwright, Puppeteer, managed
cloud browsers), or scale down the DOM (jsdom, happy-dom, linkedom). The
first treats isolation as something you buy with infrastructure — more
containers, more browser instances, more orchestration. The second treats
it as optional, because a DOM shim's job was always "pass the tests," not
"contain a hostile script."

We think that's backwards for agentic use. An agent parsing a page and
running the JavaScript it finds there — or JavaScript an LLM generated on
the fly — is running code from a source it doesn't control. That code
deserves a hard boundary by construction, not a process boundary you have
to provision, or a shim's goodwill. Compiling the engine itself to WASM is
how kenkage gets there: the boundary is the compilation target, so it holds
wherever the module runs.

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
