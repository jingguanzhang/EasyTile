#!/usr/bin/env bash
# 构建 acadrust-wasm 并输出到 assets/vendor/acadrust-wasm（覆盖现有产物）
# 可用 CARGO_TARGET_DIR 指定编译目录（默认 ./target）
set -euo pipefail
cd "$(dirname "$0")"
OUT=../../assets/vendor/acadrust-wasm
TARGET_DIR=${CARGO_TARGET_DIR:-target}
cargo build --release --target wasm32-unknown-unknown --lib
wasm-bindgen --target web --out-dir "$OUT" --out-name acadrust_wasm \
  "$TARGET_DIR/wasm32-unknown-unknown/release/acadrust_wasm.wasm"
echo "已输出到 $OUT"
