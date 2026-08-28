# Apogee — Chrome Web Store listing

Version-controlled copy of the Web Store submission text, so a version bump starts
from source rather than re-typing into the dashboard. Keep in sync with
`package.json` version and the permissions in `manifest.config.ts`.

## Description

Apogee is a self-custodial wallet for the Liquid Network — the Bitcoin sidechain built for fast, low-fee, confidential transactions in LBTC and other Liquid assets.

Your keys, your coins. Apogee generates and stores your keys locally, encrypted on your device. They are never uploaded, and Resolvr never has access to them. No accounts, no sign-up, no tracking.

WHAT YOU CAN DO
• Create a new wallet, or restore one from a standard BIP-39 recovery phrase.
• Import a watch-only wallet from a Liquid descriptor: track balances and receive without keys on this device. Restore the matching seed later and it upgrades to a full wallet in place.
• Hold, receive, and send LBTC and other Liquid assets — like USDt — with an asset picker, registry names and icons, correct decimal precision, and an approximate fiat value for USD-pegged tokens.
• Keep amounts private with Liquid's confidential transactions.
• Pair a Blockstream Jade hardware wallet and approve transactions on the device.
• Connect to Liquid web apps and authorize their transactions — you review and sign every action.

SELF-CUSTODY, DONE RIGHT
Apogee uses standard BIP84 native SegWit derivation, so the same recovery phrase restores in Blockstream Green, Blockstream Jade, and other standard Liquid wallets — you are never locked in. Your seed is encrypted at rest, the wallet auto-locks after inactivity, and a revealed recovery phrase hides itself again after 30 seconds.

PRIVATE BY DESIGN
To sync your balance, Apogee uses a Waterfalls scan server by default and encrypts your wallet descriptor to it first, so your individual addresses aren't handed to the server. It talks only to public Liquid infrastructure — Waterfalls (liquidwebwallet.org) and public Esplora servers (liquid.network, blockstream.info) — plus public price APIs to show a fiat value. No analytics, no cookies, no ads.

BUILT TO STAY UP
If a chain server is down or rate-limited, Apogee detects it in seconds and fails over to another provider, for syncing and for broadcasting alike. Wallet scan state is kept locally, so reopening the extension picks up where it left off instead of re-scanning from scratch. Prefer a specific provider? Pin it in Settings > Advanced; the choice is verified against the chain itself before it saves.

CONNECT TO LIQUID APPS
Apogee provides a wallet connection to web pages, so Liquid apps can request to connect and ask you to approve transactions. Every connection and every transaction requires your explicit approval in Apogee, and you can review or revoke connected sites at any time in Settings.

HARDWARE WALLET SUPPORT
Pair a Blockstream Jade to keep your keys on a dedicated device. Apogee builds the transaction, you review and approve it on the Jade, and Apogee broadcasts it.

GETTING STARTED
1. Install Apogee and open it from the browser side panel.
2. Create a new wallet or restore a recovery phrase, and set a password.
3. Receive LBTC to your address, or connect a Liquid app.

Apogee never asks for your recovery phrase outside of setup. Keep your phrase and password safe — because Apogee is self-custodial, no one can recover them for you if they are lost.

Apogee is a self-custodial wallet, not a custodian, exchange, or financial service.

WHAT'S NEW IN 0.8.0
• Export your wallet's descriptor and public data — the account key, the watch-only descriptor that recreates the wallet elsewhere, the master blinding key, and a public descriptor with that key removed. Grouped by what each one discloses, because one group reveals which addresses are yours and the other reveals every amount you hold. Nothing exported can sign or spend, and your seed phrase is never included. Works for seed, Jade and watch-only wallets.
• Trusted Simplicity Lending transactions — a connected Liquid app can request any of eight lending lifecycle actions, and Apogee independently resolves chain state, builds and dry-runs the covenant transaction, shows the exact effects for approval, then signs and broadcasts. Restricted to Liquid testnet software wallets in this release.
• The balance behaves like an instrument — the numerals strike when a figure changes, the balance folds away as your history scrolls, and an Animations switch turns the motion off.
• A seed QR a Jade can read — the export now carries a brightness control, so moving a wallet onto a Jade no longer depends on your screen.
• Fixes — a consolidation in flight survives leaving the Coins screen, an implausible fee estimate is refused rather than paid, and a completed contract execution keeps only its txid instead of a week of readable detail.

## Single purpose

A self-custodial wallet for the Liquid Network: hold, receive, and send Liquid assets, and approve wallet actions requested by Liquid web apps the user explicitly connects to.

## Permission justifications

- **storage** — Stores the password-encrypted wallet vault, user settings, the list of sites the user has approved, and the failed-unlock throttle counter, all in local storage on the user's device. Nothing is uploaded.
- **sidePanel** — The entire Apogee UI runs in the browser side panel: balance, send/receive, settings, and the prompts where the user approves connections and transactions.
- **offscreen** — Runs the Liquid wallet engine (lwk_wasm) in an offscreen document. The MV3 service worker is ephemeral and CSP-restricted, so the WebAssembly wallet/signing engine needs a persistent offscreen context.
- **alarms** — Schedules the inactivity auto-lock so the wallet re-locks itself, and expires stale dApp connection/signing requests.
- **host permissions** — Reads Liquid chain data and prices from public services:
  - `waterfalls.liquidwebwallet.org` — default wallet-sync scan server (one encrypted-descriptor request per sync).
  - `blockstream.info` / `*.blockstream.info` — Esplora REST for sync fallback, transaction broadcast, and the asset registry.
  - `liquid.network` — public Esplora endpoint: sync/broadcast fallback and token icons from the public Liquid asset registry.
  - `api.coinbase.com`, `api.kraken.com`, `api.coingecko.com`, `api.coinpaprika.com`, `blockchain.info`, `mempool.space` — public price sources; Apogee uses the median of those reachable to show a fiat value. `mempool.space` also serves the price history behind the optional price chart, fetched only when the user opens the chart.
  - `*.sideswap.io` — the SideSwap dealer, for the optional LBTC/USDt swap feature: requesting a quote and submitting the transaction the user approved. Contacted only when the user opens the Swap screen.
  - `api.github.com` — reads the extension's own latest release tag to tell the user whether a newer version has been published. One request to a single public endpoint, made only when the user presses "Check for updates" in Settings; never on open and never on a timer. No account, no token, and nothing about the user or their wallet is sent.
  - All are read-only chain/price requests; the only user-derived data sent is an encrypted wallet descriptor (sync), a user-approved signed transaction (broadcast), or — for a swap the user initiates — the amount and the unspent outputs needed to build it.
- **camera (no manifest permission)** — Optional QR scanning: reading a payment address in Send, or a seed phrase when restoring a wallet. Apogee requests no camera permission in the manifest; the browser's own prompt appears only when the user presses Scan, in a separate window (MV3 side panels can't surface that prompt). Frames are decoded locally and never stored or transmitted — the camera stream's tracks are stopped as soon as the window closes. A scanned seed phrase is passed inside the extension to the wallet's own signing context, is readable only once, and is never written to storage.
- **content scripts on `<all_urls>`** — Injects a small `window.liquid` provider into pages so Liquid web apps can request a wallet connection (the same pattern as `window.ethereum`). It must be available on whatever site hosts a Liquid app. The provider only exposes a connect/request interface and does not read page content; every connection and transaction needs explicit in-wallet approval.
- **Remote code: No** — All executable code, including the lwk_wasm WebAssembly module, is bundled in the package. Apogee fetches only data (chain state, prices), never code.
- **Data collection: none** — Keys/seed are generated and stored locally (encrypted), never transmitted; no analytics or tracking.

## Reviewer notes / test instructions

- No account or login required. Choose **Create wallet**, set a password, and you're in; keys are generated and stored locally, with no backend.
- To exercise send/receive without real funds, switch the network toggle to **Testnet** on the create screen (the extension defaults to Mainnet), then fund the wallet from a Liquid testnet faucet: https://liquidtestnet.com/faucet
- The dApp connection flow can be seen by visiting a Liquid web app that requests a connection; Apogee shows an approval prompt.
- Hardware (Jade) pairing needs a physical Blockstream Jade and is optional.
- About the swap feature: swaps go to the SideSwap dealer over its public JSON-RPC WebSocket. Apogee never sends a key or a seed — it receives an unsigned transaction, verifies the amounts against the quote the user approved, signs locally, and returns it; SideSwap broadcasts. Swaps run on mainnet only, so the Testnet toggle above won't exercise this screen.
- Homepage / support: https://apogee.resolvr.io
