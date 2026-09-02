import { describe, expect, it } from "vitest";
import {
  APOGEE_DECLARATIVE_TRANSACTION_EXTENSION,
} from "./declarative";
import { txManifestBundleHash, type TxManifestBundle } from "./bundle";
import {
  declarativeSigningMode,
  resolveDeclarativeRequirements,
} from "./declarative-plan";

const CHAIN = `bip122:${"11".repeat(16)}`;
const ACCOUNT = `${CHAIN}:wallet`;
const TXID = "22".repeat(32);

function bundle(action = "example.Move"): TxManifestBundle {
  return {
    schema: "apogee-tx-manifest-bundle/v1",
    manifestSpec: { id: "elip-205-draft", revision: "1a8d0b759853a00fef5f74351b64a602e2ba7a6f" },
    compiler: { id: "simplicityhl", revision: "9e77379d343e76eb92cb57c2668af9f8e0c4f46b", debugSymbols: false },
    extensions: [APOGEE_DECLARATIVE_TRANSACTION_EXTENSION],
    manifest: {
      manifest_version: "0.1.0",
      protocol: "publisher-example",
      actions: { [action]: { description: "Publisher-provided action prose." } },
      x_apogee_declarative: {
        version: 1,
        chains: [CHAIN],
        actions: {
          [action]: {
            arguments: { ASSET: "asset_id", AMOUNT: "u64" },
            inputs: [
              {
                kind: "provided",
                id: "state",
                provided_input: "state_in",
                authorization: "covenant",
                expect: {
                  asset: { op: "arg", name: "ASSET" },
                  amount: { op: "arg", name: "AMOUNT" },
                },
              },
            ],
            outputs: [
              {
                kind: "script",
                asset: { op: "arg", name: "ASSET" },
                amount: { op: "arg", name: "AMOUNT" },
                script: { op: "bytes", value: "51" },
                confidential: false,
              },
            ],
            fee: {
              mode: "fixed",
              asset: { op: "arg", name: "ASSET" },
              amount: { op: "uint", value: "1" },
            },
            covenant_witnesses: [
              {
                input: "state",
                source: "contract.simf",
                arguments: {},
                extra_leaf_payloads: [],
                witnesses: {
                  PATH: { kind: "right", value: { kind: "unit" } },
                },
              },
            ],
          },
        },
      },
    },
    sources: { "contract.simf": "fn main() {}\n" },
  };
}

async function invocation(action = "example.Move") {
  const value = bundle(action);
  return {
    protocolVersion: "0.1" as const,
    requestId: "request-1",
    chainId: CHAIN,
    accountIdentifier: ACCOUNT,
    manifest: { bundleHash: await txManifestBundleHash(value), bundle: value },
    action,
    arguments: { ASSET: "33".repeat(32), AMOUNT: "9" },
    providedInputs: { state_in: { txid: TXID, vout: 0 } },
    constraints: { maxFee: "10" },
  };
}

describe("declarative requirements", () => {
  it("normalizes a full untrusted invocation and retains publisher prose as data", async () => {
    const plan = await resolveDeclarativeRequirements(await invocation());
    expect(plan.arguments).toEqual({ AMOUNT: "9", ASSET: "33".repeat(32) });
    expect(plan.providedInputs).toEqual([
      {
        roleId: "state",
        providedInput: "state_in",
        authorization: "covenant",
        outpoint: { txid: TXID, vout: 0 },
      },
    ]);
    expect(plan.publisher.description).toBe("Publisher-provided action prose.");
    expect(plan.requirementDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(declarativeSigningMode(plan)).toBe("none");
  });

  it("reads publisher prose from the matching contract-template action", async () => {
    const action = "renamed_contract.Execute";
    const value = bundle(action);
    value.manifest.actions = {};
    value.manifest.contract_templates = {
      renamed_contract: {
        actions: { Execute: { description: "Template-scoped publisher prose." } },
      },
    };
    const request = await invocation(action);
    request.manifest = { bundleHash: await txManifestBundleHash(value), bundle: value };

    await expect(resolveDeclarativeRequirements(request)).resolves.toMatchObject({
      publisher: { description: "Template-scoped publisher prose." },
    });
  });

  it("derives wallet signing from capabilities, not protocol or action names", async () => {
    const value = bundle("renamed.Rehashed");
    const extension = value.manifest.x_apogee_declarative as {
      actions: Record<string, { inputs: unknown[] }>;
    };
    extension.actions["renamed.Rehashed"].inputs.push({
      kind: "wallet",
      id: "funding",
      asset: { op: "arg", name: "ASSET" },
      amount: { op: "arg", name: "AMOUNT" },
      amount_mode: "minimum",
      script_type: "p2wpkh",
    });
    const request = await invocation("renamed.Rehashed");
    request.manifest = { bundleHash: await txManifestBundleHash(value), bundle: value };
    const plan = await resolveDeclarativeRequirements(request);
    expect(declarativeSigningMode(plan)).toBe("wallet");
  });

  it("requires the full bundle and exact provided-input and argument maps", async () => {
    const request = await invocation();
    await expect(resolveDeclarativeRequirements({
      ...request,
      manifest: { bundleHash: request.manifest.bundleHash },
    })).rejects.toThrow(/full bundle/);
    await expect(resolveDeclarativeRequirements({
      ...request,
      arguments: { ...request.arguments, EXTRA: "1" },
    })).rejects.toThrow(/unknown name/);
    await expect(resolveDeclarativeRequirements({
      ...request,
      providedInputs: { wrong: { txid: TXID, vout: 0 } },
    })).rejects.toThrow(/exactly/);
  });

  it("rejects undeclared names inherited from Object.prototype", async () => {
    const request = await invocation();
    await expect(resolveDeclarativeRequirements({
      ...request,
      action: "constructor",
    })).rejects.toThrow(/does not declare the requested action/);
    await expect(resolveDeclarativeRequirements({
      ...request,
      action: "toString",
    })).rejects.toThrow(/does not declare the requested action/);
  });
});
