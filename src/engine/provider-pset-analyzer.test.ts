import type * as Lwk from "lwk_wasm";
import { describe, expect, it, vi } from "vitest";
import type { NormalizedProviderPsetSignInput } from "./provider-pset-analyzer";
import {
  analyzeAndSignProviderPset,
  analyzeProviderPset,
} from "./provider-pset-analyzer";
import { providerPsetReviewsMatch } from "./provider-pset-review";

const POLICY = "6f0279e9ed041c3d710a9f57d0c02928416460c4b722ae3457a11eec381c526d";
const OTHER_ASSET = "11".repeat(32);
const TXID = "4b33bd9a251311bd7f247ea19b3cf9887977ba4d9abe2ec7886de24094252586";
const OTHER_TXID = "22".repeat(32);
const SCRIPT = "0014272f557c30d2f520b6d4ae1dbdddaaf08708939f";
const OTHER_SCRIPT = "001444cce4238a23a23946ab36258e2a96706e325fa0";
const ADDRESS = "ex1qyuh42lps6t6jpdk54cwmmhd27zrs3yulrc7t5a";
const RECIPIENT = "lq1qrecipient";

interface MockInputOptions {
  txid?: string;
  vout?: number;
  script?: string;
  redeemScript?: string;
  sighash?: number;
  issuance?: { issuance?: boolean; reissuance?: boolean };
}

interface MockOutputOptions {
  script?: string;
  asset?: string;
  amount?: bigint;
  blinderIndex?: number;
}

interface MockUtxoOptions {
  txid?: string;
  vout?: number;
  script?: string;
  asset?: string;
  amount?: bigint;
  explicit?: boolean;
  address?: string;
}

interface MockUnblinded {
  asset: () => ReturnType<typeof stringValue>;
  value: () => ReturnType<typeof stringValue>;
  isExplicit: () => boolean;
  assetBlindingFactor: ReturnType<typeof vi.fn>;
  valueBlindingFactor: ReturnType<typeof vi.fn>;
}

interface MockRecipientOptions {
  asset?: string;
  amount?: bigint;
  address?: string;
  blinded?: boolean;
}

interface FixtureOptions {
  inputs?: ReturnType<typeof mockInput>[];
  outputs?: ReturnType<typeof mockOutput>[];
  utxos?: ReturnType<typeof mockUtxo>[];
  requested?: NormalizedProviderPsetSignInput[];
  balances?: Record<string, bigint>;
  fees?: Record<string, bigint>;
  recipients?: ReturnType<typeof mockRecipient>[];
  walletStatus?: bigint;
}

describe("provider PSET analyzer", () => {
  it("produces a complete, secret-free review for the ELIP-style spend", () => {
    const fixture = makeFixture();
    const result = analyze(fixture);

    expect(result).toEqual({
      ok: true,
      analysis: {
        uniqueId: "aa".repeat(32),
        walletStatus: "42",
        inputCount: 1,
        outputCount: 2,
        policyAssetId: POLICY,
        inputs: [
          {
            index: 0,
            txid: TXID,
            vout: 0,
            address: ADDRESS,
            assetId: POLICY,
            amount: "123456",
            scriptPubKey: SCRIPT,
            confidential: true,
            sighashType: 1,
          },
        ],
        recipients: [
          {
            address: RECIPIENT,
            assetId: POLICY,
            amount: "122456",
            confidential: true,
          },
        ],
        balanceChanges: { [POLICY]: "-123456" },
        fees: { [POLICY]: "1000" },
        hasConfidentialInputs: true,
        hasConfidentialOutputs: true,
      },
    });
    expect(fixture.pset.addDetails).toHaveBeenCalledWith(fixture.wollet);
    expect(fixture.unblinded.assetBlindingFactor).not.toHaveBeenCalled();
    expect(fixture.unblinded.valueBlindingFactor).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("blind-factor-secret");
  });

  it("accepts wallet change when recipients plus fees explain the net outflow", () => {
    const result = analyze(
      makeFixture({
        outputs: [
          mockOutput({ amount: 100_000n, blinderIndex: 0 }),
          mockOutput({ script: OTHER_SCRIPT, amount: 22_456n, blinderIndex: 0 }),
          mockOutput({ script: "", amount: 1_000n }),
        ],
        balances: { [POLICY]: -101_000n },
        recipients: [mockRecipient({ amount: 100_000n })],
      }),
    );

    expect(result).toMatchObject({
      ok: true,
      analysis: { balanceChanges: { [POLICY]: "-101000" } },
    });
  });

  it("rejects an input that is not a current wallet UTXO", () => {
    const result = analyze(
      makeFixture({ inputs: [mockInput({ txid: OTHER_TXID })] }),
    );
    expect(result).toEqual({ ok: false, reason: "input_not_current_utxo", inputIndex: 0 });
  });

  it("rejects a current wallet input omitted from signInputs", () => {
    const inputs = [mockInput(), mockInput({ txid: OTHER_TXID })];
    const result = analyze(
      makeFixture({
        inputs,
        utxos: [mockUtxo(), mockUtxo({ txid: OTHER_TXID })],
        requested: [requestedInput()],
      }),
    );
    expect(result).toEqual({ ok: false, reason: "unrequested_wallet_input", inputIndex: 1 });
  });

  it("rejects duplicate PSET outpoints", () => {
    const result = analyze(
      makeFixture({
        inputs: [mockInput(), mockInput()],
        requested: [requestedInput(), requestedInput({ index: 1 })],
      }),
    );
    expect(result).toEqual({ ok: false, reason: "duplicate_input", inputIndex: 1 });
  });

  it("rejects duplicate, empty, and out-of-range authorization lists", () => {
    expect(analyze(makeFixture({ requested: [] }))).toEqual({
      ok: false,
      reason: "invalid_request",
    });
    expect(
      analyze(makeFixture({ requested: [requestedInput(), requestedInput()] })),
    ).toEqual({ ok: false, reason: "invalid_request", inputIndex: 0 });
    expect(analyze(makeFixture({ requested: [requestedInput({ index: 1 })] }))).toEqual({
      ok: false,
      reason: "invalid_request",
      inputIndex: 1,
    });
  });

  it("binds the caller's address and the PSET prevout script to wallet state", () => {
    expect(
      analyze(
        makeFixture({ requested: [requestedInput({ scriptPubKey: OTHER_SCRIPT })] }),
      ),
    ).toEqual({ ok: false, reason: "input_address_mismatch", inputIndex: 0 });

    expect(
      analyze(makeFixture({ inputs: [mockInput({ script: OTHER_SCRIPT })] })),
    ).toEqual({ ok: false, reason: "input_prevout_mismatch", inputIndex: 0 });
  });

  it("limits the first signer boundary to native-SegWit single-key inputs", () => {
    const p2wsh = `0020${"33".repeat(32)}`;
    const result = analyze(
      makeFixture({
        inputs: [mockInput({ script: p2wsh })],
        utxos: [mockUtxo({ script: p2wsh })],
        requested: [requestedInput({ scriptPubKey: p2wsh })],
      }),
    );
    expect(result).toEqual({
      ok: false,
      reason: "private_or_unsupported_script",
      inputIndex: 0,
    });

    expect(
      analyze(makeFixture({ inputs: [mockInput({ redeemScript: SCRIPT })] })),
    ).toEqual({
      ok: false,
      reason: "private_or_unsupported_script",
      inputIndex: 0,
    });
  });

  it("rejects issuance and reissuance inputs", () => {
    for (const issuance of [{ issuance: true }, { reissuance: true }]) {
      expect(
        analyze(makeFixture({ inputs: [mockInput({ issuance })] })),
      ).toEqual({ ok: false, reason: "unsupported_issuance", inputIndex: 0 });
    }
  });

  it("enforces the PSET sighash against the caller's allowed set", () => {
    expect(
      analyze(makeFixture({ inputs: [mockInput({ sighash: 129 })] })),
    ).toEqual({ ok: false, reason: "sighash_not_allowed", inputIndex: 0 });

    expect(
      analyze(
        makeFixture({
          inputs: [mockInput({ sighash: 129 })],
          requested: [requestedInput({ sighashTypes: [1, 129] })],
        }),
      ),
    ).toMatchObject({ ok: true, analysis: { inputs: [{ sighashType: 129 }] } });
  });

  it("rejects malformed, unknown, and output-mutable sighash modes", () => {
    expect(
      analyze(makeFixture({ requested: [requestedInput({ sighashTypes: [128] })] })),
    ).toEqual({ ok: false, reason: "invalid_request", inputIndex: 0 });
    expect(
      analyze(makeFixture({ inputs: [mockInput({ sighash: 4 })] })),
    ).toEqual({ ok: false, reason: "unsupported_sighash", inputIndex: 0 });
    for (const sighash of [2, 3, 130, 131]) {
      expect(
        analyze(
          makeFixture({
            inputs: [mockInput({ sighash })],
            requested: [requestedInput({ sighashTypes: [sighash] })],
          }),
        ),
      ).toEqual({ ok: false, reason: "unsupported_sighash", inputIndex: 0 });
    }
  });

  it("rejects outputs whose asset or amount cannot be reviewed", () => {
    const result = analyze(
      makeFixture({ outputs: [mockOutput({ amount: undefined }), mockOutput({ script: "" })] }),
    );
    expect(result).toEqual({ ok: false, reason: "unreviewable_output" });
  });

  it("rejects non-policy fee outputs", () => {
    const result = analyze(
      makeFixture({ outputs: [mockOutput({ script: "", asset: OTHER_ASSET, amount: 123_456n })] }),
    );
    expect(result).toEqual({ ok: false, reason: "non_policy_fee" });

    expect(
      analyze(
        makeFixture({
          outputs: [mockOutput(), mockOutput({ script: "", amount: 1_000n, blinderIndex: 0 })],
        }),
      ),
    ).toEqual({ ok: false, reason: "non_policy_fee" });
  });

  it("checks exact input/output conservation from trusted wallet amounts", () => {
    const result = analyze(
      makeFixture({ outputs: [mockOutput({ amount: 122_455n }), mockOutput({ script: "", amount: 1_000n })] }),
    );
    expect(result).toEqual({ ok: false, reason: "pset_value_mismatch" });
  });

  it("requires fee outputs and LWK's wallet balance review to agree", () => {
    expect(analyze(makeFixture({ fees: { [POLICY]: 999n } }))).toEqual({
      ok: false,
      reason: "pset_balance_mismatch",
    });
    expect(analyze(makeFixture({ balances: { [POLICY]: -123_455n } }))).toEqual({
      ok: false,
      reason: "pset_balance_mismatch",
    });
  });

  it("rejects recipients with unavailable confidential review data", () => {
    const result = analyze(
      makeFixture({ recipients: [mockRecipient({ address: undefined })] }),
    );
    expect(result).toEqual({ ok: false, reason: "unreviewable_output" });
  });

  it("treats wallet status as freshness rather than an approved transaction effect", () => {
    const approved = successfulAnalysis(makeFixture({ walletStatus: 41n }));
    const current = successfulAnalysis(makeFixture({ walletStatus: 42n }));
    expect(providerPsetReviewsMatch(approved, current)).toBe(true);
    expect(
      providerPsetReviewsMatch(approved, {
        ...current,
        recipients: [{ ...current.recipients[0], amount: "122455" }],
      }),
    ).toBe(false);
  });

  it("re-analyzes and signs the exact approved PSET atomically", () => {
    const approved = successfulAnalysis(makeFixture({ walletStatus: 41n }));
    const fixture = makeFixture({ walletStatus: 42n });
    const signedFree = vi.fn();
    const sign = vi.fn((candidate: Lwk.Pset) => {
      expect(candidate).toBe(fixture.pset);
      return {
        toString: () => "signed-pset",
        free: signedFree,
      } as unknown as Lwk.Pset;
    });

    const result = analyzeAndSignProviderPset(
      fixture.pset as unknown as Lwk.Pset,
      fixture.wollet as unknown as Lwk.Wollet,
      POLICY,
      fixture.requested,
      approved,
      sign,
    );

    expect(result).toMatchObject({ ok: true, pset: "signed-pset" });
    expect(sign).toHaveBeenCalledOnce();
    expect(signedFree).toHaveBeenCalledOnce();
  });

  it("never reaches the signer when current effects differ from approval", () => {
    const approved = successfulAnalysis(makeFixture());
    const fixture = makeFixture({
      balances: { [POLICY]: -1_000n },
      recipients: [],
    });
    const sign = vi.fn();

    const result = analyzeAndSignProviderPset(
      fixture.pset as unknown as Lwk.Pset,
      fixture.wollet as unknown as Lwk.Wollet,
      POLICY,
      fixture.requested,
      approved,
      sign,
    );

    expect(result).toEqual({ ok: false, reason: "review_changed" });
    expect(sign).not.toHaveBeenCalled();
  });

  it("contains signer failures behind a structured result", () => {
    const approved = successfulAnalysis(makeFixture());
    const fixture = makeFixture();
    const result = analyzeAndSignProviderPset(
      fixture.pset as unknown as Lwk.Pset,
      fixture.wollet as unknown as Lwk.Wollet,
      POLICY,
      fixture.requested,
      approved,
      () => {
        throw new Error("seed or signer internals");
      },
    );
    expect(result).toEqual({ ok: false, reason: "signing_failed" });
    expect(JSON.stringify(result)).not.toContain("seed or signer internals");
  });
});

function analyze(fixture: ReturnType<typeof makeFixture>) {
  return analyzeProviderPset(
    fixture.pset as unknown as Lwk.Pset,
    fixture.wollet as unknown as Lwk.Wollet,
    POLICY,
    fixture.requested,
  );
}

function successfulAnalysis(fixture: ReturnType<typeof makeFixture>) {
  const result = analyze(fixture);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.reason);
  return result.analysis;
}

function makeFixture(options: FixtureOptions = {}) {
  const calls: string[] = [];
  const unblinded = {
    asset: () => stringValue(POLICY),
    value: () => stringValue("123456"),
    isExplicit: () => false,
    assetBlindingFactor: vi.fn(() => stringValue("blind-factor-secret")),
    valueBlindingFactor: vi.fn(() => stringValue("blind-factor-secret")),
  };
  const utxos = options.utxos ?? [mockUtxo({ unblinded })];
  const balance = {
    balances: () => mapValue(options.balances ?? { [POLICY]: -123_456n }),
    fees: () => mapValue(options.fees ?? { [POLICY]: 1_000n }),
    recipients: () => options.recipients ?? [mockRecipient()],
  };
  const pset = {
    addDetails: vi.fn(() => calls.push("addDetails")),
    inputs: () => {
      expect(calls).toEqual(["addDetails"]);
      return options.inputs ?? [mockInput()];
    },
    outputs: () => {
      expect(calls).toEqual(["addDetails"]);
      return options.outputs ?? [mockOutput(), mockOutput({ script: "", amount: 1_000n })];
    },
    uniqueId: () => stringValue("aa".repeat(32)),
  };
  const wollet = {
    utxos: () => utxos,
    psetDetails: vi.fn(() => {
      calls.push("psetDetails");
      expect(calls).toEqual(["addDetails", "psetDetails"]);
      return { balance: () => balance };
    }),
    status: () => options.walletStatus ?? 42n,
  };
  return {
    pset,
    wollet,
    requested: options.requested ?? [requestedInput()],
    unblinded,
  };
}

function mockInput(options: MockInputOptions = {}) {
  return {
    previousTxid: () => stringValue(options.txid ?? TXID),
    previousVout: () => options.vout ?? 0,
    previousScriptPubkey: () =>
      options.script === undefined ? stringValue(SCRIPT) : stringValue(options.script),
    redeemScript: () =>
      options.redeemScript === undefined ? undefined : stringValue(options.redeemScript),
    sighash: () => options.sighash ?? 1,
    issuance: () =>
      options.issuance
        ? {
            isIssuance: () => options.issuance?.issuance ?? false,
            isReissuance: () => options.issuance?.reissuance ?? false,
          }
        : undefined,
  };
}

function mockOutput(options: MockOutputOptions = {}) {
  return {
    scriptPubkey: () => stringValue(options.script ?? OTHER_SCRIPT),
    asset: () =>
      options.asset === undefined ? stringValue(POLICY) : stringValue(options.asset),
    amount: () => ("amount" in options ? options.amount : 122_456n),
    blinderIndex: () => options.blinderIndex,
  };
}

function mockUtxo(
  options: MockUtxoOptions & { unblinded?: MockUnblinded } = {},
) {
  const unblinded =
    options.unblinded ??
    ({
      asset: () => stringValue(options.asset ?? POLICY),
      value: () => stringValue((options.amount ?? 123_456n).toString()),
      isExplicit: () => options.explicit ?? false,
      assetBlindingFactor: vi.fn(() => stringValue("blind-factor-secret")),
      valueBlindingFactor: vi.fn(() => stringValue("blind-factor-secret")),
    } satisfies MockUnblinded);
  return {
    outpoint: () => ({
      txid: () => stringValue(options.txid ?? TXID),
      vout: () => options.vout ?? 0,
    }),
    unblinded: () => unblinded,
    address: () => stringValue(options.address ?? ADDRESS),
    scriptPubkey: () => stringValue(options.script ?? SCRIPT),
  };
}

function mockRecipient(options: MockRecipientOptions = {}) {
  return {
    asset: () =>
      options.asset === undefined ? stringValue(POLICY) : stringValue(options.asset),
    value: () => ("amount" in options ? options.amount : 122_456n),
    address: () =>
      "address" in options && options.address === undefined
        ? undefined
        : {
            toString: () => options.address ?? RECIPIENT,
            isBlinded: () => options.blinded ?? true,
          },
  };
}

function requestedInput(
  options: Partial<NormalizedProviderPsetSignInput> = {},
): NormalizedProviderPsetSignInput {
  return {
    index: 0,
    address: ADDRESS,
    scriptPubKey: SCRIPT,
    ...options,
  };
}

function stringValue(value: string) {
  return { toString: () => value };
}

function mapValue(value: Record<string, bigint>) {
  return { entries: () => new Map(Object.entries(value)) };
}
