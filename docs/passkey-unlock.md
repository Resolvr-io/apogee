# Passkey unlock

Proposal: let users unlock the vault with a passkey (fingerprint, face, or the
device's screen lock) instead of typing their password, with the password kept
as a permanent fallback.

## Why

- A password is guessable, shoulder-surfable, and reused across sites. A passkey
  is phishing-resistant, bound to the device, and gated behind user verification.
- Typing a password to sign every time the service worker evicts — or after every
  lock — is the single most repeated friction in the app. Biometric unlock removes
  it without weakening anything at rest.
- The 2026 platform landscape finally supports this on desktop: the WebAuthn
  PRF (large blob) extension round-trips on Windows 11 25H2 (Chrome/Edge 147+,
  Firefox 148+), macOS 15+ and iOS 18+ via iCloud Keychain, and Android via
  Google Password Manager. Synced passkeys sync the PRF secret, so the unlock
  works on every device the passkey syncs to — the property that was missing
  before 2026 and made this a non-starter on desktop.

Windows 10 never gets PRF. That is fine: the password always remains, and we
feature-detect (below) so the option simply never appears where it cannot work.

## The idea, precisely

We do not want WebAuthn for *authentication*. There is no server to verify an
assertion, and a signature only proves the authenticator was present — presence
is not an at-rest factor. Storing a random secret "released" after a signature
check would protect the vault with nothing cryptographic and must be rejected
outright.

What we want is the **PRF extension**: for a given credential and salt, the
authenticator deterministically returns 32 pseudo-random bytes, and will not
produce them without user verification. That makes it a key-derivation oracle
gated behind a biometric. Those 32 bytes, run through HKDF, become the KEK that
unwraps a copy of the vault's data key. The ceremony is repeatable: same
credential plus same salt yields the same bytes, so unlock reproduces the key
without the password ever being involved.

Nothing derived from the passkey is ever stored. The slot keeps only what is
needed to ask again: the credential id, the PRF salt, an HKDF salt, and the
wrapped key.

## What it involves

### 1. Vault migration: put everything behind key slots (store v3)

Today every secret is wrapped *directly* under the password-derived key: each
mnemonic envelope, the verifier, the session key. Every operation that touches
the password must remember every wrap site, and forgetting one leaves ciphertext
under a key nobody has anymore.

The migration introduces one random data key (the DEK) that encrypts every
payload, and a `slots[]` array where each slot wraps the DEK under one factor:

```ts
{
  version: 3,
  slots: [
    { type: "password", kdf: { PBKDF2, 600_000, salt }, wrapped: Enc },
    { type: "passkey", credentialId, prfSalt, hkdfSalt, kind, wrapped: Enc },
  ],
  wallets: { … mnemonic encrypted under the DEK … },
  verifier: Enc,
}
```

- Changing the password re-wraps 32 bytes; no ciphertext moves.
- Adding or removing a passkey touches one slot and nothing else.
- The migration follows the existing discipline in `migrations.ts`: one atomic
  write, every secret decrypted back out of the *new* ciphertext and compared
  byte-for-byte before anything is persisted, abort leaves v2 intact.

This ships on its own, before any WebAuthn code exists — the riskiest part
lands and soaks first.

### 2. The passkey slot

- **KDF:** HKDF-SHA-256 over the PRF output, with an `info` string that
  domain-separates this use from any other use of the same credential. HKDF,
  not PBKDF2: PBKDF2's iterations exist to slow down guessing a low-entropy
  secret, and the PRF output is already 32 uniformly random bytes an attacker
  cannot brute-force toward. The KEK is non-extractable; it never needs to
  survive a service-worker restart because what persists in the session store
  is the DEK it unwraps.
- **One PRF salt per vault, not per credential.** A `get()` carries exactly one
  salt, so per-credential salts would mean one authenticator tap per enrolled
  device. The PRF is already keyed by the credential's own secret, so a shared
  salt still yields a distinct output per passkey — and a single prompt can
  offer every enrolled credential. The store refuses a slot whose salt
  disagrees: a slot sealed under a salt the unlock ceremony never asks for
  looks enrolled and opens for nobody.
- **A fresh random `user.id` per enrollment.** Authenticators key
  resident-credential storage on (rpId, user.id) and *replace* on collision;
  reusing a handle makes enrolling a second passkey silently destroy the first.
- **`userVerification: "required"`.** The biometric is the security property.
  Without it the PRF is available to anyone holding an unlocked device — a
  weaker factor than the password it would sit beside.
- **Exclusion of already-enrolled credentials**, so a second enrollment on the
  same authenticator fails loudly instead of shadowing the first. Loudly, and
  *with a way out* — see "Reaching a second device" below, because the loud
  failure was itself a dead end for a while.
- **The transports each credential reported, recorded at enrollment.**
  `getTransports()` answers only on the response of the ceremony that minted
  the credential; no later `get()` can ask where the thing it just talked to
  lives. The hints go back into `allowCredentials` and `excludeCredentials`, and
  they are not decoration: `hybrid` is what makes a browser offer *use a phone*
  instead of looking only for something local and finding nothing. A slot that
  forgot them is a passkey the user can no longer reach. Optional on the slot —
  slots written before the field existed, and authenticators that report
  nothing, both degrade to an unhinted descriptor (meaning "try every route").
  Absent is deliberately not `[]`: an empty array is a positive claim of
  *reachable by nothing*.
- **Recovery shape:** some browsers report PRF supported but decline to
  evaluate it during `create()`; the fix is a follow-up `get()` against the
  credential just made, not treating the device as unsupported.
- **Where the passkey lives, captured at enrollment** from
  `authenticatorAttachment` (which outranks the `getTransports()` hint — hybrid
  transport covers both phones and passkeys synced through a platform store,
  so it cannot claim a phone). Stored as a short kind ("This device" /
  "Cross-device" / "Security key") plus date, because it can never be fetched
  retroactively without another ceremony. No attestation/AAGUID: it trades a
  privacy consent prompt for an opaque GUID.

#### Reaching a second device

The slot array allowed N passkeys from the first commit. What it lacked for a
while was any way for a user to create the second one, and the reason is worth
writing down because it is invisible from the code and invisible from the
virtual-authenticator tests (one authenticator, one transport, no picker):

*Left unconstrained, a machine with a platform authenticator answers
`create()` with that authenticator.* So the sequence a user actually performs —
enroll this laptop, then try to add their phone — sends the second ceremony
straight back to the laptop, where `excludeCredentials` refuses it with
`InvalidStateError`. The phone in their pocket is unreachable, and the error
they see is the RP's own exclusion telling them they already did the thing they
are trying to do.

The fix is two-sided:

- **`authenticatorAttachment: "cross-platform"`**, requested only when the user
  pressed something that named another device. That is the one lever that makes
  Chrome go to the phone/QR and security-key surfaces instead of the local
  store. Deliberately *not* set on the plain "add a passkey" entry, where the
  browser's own picker is the better answer — the user did not say where.
- **Copy that points at the route that works.** The exclusion refusal now reads
  "This device already has a passkey for this wallet. Use *Another device* to
  add a phone or security key" rather than "enroll a different one", which named
  no route at all.

Settings therefore carries two entries, "Add passkey" and "Another device".
They differ in exactly one request field; everything downstream — slot, salt,
wrap, list, removal — is the same path.

One more thing sizing changed: **the ceremony timeout**. A cross-device
enrollment is an errand, not a tap — read a QR off the screen, pick the phone
up, unlock it, open the camera, scan, approve. The 60s bound introduced during
the RP-ID hunt (see §4) aborts mid-scan and reads to the user as "my phone
doesn't work with this". It is now three minutes, which still turns the
pathological accepted-but-never-dispatched case into a named exception instead
of an eternity. Both properties — finite, and long enough for the errand — are
pinned in `passkey-rp-contract.test.ts`.

### 3. Ceremony mechanics in an MV3 extension

`navigator.credentials` does not exist in the service worker. The ceremony runs
in the side panel (an extension page) and hands the raw PRF bytes to the SW
over a runtime message — the same trust domain the password already crosses on
unlock. Both sides wipe their copy after use. The bytes travel base64: runtime
messages are JSON, and a `Uint8Array` would arrive as a plain object and
silently derive a different key; the SW decodes and length-checks rather than
trusting the shape.

### 4. The RP ID — there isn't one

**Ceremonies send no `rp.id` and no `rpId`.** WebAuthn then defaults the RP ID
to the caller's origin, so every credential is baked to
`chrome-extension://lbepaaibhmjmloagoggjhocdkelogamo` — the extension's own
identity. No host permission, no hosted verification file, no domain.

This replaces an earlier design that claimed the first-party registrable domain
`resolvr.io` through an optional host permission. That design was wrong in a way
that took two device sessions to localize, and the failure is worth recording
because it is completely silent:

> On Chrome, an extension claiming a registrable domain it holds host
> permissions for is **accepted and then never dispatched** when the call comes
> from a side panel. No native prompt. No rejection. `create()` simply stays
> pending until the ceremony timeout. The *identical* ceremony from an ordinary
> extension tab works — because Chrome renders its own attribution dialog for a
> domain that is not the caller's, that dialog is tab-modal, and a side panel is
> not a tab. An own-origin ceremony needs no such dialog and runs anywhere,
> side panel included.

The earlier draft of this section blamed RP-ID *depth* instead, and claimed
on-device evidence that a deeper-than-eTLD+1 claim hangs while eTLD+1 works.
That was a misreading: both were tested from the side panel, where **any**
foreign-domain claim hangs, so the comparison never isolated depth. The depth
rule may well exist; we have no evidence either way and no longer need any.

What the correction buys, beyond working at all:

- **No host permission.** `optional_host_permissions` is gone, along with the
  gesture-time `permissions.request`, the unlock screen's `permissions.contains`
  pre-check, the declined-grant degradation path, and the development-build
  upfront grant that existed only because automation cannot click a native
  permission dialog. Updates never re-prompt anyone.
- **Nothing to explain in release notes.** There is no new site access to
  justify to users who will never enroll.
- **One fewer permanent decision about someone else's namespace.** Passkeys no
  longer live under the company-wide domain.

**The permanence moved rather than disappeared.** Credentials are now bound to
the extension id, so that id is load-bearing. `manifest.config.ts` carries the
Chrome Web Store listing's own public `key`, which forces a shipped build to
load under the published id `lbepaaibhmjmloagoggjhocdkelogamo` rather than one
derived from whatever directory it was built in. Drop or edit that key and a
shipped build loads under a different id, every enrolled passkey orphans
field-wide, and WebAuthn's lack of a delete means users cannot even clear the
dead entries from their password manager. Nothing else in the test suite would
notice — a fresh profile enrolls and unlocks perfectly happily under the wrong
id — so `e2e/passkey-unlock.spec.ts` asserts the literal in
`manifest.config.ts` still derives the published id.

**Development builds deliberately omit the key**, and this is a safety
property rather than an oversight. An unpacked build carrying the store key
loads under the store id, and `chrome.storage.local` is keyed by extension id —
so it would share storage with the developer's real installed wallet, where a
`wallet/reset` or a restore-with-test-mnemonic destroys access to real funds.
It also collides with the installed copy on load. A dev build's path-derived id
keeps its storage separate; the only cost is that a passkey enrolled in a dev
build does not carry over to the store build, which nothing needs. The e2e
suite asserts a dev manifest has no `key` for exactly this reason, and that no
`resolvr.io` permission has crept back into either form.

`src/sidepanel/passkey-rp-contract.test.ts` pins the other half: that neither
ceremony sends an RP ID, that the abandoned literal appears nowhere in either
request, and that both carry an explicit bounded timeout. The timeout's *value*
is pinned by its two properties rather than its number (finite, and long enough
for a phone to be fetched); it was raised from 60s to three minutes once
cross-device enrollment became reachable — see §2, "Reaching a second device".

**Firefox is the mirror image, so do not "fix" this by symmetry.** Firefox
supports the host-permission domain claim (bug 1956484, resolved) and does *not*
support an extension using its own origin as an RP ID (bug 1693562,
reclassified from defect to enhancement and still open). Apogee is Chrome-only
since the 2026-08 AMO block, so own-origin is unambiguously right here. A
Firefox build would have to reintroduce the domain claim and its credentials
would be separate from Chrome's regardless — a passkey per browser, which is
inherent and acceptable.

## Security decisions

- **A password change no longer revokes a leaked session key.** In v2 the
  session cache held the password-derived key, which a password change
  re-derived — an exfiltrated copy became useless. In v3 the DEK is permanent
  across password changes by design (that is the indirection), so an attacker
  holding a copy of the session DEK keeps decrypting every mnemonic until
  `reset()`. Same observable behavior for the user, different for an attacker:
  the remediation for a compromised unlocked session is a reset, not a password
  change. (Added during v3 review.)
- **The password slot is permanent.** A passkey lives on hardware that gets
  lost, reset, and erased; if it could become the only door, a wiped device is
  a lost vault and the recovery story is a seed backup the user may never have
  made. Removing the password slot is refused at the keystore layer, not the
  UI. A passkey is always an additional door.
- **Enrollment and removal require an unlocked vault.** What gets sealed is
  the DEK; there is no way to reach it otherwise. Enrollment additionally gets
  user verification from the ceremony itself — you cannot enroll without
  touching the authenticator.
- **No password step-up for removal.** Removal is non-destructive (the vault
  and every key survive; only a convenience is lost) and the destructive
  operations already have their own step-up. Step-up auth is for destruction,
  not for settings.
- **Passkey failures do not count toward the unlock throttle.** The throttle
  and hard-lock exist for a secret an attacker can guess offline-adjacent; a
  passkey is not guessable, so a failed unwrap carries no information — and
  counting attempts would let a flaky fingerprint sensor hard-lock someone out
  of their own vault. A *successful* passkey unlock does clear the throttle,
  since it proves the legitimate user. (Today's curve stays: first 10 free,
  then (fails − 9) × 5 s capped at 60 s, hard-lock at the max.)
- **A leaked PRF output is not a leaked password.** Recorded explicitly
  because the session-key note above rhymes with it: the password can be
  rotated by the user in one dialog; the PRF secret cannot be rotated at all —
  revocation means removing the slot. Nothing derived from it is ever stored,
  and it crosses the runtime channel only in the base64 form the router
  decodes and length-checks.
- **PRF bytes ride the broadcast message channel, deliberately.** The repo's
  strictest shape (the dedicated `apogee-secret` port) exists for mnemonics;
  `wallet/restore` refuses the broadcast channel outright. The PRF output
  takes the same channel as the unlock password instead: same trust boundary
  (every listener is our own extension page, and non-extension senders are
  dropped before routing), same payload class for exactly the length of one
  ceremony, and reusing the port would put enrollment plumbing in the restore
  path's blast radius. If that calculus ever changes, change both doors
  together.
- **Enrollment adds a permanent factor with no password step-up.** Step-up is
  for destruction, and this destroys nothing. The honest caveat sits here
  rather than unspoken: someone holding an unlocked panel can enroll their own
  authenticator, and that factor survives the owner later rotating the
  password. Working against it: the ceremony demands user verification against
  THAT authenticator, and the slot is visible in Settings beside the rest.
- **A passkey unlock clears even a hard `UNLOCK_BLOCKED`.** Intended. A
  successful ceremony proves the user more strongly than any number of typed
  passwords, so the hard lock's role narrows to what it actually guards:
  password guessing. The forgot-password flow remains for when no enrolled
  biometric exists.
- **Slot AAD versioning has one dial per module, pinned together.**
  `slots.ts` writes its envelopes under `SLOT_AAD_VERSION`; keystore.ts seals
  `dekCheck` under the same number, and a compile-time assertion pins the two
  constants equal — at a future bump TypeScript breaks the build before any
  half-migrated combination can ship (password unlock would keep working
  while every passkey unlock silently returned null).
- **The wrong-factor case is distinct:** a wrong password decrements the
  throttle; a cancelled prompt is a shrug; a PRF that produces no bytes (wrong
  credential, credential synced to a store without PRF) reports that it did not
  unlock and spends nothing.

## UX

- **Unlock:** the passkey button sits above the password field, with the
  password always present below it. Copy stays two short lines — "Unlock with
  your fingerprint or face. Your password always works."
- **Discoverability:** a settings-only feature is a feature nobody finds. A
  one-time, dismissable offer appears once the vault holds a local-seed wallet
  and no passkey is enrolled; dismissal persists and never nags again.
  Management lives in settings beside Change password.
- **The list:** each row shows where the passkey lives ("This device", "Phone
  or tablet", "Security key") plus when it was added — date *and* time, because
  with more than one device enrolled the kind label alone can repeat (two
  security keys, a second platform passkey), and a row you cannot tell apart
  makes Remove a coin flip. Removal uses an inline confirm; the stray credential
  remains in the OS password manager (WebAuthn has no delete) and the copy says
  so.
- **Post-create failures say the same thing.** If anything fails AFTER
  `navigator.credentials.create()` succeeds (auto-lock firing mid-prompt, a
  salt mismatch, a storage write), the copy names it: created on your device,
  not enrolled here, removable from the device's password manager — never a
  bare "Keystore is locked" as if nothing had happened.
- **Wallet types:** Jade and watch-only wallets hold no seed, so unlock gates
  nothing for them — the passkey applies to local-seed wallets only, and the
  unlock screen already reflects that distinction.

## Feature detection and support matrix

Offer enrollment only where a real ceremony can succeed: check WebAuthn
availability, a user-verifying authenticator, *and* an actual create + evaluate
PRF round-trip before writing anything. No slot is persisted unless the full
round-trip works, which also covers the declined-host-permission case.

| Platform | PRF status |
|---|---|
| Windows 11 25H2 | Chrome/Edge 147+, Firefox 148+ |
| Windows 10 | never |
| macOS 15+ / iOS 18+ | iCloud Keychain (avoid 18.0–18.3 sync bug) |
| Android | Google Password Manager, most robust |
| Hardware keys | works; label distinctly |

## Phases

1. **Vault v3 (DEK + slots)** with the byte-verify migration and a v2 backup
   cleared on the first clean v3 unlock. Unit tests for: ciphertext untouched
   by slot changes, password change leaving passkey slots byte-identical,
   interleavings, migration abort paths.
2. **Passkey slot + ceremony module.** Pure crypto/storage functions are fully
   unit-testable against a fake authenticator whose PRF is a deterministic
   function of (credential, salt) — the only property of an authenticator this
   design depends on. Ceremonies themselves need a browser.
3. **Surfaces:** unlock (side panel), enrollment offer, settings management,
   throttle interplay, session persistence across SW eviction.
4. **Release packaging:** nothing permission-shaped is owed any more (§4 —
   ceremonies claim no domain, so there is no new site access and no
   re-confirmation prompt). What ships instead is the pinned manifest `key`,
   which must match the store listing's own key or passkeys orphan.

## Open questions

- ~~Confirm the permanent RP ID (it cannot change later)~~ settled 2026-08-27:
  **there is no RP ID.** Ceremonies send none, so credentials bind to the
  extension's own origin; the permanent identifier is the published extension
  id, pinned by the manifest `key`. The earlier `resolvr.io` answer was
  reversed — a foreign-domain claim never dispatches from a side panel. See §4.
- ~~Whether the enterprise build wants a different RP ID treatment~~ moot: no
  build claims a domain. An enterprise build with a *different extension id*
  would have its own separate passkeys, which is correct by construction.
- ~~Minimum Firefox version we intend to support~~ moot: Firefox support ended
  2026-08 (AMO block); Chrome only.

## Testing (the short list)

- Real-device: enroll + unlock on macOS (iCloud Keychain), Windows 11, Android;
  two passkeys offered in one prompt; either opens. **From the side panel** —
  that surface is the one an own-origin ceremony had to make work, and the whole
  of §4 exists because a foreign-domain claim silently did not.
- Throttle: wrong passwords count, cancelled prompts do not, a passkey success
  resets the counter, a passkey unlock works while password-throttled.
- MV3: unlock, idle past SW eviction, sign with no re-prompt.
- Degradation: no-PRF device, no platform authenticator — the option never
  appears or fails loudly; the password is unaffected. (The declined-host-
  permission case is gone with the permission itself, §4.)
- Migration: a v2 vault unlocks once with the password, becomes v3, and a passkey
  enrolled before and after a password change both still open it.
- (2026-08-27) **More than one device is pinned at both levels.**
  `keystore-passkey.test.ts` drives two authenticator secrets into one vault:
  the second enrollment leaves the first slot opening the vault cold, both share
  the vault salt (a re-minted salt would leave slot two looking enrolled and
  opening for nobody), each slot hands its own transports back to the next
  ceremony, and removing one refuses that device while the other still works.
  `passkey-multi-device.test.ts` pins the request shape the virtual
  authenticator cannot see — attachment unset for "any" and `cross-platform` for
  "another device", transports passed through in both `allowCredentials` and
  `excludeCredentials`, absent staying absent. `e2e/passkey-multi-device.spec.ts`
  runs the whole thing through the real UI against TWO virtual authenticators
  (`internal` + `usb`), including the exclusion refusal and its copy. Steering
  which one answers uses `WebAuthn.setAutomaticPresenceSimulation` rather than
  removing an authenticator: a removed virtual authenticator loses its PRF
  secret, so its credential can never be re-injected and slot one would fail
  for a reason that has nothing to do with the code.
- (2026-08-26, post-review round two) The composed invariants are pinned, not
  aspirational: `keystore-passkey.test.ts` drives changePassword → cold lock →
  passkey unlock against an in-memory storage area; the salt-mismatch refusal
  and unknown-id removal each have their unit; e2e wipes storage.session
  between enroll and unlock (chrome.runtime.reload() also works but destroys
  the panel page AND the CDP virtual authenticator with it).
