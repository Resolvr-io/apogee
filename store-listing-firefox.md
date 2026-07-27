# Apogee — Firefox Add-ons (AMO) listing

Version-controlled copy of the AMO submission text. Keep in sync with
`package.json` and the Firefox manifest in `manifest.shared.ts` (`firefoxManifest`) —
in particular the host-permission list below, which AMO reviewers check against the
manifest.

Listing URL: https://addons.mozilla.org/firefox/addon/apogee-wallet/ — the slug is
`apogee-wallet` because `apogee` is taken on AMO by an unrelated 2019 theme.

## Name

Apogee

## Summary

A self-custodial Liquid Network wallet. Hold, receive, and send LBTC and Liquid assets like USDt with confidential transactions — keys stored locally, no accounts, no tracking.

## Description

Apogee is a self-custodial wallet for the Liquid Network — the Bitcoin sidechain built for fast, low-fee, confidential transactions in LBTC and other Liquid assets.

Your keys, your coins. Apogee generates and stores your keys locally, encrypted on your device. They are never uploaded, and Resolvr never has access to them. No accounts, no sign-up, no tracking.

WHAT YOU CAN DO
• Create a new wallet, or restore one from a standard BIP-39 recovery phrase.
• Import a watch-only wallet from a Liquid descriptor: track balances and receive without keys on this device. Restore the matching seed later and it upgrades to a full wallet in place.
• Hold, receive, and send LBTC and other Liquid assets — like USDt — with an asset picker, registry names and icons, correct decimal precision, and an approximate fiat value for USD-pegged tokens.
• Keep amounts private with Liquid's confidential transactions.
• Connect to Liquid web apps and authorize their transactions — you review and sign every action.

SELF-CUSTODY, DONE RIGHT
Apogee uses standard BIP84 native SegWit derivation, so the same recovery phrase restores in Blockstream Green, Blockstream Jade, and other standard Liquid wallets — you are never locked in. Your seed is encrypted at rest, the wallet auto-locks after inactivity, and a revealed recovery phrase hides itself again after 30 seconds.

PRIVATE BY DESIGN
To sync your balance, Apogee uses a Waterfalls scan server by default and encrypts your wallet descriptor to it first, so your individual addresses aren't handed to the server. It talks only to public Liquid infrastructure — Waterfalls (liquidwebwallet.org) and public Esplora servers (liquid.network, blockstream.info) — plus public price APIs to show a fiat value. No analytics, no cookies, no ads.

BUILT TO STAY UP
If a chain server is down or rate-limited, Apogee detects it in seconds and fails over to another provider, for syncing and for broadcasting alike. Wallet scan state is kept locally, so reopening the add-on picks up where it left off instead of re-scanning from scratch. Prefer a specific provider? Pin it in Settings > Advanced; the choice is verified against the chain itself before it saves.

CONNECT TO LIQUID APPS
Apogee provides a wallet connection to web pages, so Liquid apps can request to connect and ask you to approve transactions. Every connection and every transaction requires your explicit approval in Apogee, and you can review or revoke connected sites at any time in Settings.

GETTING STARTED
1. Install Apogee and open it from the Firefox sidebar.
2. Create a new wallet or restore a recovery phrase, and set a password.
3. Receive LBTC to your address, or connect a Liquid app.

Apogee never asks for your recovery phrase outside of setup. Keep your phrase and password safe — because Apogee is self-custodial, no one can recover them for you if they are lost.

Apogee is a self-custodial wallet, not a custodian, exchange, or financial service.

## Release notes — 0.6.0

Paste into AMO's "Release Notes" field for this version. Plain text, no markdown.

Swap LBTC and USDt without leaving the wallet. Apogee gets a quote from the SideSwap dealer and settles it as a single atomic Liquid transaction, so both sides move at once and your funds are never held by anyone. Swap in either direction, and name either the amount you want to spend or the amount you want to receive.

Before signing, Apogee checks the dealer's proposed transaction against the quote you approved: that you receive at least the agreed amount, that nothing beyond what you offered leaves the wallet (including any other asset you hold), and that the network fee is within an independent cap. If anything moved unfavorably, it is not signed.

The review screen names the dealer and states the fees, what share of the swap they represent, and the minimum you will receive. Fees are mostly flat, so a very small swap costs proportionally much more — the screen says so rather than leaving you to work it out.

Also new: a Bitcoin price chart under the balance, covering 24 hours through all time, with hover to read the price at a point in time. Import a wallet by scanning its seed-phrase QR, the counterpart to the QR Apogee already exports. QR scanning — for a seed phrase or a payment address in Send — now works in Firefox: it bundles a fallback decoder since Firefox has no built-in one. A fourth price source keeps fiat values steady when one provider rate-limits. Fixed an "engine error" that could appear briefly on first open after installing or updating.

## Release notes (0.5.0 — first Firefox release, for reference)

First Firefox release. Apogee brings the Liquid Network wallet to Firefox: create, restore, or import watch-only wallets; hold, send, and receive LBTC and Liquid assets like USDt with confidential transactions and approximate fiat values for USD-pegged tokens; and connect to Liquid web apps with per-action approval — all with keys stored locally and encrypted.

## Data collection

None. Apogee collects and transmits no personal data: keys and wallet state are generated and stored locally (encrypted), and Liquid amounts and assets are confidential on-chain. The manifest declares `data_collection_permissions: { required: ["none"] }`.

## Permission justifications

- **storage** — Stores the password-encrypted wallet vault, user settings, the list of sites the user has approved, and the failed-unlock throttle counter, all in local storage on the user's device. Nothing is uploaded.
- **alarms** — Schedules the inactivity auto-lock so the wallet re-locks itself, and expires stale connection/signing requests.
- **host permissions** — Reads Liquid chain data and prices from public services:
  - `waterfalls.liquidwebwallet.org` — default wallet-sync scan server (one encrypted-descriptor request per sync).
  - `blockstream.info` / `*.blockstream.info` — Esplora REST for sync fallback, transaction broadcast, and the asset registry.
  - `liquid.network` — public Esplora endpoint: sync/broadcast fallback and token icons from the public Liquid asset registry.
  - `api.coinbase.com`, `api.kraken.com`, `api.coingecko.com`, `api.coinpaprika.com`, `blockchain.info`, `mempool.space` — public price sources; Apogee uses the median of those reachable to show a fiat value. `mempool.space` also serves the price history behind the optional price chart, which is fetched only when the user opens the chart.
  - `*.sideswap.io` — the SideSwap dealer, for the optional LBTC/USDt swap feature: requesting a quote and submitting the transaction the user approved. Contacted only when the user opens the Swap screen.
  - All are read-only chain/price requests; the only user-derived data sent is an encrypted wallet descriptor (sync), a user-approved signed transaction (broadcast), or — for a swap the user initiates — the amount and the unspent outputs needed to build it.
- **camera (no manifest permission)** — Optional QR scanning: reading a payment address in Send, or a seed phrase when restoring a wallet. Apogee requests no camera permission in the manifest; the browser's own prompt appears only when the user presses Scan, in a separate extension window (a sidebar cannot surface that prompt). Frames are decoded locally and never stored or transmitted — the camera stream's tracks are stopped as soon as the window closes. A scanned seed phrase is passed inside the add-on to the wallet's own signing context, is readable only once, and is never written to storage.
- **content scripts on `<all_urls>`** — Injects a small `window.liquid` provider into pages so Liquid web apps can request a wallet connection (the same pattern as `window.ethereum`). The provider only exposes a connect/request interface and does not read page content; every connection and transaction needs explicit in-add-on approval.
- Apogee uses a **sidebar** (not a Chrome side panel) and runs its wallet engine in the extension's background page, so it needs no `sidePanel` or `offscreen` permission.
- **Remote code: No** — All executable code, including the lwk_wasm WebAssembly module, is bundled in the package. Apogee fetches only data (chain state, prices), never code.

## Notes to reviewer

Plain text — the AMO reviewer-notes field renders literally, so no markdown below.

No account or login required. Choose Create wallet, set a password, and you're in; keys are generated and stored locally, with no backend.

About QR scanning: it is entirely optional and only starts when the user presses Scan. On Chromium the browser's built-in BarcodeDetector decodes the frame; Firefox does not implement that API, so the add-on bundles jsQR (pure JavaScript, MIT) and decodes locally instead. No frame or decoded value leaves the device. All executable code is bundled — nothing is fetched at runtime.

About the swap feature: swaps go to the SideSwap dealer over its public JSON-RPC WebSocket. Apogee never sends a key or a seed. It receives an unsigned transaction, verifies the amounts against the quote the user approved, signs locally, and returns it; SideSwap broadcasts. Both sides settle in one Liquid transaction, so there is no point at which a third party holds the user's funds. Swaps run on mainnet only.

Testing tip: switch the network toggle to Testnet on the create screen. Then fund it from a Liquid testnet faucet to exercise receive/send without real funds.
https://liquidtestnet.com/faucet

Apogee lives in the Firefox sidebar.

The add-on bundles a WebAssembly wallet engine (lwk_wasm) compiled from Rust. Source and build instructions are public at https://github.com/Resolvr-io/apogee — run "pnpm install" then "pnpm build:firefox" to produce the dist-firefox output this package is zipped from.

Homepage / support: https://apogee.resolvr.io
