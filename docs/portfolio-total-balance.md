# Portfolio Total Balance

**Status:** Deferred — spec for a later phase.

## Goal

Show a combined portfolio value in the main balance area that includes both
LBTC and token holdings, so the user sees their total wallet value at a glance.

## Current behavior

The big balance number at the top of Wallet.tsx shows LBTC only. Token
balances appear separately in the Tokens section below.

## Proposed behavior

### Fiat mode (USD / EUR / etc.)

Sum the LBTC fiat value and all priceable token values into one figure:

```
totalFiat = satsToFiat(lbtcSats, btcRate)
          + Σ (tokenBalance / 10^precision) * usdToFiatRate   // for pegUsd tokens
```

Display the combined figure as the main balance. The subtitle changes from
"USD · 12,345 sats" to "USD · 12,345 sats + tokens".

### BTC mode

Main number: LBTC amount (unchanged — mixing BTC and USD in one figure is
confusing). New subtitle line: "incl. ≈ $3.00 in tokens" showing the fiat
value of token holdings.

### Sats mode

Same as BTC mode: sats figure for LBTC, subtitle for token fiat value.

### Hidden mode

Unchanged — stars throughout.

## Unpriced assets

Assets without a `pegUsd` flag and no oracle have no fiat value. If any exist
in the wallet, append "+ N unpriced asset(s)" to the subtitle so the user
knows the total is incomplete.

## Scope

~30 lines in `Wallet.tsx`:

1. Compute `tokenFiatTotal` by iterating `sync.balance`, filtering to
   `KNOWN_ASSETS[id]?.pegUsd`, and summing `(amt / 10^precision) * usdToFiat`.
2. In fiat mode, add `tokenFiatTotal` to the LBTC fiat value for the main
   display.
3. In BTC/sats mode, render `tokenFiatTotal` as a subtitle line.
4. Count unpriced assets and append the note if > 0.

No new dependencies. No new API calls — uses the existing `usdToFiat` rate
and `KNOWN_ASSETS` registry.
