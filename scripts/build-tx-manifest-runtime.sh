#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
runtime_root="$repo_root/crates/tx-manifest-runtime"
wasm_path="$runtime_root/target/wasm32-unknown-unknown/release/apogee_tx_manifest_runtime.wasm"
out_dir="$repo_root/src/tx-manifest/runtime/pkg"
cargo_home="${CARGO_HOME:-$HOME/.cargo}"
rust_sysroot="$(rustc --print sysroot)"

# Rust embeds source paths in panic/debug location data even in release WASM.
# Canonicalize every machine-specific root so generated artifacts neither leak a
# builder's username nor drift because of checkout, Cargo, or Rust installation
# paths. CI's pinned Linux job is the canonical producer for checked-in bytes.
path_remaps="--remap-path-prefix=$repo_root=/workspace"
path_remaps="$path_remaps --remap-path-prefix=$cargo_home=/cargo"
path_remaps="$path_remaps --remap-path-prefix=$rust_sysroot=/rust"
rustflags="${RUSTFLAGS:+$RUSTFLAGS }$path_remaps"

cd "$runtime_root"
nix shell \
  "$repo_root#tx-manifest-clang" \
  "$repo_root#tx-manifest-llvm-tools" \
  --command \
  env CC_wasm32_unknown_unknown=clang \
  AR_wasm32_unknown_unknown=llvm-ar \
  RANLIB_wasm32_unknown_unknown=llvm-ranlib \
  RUSTFLAGS="$rustflags" \
  cargo build --release --target wasm32-unknown-unknown --locked

cd "$repo_root"
nix shell "$repo_root#tx-manifest-wasm-bindgen" --command \
  wasm-bindgen "$wasm_path" \
  --target web \
  --out-dir "$out_dir" \
  --out-name apogee_tx_manifest_runtime
