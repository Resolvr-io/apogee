# Spec: Watch-only wallets

**Status:** Proposed (spec only — no implementation on this branch)

## Motivation

Let a user track balance and receive funds by importing public wallet material,
without ever entering a seed ("keep my holy words out of the system, like
Electrum"). Requested by a user on Nostr.

## Why this fits Apogee

The architecture already separates watch-only material from signing:

- **Engine ops are already watch-only.** In `engine/protocol.ts`, only
  `signPset` / `signBroadcast` take a `mnemonic`. `sync`, `getBalance`,
  `getAddress`, `getTransactions`, `prepareSend`, and `finalizeBroadcast` take
  only the `descriptor`. Receiving, balance, activity, and even *building* a
  spend already run without a seed.
- **Seedless wallets already persist.** The Jade path stores a `WalletRecord`
  with a cleartext watch-only descriptor and no encrypted seed (`enc` absent).
  A watch-only wallet is the same record with a new signer kind.

A watch-only wallet is therefore the existing Jade wallet **minus the external
signer**.

## Design sketch (the delta)

1. **Signer kind.** Add `"watch"` to `WalletSigner` (`"local" | "jade" | "watch"`).
2. **Onboarding.** New "Watch-only / Import descriptor" step, modeled on the
   Jade pairing flow (`Onboarding.tsx` → `addHardwareWallet`), but the descriptor
   comes from a paste field instead of the device. Validate by constructing the
   Wollet in the engine before persisting.
3. **Persist.** Reuse the seedless record path (descriptor + signer, no `enc`).
4. **Disable spending.** Hide Send in the UI for `signer === "watch"`, and
   **refuse `wallet/send` and send-approvals at the service-worker boundary** —
   not just in the UI. There is no seed to sign with, but the refusal should be
   explicit. Reveal-seed is naturally absent.
5. **Unchanged.** Receive (address + QR), balance, activity, and dapp *connect*
   (read-only account) already work, since they only need the descriptor.

## Liquid consideration (important)

Unlike Bitcoin/Electrum (where an xpub is enough), Liquid is confidential: to
**see** a balance you also need the **master blinding key**. lwk's CT descriptor
bundles both — the `slip77(...)` part is the blinding key:

```
ct(slip77(<blinding-key>),elwpkh([fp/84h/<coin>h/0h]xpub/<0;1>/*))
```

So the clean import unit is the **full CT descriptor** (exactly what Jade
exports and what Apogee already uses internally). A bare xpub would let the user
receive but show blinded (unknown) amounts — acceptable as a later "receive-only"
mode, but the descriptor import should be primary.

## Security notes

- Watch-only strictly **reduces** attack surface: no seed stored for that wallet.
- The one must-get-right: the SW must refuse signing/sends for watch-only
  accounts at the trust boundary (defense in depth), and descriptor import must
  be validated so a malformed descriptor can't wedge the engine.

## Bonus

Importing an explicit descriptor sidesteps the derivation-path guessing problem
(e.g. the Green flat-`m/*` vs BIP84 mismatch): the user brings the exact
descriptor, so we don't infer the path.

## Open questions

- Import formats to accept: full CT descriptor only, or also xpub (+ optional
  blinding key)? Support other-wallet descriptors (non-BIP84) for viewing?
- Should a watch-only account be connectable by dapps (read-only), or excluded?
- UX: badge/label for watch-only wallets; behavior of the hide-balance toggle.

## Out of scope

Implementation, PSBT/PSET export for external signing, and any airgapped-signer
round-trip. This branch is the spec only.
