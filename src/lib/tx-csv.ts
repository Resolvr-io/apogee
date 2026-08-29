// Transaction history as CSV.
//
// A spreadsheet is the point: someone exporting this will sum a column, filter by
// asset, or hand it to an accountant. Three consequences are not obvious:
//
//   1. ONE ROW PER ASSET MOVEMENT, not per transaction. A swap moves two assets,
//      and a row holding both can't be summed or filtered by asset. Rows share a
//      txid, so they regroup trivially.
//
//   2. THE FEE APPEARS ON EXACTLY ONE ROW PER TRANSACTION. Repeating it on each
//      asset row of a swap doubles the total the moment anyone sums the column —
//      the easiest way for this file to be quietly wrong.
//
//   3. NO LOCALE FORMATTING. The UI's formatters group thousands with commas,
//      which would either break the columns or force quoting that spreadsheets
//      read back as text.
//
// And one security property: asset tickers and names come from the Liquid
// registry, where anyone can register an asset with any name. Those strings land
// in a file opened in Excel or Sheets, so they are neutralized against formula
// injection first. See csvCell.

import type { AssetInfo, WalletTxDTO } from "@/engine/protocol";

/** The policy asset carries its own descriptor: it is not always in the registry
 *  map the panel holds, and its precision is a chain fact rather than a lookup. */
export interface PolicyAsset {
  id: string;
  ticker: string;
  precision: number;
}

export interface TxCsvRow {
  dateUtc: string;
  txid: string;
  status: "confirmed" | "pending";
  blockHeight: string;
  direction: "in" | "out";
  assetId: string;
  assetTicker: string;
  assetName: string;
  amountBaseUnits: string;
  amount: string;
  precision: string;
  /** Empty on every row but one per transaction — see the header note. */
  feeBaseUnits: string;
  manifestStatus: string;
  manifestAction: string;
}

/** Column order and header row. Snake case because these are data columns read
 *  by tools, not labels read by people. */
const COLUMNS: Array<[header: string, key: keyof TxCsvRow]> = [
  ["date_utc", "dateUtc"],
  ["txid", "txid"],
  ["status", "status"],
  ["block_height", "blockHeight"],
  ["direction", "direction"],
  ["asset_id", "assetId"],
  ["asset_ticker", "assetTicker"],
  ["asset_name", "assetName"],
  ["amount_base_units", "amountBaseUnits"],
  ["amount", "amount"],
  ["precision", "precision"],
  ["fee_base_units", "feeBaseUnits"],
  ["manifest_status", "manifestStatus"],
  ["manifest_action", "manifestAction"],
];

/** Characters that make a spreadsheet treat a cell as a formula. Tab and CR are
 *  included because Excel strips leading whitespace before deciding. */
const FORMULA_LEAD = /^[=+\-@\t\r]/;

/**
 * One CSV cell: formula-neutralized, then quoted if it needs to be. The prefix is
 * an apostrophe, which Excel and Sheets both consume as "the rest is literal
 * text", and it is applied ONLY to values that would otherwise start a formula.
 * Amounts we generate skip this path entirely — see numberCell.
 */
export function csvCell(value: string): string {
  const neutralized = FORMULA_LEAD.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(neutralized) ? `"${neutralized.replace(/"/g, '""')}"` : neutralized;
}

/** A number we produced ourselves. Never formula-checked: a leading minus here is
 *  arithmetic, and prefixing it would turn every outgoing amount into text a
 *  spreadsheet can't sum. */
function numberCell(value: string): string {
  return value;
}

/** Scale a base-unit amount by `precision` as a plain decimal, no grouping. Kept
 *  local rather than reusing lib/format.ts, whose output is grouped for display
 *  and would break the column. */
export function plainDecimal(baseUnits: number, precision: number): string {
  const negative = baseUnits < 0;
  const digits = Math.abs(baseUnits).toString();
  if (precision <= 0) return `${negative ? "-" : ""}${digits}`;
  const padded = digits.padStart(precision + 1, "0");
  const whole = padded.slice(0, padded.length - precision);
  const fraction = padded.slice(padded.length - precision);
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

/** Per-asset deltas for one transaction, policy asset included. If a transaction
 *  reports a policy balance change with no matching entry — a token transfer
 *  whose only L-BTC movement is the fee — the policy row is synthesized so the
 *  file never loses it. */
function deltasFor(tx: WalletTxDTO, policy: PolicyAsset): Array<[string, number]> {
  const deltas = Object.entries(tx.assetDeltas ?? {}).filter(([, d]) => d !== 0);
  const hasPolicy = deltas.some(([id]) => id === policy.id);
  if (!hasPolicy && tx.balanceChange !== 0) deltas.push([policy.id, tx.balanceChange]);
  // Policy asset first, then tokens by id, so rows are stable between exports
  // rather than following object key order.
  return deltas.sort(([a], [b]) => (a === policy.id ? -1 : b === policy.id ? 1 : a < b ? -1 : 1));
}

export function txCsvRows(
  txs: WalletTxDTO[],
  assets: Record<string, AssetInfo>,
  policy: PolicyAsset,
): TxCsvRow[] {
  const rows: TxCsvRow[] = [];
  for (const tx of txs) {
    const deltas = deltasFor(tx, policy);
    deltas.forEach(([assetId, delta], index) => {
      const info = assets[assetId];
      const isPolicy = assetId === policy.id;
      const precision = isPolicy ? policy.precision : (info?.precision ?? 0);
      rows.push({
        // An unconfirmed transaction has no block time; an empty cell sorts and
        // filters better than a fabricated one.
        dateUtc: tx.timestamp ? new Date(tx.timestamp * 1000).toISOString() : "",
        txid: tx.txid,
        status: tx.height == null ? "pending" : "confirmed",
        blockHeight: tx.height == null ? "" : String(tx.height),
        direction: delta >= 0 ? "in" : "out",
        assetId,
        assetTicker: isPolicy ? policy.ticker : (info?.ticker ?? ""),
        assetName: isPolicy ? "" : (info?.name ?? ""),
        amountBaseUnits: String(delta),
        amount: plainDecimal(delta, precision),
        precision: String(precision),
        // One row per transaction carries the fee — see the header note.
        feeBaseUnits: index === 0 ? String(tx.fee) : "",
        manifestStatus: tx.txManifest?.status ?? "",
        manifestAction:
          tx.txManifest?.status === "verified" ? tx.txManifest.actionLabel : "",
      });
    });
  }
  return rows;
}

/** Which columns hold values we generated and must not formula-neutralize. */
const NUMERIC: ReadonlySet<keyof TxCsvRow> = new Set([
  "blockHeight",
  "amountBaseUnits",
  "amount",
  "precision",
  "feeBaseUnits",
]);

/** CRLF line endings: the spec says so, Excel on Windows is the likely consumer,
 *  and every tool that accepts LF also accepts CRLF. */
export function toCsv(rows: TxCsvRow[]): string {
  const lines = [COLUMNS.map(([header]) => header).join(",")];
  for (const row of rows) {
    lines.push(
      COLUMNS.map(([, key]) =>
        NUMERIC.has(key) ? numberCell(row[key]) : csvCell(row[key]),
      ).join(","),
    );
  }
  return `${lines.join("\r\n")}\r\n`;
}

export function txCsvFilename(label: string, network: string): string {
  const slug =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "wallet";
  return `apogee-${slug}-${network}-transactions.csv`;
}
