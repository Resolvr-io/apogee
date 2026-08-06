# Provider PSET analyzer

Apogee implements the Liquid Wallet RPC Profile's `signPset` method through the
internal, read-only `analyzeProviderPset` engine operation. The analyzer never
loads a seed, asks a signer for a signature, mutates wallet state, or broadcasts
a transaction.

The RPC types and request validation remain pinned to
[ElementsProject/ELIPs#36](https://github.com/ElementsProject/ELIPs/pull/36) at
the `ELIP_DRAFT_REVISION` exported by `src/provider/liquid-rpc.ts`. The analyzer
adds wallet policy beyond that transport-neutral draft. Supporting a shape in
the draft does not require Apogee to sign every transaction expressible by that
shape.

## Current contract

The analyzer enriches the caller's PSET from the current LWK wallet and then
fails closed unless all of these statements hold:

- Every PSET input is a distinct, current wallet UTXO and is explicitly listed
  in `signInputs`. Collaborative PSETs containing inputs owned by someone else
  are not supported yet.
- The trusted UTXO script, the PSET prevout script, and the caller's address
  script all agree.
- Every input is an Apogee-native P2WPKH input. Redeem scripts, arbitrary script
  policies, issuances, and reissuances are rejected.
- Every signature commits to all outputs. `SIGHASH_ALL` and
  `SIGHASH_ALL | SIGHASH_ANYONECANPAY` are supported; `NONE` and `SINGLE` modes
  are rejected even when they are valid draft values, because they permit an
  approved output set to be changed after signing.
- Every output asset and amount is reviewable, trusted wallet input totals equal
  PSET output totals exactly for every asset, and fee outputs contain only the
  network policy asset.
- LWK's wallet-relative balance, fee, and recipient view agrees with the raw
  input/output accounting. Recipient outflow plus fees must explain the wallet's
  complete negative balance change for each asset.

On success the operation returns only review material: the PSET unique ID, a
wallet-status snapshot, wallet input outpoints and amounts, recipients, balance
changes, fees, and confidentiality flags. It never reads or serializes asset or
value blinding factors.

## Signing integration

A successful analysis is not a reusable authorization token. The public handler
syncs first, analyzes for the approval screen, and, after approval, refreshes
wallet state and reruns the same checks. Local wallets re-analyze and sign the
same parsed PSET atomically in one engine operation. Jade requests bind the
approved review and origin authorization across the device round-trip, then
refresh and validate the returned signed PSET before releasing it to the app.
Neither path passes a page-controlled PSET to the existing bare `signPset`
engine case, because LWK's signer signs every input it recognizes.

Without `broadcast`, Apogee returns the validated signed PSET and performs no
network submission. `broadcast: true` extends that same approval with an
explicit “sign and broadcast” action. After signing, Apogee finalizes the PSET,
revalidates the origin, wallet, permission, and local-wallet lock state at the
head of the serialized engine queue, and only then submits it through the
configured chain server. Success returns the signed PSET and `txid`; incomplete
transactions and broadcast failures reject without exposing the signed PSET in
the error.
