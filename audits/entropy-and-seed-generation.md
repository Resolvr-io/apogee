# Audit — entropy and seed generation

- **Date:** 2026-07-31
- **Branch:** `docs/seed-generation-audit`
- **Reviewed at commit:** `297e035` (`main`)
- **Prompted by:** Blockstream's ["Blockstream Jade is unaffected by the Coldcard
  vulnerability"](https://blog.blockstream.com/jade-unaffected-coldcard-vulnerability/) and
  Block's root-cause writeup, ["Predictable RNG fallback and 32-bit reseed in Coldcard
  firmware"](https://engineering.block.xyz/blog/predictable-rng-fallback-and-32-bit-reseed-in-coldcard-firmware).
  That class of flaw is not patchable: the weakness lives in the keys themselves, so a
  wallet created with a weak seed stays weak after any update. Per Block's account, active
  theft from Coldcard users was identified on 2026-07-30 and traced to a configuration
  error introduced in 2021.
- **Scope:** every path that produces or protects private key material — mnemonic
  generation, the entropy source behind it, key derivation, and encryption at rest.
  Excludes transaction signing and the dealer-PSET verification gate, which have their own
  audits in this directory.
- **Method:** static trace of the full call chain from UI to CSPRNG; inspection of the
  shipped `lwk_wasm@0.18.0` JS bindings and their wasm import table for the entropy
  boundary and for any weak fallback; runtime checks of the crypto guarantees inside the
  loaded extension.
- **Question:** could Apogee produce a seed with insufficient or predictable entropy, and
  does it follow the practices Blockstream describes?

## Result

**No weak-entropy defect found.** Apogee does not implement its own random number
generator and does not derive key material from any non-cryptographic source. Mnemonic
generation is delegated to Blockstream's own Liquid Wallet Kit, which draws from the
platform CSPRNG.

To be precise about one thing a reader will grep for: `Math.random` **does** appear in
`src/`, 18 times — 17 of them drawing the animated backdrop (5 in `Starfield.tsx` for star
positions and sizes, 12 in `ShootingStars.tsx` for meteor timing) and 1 in
`sideswap/integration.test.ts`. Neither backdrop component references key material,
WebCrypto, or storage, and the test is not shipped. It appears **zero** times on any path
that produces or protects a key, and zero times in `lwk_wasm`.

The one substantive difference from the practices in the post is **architectural, not a
bug**: Jade combines many independent entropy sources into a SHA-512 pool so that no single
weak source can collapse it. Apogee is a browser extension with no hardware RNG, no
uninitialized-memory access and no CPU counters, so it depends on a **single** source — the
browser's CSPRNG. That is the correct primitive for the environment, and it is what every
software wallet in a browser depends on, but it is a single point of trust that Jade's
design deliberately avoids. See *Gaps* below.

## How a seed is generated

The chain, traced end to end:

| Step | Location |
|---|---|
| 1. User picks "Create a new wallet" | `src/sidepanel/screens/Onboarding.tsx` |
| 2. Background asks the engine for a phrase, **hardcoded to 12 words** | `src/background/index.ts:439` |
| 3. Engine host (offscreen document on Chrome, background page on Firefox) | `src/offscreen/offscreen.ts` |
| 4. `lwk.Mnemonic.fromRandom(12)` | `src/engine/engine-core.ts:808-809` |
| 5. LWK (Rust → wasm) requests randomness via the `getrandom` shims | `lwk_wasm@0.18.0` |
| 6. wasm import calls `Crypto.getRandomValues` on the host | `lwk_wasm_bg.js:8025-8027` |
| 7. Browser CSPRNG | platform |

Nothing in Apogee's own code chooses the entropy. Step 4 is a single call into
Blockstream's library, and the phrase comes back as a string that is immediately encrypted
under the user's password (below). Derivation is likewise LWK's: standard BIP-84 via
`wpkhSlip77Descriptor` (`engine-core.ts:813-817`), interoperable with Blockstream Green and
Jade.

**12 words means 128 bits of entropy** under BIP-39 (plus a 4-bit checksum). The engine
protocol accepts `words?: 12 | 24` (`engine/protocol.ts:21`) and LWK supports
12/15/18/21/24, but wallet creation passes 12 unconditionally; restore accepts 12 or 24.

## The entropy boundary

The wasm module declares exactly the `getrandom` crate's standard shims:

```
__wbg_crypto_…            __wbg_getRandomValues_…    __wbg_randomFillSync_…
__wbg_msCrypto_…          __wbg_process_…            __wbg_versions_…
__wbg_node_…              __wbg_require_…
```

In a browser this resolves to `crypto.getRandomValues`; the `randomFillSync` / `process` /
`require` shims are the Node detection path and are unreachable in the extension. Two
properties matter and both hold:

- **There is no weak fallback.** `Math.random` appears **zero** times in
  `lwk_wasm_bg.js`. If the host has no CSPRNG the call cannot silently degrade.
- **A failure surfaces as a failure.** The binding is wrapped in `handleError`
  (`lwk_wasm_bg.js:8025`), so an exception propagates into Rust as a `getrandom` error
  rather than yielding zeros or a partially filled buffer.

Runtime checks inside the loaded extension (`chrome-extension://` origin, the same origin
the offscreen engine runs on):

```
isSecureContext        true
crypto.getRandomValues function
crypto.subtle          object
crypto.randomUUID      function
two 32-byte draws      differ
```

## Protection at rest

`src/keystore/crypto.ts`, used for the mnemonic in `browser.storage.local`:

| Property | Value |
|---|---|
| KDF | PBKDF2-HMAC-SHA256, **600,000** iterations (`crypto.ts:8`) |
| Salt | 16 random bytes, fresh per keystore (`crypto.ts:9,61`) |
| Cipher | AES-GCM-256 (`crypto.ts:82`) |
| Nonce | 12 random bytes, **fresh per encryption** (`crypto.ts:10,106`) |
| Binding | wallet id bound as AES-GCM additional authenticated data |
| Password check | separate verifier, so a wrong password is rejected without touching the wallet ciphertext (`crypto.ts:130-140`) |

All randomness here is `crypto.getRandomValues` (`crypto.ts:29-31`). The salt is per
keystore rather than global, and the IV is per call rather than reused — the two mistakes
that break AES-GCM.

Handling hygiene: no `console` statement anywhere in `src/` mentions a mnemonic, seed or
password; the mnemonic is only ever persisted as `enc` (`keystore.ts:57`); hardware (Jade)
wallets store no seed at all.

## Against the two documented Coldcard failure modes

Block's writeup names two distinct defects. Both are worth testing for directly, because
they are the two ways this goes wrong in practice rather than in theory.

### 1. Predictable RNG fallback

On Coldcard, a build-configuration error (`#ifndef` on a macro whose value was `0`) linked
the firmware to MicroPython's non-cryptographic Yasmarang generator instead of the hardware
RNG. It was seeded from device metadata — MCU UID, SysTick, RTC — collapsing entropy to
roughly 2^16.3–2^40.7 rather than the intended 256 bits. The generator degraded silently:
the build succeeded and the device kept producing phrases.

**Apogee has no analog, structurally.** A wasm module can only obtain randomness through
the imports it declares, and the shipped module declares no weak one. Filtering the
complete import list of `lwk_wasm_bg.js` for anything that could serve as randomness leaves
only `crypto` and the `getRandomValues` / `randomFillSync` shims. `Math.random` appears
**zero** times. There is no bundled software PRNG for a misconfiguration to fall back *to*.

The module does import `performance.now`, but a clock is not a generator — the Coldcard
failure needed a PRNG seeded from such values, and none is present here.

It also fails closed rather than degrading: the `getRandomValues` binding is wrapped in
`handleError` (`lwk_wasm_bg.js:8025`), so a host without a CSPRNG produces a propagated
error, not zeros and not a partially filled buffer. This is the property Block's lesson 2
asks for ("fallback RNG paths should fail-closed, not silently degrade").

### 2. 32-bit reseed narrowing

On Coldcard, 40 bytes of secure-element entropy were hashed with SHA-256 and then **only
the first 4 bytes** were used to reseed, replacing a single 32-bit word of PRNG state. That
capped distinguishable output streams at 2^32 regardless of the input width.

**No narrowing occurs on any Apogee key path.** Entropy for the mnemonic never passes
through our code at all: it goes from the host CSPRNG into wasm memory inside LWK. Our own
random draws are used at full width — the 16-byte PBKDF2 salt and the 12-byte AES-GCM IV
are consumed whole, never truncated (`crypto.ts:61,106`).

Two truncations do exist in the codebase, and neither is key material:

| Site | What it truncates | Why it is not a narrowing defect |
|---|---|---|
| `engine-core.ts:225` | SHA-256 of the wallet **descriptor**, to 16 hex chars | A local cache key for scan state. The descriptor is public (it contains an xpub); the requirement is collision resistance within one namespaced store, not secrecy. |
| `keystore.ts:203` | `crypto.randomUUID()`, to 16 hex chars (64 bits) | A wallet identifier. Used as an id and inside the AES-GCM AAD string `apogee:mnemonic:v1:{id}` (`keystore.ts:251-253`), where the requirement is uniqueness and binding, not entropy. AAD is authenticated, not secret. |

Block's lesson 4 — "hashing cannot repair weak sources" — is the reason recommendation 2
below is worded as a caution rather than a suggestion.

## Against the practices in the post

| Blockstream's practice | Apogee |
|---|---|
| Multiple independent entropy sources pooled with SHA-512 | **Not applicable / not done.** No hardware RNG or CPU counters exist in an extension. Single source: the browser CSPRNG. |
| Generate a fresh phrase rather than restoring a suspect one | Supported — create is the default path, restore is a separate explicit choice. |
| Verify receive addresses on the device | Supported on the Jade path (Jade displays the address); no second display exists for a software wallet. |
| Firmware/software from official channels only | Published to the Chrome Web Store and AMO; the repo is public. |
| Consider a BIP-39 passphrase | **Not supported.** See below. |

## Gaps and recommendations

1. **No BIP-39 passphrase support.** `grep -i passphrase src/` returns nothing. This is the
   one explicit recommendation in the post that Apogee does not offer. It would also give a
   user with a possibly-weak seed a way to harden it without migrating. Worth considering
   as a feature; it needs care in the restore flow, since a lost passphrase is
   indistinguishable from a wrong one.
2. **Single-source entropy.** Unlike Jade, one weak source *would* collapse the pool
   because there is only one. If we ever want defense in depth, LWK already exposes
   `Mnemonic.fromEntropy(bytes)` (≥16 bytes), so a pooled value could be passed in
   directly. **This should not be done casually** — hand-rolled mixing is a classic source
   of new bugs, and a correct CSPRNG needs no help. Coldcard's second failure mode is the
   cautionary case: it hashed 40 bytes and then used 4, and as Block puts it,
   "deterministic hashing cannot increase the number of possible seeds." Any mix here must
   therefore be strictly additive over a **full-width** CSPRNG draw — `SHA-512(
   getRandomValues(64) || other sources)`, consumed whole — so the result can never be
   weaker than `getRandomValues` alone. A mix that hashes narrow inputs, or that keeps only
   part of the digest, would reproduce exactly the defect it was meant to guard against.
3. **12 words is hardcoded at creation.** 128 bits is not a weakness, but the protocol and
   LWK both already support 24, so offering it is nearly free.
4. **The in-memory mnemonic cannot be zeroized.** Unlocked phrases live in a JS `Map`
   (`keystore.ts:99`) and JavaScript offers no reliable way to wipe a string. Inherent to
   the platform; mitigated by auto-lock, which clears the map.
5. **The browser CSPRNG is unauditable from inside.** We verify the API path, not the
   generator. A user who wants entropy they can reason about should use Jade, which Apogee
   supports as an external signer — that is the highest-assurance path in this wallet and
   worth saying so in user-facing docs.

## Not verified

- **LWK's Rust internals.** `lwk_wasm` ships as a compiled `.wasm`; the audit covers the JS
  binding boundary and the import table, not the Rust code that decides how many entropy
  bytes `fromRandom(12)` requests. The 128-bit figure is BIP-39's definition of a 12-word
  phrase, taken together with LWK being Blockstream's own library, rather than a reading of
  their source.
- **The browser's CSPRNG quality.** Out of scope for any in-app audit.
- **No statistical testing of generated phrases** was attempted. It would not be
  meaningful at the sample sizes available here, and it cannot distinguish a good CSPRNG
  from a subtly backdoored one.
