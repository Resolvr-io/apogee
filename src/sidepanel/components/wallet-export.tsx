// Export a wallet's public data. Its own sub-view, not a Settings drawer: there
// are four separate values here, each needing a name, a risk marker, a reveal
// and a copy, and that does not fit in a 400px column underneath everything else
// in Settings.
//
// Everything shown is already stored in cleartext (the sync engine needs the
// descriptor), so nothing is decrypted and no password is asked for. The care
// here is about DISCLOSURE, not access — see docs/wallet-descriptor-export.md,
// which carries the full reasoning so this screen does not have to.
//
// That split is deliberate. An earlier version explained each value in two or
// three sentences of body copy and became a wall of text nobody would read,
// which is worse than terse: an unread warning protects no one.
//
// So the values are grouped into two cards by WHAT THEY DISCLOSE, and each group
// gets one short line saying what the data shows. Three clauses, in the same
// order both times: what it shows, how long that lasts, what it still cannot do.
// The parallel structure is what makes the difference between the two groups
// scannable — the only clause that changes is the middle one.
//
// Phrasing rules learned the hard way here: no "lets someone", which buries the
// point behind a hypothetical actor; the subject is the data and the verb is
// "shows". And both groups end on "Cannot spend", so the warning never reads as
// scarier than it is.
//
// The line between the groups: the values under "Reveals your balances" carry
// the SLIP-77 master blinding key. The ones above it do not — but they still
// link every address the wallet will ever derive, because both descriptor forms
// carry the account xpub. Removing the blinding key removes the amounts, not the
// linkage, and the headings say so rather than implying the first group is
// anonymous. Nothing in either group can sign.

import { useState } from "react";
import { Download, Eye, EyeOff } from "lucide-react";
import type { AssetInfo, WalletTxDTO } from "@/engine/protocol";
import type { WalletInfo } from "@/keystore/keystore";
import { downloadText } from "@/lib/download";
import { toCsv, txCsvFilename, txCsvRows } from "@/lib/tx-csv";
import {
  type WalletExportFields,
  walletExportFields,
  walletExportFilename,
  walletExportText,
  walletsExportFilename,
  walletsExportJson,
} from "@/lib/wallet-export";
import { Card, CopyButton } from "@/sidepanel/components/ui";

/**
 * Bind the final two words with a non-breaking space, so a wrapped paragraph can
 * never end on a single word.
 *
 * `text-pretty` below is the modern fix, but Chrome only shipped it in 117 and
 * this extension's manifest floor is 116, so it cannot be the only one. Doing it
 * by transform rather than by typing a literal \u00A0 into the copy keeps the
 * strings editable and readable: an invisible character pasted mid-sentence is
 * the kind of thing that survives one copy edit and silently dies on the next.
 */
function noOrphan(text: string): string {
  return text.replace(/\s+(\S+)$/, "\u00A0$1");
}

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="shrink-0 text-[11px] text-[color:var(--text-subtle)]">{label}</span>
      <span className="min-w-0 truncate font-mono text-[11px] text-[color:var(--text-secondary)]">
        {value}
      </span>
    </div>
  );
}

/** One exportable value: a row that stays one line until opened. Carries no risk
 *  marker of its own — the group heading above it does, which is what lets the
 *  row stay a single line. */
function ValueRow({ title, value }: { title: string; value: string }) {
  const [shown, setShown] = useState(false);
  return (
    <div className="border-t border-[color:var(--border-soft)] py-2 first:border-t-0">
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 truncate text-xs text-[color:var(--text-strong)]">{title}</span>
        <button
          type="button"
          onClick={() => setShown((s) => !s)}
          aria-label={shown ? `Hide ${title}` : `Reveal ${title}`}
          className="shrink-0 text-[color:var(--text-subtle)] hover:text-[color:var(--text-secondary)]"
        >
          {shown ? <EyeOff size={13} /> : <Eye size={13} />}
        </button>
      </div>
      {shown && (
        <div className="mt-1.5 flex flex-col gap-1.5">
          <code className="block max-h-24 overflow-y-auto break-all font-mono text-[10px] leading-snug text-[color:var(--text-secondary)]">
            {value}
          </code>
          <CopyButton value={value} label="Copy" className="self-start text-[11px]" />
        </div>
      )}
    </div>
  );
}

/**
 * A group of values that disclose the same thing, headed by what someone
 * holding them could actually do.
 *
 * The heading plus one short line is where the risk lives, so a row can stay a
 * single line. Grouping means that line is written once instead of per row,
 * which is what keeps the screen short enough to actually be read.
 */
function ValueGroup({
  heading,
  implication,
  severe,
  rows,
}: {
  heading: string;
  implication: string;
  severe?: boolean;
  rows: Array<{ title: string; value: string }>;
}) {
  if (rows.length === 0) return null;
  return (
    <div className="mt-3 first:mt-0">
      <p
        className={
          severe
            ? "console-overline text-[color:var(--warning-text)]"
            : "console-overline text-[color:var(--text-secondary)]"
        }
      >
        {heading}
      </p>
      {/* text-pretty so a three-clause line does not leave "Cannot spend." as a
          one-word last line. Chrome ignores it below 117 (the manifest floor is
          116), which degrades to the wrap we had rather than to anything broken. */}
      <p className="mt-1 text-pretty text-[11px] text-[color:var(--text-subtle)]">
        {noOrphan(implication)}
      </p>
      <div className="mt-1.5 flex flex-col">
        {rows.map((row) => (
          <ValueRow key={row.title} {...row} />
        ))}
      </div>
    </div>
  );
}

/** The two groups, least disclosing first, so the eye lands on the safer set
 *  before the one that gives away balances. */
function valueGroups(fields: WalletExportFields) {
  const addressesOnly: Array<{ title: string; value: string }> = [];
  if (fields.extendedPublicKey) {
    addressesOnly.push({ title: "Account xpub", value: fields.extendedPublicKey });
  }
  if (fields.publicDescriptor) {
    addressesOnly.push({ title: "Public descriptor", value: fields.publicDescriptor });
  }
  const revealsBalances: Array<{ title: string; value: string }> = [
    { title: "Watch-only descriptor", value: fields.ctDescriptor },
  ];
  if (fields.masterBlindingKey) {
    revealsBalances.push({ title: "Master blinding key", value: fields.masterBlindingKey });
  }
  return { addressesOnly, revealsBalances };
}

/**
 * `wallet` is the active wallet, matching the rest of Settings. `wallets` is
 * every wallet, for the all-wallets file — a backup that skipped whichever
 * wallet was not active would not be a backup.
 */
export function WalletExport({
  wallet,
  wallets,
  txs,
  assets,
  policyAssetHex,
}: {
  wallet: WalletInfo;
  wallets: WalletInfo[];
  txs: WalletTxDTO[];
  assets: Record<string, AssetInfo>;
  /** From the sync snapshot. Absent until the first sync lands, which is why the
   *  CSV action waits for it: without the policy asset id the export cannot tell
   *  L-BTC from a token, and would mislabel a column rather than omit one. */
  policyAssetHex?: string;
}) {
  const fields = walletExportFields(wallet);
  const groups = valueGroups(fields);
  const canExportCsv = txs.length > 0 && !!policyAssetHex;
  return (
    <div className="flex flex-col gap-3">
      <Card>
        <div className="flex flex-col gap-1">
          <MetaRow label="Wallet" value={wallet.label} />
          <MetaRow label="Keys" value={fields.signerLabel} />
          <MetaRow label="Network" value={wallet.network} />
          <MetaRow label="Fingerprint" value={wallet.fingerprint} />
          {fields.derivationPath && <MetaRow label="Derivation" value={fields.derivationPath} />}
          {fields.scriptType && <MetaRow label="Script" value={fields.scriptType} />}
        </div>
      </Card>

      {/* Two cards, not two headings in one: the split is the point, and a card
          boundary makes it impossible to skim past. Each heading states a
          CAPABILITY — what a holder can do — because a label like "sees amounts"
          names the data without naming the consequence. */}
      <Card>
        <ValueGroup
          heading="Reveals your addresses"
          implication="Shows which addresses are yours, including ones you haven't used yet. Not your balances. Cannot spend."
          rows={groups.addressesOnly}
        />
        {!fields.publicDescriptor && fields.publicDescriptorUnavailable && (
          <p className="mt-2 text-pretty text-[11px] text-[color:var(--text-subtle)]">
            {noOrphan(`No shareable form for this wallet: ${fields.publicDescriptorUnavailable}`)}
          </p>
        )}
      </Card>

      <Card>
        <ValueGroup
          severe
          heading="Reveals your balances"
          implication="Shows every amount you hold and every payment you make, past and future. Permanent once shared. Cannot spend."
          rows={groups.revealsBalances}
        />
      </Card>

      {/* A download is the one action here that hands over BOTH groups at once,
          in a file that outlives the moment. So it says what is inside by
          pointing at the headings above rather than re-listing the values —
          "including the values that reveal your balances" is the sentence that
          stops someone mailing this to a third party. */}
      <Card>
        <p className="console-overline text-[color:var(--text-secondary)]">Save to a file</p>
        <p className="mt-1 text-pretty text-[11px] text-[color:var(--text-subtle)]">
          {noOrphan(
            // No count here on purpose: a watch-only wallet whose blinding policy
            // is not SLIP-77 has no master blinding key and no public
            // descriptor, so "all four" would be wrong for exactly the wallet
            // kind most likely to be exporting.
            "Contains the details above plus every value listed, including the ones that reveal your balances. Store the file like a password.",
          )}
        </p>
        <div className="mt-2.5 flex flex-wrap items-center gap-4">
          <button
            type="button"
            onClick={() =>
              downloadText(walletExportFilename(wallet, "txt"), walletExportText(fields))
            }
            className="inline-flex items-center gap-1 text-xs font-medium text-[color:var(--accent)] hover:underline"
          >
            <Download size={12} />
            This wallet (.txt)
          </button>
          {wallets.length > 1 && (
            <button
              type="button"
              onClick={() => downloadText(walletsExportFilename(), walletsExportJson(wallets))}
              className="inline-flex items-center gap-1 text-xs font-medium text-[color:var(--text-secondary)] hover:underline"
            >
              <Download size={12} />
              All {wallets.length} wallets (.json)
            </button>
          )}
        </div>
      </Card>

      {/* Its own card because it is a different kind of payload: history rather
          than key material. Saying "no keys" without also saying it is a full
          financial record would be the reassuring half of the truth. */}
      {canExportCsv && (
        <Card>
          <p className="console-overline text-[color:var(--text-secondary)]">Transaction history</p>
          <p className="mt-1 text-pretty text-[11px] text-[color:var(--text-subtle)]">
            {noOrphan(
              "Every transaction with dates, amounts, assets and txids, one row per asset moved. No keys, but it is a full record of your balances, so store it like the files above.",
            )}
          </p>
          <div className="mt-2.5">
            <button
              type="button"
              onClick={() =>
                downloadText(
                  txCsvFilename(wallet.label, wallet.network),
                  toCsv(
                    txCsvRows(txs, assets, {
                      id: policyAssetHex,
                      // The registry usually carries L-BTC; the network-derived
                      // fallback keeps the column labelled when it does not.
                      ticker:
                        assets[policyAssetHex]?.ticker ??
                        (wallet.network === "liquid" ? "L-BTC" : "tL-BTC"),
                      // A chain fact, not a lookup: the policy asset is always
                      // 8 decimals, and a registry miss must not silently
                      // rescale every amount in the file.
                      precision: 8,
                    }),
                  ),
                  "text/csv;charset=utf-8",
                )
              }
              className="inline-flex items-center gap-1 text-xs font-medium text-[color:var(--accent)] hover:underline"
            >
              <Download size={12} />
              Transactions ({txs.length}) (.csv)
            </button>
          </div>
        </Card>
      )}
    </div>
  );
}
