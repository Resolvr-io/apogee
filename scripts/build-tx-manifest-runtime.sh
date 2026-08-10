#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
runtime_root="$repo_root/crates/tx-manifest-runtime"
wasm_path="$runtime_root/target/wasm32-unknown-unknown/release/apogee_tx_manifest_runtime.wasm"
out_dir="$repo_root/src/tx-manifest/runtime/pkg"

cd "$runtime_root"
nix shell "$repo_root#tx-manifest-clang" --command \
  env CC_wasm32_unknown_unknown=clang \
  cargo build --release --target wasm32-unknown-unknown --locked

cd "$repo_root"
nix shell "$repo_root#tx-manifest-wasm-bindgen" --command \
  wasm-bindgen "$wasm_path" \
  --target web \
  --out-dir "$out_dir" \
  --out-name apogee_tx_manifest_runtime
