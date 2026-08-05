# BTC price sources

Where Apogee's fiat figures come from, how they're validated, and how to change the set
without breaking things.

Two independent concerns, often confused:

| | Spot rate | Price history |
|---|---|---|
| Used by | balance in fiat, the portfolio total, USD equivalents, swap estimates | the price chart / rate bar |
| Entry point | `getRate` (`engine-core.ts`) | `getPriceHistory` / `getPrice24hAgo` |
| Sources | lwk's `PricesFetcher`, then `fallbackRate`'s four tickers | mempool.space only |

Everything here is **display-only**. No price ever feeds a send amount or a swap amount —
swap safety comes from the verification gate reading the PSET itself, never from a rate.

That includes the hero's portfolio total, which folds USD-pegged tokens into the balance
figure at the spot rate (`lib/portfolio.ts`). Send and Swap read per-asset balances straight
off the sync result, so a wrong rate can misprice the total but cannot change what leaves
the wallet. It also adds **no request**: it reuses the USD rate already fetched when a
pegged token is held, so the no-polling property below still holds.

## Spot rate

`getRate` tries lwk's own `PricesFetcher` first, timeboxed at 8s. On *any* failure it falls
through to `fallbackRate`.

That fallthrough is broader than the name suggests: it covers currencies lwk refuses (its
supported list omits JPY) **and** timeouts, so on a slow network `fallbackRate` is the path
for every currency, not an edge case.

### `fallbackRate` — median of four, ≥2 required

Four tickers in parallel via `Promise.allSettled`:

| Source | Notes |
|---|---|
| CoinGecko | free tier intermittently returns HTTP 429 |
| CoinPaprika | |
| blockchain.info | |
| mempool.space | keyless, no practical rate limit, quotes all 7 `FIAT_OPTIONS` in one call |

Then: drop non-finite and non-positive values, require **at least 2** survivors, take the
median. A single bad or stale source cannot set the rate.

Defenses worth knowing, each there for a reason:

- **`r.ok` gate before parsing.** A 429 or an HTML error page rejects as "source
  unavailable" instead of being parsed as a rate.
- **6s `AbortSignal.timeout` per source.** One hanging ticker can't stall the median.
- **`/^[A-Z]{3}$/` currency guard.** The value is trusted today (it comes from the fixed
  `FIAT_OPTIONS`), but the guard means `currency` can never reach a URL host — only a query
  param or an object key. No SSRF surface.

### Why mempool.space is the fourth source

Measured 2026-07-25: with only three sources the ≥2 median had **no margin**, because
CoinGecko — the least reliable of them — was guaranteed to be one of the three. During a
verification run CoinGecko began failing mid-run (CHF, JPY, SEK) while the others held.
With four sources those cases had 3 usable; under three they'd have sat at exactly the
minimum.

Cross-source agreement was ~0.1%.

### Why Coinbase is deliberately excluded

Coinbase delisted JPY, but its `BTC-JPY` spot endpoint **still answers** — with a stale
quote ~3.4× off consensus. A source that returns a confidently wrong number is worse than
one that returns nothing: the median only defends while honest sources outnumber it. Don't
add it back.

### Adding or removing a source

1. Add the host to `hostPermissions` in **`manifest.shared.ts`** (repo root — not `src/`).
   Without it the fetch is silently blocked.
2. Keep the **≥2 median bar as-is.** More sources should widen the margin, not lower the
   threshold.
3. Verify the missing-key path. `Number(undefined)` → `NaN`, which the existing
   `Number.isFinite` filter drops — confirmed live for SEK, which mempool.space doesn't
   quote.

## Price history (the chart)

`mempool.space/api/v1/historical-price` — a single source, deliberately.

It returns the **entire** hourly series (~24k points back to 2010) in one response, plus
USD→fiat rates for exactly the currencies the panel offers. It accepts no windowing
parameters (`from`, `limit`, `interval` are all ignored — verified), so it's all-or-nothing
at ~147 KB gzipped.

That shape is a benefit rather than a cost: **one cached fetch serves every range and every
currency**, so switching range or currency costs zero further requests. A second source
would mean more requests to more hosts for no accuracy gain on display-only data.

Two properties to preserve:

- **The series is NOT evenly spaced** — weekly before 2013, daily until late 2023, hourly
  after. The chart must position points by *timestamp*, not array index. Plotting by index
  crushed 2010–2023 into the leftmost ~3% of the width, rendering a real early rally as a
  vertical spike. See `tracePaths` and its regression test.
- **`getPrice24hAgo` is separate on purpose.** The always-visible rate bar needs a 24h
  delta, and pulling 147 KB on every wallet open for a one-line readout would be
  disproportionate. Passing `&timestamp=` returns exactly one point (~148 bytes), so the
  collapsed bar costs ~1 KB and the full series is fetched only when the chart is expanded.

## Privacy

Apogee declares `data_collection_permissions: { required: ["none"] }`. These requests are
consistent with that: a fixed URL carrying **no user data** — no address, balance, amount,
or identifier — and byte-identical regardless of holdings.

What a request does reveal is the user's IP to the price host and that an Apogee user is
active. That's inherent to showing a fiat figure at all, and it's bounded by:

- **No polling.** `getRate` is one-shot per currency change; the chart fetches on expand
  only. Nothing runs on a timer. Preserve this.
- **Caching.** 10-minute TTLs on both history paths, so repeat views cost nothing.
- **No new third parties.** mempool.space was already a `fallbackRate` host before the chart
  used it.

## Fee estimates are not price sources

`SWAP_MAX_FEE_SATS` (1000) and `SWAP_TYPICAL_FEE_SATS` (60) in `sideswap/constants.ts` are
Liquid network-fee figures, not fiat rates — but they're easy to conflate, so: the first is
the verification gate's enforced ceiling and must stay generous (the gate *rejects* above
it); the second is display-only. Both are grounded in measured mainnet swaps (53–60 sats at
~6,200 vsize). Never derive either from dealer-supplied data.
