# SideSwap API coverage — what Apogee uses, and what it defers

Companion to `docs/apogee-swap-integration-plan.md` (Track 1). That doc records the
*decision* to use SideSwap's dealer-quoted instant swaps; this one records how much of
that API the implementation actually consumes, so deferred capability is a deliberate,
reviewable choice rather than an oversight.

Reviewed 2026-07-25 against the merged flow (`main` @ `5cabaea`) plus the
`fix/swap-safety-and-ux-gaps` work.

## The API surface

SideSwap is JSON-RPC 2.0 over WebSocket; every action is the single `"market"` method with
the action named in `params`. Four actions exist, plus an async `quote` notification stream.

| Action | Used? | Where |
|---|---|---|
| `start_quotes` | ✅ | `orchestrator.ts` — both `executeInstantSwap` and `previewSwapQuote` |
| `get_quote` | ✅ | `orchestrator.ts` — fetches the dealer-built unsigned PSET |
| `taker_sign` | ✅ | `orchestrator.ts` — submits the signed PSET; the server broadcasts |
| `quote` notifications | ⚠️ partial | `waitForQuote` — resolves on the **first** quote, then stops listening |
| `list_markets` | ❌ | implemented in `client.ts` but **never called** |

## Consumed from the quote payload

`Success` carries `{ base_amount, quote_amount, fixed_fee, server_fee, quote_id, ttl }`.

| Field | Used? | Notes |
|---|---|---|
| `base_amount` / `quote_amount` | ✅ | Mapped to send/recv by `sendIsBase`; drive the review screen and the gate's independent caps |
| `quote_id` | ✅ | Threaded to `get_quote` / `taker_sign` |
| `ttl` | ✅ | Converted to an absolute `expiresAt`; drives the review-screen countdown and disarms Confirm on expiry |
| `LowBalance.available` | ✅ | Surfaced as "the dealer can currently fill up to X" |
| `fixed_fee` / `server_fee` | ❌ | **Deferred** — see below |

## Deferred, with rationale

### 1. Dealer fee disclosure (`fixed_fee` / `server_fee`) — deferred, pending copy

The review screen shows only the *network* fee ("Up to 1000 sats"). The dealer's own
fee/spread is never displayed, so the user can only infer it by comparing send vs receive
against the market rate.

This is deliberately held together with the **trust-disclosure** gap: the plan's constraint
#4 requires that a swap surface explain who holds funds and when, and the UI currently
names neither SideSwap nor the atomic/no-custody model. Both are copy decisions, so they
should land as one considered change rather than two ad-hoc strings. Nothing blocks it
technically — the fields are already parsed into `SideSwapQuoteSuccess`.

### 2. `list_markets` — deferred until a second pair exists

Swappable assets come from a hardcoded `KNOWN_ASSETS` (`src/lib/asset-registry.ts`): LBTC
and USDt. `list_markets` would make the picker reflect the dealer's *actual* liquidity.

Consequences of not wiring it, both currently acceptable:
- A pair SideSwap adds can't be offered without an Apogee release.
- A pair SideSwap **removes** surfaces as a runtime dealer error rather than the asset
  simply not appearing.

With exactly one tradable pair this is dead weight. Wire it when a second pair ships, or if
a dealer-side removal is ever observed. The client method already exists and is tested by
`integration.test.ts`.

### 3. Live quote streaming — deferred

`start_quotes` is a *subscription*: the dealer keeps pushing updated quotes for a
`quote_sub_id`. `waitForQuote` takes the first `Success` and stops, so the review screen
shows a snapshot that may be seconds stale.

With the TTL countdown now in place the user can see when their quote goes cold and
re-quote explicitly, which covers the safety concern. A live-updating price is a UX
refinement on top. Note before attempting it: `client.onQuote` overwrites a single handler,
so `waitForQuote` is not safely re-entrant — streaming would need a handler that survives
across quotes (or a proper listener list).

### 4. PayJoin — deferred by design (plan task 6)

Same cooperative-PSET shape as a swap; lets a USDt-only wallet pay Liquid fees in USDt.
The plan already schedules this after the core swap. Real product value: it removes the
"no L-BTC for fees" dead end, which is otherwise reachable for a wallet holding only USDt.

### 5. Order book / limit orders / partial fills — unavailable

Not a deferral. SideSwap removed the order-book ("P2P Swaps") and old Instant Swap APIs in
its Feb 2025 revision. The current `market` API is dealer-quoted instant execution only, so
this isn't available to any client.

## Known behavior worth revisiting (not API coverage)

- **`taker_sign` post-broadcast ambiguity.** A 15s request timeout or a socket close
  rejects the promise *after* the wallet has handed the dealer a fully signed, broadcastable
  PSET. The swap may still settle on-chain while the UI reports failure. Mitigated in the
  UX (a failed execution forces a fresh quote rather than inviting a one-tap retry), but the
  ambiguity is inherent to a server-broadcasts protocol. A "check your balance or the
  explorer before retrying" affordance would help.
- **Fixed 1000-sat fee cap.** `SWAP_MAX_FEE_SATS` (`src/sideswap/constants.ts`) is a fixed
  independent ceiling — correct in kind (never dealer-derived) but should become a real
  feerate × vsize estimate before mainnet.
