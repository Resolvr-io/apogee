import { describe, expect, it } from "vitest";
import {
  createLiquidProviderController,
  installLiquidProviderDiscovery,
} from "../../src/provider/liquid-browser-provider-runtime";
import {
  LIQUID_RPC_ERROR_REASONS,
  LiquidRpcError,
} from "../../src/provider/liquid-rpc-errors";
import {
  type PlaygroundProviderDetail,
  runSafeConformanceChecks,
} from "./conformance";

const capabilities = {
  browserProviderVersion: "1.0.0",
  methods: [
    "wallet_getCapabilities",
    "wallet_connect",
    "wallet_getConnection",
    "wallet_disconnect",
    "getBalance",
    "getUTXOs",
    "getWalletDescriptor",
    "sendTransfer",
    "signPset",
  ],
  events: ["wallet_connectionChanged", "bip122_walletDescriptorChanged"],
};

describe("Liquid provider playground conformance checks", () => {
  it("passes a conforming advertised surface", async () => {
    const target = new EventTarget();
    const controller = createLiquidProviderController(async ({ method }) => {
      if (method === "wallet_getCapabilities") return capabilities;
      if (method === "wallet_getConnection") return null;
      if (method === "getIdentityPublicKey") {
        throw new LiquidRpcError(
          4200,
          "unsupported",
          LIQUID_RPC_ERROR_REASONS.UNSUPPORTED_CAPABILITY,
        );
      }
      throw new LiquidRpcError(-32601, "unknown", LIQUID_RPC_ERROR_REASONS.METHOD_NOT_FOUND);
    }, ["wallet_connectionChanged"]);
    const detail = Object.freeze({
      info: Object.freeze({
        uuid: "00000000-0000-4000-8000-000000000001",
        name: "Apogee",
        icon: "data:image/png;base64,AA==",
        rdns: "io.resolvr.apogee",
      }),
      provider: controller.provider,
    });
    installLiquidProviderDiscovery(target, detail);

    const checks = await runSafeConformanceChecks(
      detail,
      () => {
        const found: PlaygroundProviderDetail[] = [];
        const listener = (event: Event) => found.push((event as CustomEvent).detail);
        target.addEventListener("liquid:announceProvider", listener);
        target.dispatchEvent(new Event("liquid:requestProvider"));
        target.removeEventListener("liquid:announceProvider", listener);
        return found;
      },
      { isSecureContext: true, isTopLevel: true, legacyProvider: {} },
    );

    expect(checks).toHaveLength(14);
    expect(checks.filter((check) => check.status === "fail")).toEqual([]);
  });

  it("reports malformed metadata without aborting later checks", async () => {
    const provider = Object.freeze({
      request: async ({ method }: { method?: string }) => {
        if (method === "wallet_getCapabilities") return capabilities;
        if (method === "wallet_getConnection") return null;
        if (method === "sendTransfer") throw Object.assign(new Error("unsupported"), { code: 4200 });
        throw Object.assign(new Error("unknown"), { code: -32601 });
      },
      on: () => () => undefined,
    });
    const detail = Object.freeze({
      info: Object.freeze({ uuid: "not-a-uuid", name: "", icon: "https://example/icon.svg", rdns: "wallet" }),
      provider,
    });

    const checks = await runSafeConformanceChecks(
      detail,
      () => [detail],
      { isSecureContext: true, isTopLevel: true },
    );

    expect(checks.find((check) => check.id === "metadata")?.status).toBe("fail");
    expect(checks.find((check) => check.id === "caller-id")?.status).toBe("pass");
  });
});
