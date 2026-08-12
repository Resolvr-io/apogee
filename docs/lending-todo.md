# Simplicity Lending TODO

This backlog covers the work remaining after the first Apogee-native implementation
of the Simplicity Lending v3 lifecycle. The current integration supports Enable
Borrowing, Create Offer, Accept Offer, Claim Principal, full Repayment, Collect
Repayment, Cancel Offer, and Liquidate Offer on Liquid testnet through the
event-discovered provider.

## Release validation

- [x] Complete a controlled two-wallet Liquid testnet demo.
  - [x] Repayment branch: Enable Borrowing -> Create Offer -> Accept Offer -> Claim
    Principal -> Repay in full -> Collect Repayment.
  - [x] Cancellation branch: Create Offer -> Cancel Offer.
  - [x] Default branch: Create Offer -> Accept Offer -> Claim Principal -> wait for
    expiry -> Liquidate Offer.
  - [x] Confirm the indexer and web UI show every state transition correctly.
- [x] Automate explicit rejection, lock-during-approval invalidation, same-request
  retry, concurrent duplicate coalescing, terminal replay, conflicting request-ID
  rejection, page reload, and disconnect/reconnect coverage. Each failure path
  asserts that nothing was broadcast; concurrent and terminal retries assert one
  approval, one transaction, and one recovered on-chain action hint.
- [x] Add automated browser/extension coverage for all eight manifest actions.
- [x] Run the lifecycle against the exact production extension build and record
  transaction IDs, bundle hash, chain height, and observed balances.

### Liquid testnet validation record (2026-08-10)

- Trusted bundle: `sha256:debdae89777fdd21fec2d763efe028876f267ff214aca9ddf9b3735d7657be15`
- Confirmed block range: `2567412` through `2567442`
- Enable Borrowing: `ab18168d5923c36714ef7f0fc0bd677f9893423611b99579503ab5c262fef08d`
- Cancellation branch: create `3cfea1dc752a882ce135557b53c3aa0082784b5044747041ecaa2f6d7eebad47`,
  cancel `bf8568e93f9285139c4aeb6330663328d8c7f5bb0788216fb924dfc78c6fcde6`
- Default branch: create `a6f10ad5914989011809817cc18df3ea7b7ae249a7994889e8fd3b227eaecabd`,
  accept `110098e0d6d2f79b589b2d1e498953ca5e6f36657baa836494bfe6fd6ffffc8d`,
  claim `438438a0a333345e3a4e82b742e57705aed4a17fcc2309c3e9be2dfd77ac28db`,
  liquidate `74f743c9f2cbb4c10d60c55cc7e4c97014136b4bcc038bc1b60668270ad0973a`
- Repayment branch: create `719677f58b85199a68b05d13f5f2e7a62c96a15e7e528b0b05ebd453ff44c36f`,
  accept `c79aee4968e86cd1a17ccda11e6d6753c3766af180ff4b5879b99e921f5d13bc`,
  claim `6229e7e1cf536740e96f2bb96639d58369fc57d83619c74341dcad4425d47de7`,
  repay `de409f3da05db5d8a61f342897c31687cd07fc864359de58cff082f8c84476d9`,
  collect `6418b37009ef20472ca3d76b486af16f490058381a301d17c361e46350b37538`
- Final UI state: cancellation offer `Cancelled`, default offer `Liquidated`, repayment
  offer `Claimed`; borrower showed `0.00062974` L-BTC and `1.9` TEST-USDT, lender
  showed `0.00025` L-BTC and `3.09` TEST-USDT.

### Local regtest browser validation (2026-08-10)

- `pnpm test:lending:regtest` passed the complete two-wallet lifecycle in 3.9
  minutes against the real unpacked Apogee build, lending web, API, indexer,
  Elements/electrs stack, and disposable Postgres database.
- The test used only event-based provider discovery and approved all eight trusted
  actions through Apogee: Enable Borrowing, Create Offer, Cancel Offer, Accept
  Offer, Claim Principal, Repay in Full, Collect Repayment, and Liquidate Offer.
- The scenario verified the terminal `Cancelled`, `Claimed`, and `Liquidated` UI
  states after confirmation and indexer ingestion.
- The reliability extension intentionally locks and rejects an open manifest
  request, retries the identical request concurrently, replays its durable result,
  rejects conflicting reuse, revokes a second open approval by disconnecting, then
  reconnects and reloads the dapp. The successful retry is asserted in mempool,
  on-chain, in wallet history, and after seed recovery.
- Regtest execution remains build-gated test infrastructure; ordinary Chrome,
  Firefox, unit-test, and release builds do not trust the regtest chain.

## Contract lifecycle

- [ ] Support partial repayments.
  - Add a distinct trusted manifest action and signer-visible review.
  - Preserve the Borrower NFT and recreate the active offer with reduced debt.
  - Unlock collateral proportionally.
  - Create or roll forward the lender and protocol-fee vaults across all repayment
    phases.
  - Add repayment-amount controls and updated debt/collateral presentation to the
    lending web.
  - Cover the first partial repayment, fee repayment, principal repayment, and
    final repayment transitions.

## Signers and networks

- [ ] Enable Jade-backed TX Manifest execution.
  - Prove Jade/LWK can sign mixed PSETs containing wallet inputs and Simplicity
    covenant inputs.
  - Prove the Enable Borrowing issuance PSET is accepted by Jade.
  - Bind the approved unsigned transaction across the device-signing round trip.
  - Revalidate chain state, finalize covenant witnesses, dry-run, and broadcast in
    Apogee after the device returns its signatures.
- [ ] Enable mainnet only after the trusted bundle, compiler/runtime, fee policy,
  hardware path, recovery behavior, and lifecycle testing are release-ready.
- [ ] Decide whether regtest should be a supported application network or remain a
  development-only harness.

## Wallet and indexer integration

- [x] Promote the successful TX Manifest on-chain action-hint prototype into
  verified transaction-history annotations.
  - [x] Keep the dedicated position-independent OP_RETURN placement validated across
    all eight lifecycle actions in `docs/tx-manifest-action-hint-spike.md`.
  - [x] Add an explicit trusted-registry opt-in instead of injecting outputs into
    arbitrary manifests or changing the dapp-facing bundle identity.
  - [x] Scan every OP_RETURN datum in LWK-discovered wallet transactions, resolve the
    vendored bundle/action, and verify action postconditions before labeling it.
  - [x] Preserve the mnemonic replacement/restoration coverage in the regtest suite.
- [ ] Recover counterparty-only contract transitions as a separate discovery
  feature; an action marker does not make those transactions seed-discoverable.

- [ ] Add native indexer support for rotating wallet identities.
  - Replace client-side per-script querying and aggregation with a privacy-reviewed
    portfolio discovery design.
  - Define recovery across cleared browser storage, new browsers, and new devices.
  - Avoid a permanent public address-0 identity and document the correlation model.
- [ ] Add a durable export/import or wallet-owned recovery mechanism for the set of
  lending portfolio scripts until native indexer support is available.
- [ ] Decide whether Apogee should expose a privacy-scoped lending portfolio query,
  or whether discovery belongs entirely in the lending indexer.

## Transaction construction

- [x] Replace the one-sufficient-UTXO-per-asset policy with deterministic multi-UTXO
  coin selection.
  - Uses exact-match-first, bounded best-fit selection with a 12-input-per-asset
    limit and stable outpoint tie-breaking.
  - Preserves exact approval accounting and stable transaction ordering.
  - Covers fragmented L-BTC, collateral, and principal balances in unit tests and
    the complete regtest browser lifecycle.
- [x] Calibrate and apply a wallet-owned minimum-change policy for L-BTC.
  - [x] Complete the sizing and convergence spike in
    `docs/tx-manifest-minimum-change-spike.md`: confidential change costs 67–69
    discounted vbytes, a future P2WPKH spend costs 68 discounted vbytes, and the
    wallet-owned post-creation floor is 7 sats at the 100 sat/kvB long-term rate.
  - Deterministic selection prefers exact change or at least 7 sats. An unavoidable
    1–6 sat L-BTC remainder becomes additional fee and produces no change output;
    issued-asset change is never folded into fees.
  - Approval revalidation retains both the selection fee and the actual reviewed
    fee, reproducing the same inputs and tiny-change decision without silently
    changing the approved transaction.
  - Recalibrate the long-term rate and floor as part of mainnet release review;
    live confidential-output creation cost remains covered by dynamic estimation.
- [x] Replace the fixed 1,000-sat fee with dynamic fee estimation.
  - Uses Esplora's 1-block estimate and the finalized PSET's discounted virtual
    size, including a conservative bound for every unsigned wallet witness.
  - Rebuilds with deterministic coin selection until the required fee and
    transaction shape converge, with an iteration bound and wallet-owned fee cap.
  - Keeps the dapp's lower maximum-fee constraint authoritative.
  - Pins the exact reviewed fee during approval-time revalidation; a higher
    required fee fails and requires a fresh approval instead of changing silently.
  - Falls back to LWK's conservative 100 sat/kvB default when Esplora fee estimates
    are missing or invalid.

## Manifest distribution and upgrades

- [ ] Design trusted manifest installation or distribution beyond bundles compiled
  into Apogee.
- [ ] Define coordinated version negotiation and upgrade behavior between Apogee,
  the lending web, deployed contracts, compiler revisions, and the indexer.
- [ ] Decide whether a reviewed remote registry is desirable; continue to fail
  closed for unknown bundle hashes and unsupported extensions.

## Reliability and production hardening

- [x] Eliminate the narrow recovery gap where broadcast succeeds but the browser
  stops before Apogee durably records the idempotent result.
  - [x] Persist the exact signed transaction in an encrypted, wallet-bound
    checkpoint before submission; a failed checkpoint write prevents broadcast.
  - [x] On an identical retry, return an already-observed transaction without a
    prompt or show an explicit recovery approval before rebroadcasting the exact
    saved bytes. Recovery never rebuilds or re-signs.
  - [x] Preserve unresolved checkpoints across terminal-record pruning, reject
    conflicting request-ID reuse, and require a new request ID after a permanent
    transaction-invalidity response.
  - [x] Cover checkpoint persistence failure, interrupted broadcast/terminal
    persistence, recovery, retention, chain lookup, and recovery copy in unit tests.
  - [x] Exercise an accepted broadcast with a deliberately lost response, terminate
    the extension worker, and prove that the same request recovers the result with
    exactly one on-chain transaction in the regtest browser suite.
- [ ] Test service-worker restart and browser shutdown during preparation, approval,
  hardware signing, and the other pre-checkpoint phases.
- [ ] Expand user-facing recovery guidance for insufficient funds, fragmented coins,
  stale indexer state, expired offers, changed chain state, and unavailable chain
  servers.
- [ ] Complete an independent security review before enabling mainnet.
