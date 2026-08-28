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
//     Safe to hand out, and correspondingly less useful on a confidential chain.
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
  parseOuterCtDescriptor,
  publicWalletDescriptor,
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
  /** Blinding key removed. Absent when the blinding policy is not SLIP-77 —
   *  see publicWalletDescriptor, which fails closed rather than guessing, since
   *  some other policies are themselves view-capable. */
  publicDescriptor?: string;
  /** Why the public projection is unavailable, when it is. Surfaced rather than
   *  swallowed: "this wallet cannot produce a safe-to-share form" is
   *  information the user needs, not an internal detail. */
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

/** Match a SLIP-77 blinding policy and capture its key. */
const SLIP77 = /^slip77\(([0-9a-f]{64})\)$/;
/** BIP-380 key origin at the head of a key expression. Accepts both hardened
 *  spellings: lwk canonicalizes to `'` (verified against a live derivation in
 *  wallet-export.test.ts), while descriptors pasted in by hand or produced by
 *  other tools often use `h`. Parsing only one of them would silently drop the
 *  derivation path for imported watch-only wallets. */
const KEY_ORIGIN = /\[([0-9a-fA-F]{8})((?:\/\d+[h']?)*)\]/;
/** The xpub/tpub (or other version-byte prefix) following the key origin. */
const EXTENDED_KEY = /\]([a-zA-Z0-9]{100,120})/;

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
    createdAt: new Date(info.createdAt).toISOString(),
    ctDescriptor: info.descriptor,
  };

  try {
    const projected = publicWalletDescriptor(info.descriptor);
    fields.publicDescriptor = projected.descriptor;
    fields.standardsUsed = projected.standardsUsed;
  } catch (err) {
    fields.publicDescriptorUnavailable =
      err instanceof Error ? err.message : "This wallet has no safe-to-share descriptor form.";
  }

  try {
    const [policy, inner] = parseOuterCtDescriptor(stripDescriptorChecksum(info.descriptor));
    const blinding = SLIP77.exec(policy);
    if (blinding) fields.masterBlindingKey = blinding[1];
    const origin = KEY_ORIGIN.exec(inner);
    if (origin) {
      fields.keyOrigin = origin[0];
      // origin[2] is the path with a leading slash, or "" for a bare origin.
      fields.derivationPath = `m${origin[2]}`;
    }
    const extended = EXTENDED_KEY.exec(inner);
    if (extended) fields.extendedPublicKey = extended[1];
    fields.scriptType = scriptTypeOf(inner);
  } catch {
    // Unparseable inner shape — the CT descriptor above is still the payload
    // that matters, so say nothing and let the caller show it.
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
      warning:
        "Each ctDescriptor contains a SLIP-77 master blinding key. Anyone holding it can see every address and amount for that wallet, permanently. It cannot sign or spend.",
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
