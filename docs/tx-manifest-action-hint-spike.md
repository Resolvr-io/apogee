# TX Manifest on-chain action hint spike

Date: 2026-08-11

## Result

A dedicated, position-independent TX Manifest action hint is compatible with all
eight currently trusted Simplicity Lending v3 actions. The successful prototype
adds one explicit, zero-value policy-asset OP_RETURN after ordinary and change
outputs. The Elements fee output follows it. This preserves every existing fixed
lending output index and leaves the factory/offer creation metadata untouched.

The complete two-wallet regtest browser lifecycle passed against the production
extension build, real lending web, API/indexer, Elements/electrs, and Simplicity
covenants. Both wallets were then replaced and restored using only their original
mnemonics. Each restored LWK wallet returned exactly the same transaction set it
had before replacement, and every restored manifest transaction contained one
decodable action hint.

## Prototype encoding

The v1 payload is 53 bytes and occupies one data push:

```text
magic          = ASCII "TXMF"                         (4 bytes)
version        = 0x01                                 (1 byte)
bundle_hash    = SHA256 canonical approved bundle    (32 bytes)
action_tag     = first16(TaggedHash(                  (16 bytes)
                   "tx-manifest/action/v1",
                   bundle_hash || UTF8(action)
                 ))
```

The canonical script is `OP_RETURN PUSH53 <payload>`. The decoder does not depend
on an output index: it examines every pushed datum in any OP_RETURN script and
ignores malformed records and unknown versions.

The full bundle hash makes the exact approved decoder discoverable. The 128-bit
action tag identifies one action within that bundle while leaving room under the
80-byte data-carrier target. A marker is only a routing hint; a future history
scanner must verify that the transaction satisfies the identified action before
displaying it as verified.

## Lending compatibility matrix

The marker output index varies naturally with each action's ordinary outputs and
change. That variance did not affect the position-independent decoder.

| Trusted action | Marker vout | Total outputs | Covenant/indexer | Seed restoration |
| --- | ---: | ---: | --- | --- |
| Enable borrowing (`CreateFactory`) | 4 | 6 | Pass | Borrower recovered |
| Create borrow offer (`CreateOffer`) | 7 | 9 | Pass | Borrower recovered |
| Fund loan offer (`AcceptOffer`) | 5 | 7 | Pass | Lender recovered |
| Claim borrowed funds (`ClaimPrincipal`) | 3 | 5 | Pass | Borrower recovered |
| Repay loan in full (`RepayLoan`) | 6 | 8 | Pass | Borrower recovered |
| Cancel borrow offer (`CancelOffer`) | 4 | 6 | Pass | Borrower recovered |
| Liquidate expired loan (`LiquidateOffer`) | 3 | 5 | Pass | Lender recovered |
| Collect loan repayment (`ClaimLenderVault`) | 3 | 5 | Pass | Lender recovered |

`CreateOffer` ran three times and `AcceptOffer` twice across the cancellation,
repayment, and liquidation branches. All eleven manifest transactions contained
exactly one marker and resolved to the expected approved action.

## Recovery boundary confirmed by the spike

The marker makes a transaction deterministic to interpret; it does not make a
transaction discoverable to a seed-derived wallet.

In the fresh restores, the borrower recovered its factory, offer, cancellation,
principal-claim, and repayment transactions. The lender recovered its acceptance,
vault-claim, and liquidation transactions. Neither ordinary wallet scan returned
the other party's transactions when those transactions did not touch one of its
seed-derived scripts.

This is sufficient to recover the actions that the restored Apogee wallet itself
executed. Recovering the complete shared contract timeline additionally requires
one of:

- following known lending covenant outpoints after discovering an offer;
- querying a protocol-aware indexer; or
- adding a wallet-derived notification/anchor output, with its separate privacy
  and transaction-cost tradeoffs.

## Recommended production implementation

1. Keep the dedicated marker output as the default placement. Do not overload the
   existing creation metadata or NFT-burn outputs.
2. Add a trusted-registry opt-in that explicitly authorizes and reserves the
   marker output without changing the dapp-facing bundle identity. The engine must
   not blindly append outputs to arbitrary future manifests whose contracts might
   constrain the total output layout.
3. Expose raw output scripts for LWK-discovered wallet transactions to a history
   annotation scanner.
4. Scan every OP_RETURN and every data push, resolve the exact vendored bundle and
   action, then run an action-specific postcondition verifier before applying a
   trusted label.
5. Keep unknown bundles and failed verification visible only as
   unsupported/unverified markers.
6. Keep the regtest lifecycle's replace-and-restore assertions as the release
   regression test.

The prototype proved placement and actor-side seed recovery. The production
implementation now wires decoded hints into Apogee transaction history and checks
wallet authentication plus action-specific structural postconditions. It does not
solve counterparty-only transaction discovery.
