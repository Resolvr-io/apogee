# Apogee TX Manifest bundle and execution specification

Status: internal draft v0, implemented for the first Liquid testnet release.
Normative terms such as MUST and MUST NOT apply to Apogee's implementation, not to
the upstream TX Manifest proposal.

Implementation status: the event-discovered provider exposes both experimental
methods. The built-in AcceptOffer and ClaimLenderVault paths perform fresh-chain
snapshot acquisition, deterministic wallet input selection, balanced multi-asset
construction/blinding, approval digest binding, post-approval rebuild,
software-wallet signing, exact final-transaction Simplicity dry-run, broadcast,
and terminal-result idempotency.

## Scope and invariants

Apogee exposes two new methods through the event-discovered Liquid provider:

- `experimental_getTxManifestSupport`
- `experimental_executeTxManifest`

No legacy `window.liquid` method is added. Execution is broadcast-only. Unknown
bundles, unsupported extensions, watch-only execution, and mainnet execution MUST
fail closed in the first release.

The dapp supplies intent and candidate covenant outpoints. Apogee MUST independently
resolve wallet inputs, fetch and validate referenced chain state, build the
transaction, derive the review, sign, Simplicity-dry-run, and broadcast.

## Bundle v1

The wire shape is implemented by
[`src/tx-manifest/bundle.ts`](../src/tx-manifest/bundle.ts):

```ts
type TxManifestBundle = {
  schema: "apogee-tx-manifest-bundle/v1";
  manifestSpec: {
    id: "elip-205-draft";
    revision: string; // full Git commit
  };
  compiler: {
    id: "simplicityhl";
    revision: string; // full Git commit
    debugSymbols: boolean;
  };
  extensions: string[];
  manifest: Record<string, JsonValue>;
  sources: Record<string, string>; // canonical relative .simf path -> exact UTF-8
};
```

The bundle MUST contain every local source directly referenced by a Simplicity
script. Bundle v1 rejects import/include/module declarations entirely; a future
bundle revision may add an explicit complete-import-closure model. URLs, absolute
paths, backslashes, empty path segments, `.` segments, and `..` segments are
forbidden.

Source text is hashed byte-for-byte after UTF-8 decoding. Line endings are not
normalized because debug-symbol builds may commit source positions into the program.
The manifest is canonicalized structurally, but every manifest field—including
prose—is committed by bundle v1.

## Bundle identity

Normalization performs the following before hashing:

1. Reject unknown or missing bundle-envelope fields.
2. Require full lowercase 40-character Git revisions.
3. Canonicalize `./x.simf` to `x.simf` and reject path aliases.
4. Sort and deduplicate extensions.
5. Require JSON values and permit only finite safe-integer JSON numbers. Amounts,
   asset quantities, and other `u64` values use decimal strings.
6. Serialize objects with lexicographically sorted keys, arrays in declared order,
   compact JSON, and ordinary JSON string escaping.

The preimage is the canonical normalized bundle. Its identity is the BIP340-style
tagged hash:

```text
tag = SHA256("apogee/tx-manifest-bundle/v1")
digest = SHA256(tag || tag || canonical_bundle_utf8)
bundleHash = "sha256:" || lowercase_hex(digest)
```

Apogee MUST recompute this value. A dapp-provided hash is never authoritative.

## Trusted registry

The first implementation uses a static registry compiled into the extension:

```ts
type TrustedManifest = {
  bundleHash: `sha256:${string}`;
  protocol: string;
  version: string;
  chainIds: string[];
  actions: string[];
  compilerRevision: string;
  extensions: string[];
  reviewMetadata: TrustedReviewMetadata;
};
```

The registry supplies signer-visible protocol/action labels. The dapp and manifest
MUST NOT supply authoritative approval text. A protocol upgrade is a new bundle hash
and a new registry entry.

The compiler revision maps to a compiler artifact shipped inside Apogee. Apogee MUST
not download executable compiler code at runtime.

The first built-in is the current simplicity-lending v3 source revision
`8f8ace33963788a0ed901c160a1187f8489e2c55`, with bundle identity
`sha256:0a57b34e20a46f0a3ec60d6be4904eebc9d3807bb6a2fbab0c66abdcdc05af8e`.
`lending_contract.AcceptOffer` and `lending_contract.ClaimLenderVault` are enabled,
and only on Liquid testnet.

## Support request

```ts
type GetTxManifestSupportParams = {
  bundleHash: `sha256:${string}`;
};

type GetTxManifestSupportResult = {
  supported: boolean;
  bundleHash: `sha256:${string}`;
  status: "builtin" | "unknown" | "blocked";
  protocol?: { name: string; version: string };
  manifestSpecVersion?: string;
  supportedActions?: string[];
};
```

This method is read-only and may run before connection. It reports static runtime and
registry support, not whether a later connected account has sufficient funds or a
compatible signer.

## Execution request

```ts
type ExecuteTxManifestParams = {
  protocolVersion: "0.1";
  requestId: string;
  chainId: string;
  accountIdentifier: string;
  manifest: {
    bundleHash: `sha256:${string}`;
    bundle?: TxManifestBundle;
  };
  action: string;
  arguments: Record<string, ManifestValue>;
  providedInputs?: Record<string, Outpoint | Outpoint[]>;
  constraints?: {
    maxFee?: string;
    validUntilHeight?: number;
  };
};

type ExecuteTxManifestResult = {
  requestId: string;
  chainId: string;
  accountIdentifier: string;
  bundleHash: `sha256:${string}`;
  action: string;
  status: "broadcast";
  txid: string;
};
```

`requestId` is an application idempotency key scoped to origin, account, and chain.
Apogee MUST persist terminal results long enough for a retry after a lost provider
response to return the original result rather than construct a second transaction.

The connected account and chain MUST exactly match the request. The action MUST be
allowed by the trusted registry. `providedInputs` are untrusted resolution hints;
the host fetches their transactions and current spend status itself.

## Internal runtime boundary

The Rust/WASM runtime has no network, filesystem, browser storage, prompts, or seed.
It receives and returns serialized data through these conceptual operations:

```ts
inspectBundle(bundle): BundleInspection

resolveRequirements(bundle, invocation): RequirementPlan

buildExecution(
  bundle,
  invocation,
  chainSnapshot,
  walletSnapshot,
): PreparedExecution

finalizeCovenants(
  preparedExecution,
  computedWitnesses,
): FinalizedExecution

dryRun(finalizedExecution): DryRunResult
```

The host adapter lives inside Apogee's existing engine context. Full wallet UTXO
unblinding data MUST remain inside that context and MUST never be returned through a
provider response or approval DTO.

`PreparedExecution` contains at least:

- the unsigned/blinded PSET;
- every resolved input and output in consensus order;
- the complete prior-output snapshot used by Simplicity;
- compiler outputs and covenant commitments;
- actual wallet asset deltas and fee;
- issuance, burn, sequence, and locktime effects; and
- a deterministic `planDigest` over all authorization-relevant fields.

## Approval lifecycle

1. Authenticate origin and check the connected permission.
2. Resolve and verify the bundle and trusted registry entry.
3. Resolve requirements; sync the wallet and fetch candidate covenant outpoints.
4. Build `PreparedExecution` without exposing signing secrets.
5. Derive the approval DTO from the built transaction and trusted review metadata.
6. Park the approval with the connection revision, wallet generation, request ID,
   bundle hash, and `planDigest`.
7. After approval, refresh spend status and wallet state and rebuild/reanalyze.
8. Require the new authorization-relevant plan to match the approved digest.
9. Recheck origin permission and wallet lock, then sign wallet inputs and required
   BIP340 witnesses.
10. Finalize covenant witnesses and dry-run every Simplicity input against the exact
    final transaction and prior-output set.
11. Recheck authorization immediately before broadcast.
12. Broadcast, persist the idempotent result, and notify wallet balance refresh.

Any state or plan mismatch aborts before signing. A final Simplicity failure aborts
before broadcast. A signed or finalized PSET MUST NOT be returned to the dapp,
including on broadcast failure.

The first release retains at most 100 successful terminal results for seven days in
extension-local storage. Concurrent retries with the same scoped `requestId` share
one execution; reuse with different request data is rejected. The result is written
before the provider promise resolves. There remains a narrow browser/storage-failure
window between successful network submission and durable result storage; eliminating
it requires a signed-transaction broadcast checkpoint and retry/resume state.

## First implementation limits

- Liquid testnet only.
- Built-in bundles only.
- Software signer first; Jade is blocked on explicit BIP340 path/capability proof.
- Exactly one principal input and one distinct L-BTC fee input.
- A conservative fixed 1,000-sat network fee; a lower dapp fee cap is rejected.
- No remote registry or manifest installation.
- No full protocol indexer in Apogee.
- No signed-PSET return mode.
- No unsupported manifest extension, hook, or compiler feature is ignored.
- No legacy `window.liquid` method; TX Manifest is available only on the
  event-discovered provider.
