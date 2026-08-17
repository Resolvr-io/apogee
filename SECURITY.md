# Security Policy

Apogee is a self-custodial wallet that holds and signs with private keys. We take
security seriously and welcome responsible disclosure.

## Reporting a vulnerability

**Please do not open a public issue for security vulnerabilities.**

Email **security@resolvr.io** with:

- A description of the issue and its impact
- Steps to reproduce (proof-of-concept if possible)
- Affected version(s) / commit

We aim to acknowledge reports within 2 business days and to keep you updated as we
investigate. We'll coordinate a disclosure timeline with you and credit you (if you
wish) once a fix ships.

## Scope

In scope: the extension in this repository — keystore/encryption, the background
service worker and message routing, the offscreen signing engine, the injected
`window.apogee` / `window.liquid` dapp provider, connected-site session handling,
and Jade (Web Serial) pairing/signing.

Out of scope: vulnerabilities in upstream dependencies (report those to the
respective projects — e.g. [LWK](https://github.com/Blockstream/lwk)), and issues
requiring a already-compromised device or browser.

## Handling of key material

Apogee never transmits seeds or private keys off the device. Seeds are encrypted at
rest (PBKDF2 → AES-256-GCM) and wasm/signing runs in an isolated offscreen document.
If you believe any of these guarantees are violated, that is in scope above.

## What is visible at rest and to whom

Apogee collects no telemetry — the extension sends nothing about you or your usage
to us. The network connections below are the main ways a light wallet works, and
they are where your wallet activity is observable by third parties.

- **Device-level access reads everything.** The recovery phrase is stored
  encrypted, but the wallet's watch-only descriptor — the extended public key
  every address derives from, plus the SLIP-77 master blinding key — is stored
  unencrypted so the wallet can sync while locked. Anything that can read the
  browser profile (malware, another OS user of an unlocked session, a copied
  profile) can therefore reconstruct your full transaction history and unblind
  every amount, and can read the local scan state, transaction metadata, cached
  asset icons (which name the assets you have held), and short-lived
  transaction-manifest records. The SLIP-77 key is secret-equivalent material:
  losing it does not risk funds, but it is what keeps your amounts private.
  Nothing is written to `storage.sync`, so none of this goes to browser-vendor
  cloud sync. This is the standard tradeoff of light wallets; we do not claim
  otherwise.
- **Chain-data providers see your whole wallet.** The default sync path sends
  the full descriptor to a Waterfalls scan server — encrypted to that server's
  own key, so it is the server, not a passive observer, that reads it — which
  lets the operator derive and cluster every address you will ever use. On
  fallback, public Esplora instances (liquid.network, blockstream.info) instead
  receive the gap-limited address set over TLS. Either operator — or whoever
  compels them — can observe your balances and activity. Settings → Advanced →
  Chain server lets you choose which public provider is used; pointing Apogee
  at a self-hosted node is not currently exposed in the UI.
- **Swap counterparties see the swapped asset.** Executing a swap necessarily
  tells the dealer (SideSwap) every UTXO you hold of the asset you're selling —
  not just the ones the swap spends — including their amounts and blinding
  factors, which the dealer needs to blind its side — and freshly derived
  receive/change addresses. Other assets are not revealed.
- **Asset metadata comes from the public registry.** Token names, tickers, and
  display precision shown in the UI are registry data an asset issuer can steer.
  On the send approval screen the asset ID and exact base-unit amount are shown
  alongside; elsewhere in the UI a registry label may appear on its own. Never
  identify an asset by its label alone.
- **Metadata and price lookups disclose holdings and location.** Asset metadata
  and icons are fetched per asset ID from public endpoints (liquid.network and
  the registry), disclosing which assets you hold to those operators. Fiat price
  sources receive only a currency code, not wallet data.

## See also

- [2026-08 security vulnerability scan](docs/security-vulnerability-scan-2026-08.md)
  — full findings, severity ratings, and recommendations for the issues above.

