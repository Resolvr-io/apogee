# Security Audit — Track 1 SideSwap swap foundation (PR #32)

- **Date:** 2026-07-23
- **Branch / PR:** `feat/track1-sideswap-swaps` → PR #32 "Track 1: SideSwap instant-swap
  foundation (client, verification gate, UTXO data)".
- **Reviewed at commit:** `eafcfa5` (branch tip — "address review — full-map drain check +
  client hardening"), i.e. after the @claude PR review was addressed.
- **Audit stored in:** `audits/` on the branch (untracked), alongside the archived PR#1/#2
  audit (`security-review-main-pr1-pr2.md`).
- **Scope:** the new swap primitives only — the dealer-PSET verification gate
  (`engine/verify-dealer-pset.ts`), the SideSwap JSON-RPC WebSocket client
  (`sideswap/client.ts`), and the two new engine handlers (`verifyDealerPset`, `getUtxos`)
  plus their protocol DTOs (`engine/protocol.ts`). The plan doc
  (`docs/apogee-swap-integration-plan.md`) is excluded (documentation).
- **Method:** security-review skill (identify → adversarial false-positive filter →
  report only confidence ≥ 8), plus independent verification of the load-bearing
  PSET-balance semantics against the shipped `lwk_wasm@0.18` type definitions and the
  existing `prepareSend` handler.
- **Threat model:** a malicious or compromised SideSwap dealer / server that controls
  (a) the `get_quote` PSET bytes the wallet is asked to sign, and (b) every JSON-RPC
  response and `quote` notification over the WebSocket. Trust boundary = the offscreen
  engine, the sole holder of key material. Question: can a hostile dealer PSET or server
  response cause fund loss, an unauthorized signature, or secret/key exposure?

## Result

**No HIGH or MEDIUM security vulnerabilities identified.** One security candidate — the
fee bound leaving the L-BTC network fee uncapped when the optional `maxFee` is omitted —
was examined and reduced to *griefing* (L-BTC burned to network fees, **no attacker
profit**): the fee term cancels in the outflow check, so the dealer's receipt is bounded
to `sendAmount` regardless of fee size (see the table). It filtered at confidence **2/10**
(griefing ≈ DoS; no theft; the cap already exists as an optional argument; the code is
unwired). The load-bearing anti-drain logic is sound against the dealer threat model.

Every new line is **latent foundation** — nothing dispatches `verifyDealerPset` or
`getUtxos`, and `SideSwapClient` is imported nowhere, so there is no end-to-end attacker
path in this PR. The findings below matter when the swap flow is wired (the Track 1 spike
and phase 2).

## Examined and independently verified

| Area | File(s) | Verdict |
|---|---|---|
| Anti-drain core (checks 1, 2, 2b) | `verify-dealer-pset.ts` | **Safe.** `psetDetails().balance().balances()` is net-per-asset from the wallet's POV, so a positive `recvNet` can only come from an output to a wallet-owned address — a dealer paying the receive asset to *their own* address never moves it, so "paid to us" can't be faked (check 1). Check 2 bounds send-asset outflow; check 2b bounds every *other* asset to ≥ −TOL, closing the third-asset drain the @claude review caught. Sign convention (negative = spent) matches how `prepareSend` reads the same API (`engine-core.ts:1035`). |
| Fee bound / optional `maxFee` | `verify-dealer-pset.ts` (checks 2 & 4) | **Griefing only, not theft — no security finding.** For an L-BTC send the fee lives *inside* the policy-asset net: `prepareSend` computes `recipient = −netPolicy − fee` (`engine-core.ts:1024-1035`), i.e. `\|netPolicy\| = recipient + fee`. So `sent = to_dealer + fee`, and check 2's `sent ≤ sendAmount + fee + TOL` reduces to `to_dealer ≤ sendAmount + TOL` — the fee cancels; the dealer cannot receive more than offered. An uncapped fee only burns the user's own L-BTC to the federation. **Recommendation (hardening):** default or require `maxFee` in the L-BTC-send direction so a hostile dealer can't grief fees. |
| `getUtxos` unblinding data | `engine-core.ts` `getUtxos` | **No key material; privacy note.** Returns asset/value plus both blinding factors per UTXO. Blinding factors do not authorize spending (safe against theft), but the handler returns *all* wallet UTXOs — when wired to `start_quotes` this over-shares the entire confidential UTXO set's amounts/assets with the counterparty. **Recommendation:** filter to the send-asset UTXOs the dealer actually needs for coin selection. |
| SideSwap client | `sideswap/client.ts` | **Safe.** Transport only — never signs, never touches keys. id-correlation is monotonic-numeric with a per-request 15s timeout and a double-settle guard; `failAll` rejects everything on close; the response/notification split uses `typeof id === "number"` (so an `id:null` notification isn't misclassified). A hostile server can mis-route a response or feed float amounts, but the sign-time authority (`verifyDealerPset`) re-derives every amount from the PSET in BigInt — so a bad server response can at worst deliver a hostile PSET, which is exactly what the gate inspects. |
| `psetDetails` ownership | `verify-dealer-pset.ts` | **Confirmed.** Takes the `Pset` by reference (does not consume it) — `prepareSend` reuses the same object after calling it (`engine-core.ts:1030,1038`). No defensive re-parse from base64 is needed; the corrected header comment is accurate. |

## Correctness / liveness (non-security, but worth fixing)

These fail *safe* (no fund risk), so they are out of security scope — but they will bite
the spike and should be fixed before the gate is trusted in a live flow:

- **Check 3 rejects every legitimate swap.** `PsetBalance.recipients()` is documented as
  "outputs that **doesn't belong to the wallet**" (`lwk_wasm.d.ts:1457`). The receive-asset
  output is paid to *our own* address, so it is wallet-owned and never appears in
  `recipients()`. `hasRecvOutput` is therefore always `false` → the gate returns `ok:false`
  for a valid swap. This fails closed (security-safe), but the "defense in depth" provides
  zero security value and blocks the happy path. Drop check 3 (check 1 is the real
  guarantee) or re-implement it against the wallet's own outputs. The spike's *positive*
  test will surface this.
- **No binding between verify and sign.** `verifyDealerPset` and the existing `signPset`
  are independent engine calls; nothing ties the verified bytes to the signed bytes.
  Trusted-caller-only and unwired today, but when wired a reorder/refetch must not sign an
  unverified PSET — bind them (e.g., verify returns the PSET's unique id and the swap
  sign path requires a match, or a single verify-and-sign engine op).
- **Float wire amounts.** SideSwap amounts are JS `number`; deriving `sendAmount` /
  `minRecvAmount` via `BigInt(...)` off the float quote could lose precision on whale-sized
  swaps. Derive the terms from an exact source when wiring.

## Confirmed unchanged (trust boundary intact)

The PR does not touch `content.ts`, `provider/liquid-provider.ts`, `keystore/*`,
`crypto.ts`, or `manifest.config.ts`. The new engine handlers reach `handle()` only via
the offscreen document's `browser.runtime.onMessage` listener gated on
`msg.target === "offscreen"` (`offscreen/offscreen.ts:13-14`) — the same extension-context
path as every existing engine handler; a web page / dapp cannot invoke them (the content
bridge relays only the fixed `provider/*` set). Secret storage, signing, and the dapp
provider surface are unmodified. The manifest gains no new `host_permissions` in this PR
(the two SideSwap WebSocket endpoints are dialed only when the flow is wired).

## Recommendation

No security changes are required to merge PR #32 **as foundation**. Before the gate is
trusted in a live flow, the Track 1 spike must:

1. Prove the tampered-PSET negative tests reject — inflated send amount **and** a
   third-asset drain (per the @claude review), not just one case.
2. Fix check 3 (it currently fails the positive/happy path) — or drop it.
3. Bind verify → sign on identical PSET bytes.
4. Decide the `maxFee` default and the `getUtxos` UTXO-filtering before shipping.

Re-audit the wiring diff (the side-panel swap flow plus the verify → sign path) once
phase 2 lands, rather than re-reviewing these primitives.

## Update (2026-07-23) — findings addressed

Applied on `feat/track1-sideswap-swaps` after this review:

- **Check 3 removed** (`verify-dealer-pset.ts`). The `recipients()` scan failed the happy
  path (the receive output is wallet-owned, so it is never a "recipient"); check 1 is the
  real guarantee. Fixes the liveness bug at no security cost.
- **`maxFee` made required** (`verify-dealer-pset.ts`, `protocol.ts`, `engine-core.ts`).
  The send-asset fee can no longer be left unbounded, closing the fee-griefing footgun at
  the primitive level.
- **Verify → sign binding** and **`getUtxos` send-asset filtering** recorded as hard wiring
  prerequisites in `docs/apogee-swap-integration-plan.md`. Both depend on the not-yet-written
  swap flow (sequencing and UTXO selection), so building the machinery now would pre-judge
  its shape; they are enforced as gates the phase-2 wiring must meet.

The load-bearing anti-drain logic (checks 1, 2, 2b) is unchanged — this review verified it
safe, so it was deliberately left untouched.
