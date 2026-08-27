# Cancelling a WebAuthn ceremony that never starts

Findings from the 2026-08-27 passkey-unlock device sessions, written down because
the failure mode is silent, the obvious defence does not work, and we burned two
days on it. Applies to any browser-mediated ceremony this extension issues, not
just passkey unlock.

The short version: **a WebAuthn ceremony can be accepted and then never
surfaced.** No native prompt, no rejection, a promise that stays pending. From
the user's side it is a spinner with no explanation and no way out. From the
code's side nothing has failed, so there is nothing to report. Every bound that
prevents this has to be one we own.

## 1. `timeout` in the publicKey options does not save you

`PublicKeyCredentialCreationOptions.timeout` is a *request to the client*. A
client that never dispatches the ceremony to an authenticator is under no
obligation to honor it, and the spec treats the value as a hint the client may
clamp or ignore. It is worth setting — it is what turns an ordinary unanswered
prompt into a `NotAllowedError` — but it is not a guarantee, and the case where
you most need a guarantee is exactly the case where it is least likely to fire.

So: set `timeout`, and **separately** bound the call with an `AbortController`
you control. The signal fires regardless of what the client does with the
ceremony, which makes it the only thing standing between an unresponsive client
and an indefinite spinner.

```ts
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(reason), CEREMONY_TIMEOUT_MS);
await navigator.credentials.create({ signal: controller.signal, publicKey: { … } });
```

The same controller gives the UI a real **Cancel** button. That is not a nicety:
when no native sheet appears there is no sheet for the user to dismiss, so
without an in-app cancel the only exit is the ceremony bound.

## 2. Three terminal states, and why merging them is expensive

An aborted or refused ceremony arrives as a `DOMException`, and three very
different situations look similar enough that it is tempting to collapse them.
Doing so is how this feature stayed undiagnosable for a day.

| State | How it arrives | What it means | UI |
|---|---|---|---|
| Cancelled | `AbortError`, or `NotAllowedError` after a dismissed prompt | The user said no | Silent. Nothing was spent |
| Request pending | **`OperationError`** or `NotAllowedError`, message `"A request is already pending."` | An earlier ceremony is still outstanding | Tell them to close and reopen the panel |
| Unresponsive | Our own abort fired | No prompt ever appeared | Name the likely cause; the password still works |

Two traps in that table:

- **Match "already pending" on the MESSAGE, never the name.** Chrome raises it as
  `OperationError`; it is reported elsewhere as `NotAllowedError`. Keying on the
  name gets it wrong on one of the two.
- **A cancellation is deliberately silent in this codebase**, so anything
  misclassified as one produces no message at all. A stuck pending request
  mapped to "cancelled" makes every subsequent press a no-op with no feedback,
  which reads as a hang and sends you looking in the wrong place.

## 3. Chrome allows exactly ONE outstanding request per profile

A second ceremony while one is open is refused outright. This has a nasty
consequence for debugging: **once a ceremony is stuck, every piece of evidence
gathered afterwards is worthless.** Console probes, retries, a different build —
all of them get the pending refusal rather than reaching an authenticator.

Before trusting any WebAuthn observation, clear the outstanding request:
close the panel document, reload the extension, or restart the browser. Then
make the ceremony under test the *first* WebAuthn call of the session.

## 4. Failing fast: the native sheet takes focus

The full ceremony bound has to stay long enough for a cross-device errand (fetch
the phone, read the QR, scan, approve), which is minutes. But a client that will
never surface a prompt should not cost the user minutes to find out. These are
distinguishable, cheaply:

**A native passkey sheet takes focus.** When one appears the extension document
blurs. In a profile where the ceremony is accepted and never dispatched, focus
never moves. So focus-still-here after a short grace period means no sheet was
ever shown, and we can abort early with an explanation.

Three guards keep the heuristic from misfiring, and all three are load-bearing:

1. **Only arm when the document HAS focus at the start.** Otherwise "never lost
   focus" infers nothing. This is also what keeps headless automation
   unaffected, where the page never holds focus at all — without this guard the
   watchdog aborts every e2e run.
2. **Any blur disarms it permanently.** Once a real sheet appears, the full bound
   applies again, so a slow but legitimate cross-device flow is never cut off.
3. **Keep the grace period far above the real thing.** A platform sheet appears
   in well under a second; 15s leaves no room to mistake a slow authenticator
   for a blocked client.

Implementation lives in `src/sidepanel/passkey-ceremony.ts` (`NO_SHEET_GRACE_MS`,
`armNoSheetWatchdog`, `boundedSignal`), with behavior pinned in
`src/sidepanel/passkey-multi-device.test.ts` — including the case that a blurred
ceremony keeps running past the grace period, and the case that a focus-less
document never triggers it.

## 5. Preflight, before spending the gesture

`PublicKeyCredential.getClientCapabilities()` is the only pre-gesture signal that
speaks to what the *client* will do, as opposed to what the hardware has.
`isUserVerifyingPlatformAuthenticatorAvailable()` is not a substitute: it answers
"is there a biometric" and returns `true` in profiles where the ceremony then
never dispatches.

Chrome reports `extension:prf` there, which is the capability passkey unlock
stands on. Rules that matter:

- Treat only an **explicit `false`** as a blocker.
- A **missing key is unknown, not absent.** Older clients have no
  `getClientCapabilities()` at all, and newer ones may omit keys. Blocking on
  silence disables the feature for clients that work fine.
- Unknown is covered by the bound in §1, not by refusing to try.

Measured limitation: in the profile where this actually failed,
`getClientCapabilities()` returned **the same values as a working profile**. The
preflight is a cheap gate for genuinely incapable clients; it did not catch the
real case. Do not rely on it as the only defence.

## 6. What was ruled out, with evidence

Recorded so nobody re-treads these:

- **RP ID depth** (`apogee.resolvr.io` vs `resolvr.io`). Swapping made no
  difference. The earlier "subdomain hung, eTLD+1 worked" story was never a valid
  comparison — both were tested on the same surface, so it never isolated depth.
- **"Side panels cannot host WebAuthn."** False. A sibling side-panel extension
  performs the same ceremony on the same machine.
- **Our request options.** A console probe using another working extension's
  *verbatim* `create()` options — no `rp.id`, `AbortSignal` instead of `timeout`,
  `attestation: "none"` — pended identically as the first call of a fresh
  session. Not the RP ID, not `timeout` vs `signal`, not `excludeCredentials`,
  not attestation.
- **Interception by another extension.** No extension in any local Chrome profile
  declares `webAuthenticationProxy`, so nothing was capturing requests and
  dropping them.
- **"Managed profile" as the discriminator.** A managed profile *did* produce the
  native sheet. Managed vs unmanaged is not the axis.

Leading remaining hypothesis: **per-profile passkey provider availability.** The
successful sheet reported "Save In: Passwords", meaning Chrome found somewhere to
put the credential. A profile with no available provider has nothing to dispatch
to. Worth checking `chrome://settings/passwords` and whether the profile is
signed in, before touching code again.

## 7. The general rule

Browser-mediated pickers are not ordinary async APIs. They can accept a request
and then depend on UI, providers, policy, and profile state that the calling page
knows nothing about and gets no error from. `src/sidepanel/jade-window.ts`
records the same lesson from Web Serial, where the device chooser needs a
top-level tab and comes up empty in an extension popup.

So for any of them:

- Own the bound. Never rely on the API's own timeout parameter.
- Give the user an in-app cancel, because the native affordance may not exist.
- Classify failures distinctly, and never let a "user said no" bucket absorb a
  "the browser never answered" case.
- Before trusting a diagnosis, confirm no earlier request is still outstanding.
