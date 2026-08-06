# Provider PSET analyzer

Apogee does not currently advertise or dispatch the Liquid Wallet RPC Profile's
`signPset` method. The internal `analyzeProviderPset` engine operation is the
first security boundary for that future RPC. It is read-only: it never loads a
seed, asks a signer for a signature, mutates wallet state, or broadcasts a
transaction.

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

## Signing integration rule

A successful analysis is not a reusable authorization token. The future public
handler must sync first, analyze for the approval screen, and, after approval,
re-run the same checks and sign the same parsed PSET in one engine operation.
It must not pass the caller's PSET to the existing bare `signPset` engine case,
because LWK's signer signs every input it recognizes. Jade and local signing
must share this gate.

The first public `signPset` implementation will keep `broadcast: true`
unsupported. Returning a signed PSET and broadcasting it are separate risk
boundaries and should gain separate tests and approval language.
