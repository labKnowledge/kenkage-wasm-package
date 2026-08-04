# Third-Party Notices

kenkage's "full" engine build vendors the QuickJS JavaScript engine as C source
(`wasm-deps/quickjs-2024-01-13/`), compiled to WebAssembly alongside kenkage's
own Zig code. It is not a runtime dependency of the "core" build.

## QuickJS

- Source: https://bellard.org/quickjs/
- Version: 2024-01-13
- License: MIT (see `wasm-deps/quickjs-2024-01-13/LICENSE`)
- Copyright (c) 2017-2024 Fabrice Bellard and Charlie Gordon
