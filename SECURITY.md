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
