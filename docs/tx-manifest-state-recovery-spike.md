# TX Manifest mnemonic-only state recovery spike

Date: 2026-08-15; design refined 2026-08-17

## Result

Mnemonic-only recovery of TX Manifest **instances and live state is feasible as an
opt-in capability**, but it is not something an OP_RETURN can provide by itself.
A complete design separates four jobs:

1. **Discovery:** find candidate transactions or resources relevant to the restored
   wallet.
2. **Reconstruction:** bind transaction components to a trusted manifest action and
   derive a candidate instance, fields, roles, and resources.
3. **Validation:** establish the evidence required by that class: either authenticate
   the current state directly or prove provenance back to a constructor.
4. **Tracking:** follow canonical resource outspends to the selected chain tip and
   resolve branches, conflicts, and reorgs.

Here, “mnemonic-only” means no per-wallet, per-dapp, or browser-state backup. The
restore still requires the mnemonic, the selected network's canonical chain via a
raw-transaction/outspend-capable backend, and Apogee's shipped archive of approved
historical action relations, wire codecs, content-addressed recovery-traversal
profiles, and deployment constants. It recovers confirmed canonical state and can
make a best effort over the current mempool; it cannot resurrect evicted/replaced
mempool attempts or local request/retry checkpoints that were never committed to
the chain.

The current 53-byte `TXMF` action marker helps identify a candidate manifest and
action. It does not carry instance fields or state, and an OP_RETURN does not make
a transaction wallet-discoverable. The right generic design is therefore:

- define each action once as a typed relation among instance fields, parameters,
  named transaction components, and resulting resources;
- interpret that relation forward to construct transactions and backward to
  reconstruct candidate bindings;
- validate those bindings against the same relation under an explicit
  `current_state` or `provenance` evidence mode;
- use the same resource effects for ordinary state updates and recovery replay;
- keep only discovery roots, graph traversal, backend requirements, privacy policy,
  bounds, and scan completeness in a thin recovery-specific layer;
- keep the existing `TXMF` marker unchanged; and
- optionally add a compact `TXMR` record only for the smallest field basis that
  cannot otherwise be recovered. Its shared codec must both encode during
  construction and decode during recovery.

For Simplicity Lending v3, the existing creation metadata, explicit issuance
outputs, and trusted deployment constants appear sufficient. It probably does
**not** need a new recovery OP_RETURN. The current bundle can be paired with a
trusted bidirectional sidecar pinned to its exact bundle hash. That compatibility
sidecar supplies the inverse bindings and resource effects missing from the legacy
format, and normalizes with the original bundle into one relation used by both
execution validation and recovery. Future manifests should carry those shared
semantics directly. The vendored bundle covers eight actions, not every valid path
in the deployed contracts; unknown valid transitions must fail closed as
`unsupported-transition` rather than producing apparently complete state.

## Explicit factory-auth transfer experiment

The isolated regtest experiment tested the strict case that motivated the
proposed L-BTC recovery anchor:

1. derive a fresh recipient script from a public BIP39 test mnemonic;
2. issue a one-unit explicit asset;
3. transfer that asset explicitly to the recipient script, with no recipient
   L-BTC output;
4. discard the original LWK wallet object and all cached state; and
5. create a new wallet from the mnemonic and perform a full descriptor scan.

The fresh LWK 0.18 wallet discovered the transaction without an out-of-band txid
or a sats anchor. Its APIs behaved as follows:

| Restored LWK view | Explicit one-unit output |
| --- | --- |
| `transactions()` | Present, with the owned output |
| `txos()` | Present, including asset, value, script, and derivation index |
| experimental `txs()` | Present and marked explicit |
| `utxos()` | Absent |
| `balance()` / `assetsOwned()` | Absent |

This proves that the descriptor/script scan itself is enough to discover an
explicit-only inbound factory-auth transfer. The missing work is after discovery:
Apogee currently builds balances and ordinary coin selection from `utxos()`, and
its narrow explicit-output recovery helper starts from an exact outpoint supplied
by the dapp.

The experiment also spent the restored explicit output and then performed a
second mnemonic-fresh scan:

- LWK's native `TxBuilder.setWalletUtxos()` rejected it as `Missing wallet UTXO`
  because it is intentionally absent from `utxos()`.
- Apogee's existing manifest PSET route succeeded when given the verified explicit
  prevout, asset, amount, and zero blinding factors. `Pset.addDetails(wollet)`
  attached the wallet derivation, the restored signer signed it, and the regtest
  node accepted the transaction.
- After another fresh restore, LWK surfaced the spending transaction and its
  experimental transaction-details view marked the original explicit output
  spent. `txos()` intentionally retained it as historical output data.

The smallest implementation path is therefore a separate inventory of explicit
manifest capabilities sourced from `txos()`/transaction details, with an
authoritative outspend recheck immediately before execution. It does not require
a custom descriptor scan, an LWK fork, or a new signing path.

That inventory should remain separate from normal balances and general-purpose
coin selection. Its outputs are untrusted discovery candidates. A candidate enters
the semantic resource index only after one shared action relation uniquely binds
it to a named output role and the required validation mode succeeds. Dapps receive
verified instance handles rather than a raw list of unusual wallet outputs.

### Experiment limits

- The test used one confirmed, generic one-unit issued asset at external
  derivation index 0, not a real factory lineage. It proves discovery, storage,
  spentness observation, and signability—not factory authenticity.
- It used the ordinary WPKH-SLIP77 descriptor. Normal address gap limits still
  apply; a payment beyond the unused-address lookahead may be missed just like a
  confidential payment.
- Mempool, RBF, and reorg behavior were not part of this isolated test and remain
  required instance-recovery tests.
- LWK's experimental spent flag can be stale. Esplora outspend/current-tip checks
  remain authoritative before listing a capability as ready or executing it.
- The basic and experimental LWK views rendered the explicit output's address
  differently. Recovery should use script and derivation metadata, not rendered
  address-string equality.

### Consequence for factory-auth transfer

The clean default transfer is one sender-funded transaction:

- spend the sender's explicit one-unit factory-auth asset;
- recreate that explicit unit at the script from the recipient's ordinary Liquid
  receive address; and
- include a trusted `TransferFactoryAuth` action marker.

No recipient co-signature, L-BTC anchor, or mandatory `AdoptFactory` transaction
is needed. `txos()` enumeration first discovers an untrusted candidate. Because a
generic one-unit asset is spoofable, the factory class requires `provenance`: the
shared relations must validate the constructor/transfer lineage and current
companion covenant before the tracker materializes a verified inbound resource.
The user can then adopt it locally. A later receiver action such as `CreateOffer`
can serve as durable on-chain evidence of use; a standalone `AdoptFactory` remains
an optional legacy/import or explicit-consent path.

The asset should remain explicit. The deployed issuance-factory covenant unwraps
and compares explicit asset/value fields for both the wallet auth unit and the
covenant unit. Blinding the transferred auth unit would require an extra
normalization transaction before it could be used.

## What Apogee recovers today

Today a mnemonic restore recovers the wallet descriptor, ordinary wallet history,
confidential coins, and TX Manifest action labels for transactions surfaced by
LWK. It does not reconstruct semantic instances or ELIP state files.

The v1 action payload is:

```text
magic          = ASCII "TXMF"                         (4 bytes)
version        = 0x01                                 (1 byte)
bundle_hash    = SHA256(canonical approved bundle)   (32 bytes)
action_tag     = first16(tagged action hash)          (16 bytes)
                                                     ----------
                                                     53 bytes
```

The marker contains no instance identifier, constructor fields, arguments,
wallet role, named input/output mapping, state root, or current outpoint. Current
history verification uses it to select a trusted action and then checks wallet
input participation plus a coarse action-specific shape. The result is a label,
not reconstructed state.

Execution currently travels in the other direction: the dapp supplies lending
instance values and exact current outpoints, and Apogee independently checks them
against chain state and the trusted covenant. Those checks are strong, but their
semantic results are not yet retained in a seed-rebuildable instance index.

## Why an OP_RETURN is not enough

An OP_RETURN is globally visible but not addressed to a wallet. A mnemonic scan
does not inspect every transaction on the chain looking for arbitrary data. It
finds transactions through seed-derived scripts and then can inspect their sibling
outputs.

Relevant discovery roots include:

- a transaction funded by a wallet input;
- an output to a seed-derived wallet script, including the explicit output proven
  by this spike;
- an issuance transaction found from an asset ID already held by the wallet; or
- an outspend followed from a previously verified covenant-state UTXO.

After a root is found, later transactions can be discovered by following the
outspends of verified state UTXOs. This is essential for multi-party protocols:
a lender's acceptance may not touch a borrower script, and a borrower's repayment
may not touch a lender script.

That requires a historical outspend-capable chain source (or an equivalent local
index built while scanning). A descriptor scan or an unindexed full node alone
cannot locate arbitrary counterparty successors from an old outpoint.

The recovery system must therefore treat the marker as a routing hint, never as
proof. A copied or forged marker must not create a wallet instance. Conversely,
once a verified state outpoint anchors the search, a successor built by another
wallet may omit Apogee's marker. A provenance-capable definition should try only
the bounded set of actions declared able to consume that state and accept one
unique, fully verified transition; the marker is then a fast path rather than
consensus state.

## Generic bidirectional model

The strongest generic design does not maintain a forward recipe and a second
inverse recovery recipe. It defines one bounded relation among:

- typed action parameters and instance fields;
- named inputs, prevouts, issuances, outputs, witnesses, and metadata records;
- deterministic derivations and historical-safe validations; and
- stable instance identities plus named resource effects.

Construction supplies parameters and current resources, then fills the transaction
side of the relation. Historical interpretation supplies a raw transaction, binds
its components to the same names, derives every recoverable field, and verifies the
same constraints. Recovery must never carry a second copy of the transaction shape.

Relation primitives have explicit supported directions:

| Relation | Construction | Historical interpretation |
| --- | --- | --- |
| Named input/output slot | Select or construct | Bind and verify |
| Fixed-width record codec | Encode | Decode and verify |
| Issuance asset derivation | Compute after input selection | Recompute from issuance |
| Covenant/script compilation | Compile | Recompile and compare |
| Hash or signature | Compute/sign | Verify only |
| Confidential commitment | Blind | Unblind only with the required wallet key |
| General arithmetic | Compute or check | Check; extract only when explicitly unambiguous |
| Resource effect | Update local state | Replay historical state |

No general symbolic solver is permitted. A required field that exists only behind
a hash, an ambiguous equation, an unavailable confidential commitment, or lost
off-chain state has no inverse. To claim mnemonic recovery, the action must bind
that field to an unambiguous chain source such as issuance data, a typed metadata
record, a seed-derived value, or an approved deployment constant. A manifest
compiler should statically reject a recovery claim when any required field lacks
such a path.

State effects are shared rather than recovery-specific:

- output only: create a named resource;
- input plus output: continue or replace that resource;
- input only: consume or terminate it; and
- no reference: preserve an independent resource unchanged.

This models covenant state, wallet capabilities, receipts, claims, vaults, and
parallel sidecars without protocol-specific wallet code.

The class/action relation declares its minimum `current_state` or `provenance`
evidence for listing and execution. A dapp may request stronger evidence but can
never lower that requirement. Only chain-search policy belongs in a thin recovery
shell:

1. **Discovery roots:** wallet input/output roles, historical explicit TXOs,
   recognized records, owned-asset origins, deterministically derived scripts, and
   known-resource outspends.
2. **Traversal support:** ancestor/outspend locator edges, required backend
   capabilities, graph/time/memory bounds, and indexer/privacy policy.

Confirmation requirements belong to validation; mempool conflicts, replacements,
and reorg behavior belong to tracking; response-field allowlists belong to provider
permission policy. The recovery shell only teaches the wallet where and how far it
may search.

That shell is itself an immutable, content-addressed, wallet-approved traversal
profile bound to the exact action-relation hash, chain, and deployment. A legacy
sidecar may commit both the relation augmentation and traversal profile in one
package while keeping their responsibilities logically separate. Its hash affects
cache identity and the meaning of scan completeness.

The wallet must retain or be able to retrieve the exact historical relation, wire
codecs, and traversal profile by content hash. A hash authenticates supplied bytes;
it does not make unknown semantics trusted. Apogee should archive approved
historical definitions and leave unknown bundles unsupported until explicitly
approved.

Every identity rule must prove its own replacement stability. A raw creation txid
is branch-scoped while its transaction can be replaced. An issuance-derived ID is
stable across replacement only if the input outpoint, entropy, and other derivation
inputs remain unchanged. Definitions must alias/migrate provisional identities to
the confirmed constructor or avoid exposing a durable handle until confirmation.

### Restore algorithm

**Discovery**

1. Perform the normal descriptor scan and enumerate both confidential and explicit
   wallet-owned outputs.
2. Apply bounded root locators and graph edges to produce untrusted candidates. A
   `TXMF` marker, metadata prefix, dapp hint, or indexer result may narrow the search
   but is never acceptance proof.
3. Select only exact archived, wallet-approved bundle/sidecar/wire-schema/traversal-
   profile combinations.

**Reconstruction**

4. Evaluate each candidate backward against the shared action relation. Bind
   observed inputs, outputs, issuances, and records to its existing names and derive
   candidate fields, instances, roles, and resources.
5. Require exactly one valid binding. Zero is unsupported; multiple bindings are
   ambiguous rather than resolved by registry order.

**Validation**

6. Under `current_state`, authenticate the reconstructed action and present
   resource set against the shared constraints and an authoritative chain snapshot.
   Discovery/tracking must already have located that snapshot; validation does not
   depend on constructor provenance for security.
7. Under `provenance`, additionally follow declared backlinks to a unique
   constructor and verify every required lineage edge.

**Tracking**

8. Apply each validated action's shared resource effects in canonical order and
   follow every live resource outspend, including successors with no wallet script.
   A missing marker may be classified by trying only shared actions whose effects
   consume that named resource.
9. Resolve conflicts, confirmations, RBF, and reorg rollbacks. An unmodeled spend
   becomes `unsupported-transition`, never a guessed terminal state.
10. Materialize a versioned, chain-tip-bound semantic cache and, optionally,
    equivalent ELIP instance/state JSON. Forward execution uses the same relation
    and resource effects.

The semantic database is a cache. Deleting it and rescanning from the mnemonic and
chain must reproduce the same canonical instances and current states.

### ELIP file fidelity

Recovery can semantically rebuild the manifest class/constructor fields and named
live UTXOs (`utxo_type`, optional `utxo_id`, txid, vout, amount, and asset). It can
rebuild `last_action` only when tracking is complete through the selected tip. It
need not reproduce byte-identical JSON, file ordering, relative `instance` paths,
tool-local `created_by` metadata, or original `provided_inputs` annotations unless
those values are independently derivable. Provenance-complete tracking therefore
means an equivalent verified, executable on-chain instance and current resource
set—not a backup of every authoring tool's local representation.

## Optional bidirectional `TXMR` record

Most live state should not be serialized into OP_RETURN. A manifest already names
the state outputs, and the transaction supplies their txid, vout, asset, amount,
and script when those fields are explicit or the restoring wallet can unblind
them. Confidential state belonging only to another actor still needs recoverable
blinding data or another source. Replaying verified actions is more compact and
less ambiguous than publishing snapshots in every transaction.

`TXMR` is only needed for the smallest basis of non-derivable static fields or a
link that cannot otherwise be inferred. Keep it in a separate output so the
existing canonical `TXMF` v1 script and history remain backward compatible.

One possible encoding under the current 80-data-byte relay target is:

```text
Common prefix:
  magic             "TXMR"                         4 bytes
  version           0x01                           1 byte
  kind_and_flags                                    1 byte

Constructor/self record:
  instance_slot                                      2 bytes
  chunk_index                                        1 byte
  chunk_count                                        1 byte
  schema-defined payload                            <=70 bytes

Linked/transfer record:
  genesis_txid                                      32 bytes
  instance_slot                                      2 bytes
  chunk_index                                        1 byte
  chunk_count                                        1 byte
  schema-defined payload                            <=38 bytes
```

The canonical record output assumed here uses an explicit policy asset, explicit
zero value, null nonce, one minimally encoded data push, and a placement declared
by the shared action relation. Payloads of 76–80 bytes use `PUSHDATA1`; shorter
payloads must also use their minimal push encoding.

The paired `TXMF` bundle/action marker gives the payload a content-addressed
namespace, so it can be canonical fixed-width positional data rather than JSON or
self-describing field names. It cryptographically commits the recovery schema only
if that schema is inside the hashed bundle. During the proposed lending-first
phase, Apogee's trusted registry instead associates a separately versioned
bidirectional sidecar with the exact bundle hash; that is wallet policy, not a
property proved by the bundle hash alone. `instance_slot` supports multiple
instances created in one transaction. The constructor record does not need its
own txid because the tx carrying it is the genesis transaction.

Every decoded field or link remains untrusted until the action relation binds it
to an objective validation—for example, recomputing the expected covenant script,
issuance ID, named output, or successor transition. A payload value that cannot be
checked this way is only a locator/annotation and cannot authorize an instance or
spend.

Useful single-record capacities include:

- two 32-byte asset IDs plus 6 bytes;
- eight `u64` values plus 6 bytes; or
- one compressed public key, one asset ID, plus 5 bytes.

Larger bases could use bounded chunks, but approved definitions should strongly
prefer transaction extraction and cap records (for example, two to four outputs).
Every maximum-size extra record adds 127 non-witness output bytes plus empty
output-proof length fields—roughly 129 raw bytes and about 128 vbytes—and
permanently fingerprints and publishes its fields.

The action relation must explicitly reserve each record in its output layout. Its
codec is the single source used to encode during construction and decode during
recovery. A wallet must never append `TXMR` blindly: arbitrary covenants and
indexers may constrain output count, position, or hashes just as the lending
contracts constrain several existing outputs.

Multiple data outputs are also chain-policy dependent. Liquid mainnet/testnet
permit them, and the existing lending lifecycle already exercises them, but a
generic Elements-based chain or regtest can enforce the default one-NULL_DATA
standard-relay rule unless multi-data is enabled. The action definition reserves
and constructs the record output; the wallet's execution/chain-support policy
decides whether that form is relayable on the selected network. Where it is
unavailable, use existing protocol metadata or a future single-output/unified
marker rather than assuming a second `TXMR` will relay.

A 32-byte state hash is not a recovery payload. It can authenticate a state file
obtained elsewhere, but it cannot reveal a missing preimage. Encryption can hide
wallet-only fields if the decryption key is seed-derived, but does not solve
discovery and becomes awkward for transferred or multi-party state.

## Lending v3 feasibility

Simplicity Lending is a good first bidirectional sidecar because most of its state
is already explicit and its transitions are bounded.

### Factory

- `CreateFactory` deterministically issues the factory asset.
- The existing 13-byte factory metadata carries the program ID, issuing-input
  count, and reissuance flags.
- Recovery can recompute the issued asset ID and require total supply two with no
  usable reissuance token. The two explicit one-unit outputs identify the wallet
  auth capability and the companion issuance-factory covenant.
- `CreateOffer` consumes and recreates both units, so the asset ID is stable while
  their outpoints and the wallet script rotate.

### Offer

- The existing 50-byte creation metadata carries principal asset, principal
  amount, expiry, and rate.
- Explicit creation outputs/issuances reveal collateral asset/amount and the
  borrower/lender capability asset IDs.
- Factory identity follows from the paired factory auth/covenant inputs.
- Derived debt and nested covenant hashes can be recomputed with the archived
  bundle/compiler.

One non-invertible field, `PROTOCOL_FEE_KEEPER_ASSET_ID`, is committed inside the
covenant construction but is not carried in the 50-byte metadata. Recovery needs
the approved chain/version deployment profile to provide that constant. A script
hash cannot reveal an unknown 256-bit constructor input.

### Shared resource-effects graph

Shared resource effects must represent parallel sidecars, not just one linear
status:

- `CreateOffer` creates pending collateral plus lender-NFT ScriptAuth state and
  sends the borrower NFT to the borrower.
- `AcceptOffer` consumes the pending/ScriptAuth pair, returns the lender NFT to the
  lender, and creates active collateral plus principal-auth state. The borrower
  NFT remains independently live.
- `ClaimPrincipal` consumes only the principal-auth sidecar and rotates the
  borrower NFT; the active collateral remains live.
- Full `RepayLoan` consumes active collateral, burns the borrower NFT, and creates
  lender and protocol-fee vaults. If principal was not claimed first, its
  principal-auth sidecar remains on-chain but can no longer be authorized; the
  wallet must report that stranded state rather than silently discard it.
- `LiquidateOffer` conflicts with repayment at the active-collateral outpoint.
  It burns the lender NFT, but an unclaimed principal-auth sidecar and borrower NFT
  remain and principal can still be claimable.
- `ClaimLenderVault` consumes the lender vault while any separate protocol-fee
  vault remains, and burns the lender NFT.
- `CancelOffer` terminates a pending offer and burns both offer NFTs.

The current action marker is sufficient to select the retained lending relation
once a transaction is found. Provenance validation still requires exact semantic
verification, following covenant outspends, retained deployment constants, and
reorg/conflict handling. No additional lending payload appears necessary for the
covered paths.

The deployed contracts also contain valid paths that the current vendored bundle
does not model: partial repayment with evolving active debt/vault state, factory
removal, and protocol-fee-vault withdrawal. Until their actions and resource
effects are added, encountering one must mark the instance
`unsupported-transition`. The current bundle therefore cannot claim complete
provenance reconstruction across every valid lending-contract transition.

## Validation modes and recovery results

The extension needs only two validation modes:

| Mode | Required evidence |
| --- | --- |
| `current_state` | Present resources and companion transaction facts independently authenticate the instance and current state. Earlier history is not a security dependency. |
| `provenance` | The wallet must verify a declared constructor/origin and every required lineage edge before accepting the reconstructed state. |

These modes describe the proof horizon, not how a candidate was located. A
`current_state` instance's discovery/tracking path may still follow outspends from
an older wallet-known transaction before presenting the latest snapshot for
validation. A `provenance` transaction may immediately reveal its manifest, action,
and instance ID but remain only a candidate until ancestry validation succeeds.

Discovery, reconstruction, validation, and tracking should be reported separately
rather than collapsed into one recovery level:

```text
discovery:      complete | partial | unavailable
reconstruction: unique | unsupported | ambiguous
validation:     current_state_verified | provenance_verified | partial | failed
tracking:       complete | partial | contested | unsupported | unavailable
tip:            { height, block_hash }
```

Completeness is scoped to the account, chain tip, approved relation and traversal-
profile hashes, backend capabilities, confirmation/mempool policy, and traversal
bounds. Empty results mean absence only when discovery is complete, every candidate
is terminally classified, the required validation mode has completed, and tracking
is complete through the reported tip. Current state may remain independently
verified after incomplete provenance only when the class explicitly permits
`current_state` evidence.

The effective result is determined by the approved relation, wallet implementation,
backend completeness, available confidential data, scan bounds, and transitions
actually observed. A dapp may request stronger evidence but cannot lower the class
or wallet's minimum requirement for listing or execution.

Mnemonic recovery is sound only when:

- the exact trusted relation and wire schema remain available;
- at least one wallet-discoverable root exists;
- every required field is seed-derived, transaction-derived, supplied by an
  approved deployment constant, or present in a bidirectional record codec;
- required state is represented by traversable on-chain UTXO lineage and each
  successor can be matched uniquely against a supported action;
- every relevant deployed transition is supported or produces an explicit
  `unsupported-transition`; and
- no indispensable off-chain or confidential preimage is missing.

This supports single-owner vaults, escrows, capability factories, token issuance,
lending, and many bounded multi-party state machines. High-frequency global pools
may require a privacy-reviewed indexer. Off-chain order books or secret state
cannot be completely reconstructed unless their missing data is made derivable or
available on-chain.

## Benefits for Apogee and dapps

| Capability | Product benefit |
| --- | --- |
| Rebuildable instance index | Browser storage, extension reinstall, origin changes, or loss of the original dapp no longer erase contract knowledge. |
| `experimental_listTxManifestInstances` | A newly connected dapp can discover approved positions/capabilities without a descriptor, all UTXOs, or origin-local script registry. |
| Instance-bound execution | Apogee resolves current auth/covenant UTXOs and rejects stale or conflicting dapp hints. |
| Wallet-native position UI | Show roles, open/active/terminal status, balances, deadlines, claimable funds, and available actions. |
| Counterparty transition following | Detect acceptance, repayment, liquidation, fills, or escrow progress even when the transaction did not pay the wallet directly. |
| Native alerts | Notify about expiry, claimability, repayment, liquidation risk, or required action without keeping the dapp open. |
| Transferable capability recovery | Factory/admin/claim NFTs received from another wallet remain discoverable and usable after seed restore. |
| Standard state export | Recreate portable ELIP-style instance/state files for another compatible tool. |
| Dapp/indexer resilience | Users can identify and recover contract-controlled funds even if the original service disappears. |

`experimental_listTxManifestInstances` consumes the tracker's validated cache; it
does not approve manifests, assign roles from dapp hints, or lower required
evidence. The response must carry discovery/completeness status even when it has no
instance rows. Each row should include an origin-scoped opaque handle, chain tip,
reconstruction/validation/tracking status, allowlisted fields and roles, readiness,
and a typed blocking reason. Execution re-resolves resources and validates against
a fresh tip rather than spending cached outpoints.

## Security and privacy constraints

- Never trust a marker or recovery payload by itself. Require the complete shared
  action validation prescribed by the class: current-state proof where independently
  sufficient and provenance proof wherever authenticity depends on lineage.
- Do not fetch or execute arbitrary bundle URLs named by on-chain data.
- Treat inbound capabilities as untrusted candidates until reconstruction and the
  required validation succeed; dust/spoofed assets must not become active
  instances.
- Treat multiple valid backward bindings as `ambiguous`; never resolve them by
  registry order or a best-fit heuristic.
- Bound graph depth, node count, chunks, network time, and concurrent candidates;
  make long scans resumable. Limit exhaustion produces `partial`, not absence.
- Track scan completeness explicitly. “No instance” requires complete discovery,
  terminal classification of every candidate, completed required validation, and
  complete tracking through the reported tip. An unavailable backend must not make
  a dapp offer duplicate setup.
- Treat indexers as locators and reverify raw transaction evidence locally.
- Forbid arbitrary code, URLs, recursion, and unbounded expressions in sidecars or
  recovery traversal metadata. Dapp requests cannot weaken required evidence.
- Roll back derived state on reorg and represent competing mempool/confirmed
  successors without guessing a winner. Key caches by definition version and tip.
- Recovery records and stable genesis links are permanent public fingerprints.
  Publish only the minimum basis required for funds recovery.
- External outspend and asset lookups reveal protocol participation to the chain
  backend. Prefer the user's configured/private backend and avoid broad per-asset
  third-party queries.

## Recommended implementation sequence

### Phase A: minimal generic engine, lending as the first definition

1. Define a small generic bidirectional action IR/evaluator with typed bindings,
   canonical record codecs, unique backward matching, shared instance identity, and
   resource effects.
2. Define the generic four-stage status model and tip-bound resource tracker before
   adding protocol-specific semantics.
3. Normalize the existing Lending v3 bundle plus a trusted sidecar pinned to its
   exact hash into that IR. Reuse its named inputs/outputs for forward validation
   and backward reconstruction.
4. Add the generic transaction inspector, LWK explicit-`txos()` discovery source,
   and bounded raw-transaction/ancestor/outspend graph.
5. Store a wallet-global discardable cache keyed by relation hash,
   traversal-profile hash, chain, account, and tip; then expose permissioned
   `experimental_listTxManifestInstances` and instance-bound execution over the
   generic tracker.
6. Prove construction/reconstruction and execution/tracking parity across all
   eight currently supported Lending actions, including backward constructor
   ancestry, counterparty-only transitions, conflicts, and reorgs. Fail closed on
   valid but unsupported deployed-contract transitions.

### Phase B: lending coverage and capability transfer

1. Add `TransferFactoryAuth` to a new retained lending bundle version and require
   provenance for received factory authority.
2. Replace the current blanket wallet-input history rule with a verified designated
   wallet-output role for this action.
3. Quarantine unsolicited/fake candidates and add transfer/reorg/spam tests.
4. Add the remaining deployed contract actions or retain an explicit
   `unsupported-transition` boundary for each unmodeled path.

### Phase C: cross-dapp validation and upstream extension

1. Express at least two additional dapp archetypes in the already-generic IR and
   test both validation modes before freezing the model.
2. Prototype optional `TXMR` encoding for their non-derivable fields/links and add
   durable content-addressed approved-bundle/sidecar/traversal-profile archival.
3. Specify the shared relational action model, instance/resource effects, and
   `current_state | provenance` validation modes as common semantics; specify
   discovery/traversal, backend, privacy, bounds, and completeness separately.
4. Propose the proven model as an upstream TX Manifest extension.

## Test plan

- Explicit-only inbound asset restore with no anchor or imported txid.
- Construction-to-history round trips proving that one record codec and action
  relation produce and recover identical typed instance fields.
- Execution-time and recovery-time resource effects producing identical state.
- Zero backward bindings classified as unsupported and multiple bindings as
  ambiguous.
- A self-authenticating fixture proving `current_state` recovery does not silently
  depend on constructor ancestry.
- A spoofed one-unit factory asset rejected under `current_state` and held until
  provenance succeeds.
- Full semantic fixtures for every currently supported lending action, including
  malformed issuance, asset/value/index/script, fake markers, and wrong deployment
  constants.
- Factory rotation and multiple concurrent offers.
- Pending-to-cancel and pending-to-accept branches.
- Principal claim before/after other active-state observations.
- Repay/liquidate conflict and lender-vault claim.
- Borrower restore following lender-only acceptance; lender restore following
  borrower-only repayment.
- Factory-auth transfer in/out and backward issuance/companion lineage.
- Valid partial-repayment, factory-removal, and protocol-fee withdrawal fixtures
  produce `unsupported-transition` until those actions are implemented.
- Mempool, RBF, double-spend, confirmation, and reorg rollback.
- Deleted/corrupt semantic cache reproducing the same state from mnemonic+chain.
- Unknown bundle, duplicate marker/record, chunk ambiguity, fake one-unit asset,
  and graph/resource exhaustion.
- RPC permission, origin-scoped handles, pagination, scan completeness, and no
  descriptor/raw-outpoint leakage.
- Dapp requests unable to downgrade a class's minimum validation evidence.
- Legacy sidecar and future embedded definitions normalizing to the same relation.

## Sources and related work

- [TX Manifest ELIP draft (PR #41 snapshot)](https://github.com/ElementsProject/ELIPs/blob/bb1e78990a60396837340b54bb6ccd1c497cb576/elip-xxx.mediawiki)
- [Elements standard OP_RETURN policy](https://github.com/ElementsProject/elements/blob/b7fc5d080a7e9ccc0ef48c3ba11db243e794bdb0/src/policy/policy.h)
- [Elements multi-data standardness check](https://github.com/ElementsProject/elements/blob/b7fc5d080a7e9ccc0ef48c3ba11db243e794bdb0/src/policy/policy.cpp#L160-L186)
- [Liquid network multi-data settings](https://github.com/ElementsProject/elements/blob/b7fc5d080a7e9ccc0ef48c3ba11db243e794bdb0/src/kernel/chainparams.cpp#L1288-L1300)
- [Current Apogee action-hint spike](./tx-manifest-action-hint-spike.md)
- [Current Apogee TX Manifest internal specification](./tx-manifest-internal-spec.md)
- [Deadcat chain-only recovery design (pinned snapshot)](https://github.com/Resolvr-io/deadcat/blob/246e9383c6b8a190e10d128612f8706607fb7856/docs/protocol/chain-only-recovery.md)

The Deadcat design is a useful adjacent example: it constrains supported contract
parameters to compact canonical encodings and uses 37–69-byte creation hints plus
asset-issuance lookup and deterministic seed-derived keys. That illustrates both
the feasibility and the tradeoff: complete mnemonic recovery often requires an
opinionated recoverable subset rather than accepting arbitrary unencoded
constructor values.
