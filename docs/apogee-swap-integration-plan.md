# Apogee swap integration: research and decision plan

Monday, July 20, 2026

Goal: select and validate the integration method for three swap categories, producing one Architecture Decision Record (ADR) per track plus a shared provider abstraction spec. Do not begin implementation of any track until its decision gate passes.

## Constraints (apply to all tracks)

1. **Self-custody boundary.** Apogee never holds a seed outside the offscreen engine. Any swap protocol requiring key material or PSET signing runs in the offscreen document. The page provider and side panel receive watch-only data and approval requests only.  
2. **MV3 environment.** Service workers are evicted. Any swap with a multi-step lifecycle (lockup, claim, refund) must survive eviction: persist swap state to storage, resume via chrome.alarms, and handle the case where the user closes the browser mid-swap. Treat this as a first-class evaluation criterion, not an implementation detail.  
3. **WASM/browser feasibility.** Candidate protocols must be executable from a browser extension: WebSocket or HTTPS APIs, no native binaries, no long-lived daemon requirement on the client.  
4. **Trust model must be surfaced, not hidden.** Where a swap is custodial in transit (track 2), the UI must say so. Where it is atomic (tracks 1 and 3), the UI may say that too. No "Swapped to X" labels without a tooltip or detail view explaining who holds funds and when.  
5. **Compliance posture.** Resolvr is a regulated company. Any third-party provider integration needs a jurisdiction and terms-of-service review before the decision gate closes. Specifically verify US availability, since several candidates block US users.  
6. **Provider abstraction.** All three tracks implement against a common `SwapProvider` interface (quote, initiate, monitor, claim/refund, status). One provider per track is fine at launch, but the interface must allow a second provider without touching UI code. Mirror the existing Esplora failover pattern.

## Track 1: L-BTC \<\> USDt (native Liquid atomic swap)

### Candidates

- **SideSwap Instant Swap API.** Dealer-quoted price, cooperative PSET construction over WebSocket, single atomic Liquid transaction. Roughly 0.6% instant swap fee. Reference client in the sideswapclient repo (Rust core).  
- **SideSwap Swap Market.** Order book with market and limit orders, 0.2% taker fee or 500 sats minimum, partial fills supported. More complex client protocol, better pricing.  
- **TDEX.** Open protocol for Liquid atomic swaps with independent liquidity providers. Verify current network health, active providers, USDt pair liquidity, and TypeScript SDK maturity before treating it as viable.  
- **Boltz.** Confirm whether Boltz supports any USDt pair. Working assumption: it does not (BTC, L-BTC, Lightning only). If confirmed, exclude and note in the ADR.

### Research tasks

1. Read the SideSwap API docs end to end (sideswap.io/docs). Document the exact instant swap message flow: price subscription, swap request, PSET exchange, signing order, broadcast responsibility, timeout behavior.  
2. Confirm the protocol works from a browser: WebSocket endpoint reachable from an MV3 service worker or offscreen document, no client daemon assumed. Identify any origin or auth requirements.  
3. Verify LWK (`lwk_wasm`) exposes what the flow needs: PSET parse, unblinding of counterparty outputs, input signing on an arbitrary externally constructed PSET, and blinding factor access. List any gaps against the lwk\_wasm API surface actually shipped in the version Apogee pins.  
4. Specify dealer PSET verification: before signing, unblind and confirm asset IDs, amount paid to our address vs the quote (with an explicit slippage tolerance), our change outputs, and fee. This check lives in the offscreen engine. Write it as a testable pure function over a parsed PSET.  
5. Assess SideSwap dealer availability history if discoverable; otherwise define client-side behavior on dealer downtime (fail closed, clear error, no retry loops that spam quotes).  
6. Evaluate the SideSwap PayJoin API as a sibling deliverable: server-provided L-BTC UTXOs let a USDt-only wallet pay fees in USDt. Same cooperative-PSET shape. Decide whether it ships in the same milestone or after; it likely removes the current "no L-BTC for fees" error path.

### Spike

Build a throwaway script (Node or a test page, not the extension) that completes one testnet instant swap L-BTC to USDt using lwk\_wasm and the SideSwap API, including the verification function from task 4\. Success criterion: swap settles, verification rejects a tampered PSET in a negative test.

### Decision gate

Choose Instant Swap vs Swap Market vs TDEX based on: protocol complexity in a browser context, fee/price quality at expected trade sizes ($10 to $10k), liquidity depth, and verification tractability. Default expectation is SideSwap Instant Swap first, Swap Market as a later upgrade behind the same interface. Record in ADR-1.

## Track 2: USDt \<\> external chains (Ethereum, Solana, Tron, BNB)

This track is categorically different: it is custodial in transit. The wallet sends Liquid USDt to a provider address and the provider pays out on the destination chain (or the reverse). No atomic construction exists here. The decision is which counterparty risk to take and how to present it.

### Candidates

- **SideShift.** Used by Aqua. API-driven, variable and fixed-rate shifts, affiliate revenue share. Known jurisdiction blocking; verify current US policy explicitly, since this may disqualify it outright for Apogee's audience.  
- **Changelly.** Aqua's second provider. Broader jurisdiction coverage but KYC holds on flagged transactions; document the hold/refund process and its failure modes.  
- **Others (ChangeNOW, FixedFloat, similar).** Screen at least two more for terms, US availability, API quality, and payout reliability reputation. Reject quickly if terms are unacceptable; do not deep-dive more than the top two viable options.

### Research tasks

1. Compliance first: for each candidate, document jurisdiction restrictions, KYC trigger conditions, licensing status, and terms-of-service obligations on integrators. Produce a one-page memo for legal review before any technical work. If no provider is acceptable for US users, the ADR outcome may be "do not ship track 2 initially," and that is a valid outcome.  
2. For surviving candidates, document the API lifecycle: quote (fixed vs floating rate), deposit address issuance, min/max limits per pair, confirmation requirements, payout timing, refund path when a deposit misses the rate window or limits, and status polling/webhooks.  
3. Define the MV3 monitoring story: a shift can take minutes to hours. Persist shift state, poll on chrome.alarms, notify on completion, and handle the browser being closed for the entire duration (state reconciliation on next open).  
4. Define UX for both directions. Receiving is the sharper problem: the "your Ethereum USDt address" shown to the user is provider-owned. Specify labeling that makes this legible (provider name, trust window, limits) without burying it. Study Aqua's network-selection screen as the baseline and improve on its disclosure.  
5. Quantify cost: spread vs mid-market at three sizes per corridor, plus fixed fees, for each candidate. A table in the ADR.  
6. Evaluate affiliate/commission terms as a secondary criterion only after trust, compliance, and reliability.

### Spike

One testnet or small-value mainnet shift each direction with the leading candidate, driven entirely through the API (no provider web UI), with state persisted and resumed across a simulated service worker restart.

### Decision gate

Select zero, one, or two providers. Two is acceptable only if the abstraction keeps UI identical and routing is deterministic (e.g., by corridor or jurisdiction), not a per-swap price race at launch. Record in ADR-2, including the explicit trust disclosure copy.

## Track 3: BTC and Lightning \<\> L-BTC

### Candidates

- **Boltz.** Submarine swaps (Lightning \<\> L-BTC) and chain swaps (BTC \<\> L-BTC). Trust-minimized: atomic via HTLC/Taproot scripts, with cooperative refund paths. Open API, browser-proven (Boltz's own web app runs client-side). Default candidate.  
- **SideSwap peg-in/peg-out.** Wraps the Liquid federation peg, roughly 0.1%, but on-chain BTC only (no Lightning) and trust in SideSwap's peg service for the peg-out leg. Evaluate as a complement for large on-chain amounts, not a Lightning solution.  
- **Native peg-in.** Trust-minimized but 102 confirmations and poor UX; peg-out is federation-only. Likely document-and-exclude, but note it as the settlement-assurance ceiling the others are measured against.

### Research tasks

1. Map Boltz swap types to Apogee flows: reverse/normal submarine swaps for Lightning, chain swaps for on-chain BTC. Document script types used today (Taproot), refund and claim mechanics, and timeout block heights per pair.  
2. Client requirements: what the wallet must generate and store per swap (preimages, keys, refund scripts), what must be broadcast and when, and whether Boltz's cooperative claim (server-assisted) reduces the client's liveness burden. This determines how hard the MV3 problem is.  
3. MV3 lifecycle design: a swap interrupted by service worker eviction or browser close must be recoverable. Specify persisted swap records, alarm-driven status checks, refund broadcasting after timeout, and a "pending swaps" surface in the side panel. This is the hardest engineering problem in the whole plan; give it proportionate depth.  
4. Confirm LWK can construct and sign the Liquid-side claim/refund transactions Boltz requires, or whether supplementary code (e.g., from boltz-core) is needed in the offscreen engine.  
5. Fees and limits: Boltz fee schedule per pair, min/max amounts, and how quoted fees are verified client-side before lockup.  
6. Decide Lightning receive scope. A Boltz reverse swap gives receive-to-L-BTC per invoice, but a persistent Lightning address is a separate product question (it requires an always-on component). Explicitly out of scope for this decision unless trivially available; note it in the ADR either way.

### Spike

Complete one testnet Lightning-to-L-BTC reverse swap and one L-BTC-to-Lightning submarine swap from a browser context, with the swap surviving a forced service worker restart mid-flight and a successful refund test on an intentionally expired swap.

### Decision gate

Boltz is the presumptive answer; the gate is confirming the MV3 lifecycle is safe (no fund-loss path when the user disappears mid-swap) and that refunds are reliably recoverable from persisted state alone. If chain swaps prove heavy, shipping Lightning pairs first and on-chain BTC later is acceptable. Record in ADR-3.

## Cross-cutting deliverables

1. **`SwapProvider` interface spec** covering all three trust models (atomic same-chain, custodial shift, HTLC cross-layer), with a common swap record schema for persistence and a shared pending-swaps UI contract.  
2. **Trust disclosure copy** for each category, reviewed once, reused everywhere.  
3. **Threat model note** per track: what a malicious or failed provider can and cannot do to user funds, and what the client verifies to enforce that.  
4. **Sequencing recommendation.** Default: Track 1 first (smallest lift, pure LWK/PSET work, immediate product value, and PayJoin falls out of it), Track 3 second (hardest, highest value), Track 2 last or never pending compliance. The agent may propose a different order with justification in the ADRs.

## Output format

Three ADRs (context, options considered, decision, consequences) plus the interface spec, all in `docs/`. Spike code lives in a `spikes/` directory outside `src/` and is not shipped.  
