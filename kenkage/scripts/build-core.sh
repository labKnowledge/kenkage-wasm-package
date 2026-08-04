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
SRC="$PROJECT_DIR/src/zig"
DIST="$PROJECT_DIR/src/dist"

mkdir -p "$DIST"
rm -f "$SRC/core.wasm"
cd "$SRC"

"$ZIG" build-exe -target wasm32-freestanding -fno-entry \
  --export=kk_init \
  --export=kk_destroy \
  --export=kk_parse_html \
  --export=kk_get_title_ptr \
  --export=kk_get_title_len \
  --export=kk_get_text_ptr \
  --export=kk_get_text_len \
  --export=kk_get_html_ptr \
  --export=kk_get_html_len \
  --export=kk_get_markdown_ptr \
  --export=kk_get_markdown_len \
  --export=kk_get_node_count \
  --export=kk_query_selector \
  --export=kk_query_selector_count \
  --export=kk_node_tag \
  --export=kk_node_tag_len \
  --export=kk_node_text \
  --export=kk_node_text_len \
  --export=kk_node_attr \
  --export=kk_node_attr_len \
  --export=kk_node_child_count \
  --export=kk_node_children \
  --export=kk_version \
  --export=kk_version_len \
  --export=kk_log \
  --export=kk_fetch_request \
  --export=kk_fetch_complete \
  --export=kk_get_fetch_status \
  --export=kk_get_fetch_body_ptr \
  --export=kk_get_fetch_body_len \
  --export=kk_eval_js_request \
  --export=kk_eval_js_complete \
  --export=kk_get_eval_success \
  src/core.zig

cp "$SRC/core.wasm" "$DIST/kenkage-core.wasm"
ls -lh "$DIST/kenkage-core.wasm"
