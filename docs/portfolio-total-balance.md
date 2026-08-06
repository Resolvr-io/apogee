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

## The list itemizes the hero

The list below the balance was named **Tokens** and excluded the policy asset,
which was right while the hero simply *was* the L-BTC balance: a row restating it
would have been duplication. Once the hero became a total that exclusion left the
one holding visible nowhere. A real wallet holding 4.87 USDt and 2,043 sats read
`$6.19 / TOTAL USD · 9,579 SATS` in the hero and `4.87079522` in the list — the
L-BTC figure appeared only on the Send screen, and was otherwise recoverable only
by subtracting.

So the rule is: **the list itemizes the hero exactly when the hero is a sum.**
It is driven by `PortfolioTotal.tokensIncluded`, the same flag that makes the
subtitle say "total", so the headline and the list cannot disagree about what the
headline is. An L-BTC-only wallet still sees no list at all.

Three consequences:

- L-BTC sorts first. It is the fee asset and the denomination everything else is
  converted into, so it reads as the anchor rather than one token among several.
- Its row follows the **denomination**, like every other L-BTC figure in the
  panel (`TxRow` takes `denom`; Send and Swap take `unit`). Rendering it in LBTC
  while the hero counts sats would defeat the row's only purpose. Tokens stay in
  their own precision — the established split.
- Its drawer shows a fiat value derived from the display rate. `pegUsd` is false
  for L-BTC, so the stablecoin branch would have left it blank, which is absurd
  for the one asset whose price the panel already has.

The heading is now **Assets**: L-BTC is the policy asset, not a token, and the
heading has to stay true in both modes.

Selection and ordering live in `lib/portfolio.ts` as `assetRows`, not in the
component — this rule is what keeps the hero and the list in agreement, and
vitest only collects `src/**` tests, so leaving it in the component would have
left the load-bearing piece uncovered.

## Identifier rows

Both drawers rendered 20 of an identifier's 64 hex characters. That is enough to
verify an id against a known value at a glance — a real need, for developers and
nobody else — and it was the widest element in the drawer. The id moved to the
label's `title`: no width, and the *whole* value rather than a truncation. Copy
stays, and the asset row gained the explorer link it never had.

The label carries `tabIndex={0}` so the tooltip is reachable without a mouse. A
`title` on a non-interactive span is otherwise invisible to keyboard users, which
would have traded a visible truncation for nothing at all.

## Deliberately not done

No token subtotal anywhere. Each row's drawer already carries its own
`Value (<fiat>)`. Token row *summaries* still show no fiat line — a body-font
fiat figure under a telemetry-font amount read as a typeface mix.
