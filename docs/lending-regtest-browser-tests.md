# Simplicity Lending regtest browser test

The lending regtest test runs the real Simplicity Lending web application against
an unpacked production Apogee extension build. It uses a disposable local Elements
chain, electrs/Esplora, Postgres database, lending API, and lending indexer. No
testnet account, browser profile, or real funds are involved.

## Coverage

One serial browser scenario creates independent borrower and lender Apogee wallets
and exercises every trusted Simplicity Lending v3 manifest action:

1. Enable borrowing.
2. Create and cancel an offer.
3. Create and fund a second offer, claim the principal, repay it in full, and
   collect the repayment.
4. Create and fund a third offer, advance the local chain past expiry, and
   liquidate it.
5. Create and fund a fourth offer, advance it past expiry, and execute repayment
   and liquidation concurrently from the borrower and lender wallets.

Every action uses event-based provider discovery, the wallet connection prompt,
Apogee's manifest review prompt, real wallet signatures, broadcast, confirmation,
indexer ingestion, and the resulting lending UI state. The suite never uses
`window.liquid` or bypasses Apogee to construct a lifecycle transaction.

The scenario also exercises the provider's reliability contract through the real
extension boundary: lock during approval, explicit rejection, identical retry,
two concurrent duplicate requests, terminal-result replay, conflicting request-ID
reuse, disconnect during approval, reconnect, and page reload. It checks the
mempool after each boundary, proving failed requests broadcast nothing and all
successful duplicates resolve to the single reviewed transaction. The resulting
action hint must also be visible on-chain, in wallet history, and after seed
recovery.

The concurrent expiry scenario is deliberately winner-agnostic. Both wallets
build, review, sign, and locally record transactions that spend the same active
offer outpoint. The harness allows exactly one transaction to reach the node, then
asserts that it is the sole mempool and on-chain winner. The competing transaction
must resolve to `Transaction Superseded`, retain its attempted transaction ID and
the winning transaction ID, and show the same failure and winner link after the
dapp is reloaded. The final indexed offer state must agree with whichever action
won.

The wallets are seeded with fragmented L-BTC and principal-asset outputs. The
scenario asserts that Create Offer, Accept Offer, and Repay Loan each consume
multiple wallet funding inputs, covering collateral, principal, repayment, and
fee selection through the production manifest path.

## Prerequisites

- Node.js 22.18 or newer and pnpm 10.
- Rust and Cargo.
- Docker running locally.
- Dependencies installed in both Apogee and the sibling
  `simplicity-lending/web` workspace.
- `simplex` on `PATH`, installed at the commit pinned by the lending repository's
  CI (`1945d11b47fff8838c3e99c210133519a9522324`).

By default the runner expects these repositories to be checked out as siblings:

```text
<parent>/apogee
<parent>/simplicity-lending
```

Set `SIMPLICITY_LENDING_DIR` when the lending checkout lives elsewhere. Set
`SIMPLEX_BIN` when the pinned `simplex` executable is not on `PATH`; the runner
also adds that executable's directory to its child-process path so the matching
`elementsd` and `electrs` binaries installed beside it are used.

## Run

From the Apogee repository:

```bash
pnpm test:lending:regtest
```

The runner allocates free loopback ports, issues a fresh principal asset, builds
the lending repository's generated contract artifacts, builds Apogee with the
test-only regtest manifest flag in the ignored `dist-lending-regtest/` directory,
and cleans up its processes and named Postgres container on success or failure. A
failure retains a Playwright trace under `test-results/`.

## Safety boundary

Regtest manifest execution is compiled in only when
`APOGEE_TX_MANIFEST_REGTEST=1` is present during the extension build. Normal
development, release, Firefox, and unit-test builds set the flag to false, and the
trusted lending manifest remains Liquid-testnet-only in those builds. Regtest is
therefore test infrastructure, not a selectable application network.
