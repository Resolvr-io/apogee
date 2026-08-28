// Wallet export: everything about a wallet that is derivable without its seed,
// assembled into forms a person or another wallet can actually use.
//
// Every Apogee wallet — local seed, paired Jade, imported watch-only — already
// persists one canonical SLIP-77 CT descriptor in cleartext, because the sync
// engine needs it. So nothing here reads a secret or needs the vault's key;
// this module only projects and formats what the wallet record already holds.
//
// TWO PAYLOADS, and the difference is the whole point:
//
//   • The CT descriptor carries the SLIP-77 master blinding key. Anyone holding
//     it can derive every address this wallet will ever use AND unblind every
//     amount and asset, past and future. It is the form another wallet needs to
//     restore a working watch-only copy, and it cannot be revoked once shared.
//   • The public descriptor has that key removed (see
//     engine/public-wallet-descriptor.ts, which exists for exactly this reason
//     when disclosing to a dapp). It can derive scripts but cannot see amounts.
//     Safer to hand out, and correspondingly less useful on a confidential
//     chain. Safer, not safe: see the paragraph below.
//
// Callers must present those as different things. Collapsing them into one
// "export" button is how a user shares total transaction visibility while
// believing they shared an address list.
//
// AND NEITHER FORM IS A SCOPED CREDENTIAL. Both carry the account-level
// extended public key, which is the same key material the wallet itself uses,
// so either one links every address the wallet will ever derive — past, future,
// change included — to one identity. Removing the blinding key removes the
// amounts, not the linkage. Scoping disclosure is a derivation problem, solved
// by handing over a separate hardened account rather than by projecting this
// one, and nothing in this module can substitute for that. Copy that calls the
// public descriptor "safe to share" without qualification is wrong.

import {
  assertNoPrivateSpendKeysIn,
  parseOuterCtDescriptor,
  publicWalletDescriptor,
  slip77KeyOf,
  stripDescriptorChecksum,
} from "@/engine/public-wallet-descriptor";
import type { WalletInfo } from "@/keystore/keystore";

/** Where a wallet's keys live, in export-facing words rather than internal ones. */
const SIGNER_LABEL: Record<WalletInfo["signer"], string> = {
  local: "Seed stored in Apogee",
  jade: "Blockstream Jade hardware signer",
  watch: "Watch-only (imported descriptor)",
};

export interface WalletExportFields {
  label: string;
  network: string;
  /** Internal signer kind, kept so machine consumers need not parse prose. */
  signer: WalletInfo["signer"];
  signerLabel: string;
  fingerprint: string;
  createdAt: string;
  /** Full SLIP-77 CT descriptor: derives addresses AND unblinds amounts. */
  ctDescriptor: string;
  /** Blinding key removed. Absent when the blinding policy is not SLIP-77 (see
   *  publicWalletDescriptor, which fails closed rather than guessing, since some
   *  other policies are themselves view-capable), and absent when the projection
   *  came back non-canonical. Still reveals every address: see the header. */
  publicDescriptor?: string;
  /** Why the public projection is unavailable, when it is. Surfaced rather than
   *  swallowed: "this wallet cannot produce a shareable form" is information the
   *  user needs, not an internal detail. */
  publicDescriptorUnavailable?: string;
  standardsUsed?: string[];
  /** The SLIP-77 master blinding key on its own. Some tools take it separately
   *  from the descriptor, and naming it explicitly is also the clearest way to
   *  show a user what the CT form is carrying. */
  masterBlindingKey?: string;
  /** BIP-380 key origin, e.g. `[a1b2c3d4/84h/1h/0h]`. */
  keyOrigin?: string;
  /** The origin's path in `m/` form, e.g. `m/84h/1h/0h`. */
  derivationPath?: string;
  /** Extended public key as it appears in the descriptor. */
  extendedPublicKey?: string;
  /** wpkh / sh(wpkh) / tr, as a script-type name. */
  scriptType?: string;
}

/** BIP-380 key origin at the head of a key expression. Accepts both hardened
 *  spellings: lwk canonicalizes to `'` (verified against a live derivation in
 *  wallet-export.test.ts), while descriptors pasted in by hand or produced by
 *  other tools often use `h`. Parsing only one of them would silently drop the
 *  derivation path for imported watch-only wallets. */
const KEY_ORIGIN = /\[([0-9a-fA-F]{8})((?:\/\d+[h']?)*)\]/g;
/** The extended key following a key origin. Note this matches xprv/tprv as
 *  readily as xpub/tpub, which is why assertNoPrivateSpendKeysIn runs first. */
const EXTENDED_KEY = /\]([a-zA-Z0-9]{100,120})/g;

/** Every match of a global pattern, so the caller can tell "one key" from
 *  "several". A single-shot exec silently reports the first cosigner of a
 *  multisig as though it were the whole wallet. */
function allMatches(pattern: RegExp, text: string): RegExpExecArray[] {
  pattern.lastIndex = 0;
  const found: RegExpExecArray[] = [];
  let match = pattern.exec(text);
  while (match) {
    found.push(match);
    match = pattern.exec(text);
  }
  return found;
}

function isoOrEmpty(createdAt: number): string {
  try {
    const iso = new Date(createdAt).toISOString();
    return iso;
  } catch {
    return "";
  }
}

function scriptTypeOf(descriptor: string): string | undefined {
  if (descriptor.startsWith("elsh(elwpkh(")) return "sh(wpkh)";
  if (descriptor.startsWith("elwpkh(")) return "wpkh";
  if (descriptor.startsWith("eltr(")) return "tr";
  return undefined;
}

/**
 * Everything exportable about one wallet.
 *
 * Never throws on a descriptor it cannot fully parse: an export is a recovery
 * path, and refusing to show a user the descriptor they already own because a
 * derived nicety failed to parse would be the worst possible time to fail
 * closed. The CT descriptor is always present; the derived fields are
 * best-effort and simply absent when the shape is unfamiliar.
 */
export function walletExportFields(info: WalletInfo): WalletExportFields {
  const fields: WalletExportFields = {
    label: info.label,
    network: info.network,
    signer: info.signer,
    signerLabel: SIGNER_LABEL[info.signer] ?? info.signer,
    fingerprint: info.fingerprint,
    // Outside a try block, and the one field that could break the never-throws
    // contract: toISOString() raises RangeError on an invalid date, and this
    // runs during render, so a corrupt record would take the panel down rather
    // than degrade.
    createdAt: isoOrEmpty(info.createdAt),
    ctDescriptor: info.descriptor,
  };

  try {
    const projected = publicWalletDescriptor(info.descriptor);
    // publicWalletDescriptor documents that its caller must canonicalize with
    // WolletDescriptor first, and this caller cannot: for an imported watch-only
    // wallet the stored value is the user's paste.
    //
    // Measured, not assumed: lwk REJECTS a descriptor with whitespace around the
    // top-level comma ("Not an elements descriptor"), so the import path already
    // refuses that shape and it cannot reach storage. This check is therefore
    // defence in depth against a future path that persists a descriptor without
    // constructing a WolletDescriptor first, not a live defect.
    //
    // The reachable case — the `h` spelling of hardened components, a missing
    // checksum — is now fixed at the source: the watch-only import persists
    // lwk's serialization rather than the paste (#160). This check still earns
    // its keep for records written BEFORE that change, which keep their paste.
    if (/\s/.test(projected.descriptor)) {
      throw new Error("This wallet's stored descriptor is not in canonical form.");
    }
    fields.publicDescriptor = projected.descriptor;
    fields.standardsUsed = projected.standardsUsed;
  } catch (err) {
    fields.publicDescriptorUnavailable =
      err instanceof Error ? err.message : "This wallet has no shareable descriptor form.";
  }

  try {
    const [policy, inner] = parseOuterCtDescriptor(stripDescriptorChecksum(info.descriptor));
    const blinding = slip77KeyOf(policy);
    if (blinding) fields.masterBlindingKey = blinding;

    // Before extracting anything key-shaped: EXTENDED_KEY matches xprv/tprv as
    // readily as xpub, and everything derived below is presented under "cannot
    // spend". The engine already decided not to rely on lwk rejecting a
    // descriptor that carries a private key; reusing its parsing without this
    // check would put the most dangerous possible value in the least-marked
    // place on the screen.
    assertNoPrivateSpendKeysIn(inner);

    // Exactly one, or none. A 2-of-3 watch-only import parses perfectly well and
    // a first-match extraction would show ONE cosigner's key as "Account xpub"
    // and ONE cosigner's path as "Derivation" with nothing saying others exist.
    // Degrading the whole group together matches what scriptType already does
    // for an unrecognized script.
    const origins = allMatches(KEY_ORIGIN, inner);
    if (origins.length === 1) {
      fields.keyOrigin = origins[0][0];
      // origins[0][2] is the path with a leading slash, or "" for a bare origin.
      fields.derivationPath = `m${origins[0][2]}`;
    }
    const extended = allMatches(EXTENDED_KEY, inner);
    if (extended.length === 1) fields.extendedPublicKey = extended[0][1];
    fields.scriptType = scriptTypeOf(inner);
  } catch {
    // Unparseable inner shape, or a private key present. Either way the derived
    // niceties are dropped and the CT descriptor above is still the payload that
    // matters, so say nothing and let the caller show it.
  }

  return fields;
}

/** Human-readable single-wallet export. Labelled so the reader can tell the two
 *  descriptor forms apart, because pasting the wrong one into a third party is
 *  the mistake this format exists to prevent. */
export function walletExportText(fields: WalletExportFields): string {
  const lines: string[] = [
    `Apogee wallet export`,
    `Label: ${fields.label}`,
    `Network: ${fields.network}`,
    `Keys: ${fields.signerLabel}`,
    `Fingerprint: ${fields.fingerprint}`,
    `Created: ${fields.createdAt}`,
  ];
  if (fields.derivationPath) lines.push(`Derivation: ${fields.derivationPath}`);
  if (fields.scriptType) lines.push(`Script type: ${fields.scriptType}`);
  if (fields.extendedPublicKey) lines.push(`Extended public key: ${fields.extendedPublicKey}`);
  lines.push(
    ``,
    `# Watch-only descriptor (SEES AMOUNTS — treat as private)`,
    fields.ctDescriptor,
  );
  if (fields.masterBlindingKey) {
    lines.push(``, `# Master blinding key (SLIP-77)`, fields.masterBlindingKey);
  }
  if (fields.publicDescriptor) {
    lines.push(
      ``,
      `# Public descriptor (no amounts; still reveals every address)`,
      fields.publicDescriptor,
    );
  } else if (fields.publicDescriptorUnavailable) {
    lines.push(``, `# Public descriptor unavailable: ${fields.publicDescriptorUnavailable}`);
  }
  return `${lines.join("\n")}\n`;
}

/** Every wallet, as JSON, for a machine-readable backup. Shape is versioned so
 *  a later format change is detectable by whatever reads it back. */
export function walletsExportJson(wallets: WalletInfo[]): string {
  return `${JSON.stringify(
    {
      format: "apogee.wallet-export",
      version: 1,
      exportedAt: new Date().toISOString(),
      // "Each" was false for exactly the non-SLIP-77 wallet the rest of this
      // module is careful about. Erring toward over-warning is cheap; being
      // provably wrong in a file someone forwards is not.
      warning:
        "A ctDescriptor that carries a SLIP-77 master blinding key lets anyone holding it see every address and amount for that wallet, permanently. Check masterBlindingKey per wallet below. Nothing here can sign or spend.",
      wallets: wallets.map(walletExportFields),
    },
    null,
    2,
  )}\n`;
}

/** A filename that says which wallet and which network, without leaking the
 *  label's punctuation into the filesystem. */
export function walletExportFilename(info: WalletInfo, extension: "txt" | "json"): string {
  const slug =
    info.label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "wallet";
  return `apogee-${slug}-${info.network}-${info.fingerprint}.${extension}`;
}

export function walletsExportFilename(): string {
  return `apogee-wallets-${new Date().toISOString().slice(0, 10)}.json`;
}
