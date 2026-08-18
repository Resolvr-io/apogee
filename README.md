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
     src="https://github.com/user-attachments/assets/1659531e-e007-49d0-ba26-472ddbeb6c54" />

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

## 0.6.0

- **Swap L-BTC and USDt in the wallet.** A new Swap screen quotes an instant swap
  through the SideSwap dealer and settles it as a single atomic Liquid
  transaction — both sides move at once, so your funds are never held by anyone.
  Swap in either direction, and either name the amount you want to spend or the
  amount you want to receive.
- **Every swap is verified before it's signed.** Apogee reads the dealer's
  proposed transaction and checks it against the quote you approved: that you
  receive at least the agreed amount, that nothing beyond the amount you offered
  leaves the wallet — including any *other* asset you hold — and that the network
  fee is within an independent cap. If anything moved unfavorably, it isn't
  signed. Swapping on a wallet set to never auto-lock asks for your password
  first, the same as sending.
- **Swap costs are shown, not buried in the rate.** The review screen names the
  dealer, states the fees, and shows what share of the swap they represent, with
  the guaranteed minimum you'll receive. Fees are mostly flat, so a very small
  swap costs proportionally much more — the screen says so rather than leaving
  you to work it out from a lower-than-expected result.
- **Bitcoin price chart.** A rate readout sits under the balance and expands into
  a price trace over 24 hours, 7 or 30 days, a year, or all time. Hovering scrubs
  the trace for the price at a point in time. Collapsed, it costs no extra
  network request.
- **Import a wallet by scanning its seed-phrase QR** — the counterpart to the QR
  Apogee already exports, so moving a wallet between Liquid wallets no longer
  means retyping twelve or twenty-four words. The scanned phrase is handed
  straight to the wallet's own signing context rather than broadcast, and is
  readable only once.
- **QR scanning now works in Firefox.** Firefox has no built-in QR decoder, so
  scanning — a payment address in Send, or a seed phrase when restoring — did
  nothing there. Apogee now bundles a fallback decoder, so both work the same
  as on Chrome.
- **Faster, steadier fiat prices** — a fourth price source (mempool.space) joins
  the median, so a rate-limited provider no longer leaves the display without a
  figure.
- **No more "engine error" on first open.** Installing or updating could briefly
  show an error before the wallet engine finished starting; it now waits for the
  engine instead of reporting a failure.
- **Smaller things** — the guide reuses its open tab instead of stacking new
  ones, the settings icon closes settings when it's already open, Send and Swap
  have a Cancel button on the entry step, the hardware-wallet option reads the
  same on Chrome and Firefox, a USDt balance shown in USD no longer repeats the
  same figure as its own fiat equivalent (still available in the drawer), the
  scrollbar no longer disappears into the panel's top fade, and the lock
  screen's occasional shooting stars no longer bunch up after the panel's been
  hidden for a while.

## 0.5.0

- **Firefox support.** Apogee now runs on Firefox, built from the same codebase
  as the Chrome extension. Creating, restoring, and watch-only wallets all work,
  and the wallet lives in the Firefox sidebar. Hardware-wallet signing isn't
  available there yet — Firefox blocks the Web Serial API that Jade needs — so
  that option opens a short notice pointing to the Chrome build.
- **Send any held Liquid asset** — USDt and other issued assets are first-class
  in Send: an asset picker appears when you hold more than one, amounts are
  entered in the asset's own precision, and Max sends the full token balance.
  The network fee is always paid in LBTC (with an upfront check so a wallet
  holding only tokens gets a clear error, not a failed build). Each token's
  drawer gains a direct Send button, BIP21 payment links with an `assetid`
  preselect the right asset, and a Jade send shows the asset amount and id
  on-device for review.
- **Fiat values for USD-pegged tokens** — a USDt balance shows an approximate
  fiat value beneath it (converted into your display currency via a BTC→USD
  cross-rate). Assets without a price source show no figure rather than a
  guessed one.
- **Token icons in the Send asset picker** — held assets show their icons when
  you choose what to send, matching the balance list.
- **Chain-server health badge** — the Advanced drawer shows at a glance whether
  the configured Liquid chain server is reachable.
- **Version badge** — a small telemetry-face version readout appears at the
  foot of the panel when it opens and fades out after 15 seconds, so you can
  confirm at a glance which build you're running. Version strings now read
  `0.5.0 (abc1234)` instead of `0.5.0+abc1234`.

## 0.4.1

- **Cleaner token amounts** — trailing zeros are trimmed past two decimals, so a
  USDt balance reads 150.42 instead of 150.42000000; fully meaningful digits
  (1.00660712) are untouched.

## 0.4.0

- **Watch-only wallets** — import a Liquid descriptor to track a wallet's balance
  and receive to it without ever entering a seed. It can't sign or send; restoring
  the matching seed later upgrades it in place to a full wallet.
- **Engine resilience** — the wallet rides through chain-server outages: fast
  reachability probes with cooldowns, failover across two Esplora providers for
  scans *and* broadcasts, and persistent scan state so reloads top up
  incrementally instead of re-scanning from scratch (which is what trips public
  rate limits). Fiat-rate fetches are timeboxed and can no longer stall syncs.
- **Chain server setting** — Settings → Advanced picks Automatic (recommended)
  or a specific provider; every choice is validated against the server's
  genesis hash so a mainnet server can't be pinned to a testnet wallet.
- **Console interface pass** — the 2001 instrument-panel voice extends through
  the app: engineering labels and signage in the telemetry face with phosphor
  hairlines, lamp-cell buttons, glowing switches and status lamps, phosphor
  focus rings, and unselectable chrome (data stays copyable).
- **Asset display** — issued assets show correct decimals (USDt reads 1.00660712,
  not raw base units) and their registry icons; asset ids and txids fit one line
  with full-value tooltips and inline copy/explorer controls.
- **Seed-phrase auto-hide** — revealing your recovery phrase (or its QR) in Settings
  starts a 30-second countdown, then hides it again so a secret isn't left on screen
  if you step away.
- **2001-style telemetry polish** — the How-Apogee-Works guide and the Jade connect
  page adopt the wallet's telemetry face and phosphor glow, with a glowing wireframe
  of the Jade device; occasional shooting stars drift across the animated lock-screen
  sky (respecting reduced-motion).
- **Reliability** — resetting the wallet now fully clears the offscreen engine and
  its persisted scan state, so a wiped wallet's chain data can't linger into the
  next one; onboarding clears typed fields when switching flows.

## 0.3.1

- **Persistent connection status** — a slim bar at the bottom of the panel shows a
  green status light when a dapp is connected (hidden otherwise); Settings marks
  each connected app with a green dot and a disconnect action.
- **Animated lock/intro backdrop** — the ocean plays as a looping MP4 with a seam
  crossfade (ported from the www site), only on the lock and intro screens; toggle
  in Display → Background animation (on by default).
- **Approval overlay** — an Apogee icon badge, a gentle pulse on the primary
  action, and a success state on approve (a blue connection glyph for connect vs
  the green check for sends).
- **Seed phrase** — neutral reveal surface plus a QR code view.
- **Accurate auto-lock** — the idle timer resets on genuine side-panel input (not
  the background poll) and verifies elapsed time on fire, so it lands on schedule
  despite `chrome.alarms` jitter; an auto-lock toast surfaces it.
- **Connect / send while locked** — approvals offer an unlock step instead of
  forcing a reject.
- **"Never" auto-lock + send safety** — "Never" stays an option, and when it's
  set, local sends require a password (Jade is exempt — device auth).
- **Sats by default** — the denomination defaults to sats and is honored across
  the balance, activity list, and fee, with a selector in Display.

## 0.2.0

- **On-device Jade signing (E3)** — review + approve sends on the device; Apogee
  finalizes + broadcasts. Branded card flow (Connect → Review → Done).
- **Mainnet** support, with a network choice when creating, restoring, or pairing.
- Dapp **connect + send approvals**; `send` replaces `signAndBroadcast`.
- Received / Sent **toasts**, a branded receive QR, and sharper balances.

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
