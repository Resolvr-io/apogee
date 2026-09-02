# Apogee TX Manifest runtime

This internal Rust/WASM package is Apogee's deterministic Simplicity boundary. It
has no filesystem, network, wallet, registry, prompt, or seed-storage dependency.
Every source, argument, transaction, and prior transaction is supplied in memory by
the host.

The first vertical slice exports:

- SimplicityHL compilation and covenant commitment derivation;
- offline Elements-environment dry-run against caller-supplied transaction bytes;
- ordered multi-asset PSET construction with confidential-change blinding and
  an optional explicit fee-output index (append-last by default);
- covenant PSET finalization after execution against the exact extracted tx; and
- caller-supplied transaction-output and confidential-address inspection for the
  host's fresh-chain and wallet-destination adapters; and
- small compiler/evaluator self-tests.

The native golden-vector tests reproduce and execute both Simplicity inputs of
confirmed Liquid testnet lending-v3 `AcceptOffer` transaction
`e69e0e401919dcd8a4721f3d33cd044375080d9578905a456d097c73f6d39231`.
They assert the deployed lending CMR and pending/active scriptPubKeys exactly, then
recreate both four-item covenant witness stacks byte-for-byte.

Pinned inputs:

- SimplicityHL `9e77379d343e76eb92cb57c2668af9f8e0c4f46b`
- `elements` 0.25.3
- simplicity-lending `8f8ace33963788a0ed901c160a1187f8489e2c55`
- `wasm-bindgen` 0.2.121 (matching the generated browser loader)
- Rust 1.92.0 via the repository's `rust-toolchain.toml`

Run native tests:

```sh
cargo test --manifest-path crates/tx-manifest-runtime/Cargo.toml --locked
```

Regenerate the checked-in browser artifact:

```sh
npm run build:tx-manifest-runtime
```

The generated WASM is lazy-loaded by Apogee's engine. Wallet coin selection,
signing, approval binding, fresh network access, idempotency, and broadcasting stay
in the host; blinding and Simplicity execution remain inside this runtime boundary.
The build remaps checkout, Cargo, and Rust source roots to canonical paths before
compilation so developer usernames and machine-specific paths do not enter the
shipped binary. The pinned Linux CI job is the canonical artifact producer and
rebuilds and byte-compares the checked-in browser runtime against the committed Rust
source. A local macOS build is valid for development, but Rust's host-specific
toolchain components do not currently guarantee the same bytes as the Linux build.
