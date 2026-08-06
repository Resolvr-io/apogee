import { describe, expect, it, vi } from "vitest";
import { LIQUID_CONNECTION_CHANGED_EVENT } from "./liquid-browser-provider";
import { LIQUID_WALLET_DESCRIPTOR_CHANGED_EVENT } from "./liquid-rpc";
import {
  createLiquidProviderController,
  installLiquidProviderDiscovery,
} from "./liquid-browser-provider-runtime";

describe("Liquid browser provider runtime", () => {
  it("discovers providers regardless of listener/provider load order", () => {
    const earlyTarget = new EventTarget();
    const lateTarget = new EventTarget();
    const controller = createLiquidProviderController(async () => null, []);
    const detail = Object.freeze({
      info: Object.freeze({
        uuid: "00000000-0000-4000-8000-000000000001",
        name: "Apogee",
        icon: "data:image/png;base64,",
        rdns: "io.resolvr.apogee",
      }),
      provider: controller.provider,
    });

    const early = vi.fn();
    earlyTarget.addEventListener("liquid:announceProvider", early);
    installLiquidProviderDiscovery(earlyTarget, detail);

    installLiquidProviderDiscovery(lateTarget, detail);
    const late = vi.fn();
    lateTarget.addEventListener("liquid:announceProvider", late);
    lateTarget.dispatchEvent(new Event("liquid:requestProvider"));

    expect(early).toHaveBeenCalledOnce();
    expect((early.mock.calls[0][0] as CustomEvent).detail).toBe(detail);
    expect(late).toHaveBeenCalledOnce();
    expect((late.mock.calls[0][0] as CustomEvent).detail).toBe(detail);
  });

  it("announces multiple providers without a shared singleton", () => {
    const target = new EventTarget();
    const discovered: string[] = [];
    target.addEventListener("liquid:announceProvider", (event) => {
      discovered.push((event as CustomEvent).detail.info.uuid);
    });
    for (const suffix of ["1", "2"]) {
      const controller = createLiquidProviderController(async () => null, []);
      installLiquidProviderDiscovery(target, {
        info: {
          uuid: `00000000-0000-4000-8000-00000000000${suffix}`,
          name: `Wallet ${suffix}`,
          icon: "data:image/png;base64,",
          rdns: `example.wallet${suffix}`,
        },
        provider: controller.provider,
      });
    }

    expect(discovered).toEqual([
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-000000000002",
    ]);
  });

  it("normalizes requests and ignores caller-owned ids", async () => {
    const transport = vi.fn(async () => ({ ok: true }));
    const { provider } = createLiquidProviderController(transport, [
      LIQUID_CONNECTION_CHANGED_EVENT,
    ]);

    await provider.request(
      {
        id: 42,
        method: "wallet_getCapabilities",
        params: {},
        pageOnly: true,
      } as never,
    );

    expect(transport).toHaveBeenCalledWith({ method: "wallet_getCapabilities", params: {} });
  });

  it("returns a rejecting Promise for malformed requests", async () => {
    const { provider } = createLiquidProviderController(async () => null, []);
    const promise = provider.request(null as never);

    expect(promise).toBeInstanceOf(Promise);
    await expect(promise).rejects.toMatchObject({ code: -32600 });
  });

  it("keeps concurrent Promise results associated with their calls", async () => {
    const resolvers = new Map<string, (value: unknown) => void>();
    const { provider } = createLiquidProviderController(
      ({ method }) =>
        new Promise((resolve) => {
          resolvers.set(method, resolve);
        }),
      [],
    );
    const capabilities = provider.request({ method: "wallet_getCapabilities" });
    const connection = provider.request({ method: "wallet_getConnection" });

    resolvers.get("wallet_getConnection")?.("connection");
    resolvers.get("wallet_getCapabilities")?.("capabilities");

    await expect(connection).resolves.toBe("connection");
    await expect(capabilities).resolves.toBe("capabilities");
  });

  it("creates distinct, idempotently removable subscriptions", () => {
    const { provider, emit } = createLiquidProviderController(async () => null, [
      LIQUID_CONNECTION_CHANGED_EVENT,
    ]);
    const listener = vi.fn();
    const offFirst = provider.on({ event: LIQUID_CONNECTION_CHANGED_EVENT, listener });
    const offSecond = provider.on({ event: LIQUID_CONNECTION_CHANGED_EVENT, listener });

    emit(LIQUID_CONNECTION_CHANGED_EVENT, null);
    offFirst();
    offFirst();
    emit(LIQUID_CONNECTION_CHANGED_EVENT, null);
    offSecond();

    expect(listener).toHaveBeenCalledTimes(3);
  });

  it("delivers descriptor changes only to descriptor-event listeners", () => {
    const { provider, emit } = createLiquidProviderController(async () => null, [
      LIQUID_CONNECTION_CHANGED_EVENT,
      LIQUID_WALLET_DESCRIPTOR_CHANGED_EVENT,
    ]);
    const connectionListener = vi.fn();
    const descriptorListener = vi.fn();
    provider.on({ event: LIQUID_CONNECTION_CHANGED_EVENT, listener: connectionListener });
    provider.on({
      event: LIQUID_WALLET_DESCRIPTOR_CHANGED_EVENT,
      listener: descriptorListener,
    });

    const payload = { descriptors: [{ descriptor: "elwpkh(...)#checksum" }] };
    emit(LIQUID_WALLET_DESCRIPTOR_CHANGED_EVENT, payload);

    expect(descriptorListener).toHaveBeenCalledWith(payload);
    expect(connectionListener).not.toHaveBeenCalled();
  });

  it("isolates listener exceptions and rejects unsupported events synchronously", () => {
    const report = vi.fn();
    const { provider, emit } = createLiquidProviderController(
      async () => null,
      [LIQUID_CONNECTION_CHANGED_EVENT],
      report,
    );
    const healthy = vi.fn();
    provider.on({
      event: LIQUID_CONNECTION_CHANGED_EVENT,
      listener: () => {
        throw new Error("boom");
      },
    });
    provider.on({ event: LIQUID_CONNECTION_CHANGED_EVENT, listener: healthy });

    emit(LIQUID_CONNECTION_CHANGED_EVENT, null);

    expect(report).toHaveBeenCalledOnce();
    expect(healthy).toHaveBeenCalledOnce();
    expect(() =>
      provider.on({ event: "bip122_walletDescriptorChanged", listener: vi.fn() }),
    ).toThrow(expect.objectContaining({ code: 4200 }));
  });

  it("rejects values that cannot be represented as JSON", async () => {
    const { provider } = createLiquidProviderController(async () => null, []);
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    await expect(
      provider.request({ method: "getBalance", params: circular } as never),
    ).rejects.toMatchObject({ code: -32600 });
    await expect(
      provider.request({ method: "getBalance", params: { amount: Number.NaN } } as never),
    ).rejects.toMatchObject({ code: -32600 });
  });
});
