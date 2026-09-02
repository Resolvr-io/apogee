# Apogee TX Manifest bundle and execution specification

Status: internal draft v0, implemented for the first Liquid testnet release.
Normative terms such as MUST and MUST NOT apply to Apogee's implementation, not to
the upstream TX Manifest proposal.

Implementation status: the event-discovered provider exposes both experimental
methods. The built-in Simplicity Lending paths cover Enable borrowing
(CreateFactory), CreateOffer, AcceptOffer, ClaimPrincipal, full RepayLoan,
CancelOffer, LiquidateOffer, and ClaimLenderVault. Apogee also executes compatible,
non-built-in bundles through the closed data-only
`apogee-declarative-transaction/v1` extension. Generic bundles are capability-
selected rather than recognized by protocol name, action name, or bundle hash,
and are always presented as unverified.

Every path uses the same host-owned lifecycle: authorization, exact bundle
validation, fresh-chain resolution, deterministic wallet input selection when
needed, transaction construction, approval digest binding, post-approval rebuild,
final-template binding, covenant dry-run, durable checkpointing, broadcast, and
terminal-result idempotency. Wallet signing occurs only for actions whose resolved
plan requires it. A fully covenant-authorized transaction may use the keyless
`none` signing mode, including from a locked, Jade, or watch-only wallet. Issued
assets for the built-in Lending adapter are derived inside Apogee from the
wallet-selected issuance outpoint and the requesting origin's ELIP-0100 contract.

## Scope and invariants

Apogee exposes two new methods through the event-discovered Liquid provider:

- `experimental_getTxManifestSupport`
- `experimental_executeTxManifest`

No legacy `window.liquid` method is added. Execution is broadcast-only. A hash-only
unknown bundle is inspect-only until the caller supplies the complete bundle. A
supplied bundle is executable only if strict normalization, bundle hashing, pinned
revision checks, and the closed declarative parser all succeed; incompatible
bundles fail closed. Mainnet execution remains disabled. Watch-only, Jade, and
locked-wallet execution is permitted only for a resolved `none` signing mode.

The dapp supplies intent, the complete bundle for a generic protocol, and candidate
covenant outpoints. Apogee MUST independently resolve wallet inputs, fetch and
validate referenced chain state, build the transaction, derive the review, sign
when required, Simplicity-dry-run, checkpoint, and broadcast. An adapter never
receives a mnemonic, signer, broadcast function, arbitrary network client, or the
ability to supply a caller-built PSET.

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

### On-chain history hint policy

The trusted registry may separately opt a vendored bundle into the wallet-owned
`txmf-v1` history extension with `dedicated-before-fee` placement and a named,
compiled-in postcondition verifier. This is wallet policy rather than dapp-supplied
manifest data, so enabling it does not change the bundle hash or require the dapp
to send a different execution request. Unknown bundles and registry entries
without this opt-in never receive an injected output or trusted history label.

The 53-byte v1 OP_RETURN datum is:

```text
ASCII("TXMF") || 0x01 || bundle_hash || action_tag

action_tag = first16(TaggedHash(
  "tx-manifest/action/v1",
  bundle_hash || UTF8(canonical_action_name)
))
```

Apogee appends one explicit zero-value policy-asset output after ordinary/change
outputs and immediately before the Elements fee output. History recovery scans
every datum of every OP_RETURN in each LWK-discovered wallet transaction; the
output index is not part of the decoding format.

A marker is not authoritative by itself. Apogee labels an action verified only
when exactly one canonical marker resolves to one action in an opted-in trusted
bundle, the transaction spends a wallet-owned input, the marker output is the
canonical explicit zero-value output at the registered placement, and the
action-specific transaction-shape postconditions pass. Unknown bundles and failed
checks remain unsupported or unverified and do not receive trusted protocol/action
labels.

The first built-in is the current simplicity-lending v3 source revision
`8f8ace33963788a0ed901c160a1187f8489e2c55`, with bundle identity
`sha256:debdae89777fdd21fec2d763efe028876f267ff214aca9ddf9b3735d7657be15`.
The eight lifecycle actions listed above are enabled, only on Liquid testnet.
Approval labels come from this registry. The wallet selects fresh destinations;
the bundle does not require address index 0.

## Generic declarative compatibility

A non-built-in bundle is eligible only when all of the following are true:

- its declared extension set is exactly `apogee-declarative-transaction/v1`;
- its TX Manifest and SimplicityHL revisions equal Apogee's pinned revisions;
- `manifest.x_apogee_declarative` is a strict version-1 object whose chain and
  action maps exactly agree with the ordinary manifest declarations;
- every referenced Simplicity source is present in the closed bundle and uses no
  import, include, or module declaration; and
- the selected action stays within Apogee's structural, expression-depth,
  expansion, script, source, and transaction-size limits.

Each recipe declares typed arguments; ordered provided or wallet input roles;
explicit script, covenant, wallet, change, fragmented-record, or `txmf` outputs;
a fixed or estimated fee and its exact output index; optional locktime and
sequences; and a structural Simplicity witness tree. Expressions are evaluated by
Apogee from the typed arguments and independently resolved inputs. Recipes cannot
run JavaScript, fetch resources, call wallet APIs, or replace the constructed PSET.

Provided outpoints are resolved by an exact, host-owned chain callback restricted
to the plan's declared inputs. A provided role may require covenant authorization
or connected-wallet ownership; wallet roles select exactly one matching UTXO in
this version. The resulting signing mode is `wallet` if any input requires wallet
authorization and `none` otherwise.

Generic protocol and action prose is publisher-provided context only. The approval
always displays an unverified warning and derives its authoritative facts from the
constructed transaction: every input and output (including the fee output),
outpoints, assets, amounts, scripts, confidentiality and ownership, sequences,
replaceability, locktime, signing mode, fee, and wallet effects. Untrusted asset
identifiers use built-in metadata when known and local abbreviated fallback labels
otherwise; they do not cause attacker-controlled registry fan-out. Generic bundles
do not receive a trusted on-chain history label.

## Support request

```ts
type GetTxManifestSupportParams = {
  bundleHash: `sha256:${string}`;
  bundle?: TxManifestBundle;
};

type GetTxManifestSupportResult = {
  supported: boolean;
  bundleHash: `sha256:${string}`;
  status: "builtin" | "generic" | "unknown" | "blocked";
  compatibility: "executable" | "inspect-only" | "incompatible";
  trust: "builtin" | "unverified" | null;
  requiresBundle: boolean;
  warningRequired: boolean;
  protocol?: { name: string; version: string };
  manifestSpecVersion?: string;
  supportedActions?: string[];
  reason?: string;
};
```

This method is read-only and may run before connection. It reports static runtime and
registry/parser support, not whether a later connected account has sufficient funds
or a compatible signer. A built-in is recognized by its pinned hash and does not
require a supplied bundle. An unknown hash-only request returns `inspect-only` and
`requiresBundle: true`; supplying the full bundle either returns executable,
unverified generic support or an incompatible result with a reason.

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
allowed by the selected built-in or declarative adapter. A generic execution MUST
carry the complete bundle again; Apogee normalizes it, recomputes its hash, and
reparses it on every invocation. `providedInputs` are untrusted resolution hints;
the host fetches their transactions and current spend status itself and restricts
generic chain resolution to the exact declared outpoints.

## Internal runtime boundary

The Rust/WASM transaction runtime has no network, filesystem, browser storage,
prompts, or seed. It compiles covenants, inspects chain data and addresses, builds
Apogee-defined PSET specifications, finalizes covenant witnesses, and dry-runs the
result. The provider lifecycle talks to protocol implementations through this
boundary:

```ts
interface TxManifestExecutionAdapter {
  id: string;
  bundleHash?: `sha256:${string}`; // built-ins only

  signingMode(plan): "wallet" | "none";
  resolveRequirements(invocation): Promise<RequirementPlan>;
  prepare(plan, context): Promise<PreparedExecution>;
  assetIds(prepared): string[];
  approvalReview(prepared, assets): ApprovalReview;
  verifyFinalTransaction(prepared, transactionHex, engine): Promise<void>;
}
```

`context.engine` is an allowlist of TX-Manifest-only construction, inspection,
finalization, and covenant-verification operations. It contains no seed access,
wallet signer, broadcast function, general network client, or arbitrary engine
escape hatch. Chain data enters only through a host-owned resolver: a built-in
snapshot resolver bound to the trusted plan, or a declarative resolver restricted
to the exact planned outpoints. Full wallet UTXO unblinding data MUST remain inside
the engine context and MUST never be returned through a provider response or
approval DTO.

`PreparedExecution` contains at least:

- the host-constructed, unsigned/blinded and covenant-finalized PSET;
- every resolved input and output in consensus order;
- the complete prior-output snapshot used by Simplicity;
- compiler outputs and covenant commitments;
- actual wallet asset deltas and fee;
- issuance, burn, sequence, and locktime effects; and
- a deterministic `planDigest` over all authorization-relevant fields.

## Approval lifecycle

1. Authenticate origin and check the connected permission.
2. Resolve a built-in registry entry or strictly validate the complete generic
   bundle and choose the declarative adapter by capability.
3. Resolve requirements; fetch exact candidate covenant outpoints and sync/select
   wallet state only when the plan requires it.
4. Build `PreparedExecution` without exposing signing secrets.
5. Derive the approval DTO from the built transaction. Use trusted review metadata
   only for built-ins; show the unverified warning for every generic transaction.
6. Park the approval with the connection revision, wallet generation, request ID,
   bundle hash, signing mode, exact reviewed fee, requirement digest, and
   `planDigest`.
7. After approval, refresh spend status and any required wallet state and fee rate,
   then rebuild with the exact reviewed fee. If it is no longer sufficient, require
   a new review.
8. Require the new authorization-relevant plan to match the approved digest.
9. Extract the reviewed unsigned transaction ID, recheck origin permission and—only
   for `wallet` mode—the signer and wallet lock, then sign the required wallet
   inputs.
10. Extract the finalized transaction and require its transaction ID to equal the
    reviewed unsigned ID. Dry-run every Simplicity input against those exact final
    bytes and the complete prior-output set.
11. Recheck authorization immediately before broadcast.
12. Broadcast, persist the idempotent result, and notify wallet balance refresh.

Any state or plan mismatch aborts before signing. A final Simplicity failure aborts
before broadcast. The transaction-ID equality check binds every non-witness field,
including all input outpoints and sequences, locktime, and output asset, value,
nonce, and script—even for an action with no covenant input. A signed or finalized
PSET MUST NOT be returned to the dapp, including on broadcast failure.

The first release retains at most 100 successful terminal results for seven days in
extension-local storage. Concurrent retries with the same scoped `requestId` share
one execution; reuse with different request data is rejected. Before submission,
Apogee durably stores the exact transaction, its review, execution-authority
bindings, and expected result in a wallet-bound checkpoint. Wallet-mode checkpoints
are sealed with the wallet; signature-free transactions use a clear local payload
because the transaction bytes are already intended for public broadcast. A
persistence failure prevents broadcast.

An identical retry first looks up the saved transaction; if it is already known it
returns the original result. Otherwise it requires an explicit recovery approval.
Apogee parses the saved authority, recomputes the saved raw transaction ID,
re-resolves requirements, rebuilds from fresh state, matches plan and authoritative
review digests, and dry-runs the saved bytes before rebroadcast. A `none`-mode
rebuild must also reproduce the saved transaction ID exactly. Wallet-mode recovery
does not require a fresh blinded rebuild to reproduce the transaction ID because
output blinding uses randomness; it instead relies on the bound plan/review, saved-
byte transaction ID, and final covenant dry-runs. Legacy checkpoints without the
new authority fields may be recognized if already found, but cannot recover a
missing transaction. The checkpoint remains durable until the terminal result is
successfully stored.

## First implementation limits

- Liquid testnet only in production; the controlled test harness may enable regtest.
- Built-in Lending plus strictly compatible declarative bundles. There is no remote
  adapter registry, downloaded executable code, dynamic module, or protocol-specific
  built-in for a generic application.
- Wallet-signing mode supports the local software signer first; Jade and watch-only
  wallets remain blocked for that mode. Signature-free `none` mode supports local,
  Jade, watch-only, and locked wallets because Apogee does not request a signature.
- The built-in Lending selector is deterministic and bounded to 12 inputs per asset
  role. When collateral or repayment is L-BTC, the same inputs may also fund the
  network fee; otherwise fee inputs are distinct.
- A declarative wallet role selects one UTXO satisfying its exact/minimum amount and
  optional P2WPKH constraint; applications must split larger selections into
  explicit roles. Generic provided inputs are exact outpoints, and version 1 does
  not prove application-specific ancestry beyond the recipe's stated tuple and
  covenant conditions.
- Declarative confidential wallet/change outputs require at least one resolved input
  with blinding factors. Fixed-fee recipes may pin the sole explicit empty-script
  fee output to an exact consensus output index.
- A live Esplora fee rate applied to the finalized PSET's conservative discounted
  virtual size. Construction repeats until the fee-dependent input/output shape
  converges, subject to both the dapp's cap and an independent Apogee ceiling.
  Approval-time revalidation pins the exact reviewed fee and requires a new review
  if that fee is no longer sufficient. Missing estimates use a 100 sat/kvB fallback.
- Full repayment only; partial-repayment vault continuation is not yet enabled.
- No full protocol indexer in Apogee.
- No generic trusted history labels or generic action postcondition verifier.
- No signed-PSET return mode.
- No unsupported manifest extension, hook, or compiler feature is ignored.
- No legacy `window.liquid` method; TX Manifest is available only on the
  event-discovered provider.
