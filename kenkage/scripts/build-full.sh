#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"     # kenkage/

ZIG="${ZIG:-$(command -v zig || true)}"
if [ -z "$ZIG" ]; then
  echo "error: zig not found. Install Zig 0.16.0+ (https://ziglang.org/download/) and" >&2
  echo "       ensure it's on PATH, or set ZIG=/path/to/zig" >&2
  exit 1
fi
ZIG_DIR="$PROJECT_DIR/src/zig"
DIST="$PROJECT_DIR/src/dist"

mkdir -p "$DIST"
cd "$ZIG_DIR"

echo "=== Building full engine (Zig + QuickJS) via build.zig ==="
"$ZIG" build -Doptimize=ReleaseSmall

cp "$ZIG_DIR/zig-out/bin/kenkage-full.wasm" "$DIST/kenkage-full.wasm"
ls -lh "$DIST/kenkage-full.wasm"
echo "=== DONE ==="
