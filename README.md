# Apogee

A self-custodial **Liquid (LBTC)** wallet browser extension. Apogee holds the keys
and signs; web apps connect to it as a dapp through an injected `window.liquid` /
`window.apogee` provider. The app never exposes a seed to the page.

<!-- A github.com/user-attachments URL inherits the access control of wherever it
     was uploaded, so one minted from a private context 404s for logged-out visitors
     and the image breaks for everyone but the uploader. This one was uploaded to an
     issue on this repo, so it is public — verified by an unauthenticated fetch.
     Re-upload the same way if it is ever replaced. -->

<img width="1280" height="800"
     alt="Five Apogee side-panel screens: the lock screen over an animated ocean; wallet creation; the balance showing a portfolio total above its price chart, an Assets list and recent activity; a receive address with QR; and settings"
     src="https://github.com/user-attachments/assets/0355c3ac-ec8a-455f-a1c4-faa20646c8c3" />

## Run / build

```sh
pnpm install
pnpm dev      # vite build --watch
pnpm build    # production build → dist/
```

Load it: `chrome://extensions` → enable **Developer mode** → **Load unpacked** →
`dist`. Use a Chromium browser (Chrome/Brave) — Jade pairing needs Web Serial.

## Architecture (MV3)

CRXJS + Vite + React + Tailwind, with **`lwk_wasm`** (Blockstream's Liquid Wallet
Kit, compiled to WASM) as the wallet engine. All wasm and key material live in
the service worker / offscreen document; the side panel and connected pages only
ever receive watch-only data and signing requests.

| Surface          | File                              | Role |
| ---------------- | --------------------------------- | ---- |
| Background SW    | `src/background/index.ts`         | message router; brokers UI ↔ engine ↔ dapp provider; auto-lock; connected-site sessions |
| Offscreen engine | `src/offscreen/`                  | runs `lwk_wasm` — the only place wasm + signing live |
| Keystore         | `src/keystore/`                   | seed encrypted at rest; watch-only descriptor in cleartext; MV3 session recovery |
| Side panel       | `src/sidepanel/`                  | the wallet UI (onboarding, unlock, balance, receive, send, settings) |
| Content bridge   | `src/content/content.ts`          | ISOLATED world; relays `window.postMessage` ↔ `chrome.runtime` |
| Page provider    | `src/provider/liquid-provider.ts` | MAIN world; defines `window.apogee` for web pages |
| Jade window      | `src/jade/`                       | Web Serial pairing with a Blockstream Jade |

## What's been built

### Wallet core
- **`lwk_wasm` engine** in an offscreen document — descriptor derivation, chain
  sync via Esplora, balance, addresses, transaction history, and PSET
  build / sign / broadcast.
- **Encrypted keystore** — BIP-39 seed encrypted at rest (PBKDF2 → AES-256-GCM);
  the watch-only descriptor is stored in cleartext so balances sync while locked;
  MV3 session recovery keeps the wallet unlocked across service-worker eviction;
  idle auto-lock.
- **BIP84 native-SegWit derivation** — the standard
  `ct(slip77(...),elwpkh([fp/84'/<coin>'/0']xpub/<0;1>/*))` descriptor (`coin` is
  `1776'` on mainnet, `1'` on testnet). The same seed restores in Blockstream
  Green / Jade (verified to the same master fingerprint). A legacy flat `m/*`
  scheme was removed in favour of this standard, interoperable form. (Funds on a
  non-native path — e.g. BIP49 "Legacy SegWit" — won't show; see Pending.)

### Side panel
- Onboarding makes hardware-vs-local a **one-time choice at init**, and picks the
  network (**Mainnet** or **Testnet**) for create, restore, and Jade pairing alike:
  create or restore a seed, **or** connect a hardware wallet.
- Unlock, balance — the whole portfolio as one figure, rendered as sats / LBTC / fiat
  with hide-balance; defaults to sats — receive (branded address + QR),
  send (build → review → sign → broadcast), Received / Sent **toasts**, a persistent
  **connection-status bar**, and settings (network, currency, denomination, auto-lock,
  background animation, reveal seed, connected apps).

### Jade hardware (E2 + E3)
- **Seedless wallets** — a wallet is either a local seed or a Jade (watch-only
  descriptor + fingerprint, no seed stored).
- **Pairing** — choose the network, then a Jade tab connects over Web Serial,
  reads the device's wpkh descriptor + fingerprint, and registers a watch-only
  wallet. The chooser is filtered to Blockstream-chip devices with a "show all"
  fallback; the device fingerprint is verified before signing.
- **On-device signing (E3)** — a send routes its PSET to a Jade signing tab; you
  review the transaction summary and approve **on the device**, then Apogee
  finalizes + broadcasts. Works for both the side panel's Send and a connected
  dapp's send. Pairing + signing are a branded card flow (Connect → Review → Done)
  on a starfield background.
- Reveal-seed is hidden for Jade wallets, and Settings shows the signer type.

### Dapp providers
- A page connects via the injected provider → content bridge → service worker.
  Surface: `connect`, `getStatus`, `getNewAddress`, `getBalance`, `send` (the page
  passes address + amount; Apogee builds the PSET, reviews, signs, broadcasts),
  `disconnect`, plus `on` / `off` events.
- **Approvals** — connecting a new site and every send raise an approval (an
  overlay in the side panel when open, a popup window otherwise); nothing is
  granted or signed without the user's confirmation. If the wallet is locked, the
  approval offers an unlock step instead of forcing a reject, and a success state
  confirms the outcome. A Jade send then signs on-device.
- **Per-site sessions** — the SW tracks connected origins; every call except
  connect / disconnect requires an approved session, so revoking a site actually
  cuts it off.
- **Connection status** — a persistent bar with a green status light when a site
  is connected, plus a connected-apps list in Settings (origin + disconnect).
- **Lock-aware balance** — a locked wallet returns no balance (the dapp shows a
  locked state and recovers on unlock) instead of a misleading 0.
- **Serialized engine calls** so the dapp and the side panel can't
  re-entrantly alias a cached `lwk_wasm` `Wollet`.

New integrations discover the Liquid browser provider through
`liquid:requestProvider` / `liquid:announceProvider`, then use its minimal
`request` and `on` interface. The older `window.liquid` and `eip6963:*` surface
remains available for compatibility but is not the standardized discovery path.
The implementation is in [`src/provider/liquid-provider.ts`](src/provider/liquid-provider.ts).
Developers can exercise the real injected boundary with the
[Liquid provider playground](docs/liquid-provider-playground.md).
The standard provider currently implements `getBalance`, `getUTXOs`,
`getWalletDescriptor`, `sendTransfer`, and `signPset`. Descriptor disclosure is a separate,
explicit per-origin permission: Apogee returns only a checksummed ordinary
public descriptor and never exports its SLIP-77 master blinding key.
PSET signing is also separately permissioned and individually approved. Its
[wallet-scoped analyzer](docs/provider-pset-analyzer.md) revalidates every
transaction effect before local or Jade signing; Apogee returns the signed PSET
by default. A caller can explicitly request `broadcast: true`; the approval then
states that Apogee will finalize and broadcast the transaction, and a successful
result includes both the signed PSET and its transaction id.

## Unreleased

- **Smaller things** — the Testnet/Regtest marker beside the logo is now a
  hard-edged caution placard in the console voice rather than a rounded pill.

## 0.7.0

- **The balance is the whole portfolio, not just L-BTC.** A wallet holding USDt
  and no L-BTC used to read "0 sats" at the top of the panel while the Tokens
  list right below it showed a real balance. The headline figure now folds in
  every USD-pegged token at the spot rate and calls itself a total, so the number
  you see first is the one you actually hold. Sats, LBTC and fiat are three
  renderings of a single figure rather than three separate sums, so they cannot
  drift apart from each other.
- **Nothing is guessed, and nothing is quietly dropped.** An asset with no price
  source is left out of the total rather than counted as zero or scaled as though
  it were a dollar — and the line beneath the figure says how many were left out,
  so the total never silently understates what you hold. While a price is still
  in flight the figure keeps the same "not final" pulse the wallet already uses
  for an unconfirmed balance, and stops pulsing once the rate has definitively
  failed rather than pulsing forever. A wallet holding only L-BTC sees no change
  at all — same figure, same wording. Send and Swap read per-asset balances
  straight from the chain, so a wrong or missing rate can misprice this figure
  but can never change what leaves the wallet. See
  [`docs/price-sources.md`](docs/price-sources.md).
- **Coins: see and tidy your unspent outputs.** A new screen under Settings lists
  every UTXO grouped by asset, and combines one asset's outputs into a single
  output when they've fragmented across many small pieces. The pending
  consolidation shows its txid with an explorer link and clears itself once the
  chain sees it.
- **Liquid apps can do more, and each capability is its own permission.** Beyond
  connecting and requesting a send, an app can ask for your unspent outputs, a
  public wallet descriptor, or a signature on a transaction it built — granted or
  refused one at a time. A signing request is revalidated against the wallet by
  its own [PSET analyzer](docs/provider-pset-analyzer.md) and shows the exact
  inputs, recipients, asset changes, and fees before you approve; Apogee returns
  the signed transaction and broadcasts only when the app asked and you agreed.
  Apps discover the wallet through the standard `liquid:requestProvider` event.
- **Approvals show exactly what you're agreeing to.** Send approvals display
  the recipient's full address instead of a shortened one, and the requesting
  site's domain stays visible even when the origin is long. Token sends mark
  registry-sourced names as unverified — the asset ID, not the label, is what
  identifies the asset.
- **Your seed phrase no longer crosses the extension's broadcast channel.**
  Restoring a wallet and scanning a seed-phrase QR travel over a private,
  point-to-point connection between the panel and the wallet backend, where no
  other extension context can observe them.
- **Encrypted storage upgrades itself in place.** When Apogee's encrypted
  storage format changes, your wallet migrates automatically the first time you
  unlock — no re-import needed. A vault that can't be upgraded says so
  immediately instead of reporting a wrong password, and unlock attempts are
  never wasted on one.
- **Changing your password is throttled like unlocking.** The progressive
  lockout that guards unlocking now also guards the old-password check when
  changing your password.
- **Less of your wallet stays decrypted while unlocked.** Seeds are decrypted
  only for the moment a wallet signs, not all at once for the whole session.
  A password step-up that hits the lockout now shows its countdown and offers a
  way back out.
- **Smaller things** — a one-time intro plays on first run; transactions open in
  liquid.network rather than blockstream.info; amounts are set in the telemetry
  face with tickers in the body face; a Settings drawer scrolls itself into view
  instead of opening off-screen.
- **Under the hood** — the wallet engine rides out service-worker restarts with
  reconnect backoff and per-connection state; resetting the wallet also clears
  the cached asset icons it displayed; CI third-party actions are pinned to
  commit SHAs and the review bot only answers trusted commenters; a dependency
  with a known advisory (postcss) is held to its patched version. The at-rest
  and provider threat model is now documented in
  [`SECURITY.md`](SECURITY.md).

## Earlier releases

Notes for 0.6.0 and earlier live on the
[Releases page](https://github.com/Resolvr-io/apogee/releases).

## Pending

- **Multi-wallet UI** — adding a wallet currently requires a reset (onboarding
  only appears when there are none); expose add / switch.
- **Legacy-path sweep** — only native SegWit (BIP84) is derived, so funds on a
  legacy path (e.g. BIP49 "Legacy SegWit") show 0 until moved; detect + offer a
  sweep.
- **Persistent Jade connection** — each send opens a fresh signing tab (one Web
  Serial port at a time); keep a paired tab connected instead.

## Acknowledgements

- [Blockstream Liquid Wallet Kit (`lwk_wasm` / LWK)](https://github.com/Blockstream/lwk),
  [Blockstream Jade](https://blockstream.com/jade/), the
  [Liquid Network](https://liquid.net/), and Blockstream's Esplora.
- **Fonts** — [Satoshi](https://www.fontshare.com/fonts/satoshi) (Indian Type
  Foundry, via Fontshare's free license) for the UI, and **Apogee Telemetry**
  for numeric displays: our patched build of
  [Routed Gothic](https://webonastick.com/fonts/routed-gothic/) by Darren Embry,
  licensed under the [SIL Open Font License 1.1](public/fonts/ApogeeTelemetry-LICENSE.md)
  and renamed per the OFL's reserved-name rule. Modifications are documented in
  the license file and reproducible via
  [`tools/patch-telemetry-font.py`](tools/patch-telemetry-font.py). The style
  is a nod to the telemetry readouts of *2001: A Space Odyssey*.
- Built by **Resolvr**.
- Built with CRXJS, Vite, React, and Tailwind CSS.
