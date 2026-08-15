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
to us. The network connections below are how a light wallet works, and they are the
one place your wallet activity is observable by third parties.

- **Device-level access reads everything.** The recovery phrase is stored
  encrypted, but the wallet's watch-only descriptor — every derived address plus
  the SLIP-77 master blinding key — is stored unencrypted so the wallet can sync
  while locked. Anything that can read the browser profile (malware, another OS
  user of an unlocked session, a copied profile) can therefore reconstruct your
  full transaction history and unblind every amount, and can read the local scan
  state and transaction metadata. The SLIP-77 key is secret-equivalent material:
  losing it does not risk funds, but it is what keeps your amounts private. This
  is the standard tradeoff of light wallets; we do not claim otherwise.
- **Chain-data providers see your addresses.** Balance and history sync sends the
  wallet's address set to an Electrum waterfall server (encrypted to that
  server's key) with fallback to public Esplora instances over TLS. These
  operators — or whoever compels them — can cluster the addresses and observe
  balances and activity. You can point Apogee at your own Esplora
  (Settings → Chain server) to restrict this to infrastructure you control.
- **Swap counterparties see the swapped asset.** Executing a swap necessarily
  tells the dealer (SideSwap) the UTXOs you spend — including their amounts and
  blinding factors, which the dealer needs to blind its side — and freshly
  derived receive/change addresses. Other holdings are not revealed.
- **Asset metadata comes from the public registry.** Token names, tickers, and
  display precision shown in the UI are registry data an asset issuer can steer;
  the asset ID and exact base-unit amounts are always shown alongside. Never
  identify an asset by its label alone.

## See also

- [2026-08 security vulnerability scan](docs/security-vulnerability-scan-2026-08.md)
  — full findings, severity ratings, and remediation status for the issues above.

