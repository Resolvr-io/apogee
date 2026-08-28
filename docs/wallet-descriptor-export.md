# Wallet descriptor export

Getting a wallet's public data out of Apogee: what it is, which forms exist, and
what each one discloses. This phase covers the manual, user-initiated export in
Settings. The programmatic path already exists and is described in §5; a
narrower, purpose-scoped disclosure is deliberately **not** in this phase and is
described in §6 so the boundary is written down rather than assumed.

## Why

Three unrelated needs, one payload:

- **Backup.** A wallet's descriptor is what recreates a working watch-only copy.
  For a Jade or an imported watch-only wallet there is no seed phrase to fall
  back on, so the descriptor is the *only* thing a user can write down.
- **Recovery.** If Apogee is uninstalled or a vault is reset, the descriptor
  restores visibility without the seed.
- **Interoperability.** Other tools take output descriptors. Requiring a user to
  re-derive from a seed phrase to use one is both worse and more dangerous.

None of this requires spending authority, and none of it touches the seed.

## 1. What every wallet already has

Every wallet record persists one canonical SLIP-77 CT descriptor **in
cleartext**, because the sync engine needs it to derive addresses and unblind
its own outputs:

```
ct(slip77(<64 hex>),elwpkh([<fingerprint>/84'/1'/0']<xpub>/<0;1>/*))#<checksum>
```

`WalletInfo.descriptor` already carries it to the panel for all three signer
kinds — `local`, `jade`, `watch`. So export reads nothing new, decrypts nothing,
and needs no key. **This is a disclosure feature, not an access feature.** The
consequence for design is that gating it behind a password would be theatre: the
value is already sitting in `chrome.storage.local` in the clear, so a password
prompt would add friction without changing what an attacker with local access
can reach. It is gated on the vault being unlocked, which is where Settings
lives anyway, and each sensitive field is behind an explicit reveal.

Hardened path components are spelled with `'`, not `h`. Verified against a live
lwk derivation in `src/lib/wallet-export.test.ts`, which derives rather than
hard-codes a fixture precisely so an lwk format change fails in CI instead of in
a user's backup.

## 2. Two forms, and the difference is the whole feature

| | Derives addresses | Sees amounts | Links addresses |
|---|---|---|---|
| CT descriptor | yes, confidential | **yes, all of them, forever** | yes |
| Public descriptor | scripts + unconfidential only | no | yes |

- **CT descriptor** carries the SLIP-77 master blinding key. It restores a full
  watch-only copy, and anyone holding it can unblind every amount and asset the
  wallet has held or will hold. It cannot sign. It cannot be revoked.
- **Public descriptor** is that value with the blinding policy removed, produced
  by `publicWalletDescriptor()` in `src/engine/public-wallet-descriptor.ts`. That
  function exists for the provider RPC and **fails closed** for any blinding
  policy other than SLIP-77, because some other policies are themselves
  view-capable and removing the outer layer would not make them safe.

`src/lib/wallet-export.ts` reuses that projection rather than reimplementing it.
A second parser that disagreed with the first is exactly how a blinding key ends
up inside a payload that promised not to carry one.

### What neither form solves

**Both carry the account-level extended public key.** That is the same key
material the wallet itself uses, so either form links every address the wallet
will ever derive — external, internal, past and future — to a single identity.
Removing the blinding key removes the *amounts*, not the *linkage*.

Scoping a disclosure is therefore a derivation problem, not a projection
problem, and no amount of formatting in this module substitutes for handing over
a separate account. See §6. UI copy must not describe the public descriptor as
"safe to share" without that qualification; it is *safer*, not anonymous.

## 3. What the export contains

Assembled by `walletExportFields()`, all derived from the stored descriptor:

- Label, network, signer kind (in words: seed stored in Apogee / Jade hardware
  signer / imported watch-only), fingerprint, creation time
- Derivation path, script type, account extended public key
- The CT descriptor
- The master blinding key on its own, since some tools take it separately
- The public descriptor and the standards it satisfies, or a stated reason when
  no public form can be produced

`walletExportFields()` **never throws.** An export is a recovery path, and
refusing to show a user a descriptor they already own because a derived
convenience failed to parse would be the worst possible moment to fail closed.
The CT descriptor is always present; derived fields are best-effort and simply
absent when the shape is unfamiliar. That includes the created-at timestamp,
whose `toISOString()` is the one line that could have raised, during render.

Three descriptor shapes get this wrong if the derived fields are extracted
naively, and none of them is malformed — all three came out of the #158 review:

- **A private key.** The extended-key pattern matches `xprv`/`tprv` as readily
  as `xpub`, and everything derived from it is presented under "cannot spend".
  `assertNoPrivateSpendKeysIn` (exported from the engine for this) runs first and
  drops the whole derived group when it trips. The engine already declined to
  rely on lwk rejecting such a descriptor; the export must not decide otherwise.
- **More than one key.** A 2-of-3 watch-only import parses cleanly — the inner
  commas sit below depth 0 — and a first-match extraction reports ONE cosigner's
  key as "Account xpub" and ONE cosigner's path as "Derivation" with nothing
  saying others exist. The patterns are global and the fields are set only when
  there is exactly one match, so the group degrades together the way
  `scriptType` already did for an unrecognized script.
- **A non-canonical descriptor.** `publicWalletDescriptor` documents that its
  caller must canonicalize with `WolletDescriptor` first, and the stored value
  for `signer: "watch"` was the user's paste.

  Measured rather than assumed: lwk **rejects** whitespace around the top-level
  comma (`Not an elements descriptor`), so that shape never reached storage. What
  it does accept and silently normalize is the `h` spelling of hardened
  components and a missing BIP-380 checksum — so an `h`-form paste and a
  `'`-form paste of the same wallet were stored as two different strings, which
  also made the dedupe in `addHardwareWallet` compare typing habits rather than
  wallets.

  Fixed at the source: `descriptorInfo` now returns `wd.toString()` and the
  import persists that, reading the fingerprint off the same serialization so
  the two cannot disagree (and freeing `wd`, which it did not). The export keeps
  a whitespace check as defence in depth for records written before that change,
  and for any future path that persists without constructing a
  `WolletDescriptor` first.

## 4. Surfaces

Settings → **Export wallet data** is a navigation row, mounted **outside** the
`signer === "local"` gate that wraps "Reveal seed phrase". Jade and watch-only
wallets have identical public data to export and are the cases where it matters
most.

It opens its own `View` (`"export"`), the same sub-view mechanism "Coins" uses,
rather than expanding a drawer in place. Four values each need a name, a risk
marker, a reveal and a copy control, and that does not fit in a 400px column
underneath the rest of Settings.

- Each value is **one line until opened**: title plus an eye toggle. Opening it
  adds the value and a Copy button.
- Values are **grouped into two cards by what they disclose**, least first:
  *Reveals your addresses* (account xpub, public descriptor) and *Reveals your
  balances* (watch-only descriptor, master blinding key). A card boundary rather
  than two headings in one card, because the split is the whole point and a
  boundary is harder to skim past.
- Each group carries **one short line, three clauses, same order both times**:
  what it shows, how long that lasts, what it still cannot do. Only the middle
  clause differs, which is what makes the two groups scannable side by side.

  > Reveals your addresses — *Shows which addresses are yours, including ones you
  > haven't used yet. Not your balances. Cannot spend.*
  >
  > Reveals your balances — *Shows every amount you hold and every payment you
  > make, past and future. Permanent once shared. Cannot spend.*

- Phrasing rules, arrived at by getting them wrong first: **no "lets someone"**,
  which buries the point behind a hypothetical actor; the subject is the data and
  the verb is "shows"; and both groups end on "Cannot spend" so the warning never
  reads as scarier than it is. The first group says "Not your balances" rather
  than anything implying anonymity — it still links addresses.
- Written once per group instead of once per value, which is what keeps it short
  enough to be read.
- **The argument lives in this document, not on the screen.** An earlier version
  explained each value in two or three sentences and became a wall of text,
  which is worse than terse: an unread warning protects nobody. A single
  undifferentiated "Export" button would be worse still — that is how a user
  hands over total transaction visibility believing they shared an address list.
- **The download card says what is in the file**, under its own "Save to a file"
  heading: the details plus every value listed, *including the ones that reveal
  your balances*. A download is the only action on the screen that hands over
  both groups at once, in something that outlives the moment, so it points back
  at the headings rather than re-listing the values. Deliberately states no
  count — a watch-only wallet whose blinding policy is not SLIP-77 has neither a
  master blinding key nor a public descriptor, so "all four" would be wrong for
  exactly the wallet kind most likely to be exporting.
- Per-wallet `.txt` download, human-readable, with the two descriptor forms under
  separate labelled headings.
- All-wallets `.json` when more than one wallet exists, carrying `format` and
  `version` so a reader can detect a later format change, plus the same warning
  inline. A backup that silently skipped whichever wallet was not active would
  not be a backup, which is why the card takes the whole list.
- Downloads go through a blob URL and a detached anchor. No host page, no server.

## 4a. Transaction history CSV (#156)

The same screen carries a third card, **Transaction history**, in its own card
because the payload is a different kind of thing: history, not key material. The
copy says "No keys, but it is a full record of your balances" rather than
stopping after the reassuring half.

Three format decisions are load-bearing, and each guards a way the file could be
quietly wrong rather than obviously broken:

- **One row per asset moved, not per transaction.** A swap moves two assets, and
  a row holding both cannot be summed or filtered by asset. Rows share a txid, so
  they regroup.
- **The fee appears on exactly one row per transaction.** Repeat it per asset row
  and every swap doubles the total the moment anyone sums the column. Pinned by a
  test that sums it.
- **No locale formatting.** `formatAssetAmountExact` and `formatBaseUnits` group
  thousands with commas, which would break the columns. `plainDecimal` in
  `src/lib/tx-csv.ts` exists solely to avoid reusing them.

And one security property: **asset tickers and names come from the Liquid asset
registry**, where anyone can register an asset with any name, and those strings
land in a file the user opens in Excel or Sheets. `csvCell` neutralizes values
that would start a formula. Signed amounts deliberately bypass that path, since
prefixing a leading minus would turn every outgoing amount into text no
spreadsheet can add.

Unconfirmed transactions are included with a `status` column and an empty
`block_height` and `date_utc`; excluding them would silently drop the most recent
activity. Full history, no date range. `asset_id` is always present, because a
ticker can be missing or duplicated across assets and the id cannot.

The action waits for `policyAssetHex` from the sync snapshot. Without it the
export cannot tell L-BTC from a token, and mislabelling a column is worse than
omitting an action.

### This is NOT a tax-import format, on purpose

There is no open standard; every tax tool has its own template. The closest to a
lingua franca is Koinly's universal CSV, and our shape is structurally
incompatible with it rather than merely differently named: it wants **one row per
transaction** with Sent and Received as separate positive columns, so a swap
exported our way arrives as two unrelated transfers and the tool computes the
wrong cost basis. Dates differ too (`YYYY-MM-DD HH:MM:SS`, not ISO 8601 with a
`Z`).

Do not "fix" this file by reshaping it. A tax-importable export is tracked
separately in **#159**, and the two formats are both wanted: neither is a superset,
since this one carries raw asset ids, precision and manifest annotations that the
tax shape has nowhere to put. Note also that tax software keys on a recognized
currency symbol, so on Liquid only L-BTC and USDt map cleanly and everything else
needs manual mapping.

## 5. The programmatic path (already shipped)

Manual export is not the only route and is not the preferred one for a site.
`getWalletDescriptor` is a wired provider RPC method:

- Per-origin connection with `getWalletDescriptor` in its granted
  `permissions.methods`, and the vault unlocked (`src/background/index.ts`)
- Approval copy: **"Derive addresses"** — *lets this site derive and correlate
  this account's scripts and unconfidential addresses; does not reveal private
  spend keys, blinding keys, or the ability to unblind outputs*
- Returns the **public** descriptor only, in `bip380-bip389-multipath`, with
  format negotiation and a specific error when nothing requested is supported
- A `walletDescriptorChanged` event behind the same permission

So a site asks, the user approves once, and the descriptor flows with no copy and
paste. The manual export in §4 is for backup, recovery, and tools that are not
websites — not a substitute for this.

## 6. Deliberately out of this phase

Two capabilities are typed in `src/provider/liquid-rpc.ts` and intentionally
unimplemented. Both belong to a later phase and are **owned separately**; do not
build them into this branch.

- **`publicConfidentialDescriptor`** (`LIQUID_DESCRIPTOR_TYPES`), with the
  `elip150-public-ct-bip389-multipath` format already named in
  `LIQUID_DESCRIPTOR_FORMATS`. The handler currently rejects it with
  `UNSUPPORTED_CAPABILITY` — *"Apogee does not expose public confidential
  descriptors."* An ELIP-150 public CT descriptor carries a blinding *public* key,
  so a holder can derive confidential addresses **without** the master blinding
  secret. That is the missing primitive for any disclosure that must receive
  confidential payments without gaining full view access.
- **Purpose-scoped accounts.** A separate hardened account (for example a
  distinct purpose level) means a disclosure cannot walk sideways into the
  wallet's ordinary BIP-84 account, because the hardened step is not invertible
  from the child xpub.

These compose, and neither is sufficient alone: a hardened account still leaks
amounts if disclosed as a CT descriptor, and an ELIP-150 projection of the
*ordinary* account still links every address the wallet uses. Together they give
minimal disclosure on both axes.

Note also that `descriptorType` is the wrong axis for account selection — it
describes the *form* of the descriptor, not its *scope*. Asking for a specific
account needs its own parameter, and that is an API design decision rather than
an overload to slip in quietly.

## 7. Related gap

`signMessage` is declared in the provider surface and its params are parsed at
the validation boundary, but **no handler exists** in the service worker, so a
site calling it fails. lwk exposes `signMessage`, so it is wirable. Recorded here
because "can this wallet export a descriptor and sign a message" is a natural
pair of questions, and the answers currently differ.

## Testing

`src/lib/wallet-export.test.ts`, 11 cases against a live lwk-derived descriptor.
The load-bearing one is negative: **the public descriptor must never contain the
master blinding key**, and in the text export the key must appear only above the
public section and never inside it. Also covered: each signer kind's label, a
non-SLIP-77 descriptor degrading to "no public form, and here is why" while still
exporting the CT descriptor, an entirely unparseable descriptor still exporting,
the JSON envelope's format/version/warning, and filename slugging including the
label that slugs to nothing.

`src/lib/tx-csv.test.ts`, 17 cases. The ones that matter are the ones a
spreadsheet would expose and a screenshot never would: the fee column summing to
the real total across a multi-asset transaction, amounts carrying no grouping
separators, a hostile registry asset name arriving as text rather than a formula,
and signed amounts NOT being neutralized so they stay summable.

There is no React component test harness in this repo, so the UI copy is verified
by grepping the built bundle.
