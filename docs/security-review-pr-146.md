# Security Review — Apogee PR #146 (Seed QR)

**Scan of [PR #146 — fix(seed-qr): make the seed QR scannable by a Jade](https://github.com/Resolvr-io/apogee/pull/146)**, reviewed at head commit `19c61d3` against `main` (`14e4a09`), 2026-08-22.

## Verdict: no vulnerabilities found

Zero findings met the reporting bar (High or Medium severity at ≥0.8 confidence). The PR handles live seed material carefully and does not expand the attack surface beyond what already existed. Verification was independent of the PR's own claims: the embedded wordlist matches upstream byte-for-byte, `pnpm typecheck` is clean, and all 482 tests pass at the PR head.

## Scope

Seven files, +632/−12: a new Standard SeedQR encoder/decoder (`src/lib/seed-qr.ts`), an embedded BIP-39 English wordlist (`src/lib/bip39-english-wordlist.ts`), tests, a seed-export QR in `Wallet.tsx` with a SeedQR/Text format toggle, brightness dimmer, 260px rendering and a 60-second reveal window, scan-in decoding of either format in `Onboarding.tsx`, CSS, and docs. No new dependencies; `package.json` and the extension manifest are untouched.

## Checks performed

| Area | What was examined | Result |
| --- | --- | --- |
| Wordlist supply chain | Embedded 2048-word list diffed against canonical `bitcoin/bips` file, fetched independently | PASS |
| Encode/decode correctness | Bijectivity of the index↔digit mapping; padding, radix and bounds handling; spec test vectors | PASS |
| Seed-material leakage | Error messages, console/network/storage writes, DOM exposure of the encoded seed | PASS |
| Untrusted scanned input | Attacker-controlled QR payload flow from scanner to restore form | PASS |
| Password gate & reveal timer | Reveal authentication, auto-hide behavior, countdown-restart dependencies | PASS |
| Build verification | `pnpm typecheck` and full test suite at PR head | 482/482 |
| Dependency audit | `pnpm audit` over the lockfile | 2 pre-existing (see below) |

## Evidence

### Wordlist supply chain — the highest-stakes item

A tampered or shifted wordlist would silently encode QRs that restore a *different* wallet, discovered only when someone needs the backup. The 2048 words were extracted from `src/lib/bip39-english-wordlist.ts` and diffed against `bip-0039/english.txt` fetched fresh from `bitcoin/bips`: byte-identical, SHA-256 `2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda`, all words unique and sorted with unique four-letter prefixes. The PR also pins this hash in a test, so any future tampering is machine-detectable in CI.

### Encode/decode correctness

The mapping is bijective: encoding always emits exactly four zero-padded digits per word; decoding slices fixed four-character chunks with `parseInt(…, 10)` — the explicit radix rules out octal parsing, and slices are always non-empty digit-only, so no `NaN` path exists. Decoding rejects non-digit strings, lengths not divisible by four, word counts other than 12 or 24, and indices at or above 2048. Tests include the published all-`0x7f` BIP-39 vector, exercising high indices from a spec-sourced fixture rather than round-tripping through the code's own encoder. No silent seed-corruption path was found.

### Seed-material leakage

Every error message reports only a word's *position*, a count, or an out-of-range index — never a seed word — and a test pins that behavior (`.not.toThrow(/notaword/)`). The diff adds no `console.*` call, network request, or storage write involving seed material. The SeedQR digit string exists only as React state (a `useMemo` keyed on the seed, cleared when the seed clears) and as the `QRCodeSVG` value prop — the same exposure class as the pre-existing plain-text QR.

### Untrusted scanned input

An attacker-controlled QR payload can do nothing beyond filling the restore textarea — the same power it had before this PR. Decoded output is either canonical wordlist words or a passed-through string rendered by React (no `dangerouslySetInnerHTML`, no eval or DOM sinks), and restore still requires the user's password plus the engine's `deriveWallet` validation before the keystore is touched. There is no format ambiguity: BIP-39 words are alphabetic, so an all-digit payload can never be a misparsed plain mnemonic.

### Password gate and reveal timer

`wallet.revealMnemonic(id, password)` and its shared unlock throttle are untouched. The 30s→60s window and the countdown restarting on format or brightness interaction extend exposure only while an already-authenticated user is actively interacting; an unattended panel still auto-hides (`setSeed("")` plus `setShowQr(false)`), and closing the drawer resets the format and brightness state. This is a disclosed UX-versus-exposure trade-off, not a gate bypass.

## Observations below the reporting bar

- If `encodeStandardSeedQr` throws (a mnemonic outside the English wordlist), the UI silently falls back to the plain-word QR while the "SeedQR" toggle stays selected. Both encodings carry identical secret material, so there is no security delta — but a SeedQR-only consumer would scan words and fail. A small UX-honesty nit worth a follow-up if you care.
- Holding the brightness slider keeps the seed on screen indefinitely (acknowledged in a code comment). An accepted hardening trade-off: the user is present and already viewing the phrase.

## Pre-existing dependency alerts — not from this PR

Both alerts live in the dev/build toolchain, not shipped wallet code, and were flagged on the default branch before this PR:

- `uuid` <11.1.1 — moderate, [GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq), via `vite-plugin-top-level-await`
- `esbuild` 0.27.3–0.28.0 — low, [GHSA-g7r4-m6w7-qqqr](https://github.com/advisories/GHSA-g7r4-m6w7-qqqr), Windows dev-server only, via `vite`

Both are fixable with routine dev-dependency bumps on `main` and don't affect the extension's runtime security or this PR's merge-worthiness.

## Method

Full manual review of the diff; independent extraction and verification of the embedded wordlist against upstream; a dedicated adversarial security pass over the seed data flows (scan-in, export, error paths, timer logic) checking input validation, injection, secret leakage, and authorization; and a clean typecheck plus full test run at the PR head. No code changes were made or needed.
