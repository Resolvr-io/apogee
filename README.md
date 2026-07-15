# Apogee

A self-custodial **Liquid (L-BTC)** wallet browser extension. Apogee holds the
keys and signs; web apps connect to it as a dapp through an injected
`window.liquid` / `window.apogee` provider, MetaMask-style. The app never
exposes a seed to the page.

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
- Unlock, balance (sats / BTC, fiat, hide-balance), receive (branded address + QR),
  send (build → review → sign → broadcast), Received / Sent **toasts**, and settings
  (network, currency, auto-lock, reveal seed, connected apps).

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

### Dapp provider (`window.apogee`)
- A page connects via the injected provider → content bridge → service worker.
  Surface: `connect`, `getStatus`, `getNewAddress`, `getBalance`, `send` (the page
  passes address + amount; Apogee builds the PSET, reviews, signs, broadcasts),
  `disconnect`, plus `on` / `off` events.
- **Approvals** — connecting a new site and every send raise an approval (an
  overlay in the side panel when open, a popup window otherwise); nothing is
  granted or signed without the user's confirmation. A Jade send then signs
  on-device.
- **Per-site sessions** — the SW tracks connected origins; every call except
  connect / disconnect requires an approved session, so revoking a site actually
  cuts it off.
- **Connected-apps indicator** in Settings (origin + Revoke).
- **Lock-aware balance** — a locked wallet returns no balance (the dapp shows a
  locked state and recovers on unlock) instead of a misleading 0.
- **Serialized engine calls** so the dapp and the side panel can't
  re-entrantly alias a cached `lwk_wasm` `Wollet`.

Any web app can integrate this provider. The extension exposes the standard
**`window.liquid`** provider interface (EIP-1193 `request` + EIP-6963
discovery); the implementation is in
[`src/provider/liquid-provider.ts`](src/provider/liquid-provider.ts).

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
- Built by **Resolvr**.
- Built with CRXJS, Vite, React, and Tailwind CSS.
