# Security Audit — wallet-ux-polish + telemetry stack (PR #1 + #2)

> **Archived 2026-07-22.** Clean pass — no HIGH/MEDIUM findings, no remediation required.
> The audited stack was PR #1 (`feat/wallet-ux-polish`) + PR #2 (`feat/telemetry-numerals`),
> reviewed as one unmerged stack at `5120129`. Status as of archival:
> **PR #1 merged 2026-07-16**; **PR #2 (display/UX only — "no new attacker-reachable surface")
> was *closed, not merged* — its telemetry work shipped merged as **PR #4**.** The security-relevant surface from #1 (auto-lock heartbeat,
> `fromExtension` origin gate, server-side `verifyPassword` step-up on send/approval) is
> present in `main` and the trust boundary verified below remains intact. Kept for the
> historical record; superseded by later audits.

- **Date:** 2026-07-16
- **Stack audited:** `feat/wallet-ux-polish` (PR #1) → `feat/telemetry-numerals` (PR #2) —
  all unmerged work vs `main`. #2 is stacked on #1, so the tip contains both.
- **Reviewed at commit:** `5120129` (stack tip — "Record the font licenses in the README")
- **Audit stored on:** `chore/security-audits`, based on the stack tip above.
- **Scope:** side-panel UX polish from #1 (connection bar, animated lock screen, auto-lock via
  activity heartbeat, send/connect-while-locked, password-on-send) and the #2 telemetry work
  (2001-style font, JPY price fallback, fiat formatting, the Python font-patch tool).
- **Note on where the risk lives:** the security-relevant surface — auto-lock heartbeat,
  password-on-send step-up, and the connect/send-while-locked flows — was introduced by the
  **PR #1** commits (`20759c0`). The #2 telemetry work is display/UX (the one exception, the
  JPY price fallback, is display-only). Both are covered here because they ship as one
  unmerged stack.
- **Method:** security-review skill (identify → false-positive filter → confidence ≥ 8), plus
  independent verification of the load-bearing trust-boundary claims.
- **Threat model:** malicious dapp pages calling the injected provider; malicious/compromised
  price-API responses; cross-context message spoofing. Trust boundary = service worker /
  offscreen document.

## Result

**No HIGH or MEDIUM security vulnerabilities identified.** No finding met the reporting bar
(confidence ≥ 8 with a concrete attack path). The #1 flows that touch authentication *add*
auth that is correctly enforced at the SW trust boundary; the #2 changes are display/UX with
no new attacker-reachable surface.

## Examined and independently verified

| Area | File(s) | Verdict |
|---|---|---|
| Auto-lock heartbeat | `use-idle-heartbeat.ts`, `background/index.ts` | **Safe.** `wallet/touch` sits behind the router `fromExtension` gate (`index.ts:975–978`); a content script carries the page's origin and is dropped. Hook listens only for `pointerdown`/`keydown` in the side-panel window — a web page can't dispatch into that extension context. A malicious site cannot keep the wallet unlocked. |
| Auto-lock fail-secure | `background/index.ts:111–124` | **Safe.** `remainingMs = minutes*60_000 − (Date.now() − lastActivityAt)`. After SW eviction `lastActivityAt` resets to `0` → `remainingMs ≤ 0` → immediate lock. Fails closed. |
| Password-on-send / connect·send-while-locked | `background/index.ts:378–395, 764–850`; `Approval.tsx`, `Send.tsx` | **Safe — adds auth.** `apogee/approval-decision` (now carrying `password`) is behind the same `fromExtension` gate; a dapp can't forge a decision or inject a password. `handleApprovalDecision` re-checks `keystore.isLocked()` server-side (`:837`) and enforces `keystore.verifyPassword()` for never-auto-lock wallets (`:845`); `wallet/send` enforces the same (`:392`). UI `locked` flag is advisory only. |
| JPY price fallback | `offscreen.ts` `fallbackRate`/`getRate` | **Safe / low-impact.** `getRate` is `wallet/*` with no `provider/*` (dapp) path; `currency` comes from hardcoded `FIAT_OPTIONS`. Each URL host is a fixed literal — `currency` only reaches a query param or object key (no host/protocol control, no SSRF). Responses parsed defensively (`Number(...)` → `isFinite && > 0` → median of ≥2). Rate is display-only, never feeds send amounts. Hosts already in `host_permissions` (manifest untouched). |
| Telemetry rendering | `ui.tsx` `TelemetryNumber`, `Wallet.tsx` | **Safe.** Formatted strings render as React text nodes (auto-escaped). No `dangerouslySetInnerHTML`/`eval`/dynamic HTML. |
| Seed QR reveal | `Wallet.tsx` | **Safe.** `QRCodeSVG` renders SVG (no unsafe sink), behind the existing password-gated reveal — same trust context as the already-shown plaintext seed. |
| Font-patch tool | `tools/patch-telemetry-font.py` | **Safe.** Build-time dev tool, manual trusted `sys.argv`; no shell/`eval`/network/untrusted input; not in the shipped runtime. |
| `formatFiat` | `lib/format.ts` | **Safe.** Dropping `maximumFractionDigits` is a display change over a constrained currency set. |

## Confirmed unchanged (trust boundary intact)

The stack does **not** touch `content.ts`, `provider/liquid-provider.ts`, `keystore/keystore.ts`,
`keystore/crypto.ts`, or `manifest.config.ts`. The message-origin trust boundary, dapp provider
surface, secret storage, and network permissions are pre-existing and unmodified. The only
additive change to a gated handler is the `password` passthrough on `apogee/approval-decision`,
which strengthens authentication.

## Recommendation

No security changes required before merging #1 or #2. Re-audit only the incremental diff once
the next round of feedback lands (`git diff 5120129..<new tip>`), rather than the whole stack.

## Follow-up feedback (pending)

_More changes are expected on `feat/telemetry-numerals`. Record the new commits here as they
land, then re-run the audit against the incremental diff from `5120129`._
