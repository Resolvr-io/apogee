# Seed-phrase QR import — design and threat model

Apogee can export a wallet's seed phrase as a QR code (Settings → reveal seed). This
documents the **import** counterpart: scanning a seed-phrase QR with the camera to
populate the restore form.

Written to be reviewed. The feature is small; the reason it needs a document is that it
moves a seed phrase across an extension message boundary, and the *default* way to do
that in this codebase is unsafe for secrets.

## What it does

The restore form (used by both first-run restore and forgot-password recovery — one
form, `Onboarding.tsx`) gains a **Scan seed QR** button. It opens the existing QR
scanner in a popup window, and on a successful scan the phrase lands in the textarea.

Export offers two encodings, chosen by a toggle on the QR view:

- **Text** — the bare mnemonic string, no prefix, no envelope.
- **SeedQR** — a Standard SeedQR digit string (each word's BIP-39 wordlist index,
  zero-padded to 4 digits, concatenated; see `src/lib/seed-qr.ts`).

Both scan into a Blockstream Jade. The toggle exists because the reverse isn't true
elsewhere: Blockstream Wallet's scanner reads only the plain-word form and silently
ignores a SeedQR (verified in its source, and filed as
[green_android#311](https://github.com/Blockstream/green_android/issues/311)), while
SeedQR is what the wider hardware-wallet ecosystem standardized on.

**Scan reliability is mostly physical, not about the format.** A Jade failing to read
the code is usually screen glare or blown-out camera exposure — the QR renders at 260px
with a brightness dimmer beside it, and turning brightness *down* is what typically
makes a stubborn scan succeed. Reach for that before suspecting the encoding.

Import accepts either format regardless of what was exported: `decodeScannedSeedPhrase`
treats an all-digit scanned payload as Standard SeedQR and decodes it, otherwise passes
the value through as a plain mnemonic. Both reduce to the same space-separated word form
before the existing 12/24-word check and normalization.

## Why a popup window at all

MV3 side panels cannot surface the camera permission prompt, so scanning has to happen
in a normal extension window. This predates the feature — `src/scanner/scanner.html` was
already used by Send to scan a payment address.

## The security problem, and the fix

The scanner's existing delivery mechanism is:

```ts
browser.runtime.sendMessage({ type: "apogee/qr-result", value })
```

`runtime.sendMessage` **with no target fans out to every extension context**. For a
payment address that is harmless — it's public data. For a seed phrase it means the
secret is delivered to every listening extension page.

Today only Apogee's own pages exist, so this is not a live vulnerability. But a seed
phrase should not be the thing whose confidentiality depends on "no other page happens
to be listening" — that's an invariant we don't control and would never notice breaking.

**So seed mode uses a different path.** The scanner is opened with `?secret=1`, which
switches delivery to a one-shot channel through the service worker:

| | address scan (existing) | seed scan (new) |
|---|---|---|
| Message | `apogee/qr-result` | `apogee/qr-secret` |
| Delivery | broadcast to all contexts | point-to-point to the SW |
| Retrieval | every listener receives it | panel claims once (`apogee/qr-secret-claim`) |
| Lifetime | n/a | cleared on read; 90 s TTL |
| On-screen | value shown in the form | scanner never renders the decoded text |

### Properties the reviewer should check

1. **Single-use.** `apogee/qr-secret-claim` reads the parked value and clears it
   *unconditionally* — before the freshness check — so a stale value can never be
   claimed twice, and a second claim always returns `null`.
2. **Time-boxed.** `QR_SECRET_TTL_MS = 90_000`. An unclaimed phrase (window closed, user
   walked away) is not retrievable afterwards.
3. **Never persisted.** The parked value is a module-level variable in the service
   worker. Deliberately *not* `storage.session` or `storage.local`: either would make
   the phrase recoverable from disk or survive a crash, which is the thing being
   avoided. Consequence, accepted: a service-worker eviction between scan and claim
   loses the phrase and the user re-scans.
4. **Cleared on lock, idle auto-lock, and reset.** A parked phrase must not outlive the
   session that scanned it.
5. **Origin-gated.** Both messages are `apogee/*`, which the router already restricts to
   the extension's own origin (`sender.origin === EXT_ORIGIN && sender.id ===
   runtime.id`). A web page or content script cannot send `apogee/qr-secret` to inject a
   phrase, nor `apogee/qr-secret-claim` to read one.
6. **No new permission.** Camera access is prompted per-use by `getUserMedia`; the popup
   is opened with `windows.create`, which needs no permission.

## Validation — a scanned phrase gets no more trust than a typed one

The scanned string is normalized (trim, lowercase, collapse whitespace — how a BIP-39
phrase is written) and checked for a 12- or 24-word count, purely so an obviously wrong
QR fails immediately with a useful message instead of at submit.

**That check is not the security boundary.** The real validation is unchanged: on submit,
`wallet/restore` runs the phrase through the engine's `deriveWallet`, which throws on an
invalid BIP-39 phrase *before* the keystore is touched. That ordering matters most in
recovery mode, where a bad phrase must not be able to wipe an existing vault. Scanning
enters the same path as typing.

## Delivery, and why polling

The panel polls `claimScannedSeed()` every 500 ms for ~90 s rather than listening for an
event. The scanner window closes itself, so the panel never owns the window id that
`windows.onRemoved` would need.

The interval id is held in a **ref**, not the calling closure, and cleared in three places:
on the first non-null claim, on hitting the try ceiling, and in a `useEffect` unmount
cleanup. Opening the scanner again also stops any prior poll first, so repeated clicks
replace the interval instead of running several concurrently.

The unmount case is the one that actually needed the ref — leaving the screen mid-scan (for
example backing out of recovery) would otherwise leave the poll running for up to 90 s
against an unmounted component, and a late claim would consume the one-shot secret with
nowhere to put it. `SEED_POLL_MS × SEED_POLL_MAX_TRIES` is kept at or under
`QR_SECRET_TTL_MS`, so the poll never outlives the value it waits for.

## Residual risks (accepted, not mitigated)

- **A seed QR is a bearer secret.** Anyone who photographs it owns the wallet. That's
  inherent to the export feature, which already exists; import doesn't change it.
- **Camera frames pass through the popup page.** They are not stored, not sent anywhere,
  and the stream's tracks are stopped on `pagehide`. But a compromised extension build
  could obviously do otherwise — this feature is only as trustworthy as the build.
- **Shoulder-surfing.** The scanned phrase is written into a visible textarea, matching
  the existing typed-entry behavior. The scanner itself never displays it.
