# Apogee — Firefox Add-ons (AMO) listing

Version-controlled copy of the AMO submission text. This is the first Firefox
release, so it states features rather than a "what's new." Keep in sync with
`package.json` and the Firefox manifest in `manifest.shared.ts` (`firefoxManifest`).

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

## Release notes (first release)

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
  - `api.coinbase.com`, `api.kraken.com`, `api.coingecko.com`, `api.coinpaprika.com`, `blockchain.info` — public price sources; Apogee uses the median of those reachable to show a fiat value.
  - All are read-only chain/price requests; the only user-derived data sent is an encrypted wallet descriptor (sync) or a user-approved signed transaction (broadcast).
- **content scripts on `<all_urls>`** — Injects a small `window.liquid` provider into pages so Liquid web apps can request a wallet connection (the same pattern as `window.ethereum`). The provider only exposes a connect/request interface and does not read page content; every connection and transaction needs explicit in-add-on approval.
- Apogee uses a **sidebar** (not a Chrome side panel) and runs its wallet engine in the extension's background page, so it needs no `sidePanel` or `offscreen` permission.
- **Remote code: No** — All executable code, including the lwk_wasm WebAssembly module, is bundled in the package. Apogee fetches only data (chain state, prices), never code.

## Notes to reviewer

Plain text — the AMO reviewer-notes field renders literally, so no markdown below.

No account or login required. Choose Create wallet, set a password, and you're in; keys are generated and stored locally, with no backend.

Testing tip: switch the network toggle to Testnet on the create screen. Then fund it from a Liquid testnet faucet to exercise receive/send without real funds.
https://liquidtestnet.com/faucet

Apogee lives in the Firefox sidebar.

The add-on bundles a WebAssembly wallet engine (lwk_wasm) compiled from Rust. Source and build instructions are public at https://github.com/Resolvr-io/apogee — run "pnpm install" then "pnpm build:firefox" to produce the dist-firefox output this package is zipped from.

Homepage / support: https://apogee.resolvr.io
