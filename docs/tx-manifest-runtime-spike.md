# TX Manifest runtime feasibility spike

Status: completed feasibility spike, 2026-08-07. This is not a production
implementation and must not be enabled for mainnet funds.

## Question

Can Apogee host a deterministic TX Manifest runtime that compiles SimplicityHL,
constructs Elements PSETs, and dry-runs Simplicity without moving wallet secrets or
chain access into dapp code?

## Pinned inputs

| Input | Revision |
| --- | --- |
| ElementsProject/ELIPs PR 41 | `bb1e78990a60396837340b54bb6ccd1c497cb576` |
| `stringhandler/tx_manifest_spec` | `1a8d0b759853a00fef5f74351b64a602e2ba7a6f` |
| `stringhandler/txmanifest-wallet` | `1cbb5101833f35156f3581a9666a4b12236cd5d2` |
| BlockstreamResearch/SimplicityHL | `9e77379d343e76eb92cb57c2668af9f8e0c4f46b` |
| BlockstreamResearch/simplicity-lending | `8f8ace33963788a0ed901c160a1187f8489e2c55` |

## Experiments and results

### Reference runtime

The reference `tx-manifest-lib` passes a native `cargo check`. It already contains
valuable manifest models, validation, canonicalization, preview, lifecycle,
Simplicity compilation/finalization, and low-level PSET construction.

It does **not** compile directly to `wasm32-unknown-unknown`. The library currently
combines reusable logic with:

- filesystem-backed manifests, `.simf` sources, wallets, instances, and state;
- interactive `dialoguer` / terminal rendering;
- blocking Esplora and Electrum clients;
- `ureq`, `reqwest`, `rustls`, and platform data-directory dependencies; and
- wallet signing and broadcasting.

Even `lwk_wollet` 0.9.0 with default features disabled compiles an async Esplora
module that references optional HTTP dependencies. A browser runtime should not
depend on that crate directly.

### Isolated Apogee probe and promoted runtime

[`crates/tx-manifest-runtime`](../crates/tx-manifest-runtime) isolates the browser
boundary and pins the same SimplicityHL revision. It proves:

1. In-memory SimplicityHL source compiles with Elements jets and produces a CMR.
2. A compiled program can be satisfied and executed by the Simplicity Bit Machine.
3. Low-level Elements PSET v2 inputs and outputs can be constructed and serialized
   without the reference CLI or network stack.
4. A covenant can be dry-run with an Elements environment assembled entirely from
   caller-supplied final and parent transaction bytes.
5. Both Simplicity inputs in confirmed lending-v3 `AcceptOffer` transaction
   `e69e0e40…9231` execute offline, while the compiled CMR and pending/active
   scriptPubKeys reproduce the deployed commitments byte-for-byte.
6. The runtime recreates both confirmed four-item covenant witness stacks
   byte-for-byte and has balanced ordered multi-asset PSET plus confidential-change
   construction primitives.
7. The crate passes native tests, compiles and links as `wasm32-unknown-unknown`,
   is post-processed by `wasm-bindgen`, lazy-loads from `engine-core`, and ships in
   the Chrome/Vite extension build.

The current post-processed WASM is approximately 6.6 MiB uncompressed (4.0 MiB
gzip) before `wasm-opt`. Size is acceptable for a first slice but remains an
explicit production budget.

Apple Clang cannot compile the `secp256k1-sys` C shim for WebAssembly. The successful
macOS build used an upstream LLVM Clang with a WebAssembly target. CI must provide
that toolchain.

## Decision

The runtime is feasible, with this boundary:

```text
Apogee service worker
  authorization, trusted registry, approval lifecycle, idempotency
                  |
Apogee offscreen engine / Firefox background host
  existing lwk_wasm wallet + chain adapter
  new TX Manifest Rust/WASM core
                  |
  serialized manifest invocation, snapshots, PSETs, and verified reviews
```

The production Rust/WASM core should use `simplicityhl` plus the `elements` wire
types. It should have no filesystem, network, prompt, registry, or seed-storage
code. Apogee's existing engine remains responsible for wallet synchronization,
unblinding material, configured Esplora access, and invoking local or Jade signing.

The reference implementation should be mined for models, algorithms, and test
vectors, but not vendored wholesale. Useful logic should be extracted behind
in-memory and host-supplied adapters, ideally upstream where practical.

## What remains after the wallet-facing slice

- A live newly constructed testnet acceptance using a funded software wallet; the
  automated suite currently uses offline confirmed-chain vectors and host mocks.
- Issuance/reissuance parity with the deployed contract.
- BIP340 wallet-witness derivation and Jade support.
- Network-aware minimum-change/dust calibration for fee-dependent change outputs.
- Crash-safe signed-transaction broadcast checkpointing to close the narrow gap
  between network acceptance and durable terminal-result storage.
- Manual Chrome/Firefox provider smoke tests and a final optimized bundle-size budget.

These are implementation milestones, not reasons to add more public RPCs.

## Implemented wallet-facing slice

1. The two supplied covenant outpoints are fetched from one genesis-verified
   testnet Esplora endpoint and checked for confirmation and current spend state.
2. The engine selects deterministic distinct principal/fee wallet inputs, retains
   their unblinding factors internally, and constructs the exact ordered PSET.
3. Confidential change is blinded, both covenant inputs are finalized, and a
   secret-free transaction-bound approval digest is derived.
4. Approval is bound to the origin connection revision, wallet generation, request
   id, and plan digest; all chain and wallet state is rebuilt after approval.
5. The software wallet enriches and signs its inputs, the exact final transaction
   dry-runs both Simplicity inputs, authorization is checked again, and the PSET is
   broadcast. Successful results are idempotently retained for seven days.
6. `experimental_getTxManifestSupport` and `experimental_executeTxManifest` are
   exposed only through event-based provider discovery.
