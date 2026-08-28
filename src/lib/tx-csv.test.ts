// Transaction CSV. The assertions that matter here are the ones a spreadsheet
// would expose and a screenshot never would: that summing the fee column gives
// the real total, that amounts carry no grouping separators, and that a hostile
// asset name cannot become a formula.

import { describe, expect, it } from "vitest";
import type { AssetInfo, WalletTxDTO } from "@/engine/protocol";
import { csvCell, plainDecimal, toCsv, txCsvFilename, txCsvRows } from "./tx-csv";

const POLICY = { id: "aa".repeat(32), ticker: "tL-BTC", precision: 8 };
const TOKEN = "bb".repeat(32);

const ASSETS: Record<string, AssetInfo> = {
  [TOKEN]: { name: "Test Token", ticker: "TEST", precision: 2 },
};

function tx(over: Partial<WalletTxDTO> = {}): WalletTxDTO {
  return {
    txid: "cc".repeat(32),
    balanceChange: -1_000,
    fee: 143,
    height: 2_581_382,
    timestamp: 1_755_000_000,
    assetDeltas: { [POLICY.id]: -1_000 },
    ...over,
  };
}

describe("plainDecimal", () => {
  it("scales without grouping separators", () => {
    // 12,345,678 sats would be "12,345,678" through the display formatter,
    // which breaks the column it lands in.
    expect(plainDecimal(12_345_678, 8)).toBe("0.12345678");
    expect(plainDecimal(100_000_000, 8)).toBe("1.00000000");
    expect(plainDecimal(-1_000, 8)).toBe("-0.00001000");
    expect(plainDecimal(1_315, 2)).toBe("13.15");
  });

  it("passes integers through when precision is zero", () => {
    expect(plainDecimal(5_000, 0)).toBe("5000");
    expect(plainDecimal(-7, 0)).toBe("-7");
  });
});

describe("csvCell", () => {
  it("quotes and escapes what CSV requires", () => {
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell("has,comma")).toBe('"has,comma"');
    expect(csvCell('has"quote')).toBe('"has""quote"');
    expect(csvCell("has\nnewline")).toBe('"has\nnewline"');
  });

  it("neutralizes a formula, because asset names come from the registry", () => {
    // Anyone can register a Liquid asset under any name, and that name lands in
    // a file the user opens in Excel. These must arrive as text.
    expect(csvCell('=HYPERLINK("http://evil","Click")')).toBe(
      '"\'=HYPERLINK(""http://evil"",""Click"")"',
    );
    expect(csvCell("+1+1")).toBe("'+1+1");
    expect(csvCell("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(csvCell("-2+3")).toBe("'-2+3");
    expect(csvCell("\t=1+1")).toBe("'\t=1+1");
  });
});

describe("txCsvRows", () => {
  it("emits one row per asset movement, sharing a txid", () => {
    // A swap: token out, policy in.
    const rows = txCsvRows(
      [tx({ balanceChange: 50_000, assetDeltas: { [POLICY.id]: 50_000, [TOKEN]: -1_315 } })],
      ASSETS,
      POLICY,
    );
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.txid)).size).toBe(1);
    // Policy asset first, deterministically, so two exports of the same history
    // are diffable.
    expect(rows.map((r) => r.assetId)).toEqual([POLICY.id, TOKEN]);
    expect(rows.map((r) => r.direction)).toEqual(["in", "out"]);
    expect(rows[1].amount).toBe("-13.15");
    expect(rows[1].assetTicker).toBe("TEST");
  });

  it("puts the fee on exactly one row, so a summed column is the real total", () => {
    const rows = txCsvRows(
      [tx({ fee: 143, assetDeltas: { [POLICY.id]: 50_000, [TOKEN]: -1_315 } })],
      ASSETS,
      POLICY,
    );
    const fees = rows.map((r) => r.feeBaseUnits);
    expect(fees.filter((f) => f !== "")).toEqual(["143"]);
    // The failure this guards: repeat the fee per asset row and every swap
    // doubles the total the moment anyone sums the column.
    const total = fees.reduce((sum, f) => sum + (f === "" ? 0 : Number(f)), 0);
    expect(total).toBe(143);
  });

  it("synthesizes the policy row when only the fee moved L-BTC", () => {
    // A token-only transfer still spends L-BTC on the fee. If assetDeltas omits
    // the policy asset, the row must not vanish.
    const rows = txCsvRows(
      [tx({ balanceChange: -143, assetDeltas: { [TOKEN]: -1_315 } })],
      ASSETS,
      POLICY,
    );
    expect(rows.map((r) => r.assetId)).toEqual([POLICY.id, TOKEN]);
    expect(rows[0].amountBaseUnits).toBe("-143");
    expect(rows[0].assetTicker).toBe("tL-BTC");
  });

  it("drops zero deltas rather than emitting empty rows", () => {
    const rows = txCsvRows(
      [tx({ balanceChange: -1_000, assetDeltas: { [POLICY.id]: -1_000, [TOKEN]: 0 } })],
      ASSETS,
      POLICY,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].assetId).toBe(POLICY.id);
  });

  it("marks an unconfirmed transaction and leaves its height and date empty", () => {
    const rows = txCsvRows([tx({ height: null, timestamp: null })], ASSETS, POLICY);
    expect(rows[0].status).toBe("pending");
    expect(rows[0].blockHeight).toBe("");
    // Empty rather than a fabricated date: it sorts and filters correctly, and
    // "now" would be a lie about when the transaction happened.
    expect(rows[0].dateUtc).toBe("");
  });

  it("dates confirmed rows in UTC, from the chain's seconds", () => {
    const rows = txCsvRows([tx({ timestamp: 1_755_000_000 })], ASSETS, POLICY);
    expect(rows[0].dateUtc).toBe(new Date(1_755_000_000 * 1000).toISOString());
    expect(rows[0].dateUtc).toMatch(/Z$/);
  });

  it("always carries the raw asset id, even with no registry entry", () => {
    const unknown = "dd".repeat(32);
    // balanceChange 0 so no policy row is synthesized and this isolates the
    // unregistered asset.
    const rows = txCsvRows(
      [tx({ balanceChange: 0, assetDeltas: { [unknown]: 42 } })],
      {},
      POLICY,
    );
    expect(rows).toHaveLength(1);
    // A ticker can be missing or duplicated across assets; the id cannot.
    expect(rows[0].assetId).toBe(unknown);
    expect(rows[0].assetTicker).toBe("");
    expect(rows[0].precision).toBe("0");
    expect(rows[0].amount).toBe("42");
  });

  it("carries the manifest annotation only when it is verified", () => {
    const verified = txCsvRows(
      [
        tx({
          txManifest: {
            status: "verified",
            bundleHash: "sha256:abc",
            protocol: "simplicity-lending",
            version: "v3",
            protocolLabel: "Simplicity Lending",
            action: "repay_loan",
            actionLabel: "Repay loan",
          },
        }),
      ],
      ASSETS,
      POLICY,
    );
    expect(verified[0].manifestStatus).toBe("verified");
    expect(verified[0].manifestAction).toBe("Repay loan");

    const unsupported = txCsvRows(
      [tx({ txManifest: { status: "unsupported", bundleHash: "sha256:def" } })],
      ASSETS,
      POLICY,
    );
    // Status is still worth recording; there is no action to name.
    expect(unsupported[0].manifestStatus).toBe("unsupported");
    expect(unsupported[0].manifestAction).toBe("");
  });
});

describe("toCsv", () => {
  it("writes a header, CRLF endings, and one line per row", () => {
    const csv = toCsv(txCsvRows([tx()], ASSETS, POLICY));
    const lines = csv.split("\r\n").filter(Boolean);
    expect(lines[0]).toBe(
      "date_utc,txid,status,block_height,direction,asset_id,asset_ticker,asset_name,amount_base_units,amount,precision,fee_base_units,manifest_status,manifest_action",
    );
    expect(lines).toHaveLength(2);
    expect(csv.endsWith("\r\n")).toBe(true);
  });

  it("leaves signed amounts summable instead of neutralizing them", () => {
    const csv = toCsv(txCsvRows([tx({ balanceChange: -1_000 })], ASSETS, POLICY));
    // A leading minus in an amount is arithmetic, not injection. Prefixing it
    // would turn every outgoing amount into text no spreadsheet can add up.
    expect(csv).toContain(",-1000,");
    expect(csv).not.toContain("'-1000");
    expect(csv).not.toContain("'-0.00001000");
  });

  it("neutralizes a hostile asset name without touching the numbers", () => {
    const hostile = "ee".repeat(32);
    const csv = toCsv(
      txCsvRows(
        [tx({ assetDeltas: { [hostile]: -5 } })],
        { [hostile]: { name: '=cmd|" /c calc"!A1', ticker: "+EVIL", precision: 0 } },
        POLICY,
      ),
    );
    expect(csv).toContain("'+EVIL");
    expect(csv).toContain("'=cmd|");
    expect(csv).toContain(",-5,");
  });
});

describe("txCsvFilename", () => {
  it("slugs the label and names the network", () => {
    expect(txCsvFilename("Daniel's  Main Wallet!! ", "liquidtestnet")).toBe(
      "apogee-daniel-s-main-wallet-liquidtestnet-transactions.csv",
    );
  });

  it("falls back when the label slugs to nothing", () => {
    expect(txCsvFilename("!!!", "liquid")).toBe("apogee-wallet-liquid-transactions.csv");
  });
});
