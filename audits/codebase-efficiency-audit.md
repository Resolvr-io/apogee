# Codebase Efficiency & Redundancy Audit

**Date:** 2026-08-22
**Scope:** full repository — `src/` (background, engine, sidepanel, provider, tx-manifest, keystore, sideswap, jade, scanner, content, offscreen, prompt, lib), `crates/tx-manifest-runtime/`, `e2e/`, `playground/`, build config.
**Method:** five parallel deep-scans (one per subsystem plus a cross-cutting sweep), every finding verified against the code at commit `12af2e2`. File:line references are to that commit.

---

## Executive summary

The codebase is in good overall shape: dependencies are all used, the build config is clean and deliberately documented, formatting/asset/explorer helpers are mostly centralized in `src/lib/`, and cleanup of timers/listeners is correct in the large majority of components. The waste that exists clusters into four themes:

1. **Hot-path CPU waste in TX-Manifest preparation** — covenants are recompiled from scratch on every iteration of the fee-convergence loop (up to 16 iterations × 8+ WASM Simplicity compilations of a 21 KB source), and the ~118 KB trusted bundle is canonical-JSON-serialized and double-SHA-256'd ~17+ times per user action. Fixing two hoisting bugs removes an order of magnitude of prepare latency.
2. **Redundant sync/network churn** — every dapp `getBalance`/`getUTXOs` call runs a full chain sync with no freshness window; the panel runs up to three overlapping sync pollers; the scan-state persistence rewrites up to ~3 MB to IndexedDB on every 20-second tick; a healthy waterfalls server is re-probed on every sync; SideSwap opens a fresh TLS+WebSocket per quote preview.
3. **Copy-paste that is already drifting** — ~450 lines of validation/PSET scaffolding across the four `prepare-*` flows (with three divergent parameter orders in security validators), a 5×-repeated provider authorization block, 7 hand-rolled messaging envelopes (one already incompatible), and utility functions (`bytesToHex` ×7, `errMessage` ×4 + ~10 inline, `isRecord` ×5, esplora endpoint lists ×4, genesis hashes ×2, trailing-slash normalizers ×5 with one behaviorally different).
4. **Dead code on sensitive surfaces** — eight engine protocol ops that are never dispatched, including an **ungated `signPset` that accepts a raw mnemonic and bypasses every provider-PSET analysis gate**; an emit-less dapp event API; a fully dead parallax-scroll pipeline; probe exports shipped in the production WASM binary.

### Top 10 by impact

| # | Finding | Area | Type | Severity |
|---|---------|------|------|----------|
| 1 | Covenant recompilation inside the fee-convergence loop (§1.1) | tx-manifest / engine | time | High |
| 2 | ~118 KB bundle re-canonicalized + re-hashed ~17× per action (§1.2) | tx-manifest | time | High |
| 3 | Dead engine ops incl. ungated mnemonic-accepting `signPset` (§6.1) | engine | dead code / attack surface | High |
| 4 | Full chain sync on every dapp read, serialized behind one queue (§1.3) | background | time | High |
| 5 | No timeout on SW↔offscreen engine port — a hung op wedges all wallet ops (§2.1) | background | reliability/memory | High |
| 6 | Scan-state full-array rewrite (≤3 MB) to IndexedDB per sync + ~6 MB retained in memory (§1.4, §2.2) | engine | time+memory | High |
| 7 | ~450 lines of drifting copy-paste across the four `prepare-*` flows (§5.1) | tx-manifest | redundancy | High |
| 8 | 5× provider authorization guard + 3× inline re-check in background (§5.2) | background | redundancy | High |
| 9 | PriceChart rebuilds a ~24k-point SVG path on every pointer-move (§1.6) | sidepanel | time | High |
| 10 | Esplora endpoints, genesis hashes, hex/error utilities each defined in 2–7 places (§4) | cross-cutting | redundancy | High |

---

## 1. Time waste (hot paths first)

### 1.1 Covenants recompiled on every fee-convergence iteration — **High**
`convergeTxManifestFee` (`src/tx-manifest/fees.ts:132`, `TX_MANIFEST_MAX_FEE_ITERATIONS = 16` at `:12`) calls `prepare(fee)` up to 16 times. The engine's prepare closures (`src/engine/engine-core.ts:1142`, `:1256`, `:1386`) invoke the full `prepareLendingV3*` each time, and each call recompiles all covenants from scratch: `prepare-accept-offer.ts:100` → `compileLendingV3AcceptOfferCovenants` (`lending-v3.ts:54–169`) runs **8 WASM Simplicity compilations** over sources up to 21 KB. The same pattern exists in `prepare-lending-action.ts:128`, `prepare-create.ts:93,229–243`, and `prepare-claim-lender-vault.ts:80`. Compilation inputs (`plan.instance`, network) are **loop-invariant** — only input selection and change amounts depend on the fee. On top of that, each `finalizeCovenant` call recompiles its source *again* inside Rust (`finalize_covenant_pset` → `compile_program`, `crates/tx-manifest-runtime/src/lib.rs:240`), so a single AcceptOffer convergence can compile `lending.simf` **30+ times**.

**Fix:** hoist `compileCovenants(plan.instance)` (and `deriveAsset`/`compileFactory` in prepare-create) out of the `prepare(fee)` closure — compile once before `convergeTxManifestFee` and pass the precompiled covenants in via the existing `runtime` DI object. Secondarily, memoize `(source, args, debug) → CompiledProgram` inside the Rust runtime or the `runtime/index.ts` wrapper.

### 1.2 Trusted bundle (~118 KB) re-hashed on every registry touch — **High**
`assertTrustedBundleIntegrity` (`src/tx-manifest/registry.ts:152–160`) runs `txManifestBundleHash(trusted.bundle)`: `normalizeTxManifestBundle` regex-scans all five sources, deep-clones the 78 KB manifest via `JSON.parse(canonicalJson(...))` (`bundle.ts:111,255`), then canonical-JSONs the whole ~118 KB bundle again for hashing. It runs from `resolveTrustedTxManifest` (`registry.ts:127`) once per requirements resolution **and** from `trustedTxManifestActionHintScript` (`registry.ts:142`), which every prepare function awaits (`prepare-accept-offer.ts:163`, `prepare-create.ts:106,276`, `prepare-lending-action.ts:131`, `prepare-claim-lender-vault.ts:113`) — i.e. once per fee iteration, ~17+ full re-hashes per user action, doubled when the reviewed-fee revalidation pass runs. The bundle is frozen at module load and its hash is a compile-time constant.

**Fix:** verify integrity once per registry entry and cache (`Map<bundleHash, Promise<void>>`); cache the hint script per `(bundleHash, action)` — a pure function over 8 actions; hoist it out of the fee loop (it is loop-invariant). Bonus: `registry.ts:129` normalizes the supplied bundle twice — `txManifestBundleHash` already begins with `normalizeTxManifestBundle`, so the outer call is a fully redundant second regex-scan + deep clone.

### 1.3 Full chain sync on every dapp read, on a serial queue — **High**
`getBalance`, `getUTXOs`, `signPset`, legacy `provider/getBalance` each begin with an unconditional `engine({ kind: "sync", ... })` (`src/background/index.ts:1726–1731`, `:1779–1784`, `:2005–2010`, `:2923–2928`; also `:2320–2325`, `:3729–3734`, `:4059–4064`). Each sync is a `chainServer` storage read → serial engine-queue wait → waterfalls preflight probe (§1.5) → full scan → scan-state persist (§1.4). A dapp polling `getBalance` every few seconds drives this whole pipeline per call, and because the engine queue is serial (`background/index.ts:484`), each dapp poll also **stalls every other wallet operation** behind it.

**Fix:** track `lastSyncedAt` per descriptor and skip/coalesce syncs younger than a small TTL (5–10 s) for read paths. Keep unconditional sync for the pre-signing security re-checks. Related: the Jade `signPset` flow performs **three** full sync+analyze rounds (request `:2005`, decision `:3729`, post-signature `:4059`); the decision-time sync can be dropped or TTL-gated since its analysis is immediately repeated post-signature.

### 1.4 Scan-state persistence rewrites the whole updates array per sync — **High (with §2.2)**
`persistScanUpdate` (`src/engine/engine-core.ts:306–331`) re-serializes and re-`put`s the **entire** updates array (bounded by `SCAN_STATE_MAX_CHARS = 3_000_000` chars, `:230`) to IndexedDB on every sync — including tip-only updates where one entry changed — and opens/closes the DB per op (`:248–285`). With the panel's 20-second poll that's up to ~3 MB of write amplification every 20 s.

**Fix:** store each update under its own key (`${stateKey}:${seq}`) and append/replace only the changed record; skip the put when a tip-only replace produced identical bytes.

### 1.5 Waterfalls health probe re-fetched on every successful sync — **Medium**
`waterfallsReachable` (`engine-core.ts:683–696`, called from `fullScanResilient` at `:720`) only caches the *failure* result (`waterfallsDownUntil`). A healthy server is re-probed with a fresh `fetch` on every sync — one extra HTTP round-trip per 20-second poll tick, forever. **Fix:** cache a positive probe for ~60 s, or skip the preflight when the last scan succeeded recently.

### 1.6 PriceChart rebuilds the full trace on every render, re-rendered per pointer-move — **High**
`src/sidepanel/components/PriceChart.tsx:117–125` computes `tracePaths(points, history.times)` plus `Math.min(...points)` / `Math.max(...points)` in the render body with no `useMemo`; `tracePaths` spreads min/max again internally (`:55–56`). The series runs to ~24k points (the file's own comment at `:171`), and every `onPointerMove` sets scrub state → re-render → four O(n) spreads plus a ~24k-segment SVG path string rebuild **per mouse event** — while the same code binary-searches the scrub index specifically to avoid a linear scan. Spreading 24k args is also within a factor of ~5 of engine argument limits.

**Fix:** `const { line, area, lo, hi } = useMemo(() => …, [history])`; compute min/max in a loop inside `tracePaths` and return them. Scrubbing becomes O(log n)/event.

### 1.7 Overlapping, uncoordinated sync polling in the panel — **Medium**
Three independent pollers can hit the same SW/Esplora endpoint concurrently with no shared in-flight dedup: the 20 s interval + visibilitychange refresh (`Wallet.tsx:418–429`), the 5 s × 12 post-send settle poll (`Wallet.tsx:392–407`, triggered per `apogee/balance-changed`), and the Coins screen's own `balance-changed` reload + 5 s consolidation poll (`Wallet.tsx:1494–1500`, `:1546–1551`). **Fix:** route refreshes through one scheduler (skip interval ticks while a settle poll is active; lift/share the settle poll), or debounce `wallet/sync` in the SW.

### 1.8 Non-Wollet ops ride the serial engine queue — **Medium**
`wallet/qr` and `wallet/getAsset` are queued (`background/index.ts:883,886`) even though they touch no Wollet — the comment at `:519–522` already names `qr` direct-safe and routes `getRate` via `engineDirect`. Consequences: a slow sync stalls QR rendering; `getAsset` performs a **network registry fetch inside the queue**, blocking syncs/sends; and `resolveManifestAssets`' `Promise.all` of `getAsset` calls (`:1913–1919`, `:2541`) is effectively sequential. Additionally, `getAsset` results are never cached (`engine-core.ts:1899–1925`) although asset metadata is immutable in practice — the same ids are re-fetched on every send review and approval. **Fix:** route both through `engineDirect`; add a `Map<network:assetId, AssetInfo>` cache in the engine.

### 1.9 Manifest history annotations recomputed per call — **Medium**
`getTransactions` re-serializes every wallet tx to bytes and re-runs `txManifestHistoryAnnotation` over the full history on every call (`engine-core.ts:1071–1103`), though a confirmed tx's annotation can never change. Inside the annotation path, `txManifestActionTag` — a pure tagged-SHA-256 over a constant table of 8 actions — is recomputed **sequentially per transaction** (`src/tx-manifest/history.ts:89–91`, `action-hint.ts:22–33`). **Fix:** memoize annotations by txid (content-addressed, no invalidation needed); precompute a `Map<actionTag, action>` once per trusted bundle.

### 1.10 Duplicate Esplora fetches within one resolution — **Medium**
`resolveOutpoint` (`src/tx-manifest/esplora.ts:258–296`) fetches `/tx/:txid/hex` and `/tx/:txid/status` per outpoint with no per-txid memoization — for CreateOffer, `factory_auth_in` and `factory_covenant_in` are two outputs of the *same* transaction, so identical responses are fetched twice and the tx hex WASM-deserialized twice (the post-hoc `new Set` dedup at `:106,188,235` proves duplicates are expected). `/block-height/0` (the genesis hash — immutable per endpoint) is re-fetched on every resolution (`:86,169,216`). **Fix:** a `Map<txid, Promise<…>>` within one resolution; cache the genesis check per esplora URL for the session.

### 1.11 SideSwap: fresh TLS+WS handshake and full UTXO/address preamble per quote preview — **Medium**
`wallet/swapQuote` and `wallet/swap` each do `new SideSwapClient(); await client.connect(); … finally client.disconnect()` (`background/index.ts:1050–1051`, `:1009–1010`), and the orchestrator re-fetches all UTXOs and re-derives two addresses per preview (`src/sideswap/orchestrator.ts:372–394`). Every amount edit or TTL-lapse re-quote pays a TLS+WS handshake plus three sequential engine round-trips. `stop_quotes` is not implemented at all — ending the dealer's push stream relies on disconnect. **Fix:** one lazily-connected, idle-timeout client per network in the SW; cache the UTXO/address preamble for a swap-form session (invalidated on `apogee/balance-changed`); send `stop_quotes` when a preview completes. Fewer round-trips beats parallelism here since the engine queue serializes anyway — add one engine op returning `{ utxos, receiveAddress, changeAddress }`.

### 1.12 Provider event broadcast scans every tab, per origin — **Medium**
`notifyConnectionChanged`/`notifyWalletDescriptorChanged` send a runtime message to **every open tab** (`background/index.ts:1229–1243`, `:1274–1288`), and `removeAllConnectedSites` (`:1365`) runs one full `tabs.query({})` **per connected origin**. **Fix:** query tabs once per batch; longer-term track which tabIds host an active bridge per origin.

### 1.13 Smaller time sinks — **Low**
- **Failed asset-info lookups retried every poll, serially** — `Wallet.tsx:445–468`: a failing `wallet.getAsset` never enters `assets`, so it re-fetches on every 20 s/5 s tick, in a `for…await` loop. Record failures with backoff; fetch in parallel.
- **`jsonRecord` triple-walks its input** — `liquid-rpc-validation.ts:208–214`: validate walk + `JSON.stringify` + `JSON.parse` (≤1 MB). One recursive validate-count-copy pass.
- **Scanner decodes at 60 fps on the main thread** — `src/scanner/scanner.ts:87–113` re-queues per animation frame; the jsQR fallback does a 640 px `drawImage` + `getImageData` + two-inversion pass per frame. Throttle to ~100–150 ms.
- **`chainServer()` read twice in one function** (`background/index.ts:2324` + `:2333`) and repeatedly per manifest decision (`:3478`, `:3617`); sequential `await`s in object literals that could be `Promise.all` (`:978–985`, `:3851–3858`).
- **Keystore**: `txManifestCheckpointKey` re-derives the AES key (SHA-256 + importKey) per seal/open (`src/keystore/keystore.ts:266–278`) — memoize per walletId, cleared on `lock()`/`reset()`. `getState`/`getActiveWalletId`/`removeWallet` issue two sequential storage reads where one batched `get([STORE_KEY, ACTIVE_KEY])` works (`keystore.ts:233–243`, `:586–590`, `:569–578`).
- **`liquid_getBalance` façade** may issue a second round-trip just to learn the network (`liquid-provider.ts:223–226`) — include the network in the internal reply.
- **Rust `compile_program`** re-serializes an already-parsed `serde_json::Value` to a string and re-parses it (`lib.rs:190–193`) — use `serde_json::from_value`.
- **Seed-reveal countdown re-renders all of SettingsBody every second** (`Wallet.tsx:2148–2160`) — the `seedQr` memo at `:2139` treats the symptom; extract the countdown row into its own component.

---

## 2. Memory waste & reliability leaks

### 2.1 SW engine port: in-flight requests have no timeout — a hung op wedges everything — **High**
`postEngine` stores `conn.inFlight.set(id, resolve)` with no watchdog (`background/index.ts:444–457`); only port disconnect settles it (`:4122–4131`). `engineQueue` (`:484–536`) serializes **all** engine calls behind the pending promise, so if the offscreen WASM engine deadlocks while the port stays connected, every subsequent wallet operation (sync, sign, provider RPC) queues forever until browser restart. The SideSwap client (`sideswap/client.ts:183–185`) and the page provider (`liquid-provider.ts:164`) both already put ceilings on their pending maps. **Fix:** a generous per-request watchdog (minutes, for signing ops) that rejects, cleans up, and tears the port down so the offscreen document reconnects fresh.

### 2.2 Scan updates duplicated in memory for the life of the offscreen document — **Medium**
`CachedWollet.updates` (`engine-core.ts:204–212`, filled at `:499–531`, appended at `:306–331`) holds up to ~3M chars (~6 MB UTF-16) per wallet **in addition to** the IndexedDB copy and the applied Wollet state, and is never released. The array is only needed at rehydrate time. **Fix:** keep only counters/last-entry metadata in memory; append individual records to IndexedDB (pairs with §1.4).

### 2.3 Per-UTXO duplication of full parent-transaction hex — **Medium**
In all three manifest candidate builders, `parentTransaction: bytesToHex(transaction)` runs **inside the per-UTXO map** (`engine-core.ts:1137`, `:1226`, `:1342`), so N UTXOs from one parent hold N identical multi-KB hex strings (confidential Liquid txs are commonly 10–100+ KB → 2× as hex) for the whole fee convergence; `extractElementsTxOut` also re-parses the raw tx per UTXO (`:1130`, `:1219`, `:1335`). The `transactions` map additionally materializes `toBytes()` for **every** historical tx, not just UTXO parents (`:1115–1120`, `:1320–1325`). Dedup via `new Set` happens only *after* all copies were materialized. **Fix:** hex each tx once into a `Map<txid, hex>` shared by candidates, populated lazily for UTXO parents only; parse each tx's outputs once and index by vout.

### 2.4 Post-send settle poll can outlive Wallet unmount — **Medium**
`settleAfterTx` (`Wallet.tsx:392–414`): if a `tick` is awaiting `refresh` when Wallet unmounts (user locks right after a send), its continuation re-arms a new timeout after cleanup ran — the chain keeps issuing `wallet.sync` + `wallet.getTransactions` (and setState on an unmounted component) every 5 s for up to ~60 s. Two overlapping chains also clobber each other's `settleTimer.current`, making one uncancelable. **Fix:** a cancellation flag/generation counter checked after the `await`, cleared on unmount and on each new `settleAfterTx`.

### 2.5 Smaller leaks/retention — **Low**
- **Page-provider response timers never cleared on settle** (`liquid-provider.ts:164–172`): each request leaves a live timer + closure for up to `SEND_TIMEOUT_MS` = 11 min. Store the handle, `clearTimeout` in the reply handler.
- **SideSwap `onQuote` handler never deregistered; `queuedQuotes` unbounded until drained** (`client.ts:115–127`, `orchestrator.ts:462–484`); a second `onQuote` silently discards the first subscriber. Make `onQuote` return an unsubscribe; keep only the latest quote per `quote_sub_id`.
- **Emit-less legacy event registry retains dapp listeners it can never call** (`liquid-provider.ts:74–79`, `:303–308`) — see §6.2.
- **`priceHistoryCache` retains a ~24k-point object array indefinitely** after its 10-min TTL (`engine-core.ts:853–857,890`); clear on expiry or store two `Float64Array`s (~10× smaller).
- **Unresolved TX-Manifest checkpoints are never aged out** (`src/tx-manifest/idempotency.ts:122`, `:253–255`) while terminals are capped at 100 — each holds an encrypted full tx hex. Cap them with an explicit failure path or surface them in the UI.
- **Per-approval global `windows.onRemoved` listener** (`background/index.ts:3314–3324`) — one live listener per open popup; replace with a single persistent listener over a `Map<windowId, approvalId>` (also removes the O(pendings) scan at `:4084–4092`).
- **`connectionRevisions` grows per origin, never pruned** (`background/index.ts:1138`) — deliberate fencing design, bounded by SW eviction; document or LRU-cap like `PANEL_STEPUP_MAX`.

**Verified clean:** interval/listener cleanup in Unlock/StepUp, Swap countdown, toast, CopyButton, OceanVideo, ShootingStars, Starfield, AssetSelect, Onboarding poll; scanner track/rAF/port cleanup; SideSwap `failAll`; jade serial-port + WASM-object `finally` frees; engine-port disconnect settling.

---

## 3. Componentization — repeated UI elements (`src/sidepanel/`)

### 3.1 Components to extract into `components/ui.tsx`

| Component | Copies today | Proposed props |
|---|---|---|
| **`Row`** (label/value dl-row) — **High** | `Wallet.tsx:2990–3015`, `Send.tsx:556–600`, `Approval.tsx:955–1008` (Approval's is a strict superset; the copies have already drifted) | `{ label, value, mono?, strong?, amount?, console?, title?, wrap? }` |
| **`IdRow` / `IdActions`** (copy icon + explorer link) — **High** | verbatim ×4 in `Wallet.tsx:1102–1116, 1336–1350, 1803–1817, 1887–1901`; byte-identical "View transaction" links in `Send.tsx:334–344` ≡ `Swap.tsx:604–614` | `{ label, value, explorerUrl, copyLabel }` |
| **`TxSuccess`** (done screen: pop-check badge, txid capsule, explorer link, Done button) — **High** | `Send.tsx:313–349` ≈ `Swap.tsx:548–618`; badge sibling at `Approval.tsx:243–273` | `{ title, summary?, txid, network, onDone, children? }` |
| **`StepUpPasswordField`** — **Medium** | near-identical on 4 signing surfaces: `Wallet.tsx:1753–1762`, `Send.tsx:401–410`, `Approval.tsx:493–502`, `Swap.tsx:811–819` | `{ value, onChange, label? }` — pairs with `useAutoLock` (§3.2) |
| **`Modal`** (overlay + centered card) — **Medium** | `Wallet.tsx:920–946`, `Unlock.tsx:147–254` (card chrome duplicated twice within), `Approval.tsx:84–95` | `{ onDismiss?, z?, children }` |
| **`Select`** — **Medium** | identical `console-select …` class string ×4: `Wallet.tsx:2255, 2266, 2297, 2492` | sibling of the existing `Input`/`Textarea` (`ui.tsx:58–67` `FIELD_BASE`) |
| **`AmountField`** (label + Max + precision-aware placeholder) — **Medium** | `Send.tsx:488–534` vs `Swap.tsx:870–929` (+ placeholder ternary a 3rd time at `Swap.tsx:979–987`) | `{ label, unitLabel, value, onChange, onMax?, isLbtc, isBtc, precision, hint? }` |
| **`PermissionCard`** — **Low** | two near-identical map bodies `Approval.tsx:327–349` vs `:351–372` | `{ icon, label, description, sensitive? }` |

### 3.2 Hooks to extract

- **`useAutoLock()` / `useNeedsStepUp(isJade)`** — **High.** The `wallet.getAutoLock()` bootstrap effect is copy-pasted 5× (`Wallet.tsx:1444–1449`, `:2035–2037`, `Send.tsx:227–229`, `Swap.tsx:109`, `Approval.tsx:187–189`) with **three different error fallbacks and two different initial states** — Send/Coins carry comments explaining why `null`-init is correct while Swap/Approval still use the divergent `15` default. Security-relevant logic that has already drifted; one hook fixes semantics everywhere.
- **`useUnlockThrottle()`** — **High.** The full countdown machinery (throttle state, refresh callback, mount effect, 1 s interval, lapse-refresh, blocked/cooldown JSX) is duplicated inside one file: `Unlock.tsx:39–68` vs `:273–296` (+ JSX `:115–121` vs `:342–347`). ~60 lines.
- **`useRuntimeMessage(type, handler)`** — **Medium.** The `browser.runtime.onMessage` guard/add/remove boilerplate is hand-rolled 7× (`Wallet.tsx:433–441`, `:1494–1500` — this one even skips the type guard the others use — `:2187–2195`, `App.tsx:300–333`, `ConnectionBar.tsx:47–63`, `Send.tsx:176–215`, `Onboarding.tsx:73–91`).
- **`resolveAssetDisplay(assetId, assets, policyHex?)`** — **High.** The chain `KNOWN_ASSETS[id]?.label ?? info?.ticker ?? info?.name ?? shortenHex(id, 6, 6)` (and the matching precision chain) is restated ~9×/~6× across `Wallet.tsx:1013–1018, 1209–1210, 1707–1709`, `Send.tsx:116–124, 460–465`, `Swap.tsx:168–186, 860–866, 953–959`. `Send.tsx:114–115`'s comment asserts the exact invariant ("entered amount can never scale differently from what's shown") that a shared helper would enforce.
- **`formatLbtc(sats, denom, rate, fiat)` and `unitsToText(units, precision)` in `@/lib/format`** — **Medium.** The 3-way denom ternary is duplicated (`Wallet.tsx:993–1000` ≡ `:1196–1203`; 2-way variants in `Swap.tsx:213–215`, `Send.tsx:440–445`); `(sats / 100_000_000).toFixed(8).replace(/\.?0+$/, "")` appears 6× (`Swap.tsx:294, 371, 430, 880`, `Send.tsx:171, 211`); `Send.tsx:50–57` `unitsToText` is re-derived inline at `Swap.tsx:377–386`; `Swap.tsx:229–231` `fmtUsd` re-implements `formatFiat`.
- **`useStoredPref<T>(key, default, { subscribe? })`** — **Low.** Four hand-rolled storage-backed hooks (`Wallet.tsx:107–120, 143–155, 157–179`, `use-animations.ts:20–52`, plus `lib/demo-funds.ts`); the three Wallet ones don't subscribe to `storage.onChanged` and would desync with a second consumer.
- **`useCopied()`** — **Low.** `CopyButton` and `CopyIconButton` duplicate the copied-state/timer logic inside `ui.tsx` itself (`:472–495` vs `:506–528`).
- **`useConnectedSites()`** — **Low.** SettingsBody and ConnectionBar independently load + re-load connected sites (`Wallet.tsx:2184–2199` vs `ConnectionBar.tsx:36–63`); when both are mounted, every change fires two duplicate SW round-trips.

### 3.3 Render-performance fixes
- **Memoize list rows** — `TxRow` (`Wallet.tsx:1156`), `CoinRow`, `Tokens` are unmemoized while the 20 s poll unconditionally replaces `sync`/`txs` identities (`Wallet.tsx:359–378`), re-rendering every loaded row (25/page, unbounded `visible`) each tick. Wrap in `React.memo`; keep `txs` referentially stable when the fetched list is unchanged.
- `const assets = demoFunds ? {} : liveAssets` creates a fresh `{}` per render (`Wallet.tsx:235`, `:628`) — hoist a module-level `EMPTY_ASSETS`.
- IntersectionObserver rebuilt on every pagination (`Wallet.tsx:541–553`) — one observer + a ref.

---

## 4. Cross-cutting duplication (utilities, constants, types)

### 4.1 Utility functions — one `src/lib/` home each

| Utility | Definition sites | Proposed home |
|---|---|---|
| `bytesToHex` / `hex` — **High** | `engine-core.ts:293`, `provider-utxos.ts:72`, `tx-manifest/action-hint.ts:154` (+ `parseHex` `:145`), `history.ts:203`, `bundle.ts:251`, inline `issuance.ts:40`, single-byte variant `Wallet.tsx:2633` | `src/lib/hex.ts` (`bytesToHex`, `hexToBytes`) |
| `errMessage` / `errMsg` — **Medium** | `sidepanel/errors.ts:10`, `offscreen/offscreen.ts:58`, `background/index.ts:4355`, `jade/jade.ts:66` (+`:56`), plus ~10 inline restatements (`background/index.ts:2648,2783,3515,3672`, `engine-core.ts:604,1747`, `content.ts:94`, `broadcast-checkpoint.ts:93,101`, `Wallet.tsx:1612,1655`, `playground/liquid-provider/conformance.ts:211`) | `src/lib/` (pure, chrome-free) |
| `isRecord` / `isObject` — **Medium** | `liquid-rpc-errors.ts:83`, `liquid-browser-provider-validation.ts:124`, `liquid-rpc-validation.ts:415–420` (`record()`), `bundle.ts:294`, `playground/…/conformance.ts:274`, `playground/…/main.ts:354` | `src/lib/` (one per package) |
| `sha256(Uint8Array)` + tagged hashing — **Medium** | `bundle.ts:245` ≡ `action-hint.ts:102`; `txManifestBundleHash` (`bundle.ts:142–153`) is an **exact inline copy** of `taggedCanonicalJsonHash` (`bundle.ts:155–166`); `action-hint.ts:93–99` `taggedHash` is the same construction a third time | `src/tx-manifest/hash.ts` (or `src/lib/digest.ts`); `txManifestBundleHash` becomes a one-line call |
| `normalizeBase` (trailing-slash strip) — **Low** | `esplora.ts:319–321` ≡ `fees.ts:194–196`; inline `engine-core.ts:1833,1866`, `background/index.ts:901`; **`broadcast-checkpoint.ts:54` is behaviorally different** (`/\/$/` strips one slash — `…/api//` → double-slash URLs) | shared chain-server module (§4.2); fixes the inconsistency for free |
| `isJsonValue` — **Medium (drift)** | `liquid-rpc-validation.ts:216–230` (depth-capped, integers-only) vs `liquid-browser-provider-runtime.ts:139–152` (**uncapped recursion**, accepts floats) — page and extension disagree on the same request, and deep input can overflow the page-side stack | one parameterized `isJsonValue(value, {maxDepth, integersOnly})` |
| u64 bound check | `liquid-rpc-validation.ts:199–206` vs `:460–472` | `transferAmount = positive(unsignedU64(...))` |
| 64-hex-id regex | `lib/explorer.ts:26`, `liquid-rpc-validation.ts:38`, inline `engine-core.ts:1846` | `src/lib/hex.ts` |

### 4.2 Network constants — **High (drift risk)**
- **Esplora endpoint lists ×4:** `engine-core.ts:133–144` (`ESPLORA`/`ESPLORA_ALT`), `tx-manifest/broadcast-checkpoint.ts:16–23`, `tx-manifest/esplora.ts:30–33`, `Wallet.tsx:2973–2988` (`chainPresetsFor`). Same URLs; the ordering rationale (liquid.network first because blockstream.info 429s, `engine-core.ts:130`) lives in only one copy, and the failover policies against the same hosts have already diverged. **Fix:** `src/lib/chain-servers.ts` exporting `ESPLORA_PROVIDERS: Record<LiquidNetwork, string[]>`; all four derive from it (with a pointer comment to keep `manifest.shared.ts` host permissions in sync).
- **Genesis hashes ×2 (+ derived logic ×4):** `engine-core.ts:198–202` (`GENESIS`) vs `tx-manifest/network.ts:4–5`; the `/block-height/0` fetch-and-compare probe is written once in engine (`engine-core.ts:1831–1856`) and three more times in `tx-manifest/esplora.ts:86–92,169–175,216–222`. Move constants next to the chain-server module; extract one `fetchAndVerifyGenesis` helper.
- **NUMS issuer key restated TS↔Rust:** `tx-manifest/issuance.ts:6–7` vs `lib.rs:27–30` — divergence would make TS derive contract hashes for a key the runtime doesn't use. Expose from the WASM runtime or add a cross-equality test.
- **Protocol constants duplicated within tx-manifest:** `u64StorageLeaf` ×2 named + ×2 inlined (`prepare-lending-action.ts:527`, `lending-v3.ts:268`, inline `prepare-accept-offer.ts:180–182,251–253`); burn script `"6a046275726e"` ×3 (`prepare-lending-action.ts:25`, `prepare-claim-lender-vault.ts:20`, raw in `history.ts:154`); state leaves named vs inlined (`prepare-lending-action.ts:27–28` vs `lending-v3.ts:142,145`, `prepare-accept-offer.ts:187`); covenant witness PATH strings restated between requirements plans and prepare files with nothing enforcing sync (`requirements.ts:451` ↔ `prepare-accept-offer.ts:188`; `requirements.ts:277,487` ↔ `prepare-claim-lender-vault.ts:130,180`; `requirements.ts:407` ↔ `prepare-create.ts:296`); `ZERO_HASH` ×2 (`lending-v3.ts:51`, `issuance.ts:8`). One `lending-v3-constants.ts`.

### 4.3 Types & channel contracts
- **`LendingV3Instance` ≡ `LendingV3InstanceArguments`** — identical 9-field types declared twice (`lending-v3.ts:9–19`, `requirements.ts:31–41`), field list restated a third time as strings (`requirements.ts:300–310`).
- **`TxManifestBundleHash`** declared in both `provider/liquid-rpc.ts:32` and `tx-manifest/registry.ts:25`.
- **Two identical 6-member plan unions:** `esplora.ts:51–57` vs `wallet-host.ts:81–87`.
- **Legacy provider channel restated on all three hops** — the 9 method names appear as an allowlist in `content.ts:13–23`, as switch arms in `background/index.ts:2826–2951`, and as `call(...)` sites in `liquid-provider.ts:194–284`; channel magic strings `"apogee-provider"`/`"apogee-content"` are hard-coded on both ends; the `Reply` envelope exported from `protocol.ts:901` is restated inline in `content.ts:44,88` and `prompt.tsx:25`. The new ELIP surface got this right (`LIQUID_BROWSER_PROVIDER_METHODS` is shared) — add a `src/provider/legacy-channel.ts` equivalent.
- **Keystore throttle literals on both ends:** thrower `keystore.ts:167,169` vs regex parser `sidepanel/errors.ts:23,29`; the sideswap channel already models the fix (`LOW_BALANCE_PREFIX`, `sideswap/constants.ts:47`).
- **Three network-name vocabularies** with scattered per-file mappers (`keystore.ts:37`, `liquid-provider.ts:19–20`, `jade.ts:34–47`) — centralize the mapping functions in `src/lib/`.
- **Sats literals bypass `src/lib/format`:** `sideswap/affordability.ts:47,57,58` uses `100_000_000` instead of `SATS_PER_BTC`; `Swap.tsx:223–231` re-implements `satsToFiat`/`formatFiat`.

### 4.4 Messaging boilerplate — one typed helper, 7 hand-rolled dialects — **Medium**
Every hop re-implements the id-correlated `{ ok, value | error }` protocol: page provider (`liquid-provider.ts:73–174`), content bridge (`content.ts:42–99`), jade tab (`jade.ts:344,379,405,447`), prompt popup (`prompt.tsx:23–29`), scanner secret port (`scanner.ts:43–58`), offscreen engine port (`offscreen.ts:33–49`), and the SW side of each (`background/index.ts:444–517, 4097–4352`). The envelopes have **already drifted**: the Jade reply (`background/index.ts:4202–4211`) puts payload fields at the top level while everything else uses `{ ok, value }`; content and page provider each re-implement "extension was reloaded" detection with different regexes (`content.ts:96` vs `liquid-provider.ts:117`). **Fix:** `src/lib/messaging.ts` with a shared `Envelope<T>`, `request<T>(type, params)`, `createPortRpc(name)` (client+server), and a typed message map. Removes ~150–200 lines and the drifted error classification.

---

## 5. Structural redundancy within subsystems

### 5.1 tx-manifest: the four `prepare-*` flows — **High**
A ~120-line helper suite is copy-pasted into all four files (`prepare-create.ts`, `prepare-accept-offer.ts`, `prepare-lending-action.ts`, `prepare-claim-lender-vault.ts`): `sameOutpoint`, `outpoint`, `psetInput`, `sumInputs`, `distinct`, `requireWalletInput(s)`, `requireChainInput`, `asset`/`decimal` validators, `script`, `output`/`confidentialOutput`/`changeOutput`, `stripSecrets` (e.g. `psetInput` byte-identical at `prepare-create.ts:414`, `prepare-accept-offer.ts:392`, `prepare-lending-action.ts:496`, `prepare-claim-lender-vault.ts:286`; several also re-copied in `wallet-host.ts:350,366`). **The copies have drifted**: `prepare-create.ts:436` requires a non-empty script via `+` while `prepare-accept-offer.ts:432` uses `*` + a separate length check; `requireWalletInput` has three different parameter orders, and only the claim variant does extra `asset()`/`decimal()` validation. Drift in security validators is exactly how one flow silently gets weaker checks.

Also repeated: the five-check plan/snapshot validation prologue ×4 (`prepare-create.ts:368–375`, `prepare-accept-offer.ts:284–303`, `prepare-lending-action.ts:423–436`, `prepare-claim-lender-vault.ts:190–209`); the finalize/authorization/digest epilogue ×5 and the action-hint output push ×6; four near-identical DI runtime scaffolds.

**Fix:** `src/tx-manifest/prepare-common.ts` (shared helpers + `validatePlanSnapshotBase`) and a `finalizeManifestExecution(plan, buildSpec, covenantExecutions, commitments, runtime)` template. ~450 lines deleted; one canonical version of each validator. Similarly, the three esplora chain-snapshot resolvers (`esplora.ts:72–118, 156–200, 203–247`) share their entire candidate-failover loop — one generic resolver + thin adapters deletes ~90 lines.

### 5.2 background/index.ts — **High**
- **Provider guard block ×5** (connection → permission → locked → `walletInfo`-or-disconnect): `:1607–1659`, `:1693–1725`, `:1742–1778`, `:1832–1887`, `:1971–1988`; the `walletInfo(...).catch(removeConnectedSite + throw)` sub-block is verbatim ×5. One `requireStandardMethod(origin, method, opts)` returning the revision/generation snapshot callers already take manually. ~120 lines.
- **Post-operation authorization re-check inlined ×3** (`:1674–1689`, `:1795–1810`, `:2028–2042`, + `:1262–1271`) despite the generalized helper already existing as `requireProviderPsetAuthorization` (`:3115–3144`) — route all four through it.
- **Approval-parking ritual ×7** (`:1533`, `:1942`, `:2048`, `:2162`, `:2267`, `:2855`, `:2977`): mint id → park → route → promise. One `awaitApproval<T>(request, entry)`; also removes seven `resolve as (result: unknown) => void` casts.
- **`pending.reject(err); throw err;` ×14–16** inside `handleApprovalDecision` (`:3357–3868`) — a `fail(pending, err): never` helper plus one try/catch removes the risk of a new exit path forgetting to reject (dapp hang until TTL).
- **`walletInfo` + engine pass-through ×6** in `handleUi` (`:759–804`, `:935–946`) — a `walletEngine` helper or dispatch table.
- **Raw storage read-guard-default dance ×10+** (`:185, 232, 353, 356, 905, 1182, 1193, 1212, 1312, 1337, 1437`) — one typed `storageGet(area, key, guard, fallback)`.
- **Jade signing-tab launcher ×2** (`signWithJade` `:3955–3995` vs `signProviderPsetWithJade` `:3997–4047`); **all-tabs broadcast ×2** (`:1229`, `:1274`); **ELIP-144 asset-id parse ×3/×4** (`:1710,1762,1872` / `:1732,1785,1897,2326`); **balance-changed nudge ×7**; **first-run keystore init guard ×4**; **unsupported-method error from two places** (`:1574–1585` vs `:2080–2086`).

### 5.3 engine-core.ts — **High**
Wallet-candidate construction copied ×3 (~20 lines each: `:1115–1139`, `:1203–1228`, `:1319–1344`), `transactions` map build tripled, `walletDestinations` flatMap doubled (`:1231–1244`, `:1355–1365`) — extract `collectManifestWalletCandidates(entry)` (pairs with §2.3). `balanceToRecord` vs `balanceToStringRecord` (`:383–421`) and `broadcastResilient` vs `broadcastTransactionResilient` (`:540–592`) are each the same function with one varying line.

### 5.4 provider validation & sideswap — **Medium**
- `liquid-rpc-validation.ts:96–413`: 12 hand-rolled per-method `parse*` functions that are structurally identical field walks over an already-clean combinator set (`:415–515`). A field-spec table + generic `parseFields(value, path, spec)` (with unknown-field rejection subsuming `exactRecord` `:232`) collapses ~200 lines to ~60 + table. Keep the two genuinely structural TX-manifest parsers hand-written.
- `liquid-provider.ts`: `liquid_requestAccounts` ≡ `liquid_accounts` mapping block (`:193–199` vs `:201–207`); `timeoutFor` re-lists the four names already in `APPROVAL_METHODS` (`:131–150`).
- `sideswap/orchestrator.ts`: `executeInstantSwap` vs `previewSwapQuote` share ~70 near-verbatim lines (`:216–261` vs `:372–411`: getUtxos → filter → getAddress ×2 → orientPair → startQuotes → waitForQuote) plus duplicated dealer-fee math with the same long measured-on-mainnet comment twice (`:284–291` vs `:416–435`). Extract `startQuoteSession(params, deps)` + `quotedAmounts(success, sendIsBase)`.
- `keystore.ts:451–468` `changePassword` re-implements `migrations.ts:50–72` `rewrapEnvelopes` — and the duplication hides a real hazard: changePassword iterates `order` (not the map), so an out-of-`order` record silently keeps its old-key envelope after a password change — the exact corrupt-index hazard `migrations.ts:47–49` defends against. Generalize `rewrapEnvelopes(decKey, encKey, store, fromAad, toAad)` and call it from both.

### 5.5 Rust runtime — **Medium**
`dry_run_covenant` vs `finalize_covenant_pset` share ~45 duplicated lines (`lib.rs:240–294` vs `:305–369`: compile → ABI → CMR → leaves → tapleaf → merkle fold → control block → env → satisfy → BitMachine), with `compile_covenant` (`:150–174`) repeating the tapleaf/merkle fragment a third time. Factor `covenant_context(spec)` + `execute_covenant(compiled, env, witnesses)`.

---

## 6. Dead code & inert surfaces

### 6.1 Eight engine protocol ops are never dispatched — **High** (includes an analysis-bypassing signer)
Verified by whole-repo grep: the only occurrences are the protocol definition and the dispatcher case. Most severe: **`signPset`** (`protocol.ts:119`, handler `engine-core.ts:1650–1653`) takes a **raw mnemonic** and signs with **no analysis gate** — a live but uncalled bypass of every provider-PSET protection (production uses `signBroadcast`/`signProviderPset`/`signTxManifestPset`/`signSwapPset`). Also dead: `verifyDealerPset` (`protocol.ts:212–218`; superseded by atomic `signSwapPset`), `compileTxManifestCovenant`, `inspectTxManifestAddress` (request kind only — the function is used internally), `buildTxManifestPset`, `finalizeTxManifestCovenant`, and the non-`WithWallet` `prepareLendingV3AcceptOffer`/`prepareLendingV3ClaimLenderVault`. The wire surface an attacker-reachable dispatcher accepts should be exactly what production sends — delete the variants and cases. `VerifyDealerPsetWireResult` (`protocol.ts:264–266`) falls out with it.

### 6.2 Legacy provider event system is emit-less — **Medium**
`window.liquid.on(...)` listeners are stored (`liquid-provider.ts:35, 74–79`) but **nothing ever dispatches into them** — no emit site exists; the standard provider's events flow through the separate `standard.emit` path (`:336–350`). A dapp subscribing to `connect`/`disconnect`/`accountsChanged`/`networkChanged` on the legacy API silently receives nothing. Wire `apogee/provider-event` relays in, or delete the registry and document the legacy provider as event-less.

### 6.3 Dead parallax pipeline — **High (dead code)**
`setSceneScroll`/`resetSceneScroll` (`src/sidepanel/scene-scroll.ts:19–30`) have **zero callers** anywhere in `src/`, and the `--moon-descent` CSS variable they write is referenced nowhere. Consequently `Starfield.tsx`'s subscription, rAF-coalesced scroll handling, per-star parallax factors, and wrap math (`Starfield.tsx:63–81`) only ever run once with `scrollY = 0` — ~60 lines of maintained machinery with no visible effect. Either wire the wallet scroll container (`Wallet.tsx:851–854`) to it, or delete the publish side and Starfield's parallax fields.

### 6.4 Unreachable identity-method validators — **Low**
`parseIdentityPublicKey`/`parseIdentitySharedKey`/`parseSignIdentity`/`parseConfidentialTransaction` + `publicKey` (`liquid-rpc-validation.ts:307–343, 410–413, 482–491`) and their result types/constants (`liquid-rpc.ts:215–273, 333–334`): the router rejects unsupported methods **before parsing** (`background/index.ts:1574–1585`), so ~120 lines validate parameters for calls that are refused pre-parse. Drop until implemented.

### 6.5 Dead probe exports shipped in the production WASM — **Medium**
`compile_cmr_from_source` (`lib.rs:50`), `execute_core_self_test` (`:416`), `build_explicit_pset_json` (`:443` + structs `:1012–1043` + `CORE_EXECUTION_PROBE` `:32`) — nothing in `src/` calls them; they pull code into the shipped `.wasm` and its JS glue. Gate behind a `probe` cargo feature or delete.

### 6.6 Miscellaneous dead/inert — **Low**
- `wallet-client.ts:75` `verifyPassword` client method: no call site.
- `recipientAmount` (Number variant, `src/engine/recipient-amount.ts:94–109`): used only by its own tests; production uses `exactRecipientAmount`.
- `TX_MANIFEST_LONG_TERM_FEE_RATE_SAT_PER_KVB` (`change-policy.ts:1`): never imported; its value is folded into a hard-coded `"7"`.
- `inspectTxManifestBundle` (`bundle.ts:131–139`): test-only export. `esplora.ts:28` re-export consumed only by a test. `instanceFromPlan` (`prepare-accept-offer.ts:427–429`) is an identity function. `SideSwapClient.listMarkets` (`client.ts:154–156`) + its types: never called.
- Unused JSON-RPC envelope types + dead `LiquidProvider` interface + `ELIP_DRAFT_URL` (`liquid-rpc.ts:403–439, 13`) — the transport never adopted JSON-RPC envelopes.
- `AUTOLOCK_DEFERRING` contains an unreachable `"wallet/restore"` entry (`background/index.ts:274` — refused at `:4317–4320` before the set is consulted); orphaned doc comment at `:559` describes `walletInfo` but sits above `rethrowSwapError`.
- `ConnectionBar.tsx:15` exports a type used only internally.

**Checked and clean:** no unused package.json dependencies (all verified by import grep); no stale imports (`noUnusedLocals` enforced); bip39 wordlist bundled into exactly one entry point with documented rationale; `hasNativeDetector` kept deliberately with a comment.

---

## 7. Oversized files — proposed splits

### 7.1 `src/background/index.ts` (4,384 lines) → 10 modules
Most cross-references already flow through `engine()`, `walletInfo()`, `chainServer()`, and the approval map, so the split is mostly mechanical **after** the §5.2 helpers are extracted (they define the seams):

| New module | Current content (approx. ranges) |
|---|---|
| `background/autolock.ts` | alarm, `AUTOLOCK_*`, `armAutoLock`, panel step-up state (178–305, 916–926) |
| `background/offscreen-engine.ts` | offscreen lifecycle, engine port, `runEngine`/`engine`/`engineDirect` (157–171, 361–556, 4097–4135) |
| `background/chain-server.ts` | `chainServer()` override resolution (341–359) |
| `background/wallet-handlers.ts` | `handleUi`, `walletInfo`, guide/update handling (557–1122) |
| `background/connections.ts` | connection store, revisions/generation, notify helpers, legacy migration (1124–1453) |
| `background/provider-rpc.ts` | `handleStandardProvider`, connect flow, error mappers, legacy `handleProvider` (1455–2088, 2647–3013) |
| `background/tx-manifest-execution.ts` | prepare/execute/resume, reviewed-fee, manifest approval review (2090–2645, 3437–3697) |
| `background/approvals.ts` | `PendingApproval`, park/route/decide, `requireProviderPsetAuthorization` (3015–3435) |
| `background/jade-signing.ts` | pending Jade signs, tab launch/validation/cancellation (3872–4092 + router branches) |
| `background/router.ts` (entry) | shim, install/side-panel wiring, `onMessage`/`onConnect` routers (remainder) |

Circularity note: approvals ↔ provider-rpc/tx-manifest interact both ways today; break it by storing a per-kind completion callback in the parked entry, or dispatch decision bodies through a `pending.kind` registry.

### 7.2 `src/sidepanel/screens/Wallet.tsx` (3,019 lines)
Twelve components + three hooks in one file. Extract `screens/Coins.tsx` (+`CoinRow`, ~525 lines), `screens/Settings.tsx` (+`ChainServerStatus`, `UpdateCheckLink`, ~700 lines), `screens/Receive.tsx`, `components/SubView.tsx`, and `use-prefs.ts`. Wallet.tsx drops to ~900 lines of home-screen logic. Do the `React.memo` work (§3.3) during the move.

### 7.3 `src/engine/engine-core.ts` (2,278 lines)
Extract the three `prepareLendingV3*WithWallet` cases (~540 lines, `:1106–1648`) into `engine/manifest-wallet-prepare.ts` and prices (`:781–959`) into `engine/prices.ts` — engine-core drops to ~1,200 lines.

---

## 8. Tests, e2e, and playground duplication

- **e2e re-implements production crypto** — **Medium.** `e2e/lending-regtest.spec.ts:625–659` re-derives the OP_RETURN action-hint parse and tagged hash (magic `54584d4601`, tag `"tx-manifest/action/v1"`, hard-coded `payload.length === 106`) in parallel with `src/tx-manifest/action-hint.ts:22–51,71–99` — a format change silently desynchronizes the verifier. `:11–21` restates the bundle hash, chain id, and all 8 action names that have canonical exports. `playground/liquid-provider/conformance.test.ts` already proves relative imports from `src/` work. Import the constants and functions; if an independent oracle is wanted for the tagged hash, keep only `actionTag` local and say so.
- **e2e specs copy-paste the launch + wallet-restore dance** — **Medium.** Identical `launchPersistentContext` blocks (`liquid-provider.spec.ts:22–29` vs `lending-regtest.spec.ts:661–670`) and the same `"apogee-secret"` port restore ritual with hand-written chrome typings (`liquid-provider.spec.ts:259–311` vs `lending-regtest.spec.ts:1085–1158`); `TEST_MNEMONIC` restated in both. Add `e2e/helpers.ts`.
- **Unit-test fixture copy-paste** — **Medium.** `bytes()` hex helper byte-identical ×3 (`elements-txout.test.ts:98`, `provider-utxos.test.ts:75`, `history.test.ts:174`); `compactSize()` ×2 including the same error string; lending `commitment()`/`covenants()` builders byte-identical ×2 (+1 near); the testnet genesis hash pasted in 6 test sites and L-BTC asset ids in ~10 instead of importing their canonical exports; the "abandon…about" mnemonic in 5 files. Add `src/test-utils/` and import constants from production homes.
- **Playground** — **Low.** The black-box structural types are a defensible independent-verifier choice (comment it), but the hand-written method/event name lists (`conformance.ts:1–58`) should import `LIQUID_BROWSER_PROVIDER_METHODS`/`LIQUID_WALLET_RPC_METHODS` so conformance can't drift from the advertised surface.
- **Config** — **Low.** `tsconfig.node.json` could `extends` the base config (~8 repeated compilerOptions); adding the `@` alias there unlocks the e2e imports above. The `.env` build-guard duplication between `package.json` and `vite.config.ts` is documented, intentional defense-in-depth — keep it.

---

## 9. Prioritized roadmap

**Phase 1 — hot-path wins (small diffs, big effect)**
1. Hoist covenant compilation out of the fee loop; memoize compiled programs (§1.1).
2. Cache bundle-integrity verification and action-hint scripts; drop the double normalize (§1.2).
3. `useMemo` the PriceChart trace (§1.6). Cancel the settle poll on unmount (§2.4).
4. Add the engine-port watchdog timeout (§2.1).
5. Freshness window for dapp-read syncs; move `qr`/`getAsset` off the serial queue; cache asset metadata (§1.3, §1.8).

**Phase 2 — kill the drift (correctness-adjacent redundancy)**
6. Delete the eight dead engine ops — the ungated `signPset` first (§6.1).
7. `src/tx-manifest/prepare-common.ts` + shared snapshot validation + finalize template (§5.1).
8. `requireStandardMethod` + route re-checks through `requireProviderPsetAuthorization`; `awaitApproval`; `fail()` (§5.2).
9. `src/lib/chain-servers.ts` (endpoints + genesis + `normalizeBaseUrl` — fixes the broadcast-checkpoint slash bug), `src/lib/hex.ts`, shared `errMessage`/`isRecord`/`isJsonValue` (§4.1–4.2).
10. Unify `changePassword` with `rewrapEnvelopes` (fixes the out-of-order envelope hazard, §5.4).

**Phase 3 — componentize the panel**
11. `Row`, `IdRow`, `TxSuccess`, `StepUpPasswordField`, `Modal`, `Select`, `AmountField` (§3.1).
12. `useAutoLock`, `useUnlockThrottle`, `useRuntimeMessage`, `resolveAssetDisplay`, `formatLbtc`/`unitsToText` (§3.2).
13. Memoize `TxRow`/`CoinRow`/`Tokens`; coordinate the pollers (§3.3, §1.7).

**Phase 4 — structure & storage**
14. Split `background/index.ts`, `Wallet.tsx`, `engine-core.ts` along the §7 seams (mechanical after Phase 2).
15. Scan-state append-only persistence + drop the in-memory duplicate (§1.4, §2.2); per-UTXO parent-hex dedup (§2.3).
16. Typed messaging module (§4.4); legacy-channel constants module (§4.3); sideswap session reuse (§1.11).
17. Test/e2e shared helpers and canonical-constant imports (§8). Resolve the dead parallax pipeline and emit-less legacy events (§6.2–6.3).
