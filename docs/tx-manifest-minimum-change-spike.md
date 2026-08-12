# TX Manifest minimum-change policy spike

Status: completed spike, 2026-08-12. This document specifies a proposed wallet
policy; it does not change production transaction construction.

## Question

When deterministic coin selection leaves a small remainder, when should Apogee
create confidential wallet change and when should it omit that output and add the
remainder to the L-BTC fee? The answer must:

- apply to any TX Manifest adapter, not only Simplicity Lending;
- conserve every issued asset exactly;
- display and bind the actual fee before signing;
- remain within the dapp and wallet fee caps; and
- terminate without oscillating between change and no-change transaction shapes.

## Elements policy boundary

This is an economic wallet policy, not a consensus dust rule.

At Elements revision
[`56a6cfa`](https://github.com/ElementsProject/elements/tree/56a6cfa991d0fe8b382e450d55fbd74608044ffe),
`IsDust` returns false when an output's value or asset is confidential. The
Elements functional test
[`wallet_elements_dust_relay.py`](https://github.com/ElementsProject/elements/blob/56a6cfa991d0fe8b382e450d55fbd74608044ffe/test/functional/wallet_elements_dust_relay.py)
also demonstrates that a manually constructed blinded one-satoshi output is
accepted by the mempool. The node wallet's ordinary send path applies its own
higher creation threshold, but Apogee constructs and blinds its PSET directly.

Explicit policy-asset outputs can still be relay dust. Manifest-owned wallet
change is confidential, while explicit contract outputs are fixed by the trusted
adapter and are outside this discretionary change policy.

## Reproducible measurements

Run:

```console
cd crates/tx-manifest-runtime
cargo run --locked --example minimum_change_spike
```

The example builds real Elements PSETs, blinds confidential P2WPKH outputs, and
uses the same conservative discounted-vsize estimator as TX Manifest approval.
Repeated runs produced identical sizes despite randomized blinding.

| Marginal transaction shape | Discounted vbytes |
| --- | ---: |
| First confidential change after an explicit output | 69 |
| Additional confidential change after a confidential output | 67 |
| Additional unsigned Apogee P2WPKH input, including its conservative witness bound | 68 |

The two-vbyte first-output difference is conservative witness-serialization
overhead in the unsigned estimate. Most lending actions already contain
confidential or finalized witness data, but policy must remain correct for a
wallet-only issuance action as well.

At one common rate for creation and future spending, the economic break-even is:

| Fee rate | Create change | Spend it later | Gross remainder floor |
| ---: | ---: | ---: | ---: |
| 100 sat/kvB | 7 sats | 7 sats | 14 sats |
| 1,000 sat/kvB | 69 sats | 68 sats | 137 sats |
| 10,000 sat/kvB | 690 sats | 680 sats | 1,370 sats |

The table uses the conservative 69-vbyte creation case. A transaction that
already has confidential witness data is two vbytes cheaper.

## Recommended policy

Use two rates with different purposes:

1. The live one-block fee estimate pays for creating the transaction now.
2. A wallet-owned long-term spend rate values the cost of consuming change later.

For the first implementation, use the existing 100 sat/kvB fallback as the
long-term rate. It matches Elements' default relay-fee scale and avoids treating a
temporary fee spike as if it will necessarily persist until the change is spent.
A future backend could supply a separately clamped long-term estimate without
changing the algorithm.

For Apogee's currently supported P2WPKH wallet inputs:

```text
postCreationChangeFloor = ceil(68 dVbytes * 100 sat/kvB / 1000)
                        = 7 sats
```

The live creation cost must not be added to that seven-satoshi selector floor.
Dynamic fee estimation already charges the 67–69 discounted vbytes when a change
output exists. In gross-remainder terms, the conservative break-even therefore is:

| Live rate | Live creation cost | Long-term spend cost | Gross remainder floor |
| ---: | ---: | ---: | ---: |
| 100 sat/kvB | 7 sats | 7 sats | 14 sats |
| 1,000 sat/kvB | 69 sats | 7 sats | 76 sats |
| 10,000 sat/kvB | 690 sats | 7 sats | 697 sats |

Keeping creation and future spending separate is important. Applying the live
one-block rate to both terms would discard increasingly large change during a
short fee spike.

### Asset rules

- L-BTC change equal to zero: omit the output.
- L-BTC change of 1–6 sats after paying the live candidate fee: omit the output
  and add the entire remainder to the actual fee.
- L-BTC change of at least 7 sats: create confidential change.
- Any positive issued-asset change: always create change, regardless of amount.
- Never convert an issued asset to fees, burn it, or silently omit it. If its
  output cannot be constructed, fail preparation.

The selector should continue to prefer exact matches, then selections with
change at or above the floor, before considering a foldable remainder.

## Convergent construction

Track a monotonically increasing `minimumFee`, while allowing a prepared
candidate's actual fee to be higher only because it folded a sub-floor L-BTC
remainder:

```text
minimumFee = 1

for at most 16 iterations:
  select deterministic inputs for fixed outputs + minimumFee
  prefer exact or >= 7-sat L-BTC change

  if 0 < L-BTC change < 7:
    omit change permanently for this candidate
    actualFee = minimumFee + change
  else:
    actualFee = minimumFee
    emit change when nonzero

  require minimumFee <= actualFee <= effectiveMaxFee
  requiredFee = estimate final candidate shape

  if requiredFee <= actualFee:
    return candidate

  require requiredFee > minimumFee
  minimumFee = requiredFee

fail safely after the iteration bound
```

Removing sub-floor change is a terminal decision for that candidate. Apogee must
not re-estimate the smaller no-change shape, lower the fee, and then resurrect
change from the apparent savings. The difference is intentionally part of the
reviewed fee.

For a fixed selected policy-input total `S`, fixed non-change policy outputs `O`,
and measured with-change fee `Fchange`, the next remainder is
`S - O - Fchange`. If it is at least seven sats, that shape is funded and stable;
if it is 1–6 sats, folding makes the actual fee `S - O`, which necessarily covers
the smaller no-change transaction; if it is zero, no change is required. A
negative remainder forces deterministic reselection at the higher target. Thus a
fixed input set settles on the next round and never toggles back to change.

### Why this terminates

- `minimumFee` strictly increases whenever another iteration is required.
- Input selection is deterministic for a given target.
- Only the policy-asset funding selection changes as the fee rises; other asset
  targets remain fixed.
- Policy funding is bounded at 12 wallet inputs. Increasing the target can cross
  only a bounded number of input-count shapes.
- A folded no-change candidate is terminal rather than an alternate state in a
  two-way change/no-change loop.
- The existing 16-iteration limit, fee ceiling, and input ceiling guarantee a
  finite failure even if an estimator or future adapter violates an assumption.

If an input set repeats while neither the lower bound nor shape makes progress,
the implementation should fail immediately with an internal convergence error;
recording a compact shape trace will make that failure diagnosable.

## Approval-time revalidation

A folded candidate has two distinct internal amounts:

- `selectionFee`: the lower bound used to choose its inputs; and
- `actualFee`: `selectionFee` plus the folded remainder shown to the user.

Both must be retained in the prepared approval context. Revalidation should
reselect with the original `selectionFee`, reproduce the same fold, require the
same `actualFee`, and then apply the existing transaction/review digest check.

Rebuilding directly with `actualFee` as the selection target is insufficient: it
can turn the original selected inputs into an exact match and allow a different
exact subset to win stable outpoint tie-breaking. That would fail closed as a
changed review, but would cause avoidable second approvals.

After approval:

- a required fee above `actualFee` still requires a new approval;
- a different input, change decision, transaction shape, or actual fee fails the
  existing review-binding check; and
- neither the dapp `maxFee` nor Apogee's independent fee ceiling can be exceeded.

## Implementation outline

1. Define the long-term P2WPKH spend floor in the generic TX Manifest fee policy,
   with a runtime measurement test tying it to the 68-dVbyte witness model.
2. Pass the seven-satoshi floor to every policy-asset selector. Leave issued-asset
   selectors at zero because their remainder is never foldable.
3. Add one shared policy-change decision helper and use it from Accept Offer,
   Claim Lender Vault, Create Factory, Create Offer, Claim Principal, Cancel,
   Repay, and Liquidate preparation. Apply it once to the transaction's total
   policy balance when the principal or collateral asset is also L-BTC.
4. Let fee convergence accept `actualFee >= selectionFee`, validate the actual fee
   against both caps, and retain both amounts for approval revalidation.
5. Keep the approval's primary fee display equal to `actualFee`; optionally label
   a nonzero folded remainder as “uneconomical change added to fee.”
6. Preserve exact issued-asset accounting in the runtime balance check.

This is a medium implementation slice rather than a constant-only change. The
coin selector already has the right ranking primitive; most work is centralizing
policy change across the currently separate lending preparation paths and binding
the selection fee through approval revalidation.

## Required tests

### Pure selection and fee convergence

- exact match;
- 1, 6, 7, and 8 sats of post-fee L-BTC change;
- a larger dust-safe alternative preferred over a foldable best fit;
- folded actual fee exactly at and one sat above each fee cap;
- estimator growth that adds a policy input;
- change that starts above the floor, shrinks below it after live fee convergence,
  and folds once without resurrection;
- repeated shape/no-progress detection and the 16-iteration hard stop;
- approval revalidation using the original selection fee and actual reviewed fee.

### Asset conservation

- one-unit issued-asset change is emitted;
- issued-asset and policy-asset change in the same transaction;
- principal or collateral equal to the policy asset, with exactly one policy
  change/fold decision;
- runtime balance checks reject every omitted issued-asset remainder.

### Browser/regtest

- one action with 6-sat foldable L-BTC change shows the higher actual fee and no
  change output;
- one action with 7-sat L-BTC change retains the output;
- approval revalidation reproduces each transaction exactly;
- the complete two-wallet lending lifecycle remains green.

## Decision

Proceed with implementation using a seven-satoshi post-creation floor, live fee
estimation for current construction, a 100 sat/kvB wallet-owned future-spend rate,
terminal L-BTC folding, and no issued-asset folding. Recalibrate the long-term
rate before mainnet release or when Apogee supports a wallet input type other than
P2WPKH.
