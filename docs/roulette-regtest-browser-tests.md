# Simplicity Roulette funded regtest test

The roulette regtest test runs the real Simplicity Roulette web app and its
read-only indexer against an unpacked production Apogee build. Two independent
Apogee wallets use a disposable Simplex Elements/electrs chain. The website
indexer receives only the local electrs Esplora URL; its Elements RPC URL is
deliberately unreachable so the run proves the node-free backend. The harness
still uses Elements RPC to fund wallets and mine blocks. No public testnet
account, persistent browser profile, or real funds are involved.

## Coverage

The serial Chromium scenario exercises every trusted roulette manifest action:

1. The player creates `roulette_vault.Open`; Apogee chooses the raw player
   P2WPKH payout script and publishes it in the canonical three-chunk RLT1
   record.
2. A separate house wallet executes `roulette_vault.Take`. Apogee chooses and
   signs the collateral inputs, binds the first P2WPKH input as house
   authorization, and creates exact ACTIVE state at output zero.
3. After the relative delay, the player executes `roulette_vault.Settle` with
   the durably stored reveal secret. The test verifies the revealed-secret RLT1
   record and direct covenant payouts.
4. The player executes the adapter-only `roulette_vault.ClaimPayout`, spending
   an explicit wallet-owned terminal payout into a confidential wallet output.
5. Independent rounds advance the chain through `roulette_vault.Cancel` and
   `roulette_vault.Forfeit` timeout paths.

Every transition uses standardized provider discovery, the connection prompt,
Apogee's action-specific approval review, ordinary wallet signatures, broadcast,
confirmation, and the public chain index. The suite checks action codes `0..5`,
the round links in RLT1, the paired TXMF marker, the indexer's phase, and
Apogee's verified wallet-history annotation. It does not construct or sign a
roulette lifecycle transaction outside Apogee.

## Files

- `scripts/test-roulette-regtest.mjs` owns the disposable stack and process
  cleanup.
- `playwright.roulette-regtest.config.ts` isolates the serial browser run.
- `e2e/roulette-regtest.spec.ts` contains the funded two-wallet lifecycle.
- `.github/workflows/roulette-regtest.yml` accepts an explicit public
  `liquid-dapps` ref, installs the pinned toolchain, and runs the same command.

## Prerequisites

- Node.js 22.18 or newer and pnpm 10 for Apogee.
- The Simplicity Roulette workspace with its dependencies installed.
- The pinned Simplex CLI (`1945d11b47fff8838c3e99c210133519a9522324`)
  on `PATH`. Its adjacent `elementsd` and `electrs` binaries are used too.
- Chromium installed through Playwright.

The default local layout is:

```text
<workspace>/apogee
<workspace>/liquid-dapps/simplicity-roulette
```

Set `SIMPLICITY_ROULETTE_DIR` if the roulette checkout lives elsewhere and
`SIMPLEX_BIN` if `simplex` is not on `PATH`. Until the cross-repository roulette
work is merged, dispatch the manual CI workflow with a public branch or commit that contains
`contracts/roulette_v1.simf`, the shared RLT1 codec, and the read-only indexer;
an older `liquid-dapps` checkout cannot run this test.

## Run

From Apogee:

```bash
pnpm test:roulette:regtest
```

The runner allocates free loopback ports, compiles the contract, starts the
Simplex regtest chain, pins the indexer to that chain's genesis and policy
asset, starts the Esplora-backed roulette indexer and Vite app, builds Apogee in
ignored `dist-roulette-regtest/`, and then launches Playwright. Temporary chain
consumers, browser contexts, and SQLite projection data are cleaned up on
success or failure. Failed browser runs retain their trace under
`test-results/`.

## Safety boundary

The trusted bundle accepts the regtest chain only when Apogee is built with
`APOGEE_TX_MANIFEST_REGTEST=1`. Release and ordinary development builds do not
set that flag, so this harness does not make regtest a user-selectable manifest
execution network.
