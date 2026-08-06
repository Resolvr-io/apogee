# Security Review — merge window PR #33 → PR #75

- **Date:** 2026-08-05
- **Scope:** every first-parent commit on `main` since the last audit checkpoint —
  `f5a9f15` (PR #32 merge, audited in `security-review-track1-sideswap-pr32.md`)
  through `25793ad` (PR #75). ~35 commits: PRs #33–#75 plus two direct commits
  (`7b8cf87` explorer links, `b5b123e` scratch-credential gitignore).
- **Reviewed at commit:** `25793ad` (main tip).
- **Audit stored in:** `audits/`, tracked and public, alongside the PR #1/#2 baseline,
  the PR #32 swap-foundation audit, and the seed-generation entropy audit (#67).
- **Method:** window review, not a per-PR re-review. Diffstat triage of all ~35
  commits, then a deep read of everything that touches key material, authorization,
  message routing, or the network perimeter: #33/#34/#40/#41 (swap signing path),
  #49/#52 (seed-phrase QR import + scanner fallback), #61 (review-amount semantics),
  #71 (provider authorization rewrite), #47 (SW tab handling), #56 (build guard),
  and the two direct commits. Everything else (#42–#48, #50–#58, #62–#67, #70,
  #73, #75) confirmed UI/copy/docs/display-only at diffstat and spot-check level.
- **Focus (as asked):** key leakage and unauthorized access specifically — can any
  change in this window expose a seed/mnemonic/blinding key, or let a web page or
  remote counterparty read or act on wallet state without the user's approval?
- **Threat model:** (a) a hostile web page driving the content bridge and the new
  event-discovered provider; (b) a malicious or compromised SideSwap dealer/server
  (unchanged from the #32 audit); (c) a hostile QR code and the scanner-to-panel
  hand-off path; (d) another extension or extension context probing `runtime`
  messaging. Trust boundary unchanged: the offscreen engine is the sole holder of
  key material; the service worker is the sole authorizer.

## Result

**No HIGH or MEDIUM findings.** The two large new attack surfaces in this window —
the seed-phrase QR channel (#49/#52) and the rewritten provider authorization
(#71) — hold up under the key-leakage/unauthorized-access lens. Several merges are
net security improvements: #56 (build refuses while a `.env` file could inline
credentials), #61 (the reviewed amount derives from the built PSET, not caller
input), #33 (the `addDetails` fix closed a trivially-passing verification gate),
`b5b123e` (scratch credential files gitignored by pattern).

Six LOW/informational findings below; none block anything, none require action
before the planned functionality/UX sweep.

## Examined and independently verified

| Area | File(s) | Verdict |
|---|---|---|
| Seed-phrase QR hand-off (#49) | `lib/qr-secret.ts`, `scanner/scanner.ts`, `background/index.ts:200-226,1926-1943` | **Safe.** The phrase travels scanner → SW → panel point-to-point, never over the broadcast path (`runtime.sendMessage` with no target fans out to every extension context; the code says so and routes around it). Parked in a **module-level SW variable, never `storage.*`** — not recoverable from disk, does not survive a crash. Single-use and time-boxed (90s): `claimSecret` clears unconditionally *before* the freshness test, so a second claim always returns null. Wiped on idle-lock and on lock/reset (`index.ts:186,412,416`). Both the park and the claim messages are behind the `sender.origin === EXT_ORIGIN && sender.id === runtime.id` gate (`index.ts:1862`) — a web page can neither deposit nor claim. The scanner never renders the decoded phrase, and the panel gives a scanned phrase exactly the trust of a typed one (validation stays in the engine's `deriveWallet`). |
| Scanner fallback (#52) | `scanner/detect.ts`, `package.json:21` | **Safe; one supply-chain note (finding 6).** `jsqr` is pure JS — no network, no Worker, no wasm, no CSP change. Native `BarcodeDetector` still handles Chromium; jsQR sees frames only on Firefox. |
| Provider input validation (#71) | `provider/liquid-rpc-validation.ts`, `provider/liquid-browser-provider-validation.ts` | **Safe.** Page-supplied requests are re-parsed at the trusted boundary into fresh objects; unknown fields dropped. Every identifier is matched against an **anchored** regex — asset ids must match `^bip122:[0-9a-f]{32}\/elip144:[0-9a-f]{64}$` — so the page-controlled hex that later indexes `sync.balance` can never be `__proto__`/`constructor` (the object-index class this repo has hit twice before). Lifecycle methods cannot be requested as permissions; duplicate grants rejected. |
| Provider authorization (#71) | `background/index.ts:900-1290` | **Safe.** Origin comes from Chrome-set `sender.origin` — unspoofable by the page. `wallet_connect` and legacy `connect` always park an approval; nothing resolves to the page until the user decides. The decision handler re-checks lock state and origin, and a revision/generation compare-and-swap means a site revoked *while its approval is open* cannot be resurrected (`setProviderConnection` refuses the stale write; `removeConnectedSite` also fails any parked approval for the origin). A locked wallet serves no balance on either the legacy or the standard path. Connections live in `storage.session` — cleared when the browser closes, never on disk. |
| What crosses to the page (#71) | `provider/liquid-provider.ts`, `content/content.ts`, `engine-core.ts:1159` | **No key material.** `ProviderAccount` is network + fingerprint + signerKind; the descriptor (xpub + SLIP-77 blinding key) is explicitly kept out. `walletIdentity` exposes chainId + DWID (a hash) + policy asset only. Connection-changed events fan out via `tabs.sendMessage` to all tabs, but the content script forwards to the page only on `sender.id === runtime.id` **and** `message.origin === window.location.origin` — a cross-origin tab's page never sees another origin's connection snapshot. |
| Swap signing (#33/#34/#41) | `engine-core.ts:943-989`, `sideswap/orchestrator.ts`, `background/index.ts:740-790` | **Safe.** Verify-then-sign is **atomic inside one engine op** (`signSwapPset`): the dealer PSET is gated by `verifyDealerPset` first, and the `lwk.Signer` is constructed only after the gate passes, so the mnemonic stays out of memory on the reject path. This closes the #32 audit's "no binding between verify and sign" wiring prerequisite. The #33 `addDetails` fix is load-bearing: without it `psetDetails` returned empty balances and every check passed trivially. The mnemonic flows SW → offscreen only; the SideSwap socket carries quote ids and PSETs, never key material (verified: no `mnemonic` reference in `sideswap/client.ts`). Password step-up (#41) applies send's exact gate to swap when auto-lock is "Never". |
| Review-amount semantics (#61) | `engine/recipient-amount.ts` | **Improvement.** The amount shown for approval derives from the PSET the wallet actually built, never from what the caller asked for (self-send excepted, where nothing leaves the wallet). What you approve is what is signed. |
| Network perimeter | `manifest.shared.ts:32-41` | **Three new hosts since #32, each justified and documented in-line:** `mempool.space` (fourth fallback ticker + price history; keyless; no user data — see `docs/price-sources.md`), `*.sideswap.io` (the dealer the #32 audit's threat model already covers; carries swap protocol data by necessity), `api.github.com` (release feed, one request, only on the user pressing Check for updates). Loopback hosts remain dev-mode-only. |
| Explorer links (`7b8cf87`) | `lib/explorer.ts` | **Safe.** 64-hex id guard plus `Object.hasOwn` on the network map — the `__proto__` lesson applied proactively; a malformed id yields no link rather than a mangled URL. |
| SW tab handling (#47) | `background/index.ts` guide-tab | **Safe, and the right trade.** Remembers the tab id it created instead of declaring the `tabs` permission (which would grant read access to every tab's URL browser-wide). |
| Credential controls (#56, `b5b123e`) | `package.json` prebuild, `scripts/build-firefox.ts`, `.gitignore` | **Working as intended.** Build and zip refuse while any `.env` file is present, so enterprise credentials cannot be inlined into a distributable bundle; scratch key files are ignored by pattern, not by name. |

## Findings (all LOW / informational)

1. **Legacy migration pins whichever wallet is active at first post-upgrade call.**
   `migrateLegacyConnection` (`background/index.ts:1070-1082`) converts a legacy
   origin allowlist entry into a pinned connection against `walletInfo()` — the
   *currently active* wallet — not the wallet that was active when the user
   originally approved the site. Today this is moot (multi-wallet add/switch is
   still Pending, so active = only), and the pre-#71 behavior was strictly worse
   (the grant followed the active wallet forever). But when multi-wallet ships, an
   origin approved against wallet A could get silently pinned to wallet B.
   **Recommendation:** before multi-wallet lands, either re-prompt on migration or
   record this as a known caveat in the ELIP doc.

2. **A connected origin can trigger unbounded full chain syncs.** Both `getBalance`
   paths (standard `background/index.ts:1222-1268`, legacy `:1376-1400`) run a full
   engine `sync` per call, unthrottled. A misbehaving approved site can hammer the
   chain server with full scans and starve the panel's own serialized engine queue.
   Nuisance/amplification, not leakage — the origin already holds a user-approved
   grant. **Recommendation:** a short TTL cache (even 5–10s) or per-origin rate
   limit.

3. **`provider/getNewAddress` is not lock-gated while `getBalance` is**
   (`background/index.ts:1359`). Pre-existing — dates to the initial import, not
   this window — and low: it returns the *last unused* address
   (`wollet.address(null)`), so a page cannot advance the derivation index or push
   funds past the scan gap, and addresses are watch-only data the approved origin
   could have obtained before lock. But the "a locked wallet serves nothing"
   story is not fully true. Recorded for completeness.

4. **`parseConfidentialTransaction` is a passthrough** — `{ ...params }` with no
   validation (`liquid-rpc-validation.ts:257`). Unreachable today:
   `handleStandardProvider` throws `UNSUPPORTED_CAPABILITY` for any profile method
   outside `SUPPORTED_PROFILE_METHODS` (currently `getBalance` only) *before*
   parsing. It becomes live the day the method is enabled, silently inheriting
   zero validation. **Recommendation:** replace the body with an explicit throw
   until the method is actually implemented.

5. **The account identifier is a stable cross-site correlator.** Every origin the
   user approves receives the same `chainId:dwid`, so colluding sites can link the
   same user. Inherent to ELIP-0144-style identifiers, and the legacy
   `masterFingerprint` has the same property — this is not a regression. Worth a
   sentence in the privacy notes so the trade-off is on the record.

6. **`jsqr` is the one new runtime dependency in the window, and seed-phrase
   frames pass through it** on the Firefox scan path. Pure JS, no I/O, resolved to
   1.4.0 in the lockfile — but `package.json:21` declares `^1.4.0`, so a future
   install can float to any 1.x. For the single third-party package with eyes on
   a seed, **pin exactly** (`"jsqr": "1.4.0"`).

## Confirmed unchanged (trust boundary intact)

No commit in the window touches `keystore/crypto.ts` (PBKDF2 → AES-256-GCM at
rest), the offscreen `msg.target === "offscreen"` gate, or the rule that the
mnemonic exists only in the unlocked keystore (SW memory) and the offscreen
engine. `content.ts` still relays only the fixed provider method set; the
`fromExtension` origin gate on `wallet/*` and `apogee/*` messages
(`background/index.ts:1862-1865`) now also protects the QR-secret channel. The
#32 audit's outstanding wiring prerequisites — verify→sign binding and
`getUtxos` send-asset filtering — were both discharged in this window:
the former by `signSwapPset`'s atomicity (#33), the latter by the orchestrator
passing only what `start_quotes` needs (#34, reviewed there).

## Recommendation

Nothing in this window requires action before the planned functionality/UX
sweep. Fold findings 2 and 4 into ordinary backlog hygiene (both are one-liners);
revisit finding 1 as a hard gate on the multi-wallet milestone; take finding 6 as
a trivial `package.json` pin whenever dependencies are next touched.

Next checkpoint: re-audit when either (a) a second Liquid RPC profile method is
enabled (`SUPPORTED_PROFILE_METHODS` grows — finding 4 goes live then), or
(b) multi-wallet ships (finding 1), whichever lands first.
