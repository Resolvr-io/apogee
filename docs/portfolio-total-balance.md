# Portfolio Total Balance

**Status:** Implemented. Math and copy live in `src/lib/portfolio.ts`
(`portfolioTotal`, `heroSubtitle`), wired into the balance frame in
`src/sidepanel/screens/Wallet.tsx`.

## Problem

The hero figure showed LBTC only (`sats = sync.lbtcSats`). A wallet holding
nothing but USDt therefore read "0 SATS" while the Tokens list below showed a
real balance — the wallet looked empty when it wasn't. Token value was only
reachable by expanding a token row's drawer.

## Prior art

Both reference wallets fold stablecoins into the top figure; the arithmetic on
their own screens shows how:

- **Aqua** — the wallet row reads `$1.12`, which is L-BTC `$0.62` + USDt `$0.51`.
  One **fiat** total. BTC price lives in a separate card.
- **SideSwap** — `Total Value / 0.00000773 L-BTC / USD 0.50`, while the actual
  L-BTC balance is `0.00000000` and USDt is `0.50`. The total is denominated in
  the **base asset**, with fiat secondary, and is labeled "Total Value".

## Behavior

SideSwap's shape, for two reasons. Apogee's hero is tap-to-cycle
(sats → LBTC → fiat), so a fiat-only total would leave the default `sats` mode
still reading 0 — the case that motivated this. And a single `totalSats` integer
re-denominated through the existing formatters makes the three views incapable of
disagreeing; a fiat total plus an independently-computed "incl. ≈ $3.00 in
tokens" subtitle (the shape this doc originally proposed) has no such guarantee.

```
tokenUsd  = Σ (balance / 10^precision)          // pegUsd assets only
tokenSats = round(tokenUsd / btcUsd * 1e8)
totalSats = lbtcSats + tokenSats
```

`btcUsd` is the BTC price in **USD** specifically — the peg is to USD, so the
display-currency rate is the wrong one. It costs no extra request: the panel
already fetches a USD rate whenever a pegged token is held and the display
currency isn't USD (and when it is, the display rate *is* the USD rate).

SideSwap's other lesson is the label. A figure that is neither the LBTC balance
nor the token balance is unreadable without the word "total", so the subtitle
says so — and keeps the unit, because `formatFiat` renders `$` for USD, CAD and
AUD alike (same reason the rate bar names the pair rather than just "BTC").

| denom | no token contributes (**unchanged from before**) | a token contributes |
|---|---|---|
| sats | `2,157,431` / `SATS` | `2,390,640` / `TOTAL SATS · $1,541.96` |
| btc | `0.02157431` / `LBTC · 2,157,431 SATS` | `0.02390640` / `TOTAL LBTC · $1,541.96` |
| fiat | `$1,391.54` / `USD · 2,157,431 SATS` | `$1,541.96` / `TOTAL USD · 2,390,640 SATS` |

Figures are `DEMO_SYNC` (2,157,431 sats + 150.42 USDt) at BTC = $64,500. A
wallet holding only LBTC sees byte-identical copy to before the total existed —
asserted in `portfolio.test.ts`.

Hidden mode is unchanged: stars, and the subtitle collapses to the non-breaking
space that holds the line so toggling hide can't shift the Send/Receive row.

## Unpriced and unpriceable assets

`pegUsd` is the only price source for a non-LBTC asset, so anything else — an
issued asset, an unlisted token, a non-USD stablecoin — has no fiat value.
Rather than guess or silently omit, the count is appended: ` · +2 UNPRICED`.
Two invariants: the total never carries a guessed price, and it never silently
understates.

Adding a EUR-pegged asset means generalizing `pegUsd: boolean` into a peg
*currency* on `KnownAsset` — both `portfolio.ts` and `usdToFiat` in `Wallet.tsx`
assume USD today.

## Degradation

| condition | hero | subtitle |
|---|---|---|
| display rate failed, fiat mode | `—` (unchanged) | fiat branch; pegged tokens counted as unpriced when the display currency is USD |
| display rate failed, sats/btc, currency is USD | LBTC only | prior copy + ` · +N UNPRICED`, no pulse |
| USD rate still loading (currency ≠ USD) | LBTC only | prior copy, **pulsing** |
| USD rate failed (currency ≠ USD) | LBTC only | prior copy + ` · +N UNPRICED`, pulse stops |
| display rate failed, USD rate fine (e.g. JPY) | correct total in sats/btc, `—` in fiat | `TOTAL SATS` with no secondary |
| pegged token at zero balance | unaffected | nothing — filtered out |
| unsynced | stars | nbsp |

A held-but-unvalued token reuses the existing "not final" pulse (`syncing ||
hasUnconfirmed`) rather than inventing an affordance; `rateUsdFailed` is what
gives that pulse a terminal state, so it can't spin forever and read as a stuck
sync.

## Not a safety boundary

Display-only, like every price in the app (see `price-sources.md`). Send and Swap
read per-asset balances straight off the sync result — `Send.tsx` derives
`lbtcSats`/`balance` from its `sync` prop, `Swap.tsx` likewise, and
`prepareSend` guards again in the engine — so a wrong rate can misprice the hero
but cannot change what leaves the wallet. The residual risk is perceptual: a
user reads a total, then Send says "Amount exceeds your available balance". That
is why the word "total" appears in all three denominations rather than only in
fiat mode.

## Deliberately not done

No token subtotal anywhere. The Tokens list is already the breakdown, and each
row's drawer already carries its own `Value (<fiat>)`. Token row *summaries*
still show no fiat line — a body-font fiat figure under a telemetry-font amount
read as a typeface mix.
