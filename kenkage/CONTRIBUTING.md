# Contributing to kenkage

## Setup

```sh
npm install
```

Requires Node 18+. Prebuilt WASM binaries are checked into `src/dist/`, so
this alone is enough to build the JS/TS package and run the test suite.

## Working on the TypeScript layer (`src/index.ts`, `src/react.tsx`, `src/next.ts`)

```sh
npm run build   # esbuild → dist/ (ESM + CJS + .d.ts)
npm test        # vitest, against the checked-in core WASM
```

## Working on the Zig/WASM engine (`src/zig/`)

You'll need [Zig 0.16+](https://ziglang.org/download/) on your `PATH` (or
set `ZIG=/path/to/zig` when invoking the scripts below).

```sh
scripts/build-core.sh   # rebuilds src/dist/kenkage-core.wasm (HTML/DOM/CSS only)
scripts/build-full.sh   # rebuilds src/dist/kenkage-full.wasm (+ vendored QuickJS)
npm run build           # re-bundle the JS layer with the new WASM
npm test
```

`core.zig` is the HTML parser, DOM tree, and CSS selector engine.
`full.zig` + `qjs_engine.c` add the QuickJS bridge (`document`/`Element`
bindings, fetch/eval plumbing). `wasm-deps/quickjs-2024-01-13/` is vendored
QuickJS source — see [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md); it
isn't kenkage's own code and shouldn't be hand-edited.

## Adding a WASM export

New Zig functions exposed to JS need three things kept in sync:

1. `--export=your_fn` in `scripts/build-core.sh` (core build only — `full`
   picks up every `pub export fn` in `full.zig` automatically via
   `build.zig`).
2. The function signature added to the `WasmExports` interface in
   `src/index.ts`.
3. A method on the public `KenkageWasm` API in the same file, following the
   existing read/write-into-linear-memory patterns (`writeString`,
   `readStringFromResult`, etc.).

## Pull requests

- Run `npm test` before opening a PR.
- Keep `core` and `full` behavior in sync where it makes sense (e.g. a new
  DOM query method should work on both), but it's fine for `full`-only
  features (like `loadPage()`) to throw a clear error on `core`.
- Describe *why* a change is needed in the PR body, not just what changed.
