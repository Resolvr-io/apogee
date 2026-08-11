import { chromium, expect, test, type BrowserContext, type Page } from "@playwright/test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const EXTENSION_PATH = resolve("dist");
const PLAYGROUND_127 = "http://127.0.0.1:4173/";
const PLAYGROUND_LOCALHOST = "http://localhost:4173/";
const TEST_MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const MAINNET_POLICY_ASSET =
  "bip122:1466275836220db2944ca059a3a10ef6/elip144:6f0279e9ed041c3d710a9f57d0c02928416460c4b722ae3457a11eec381c526d";
const LENDING_V3_BUNDLE_HASH =
  "sha256:debdae89777fdd21fec2d763efe028876f267ff214aca9ddf9b3735d7657be15";

test.describe.serial("Liquid browser provider", () => {
  let context: BrowserContext;
  let extensionId: string;

  test.beforeAll(async () => {
    if (!existsSync(resolve(EXTENSION_PATH, "manifest.json"))) {
      throw new Error("dist/manifest.json is missing; run pnpm build before the provider tests");
    }
    context = await chromium.launchPersistentContext("", {
      channel: "chromium",
      headless: true,
      args: [
        `--disable-extensions-except=${EXTENSION_PATH}`,
        `--load-extension=${EXTENSION_PATH}`,
      ],
    });

    const bootstrap = await context.newPage();
    await bootstrap.goto(PLAYGROUND_127);
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
    extensionId = new URL(worker.url()).host;
    await bootstrap.close();
  });

  test.afterAll(async () => {
    await context?.close();
  });

  test("injects the safe public surface into an ordinary page", async () => {
    const page = await context.newPage();
    await page.goto(PLAYGROUND_127);

    await expect(page.getByTestId("provider-name")).toHaveText("Apogee");
    await expect(page.locator("#provider-empty")).toBeHidden();
    await expect(page.getByTestId("providers").locator(".provider-card")).toHaveCount(1);
    await page.getByRole("button", { name: "Request providers" }).click();
    await expect(page.locator(".announcement-count")).toHaveText(/\d+×/);

    await page.getByRole("button", { name: "Run checks" }).click();
    await expect(page.getByTestId("check-summary")).toContainText("14 passed · 0 failed");
    await expect(page.locator("#checks .fail")).toHaveCount(0);
    await expect(page.getByTestId("frame-result")).toHaveText("same-origin: 0 · opaque: 0");

    const methods = await discoveredProviderMethods(page);
    expect(methods).toEqual(
      expect.arrayContaining([
        "experimental_getTxManifestSupport",
        "experimental_executeTxManifest",
      ]),
    );
    const support = await discoveredProviderRequest(page, {
      method: "experimental_getTxManifestSupport",
      params: { bundleHash: LENDING_V3_BUNDLE_HASH },
    });
    expect(support).toMatchObject({
      supported: true,
      bundleHash: LENDING_V3_BUNDLE_HASH,
      status: "builtin",
      protocol: { name: "simplicity-lending", version: "v3" },
      supportedActions: [
        "issuance_factory.CreateFactory",
        "lending_contract.CreateOffer",
        "lending_contract.AcceptOffer",
        "lending_contract.ClaimPrincipal",
        "lending_contract.RepayLoan",
        "lending_contract.ClaimLenderVault",
        "lending_contract.CancelOffer",
        "lending_contract.LiquidateOffer",
      ],
    });

    // getBalance is implemented, but account data remains unavailable until the
    // calling origin obtains an explicit connection grant.
    await page.getByRole("button", { name: "Get balance" }).click();
    await expect(page.getByTestId("result")).toContainText('"code": 4100');
    await page.getByRole("button", { name: "Get UTXOs" }).click();
    await expect(page.getByTestId("result")).toContainText('"code": 4100');
    await page.getByRole("button", { name: "Get wallet descriptor" }).click();
    await expect(page.getByTestId("result")).toContainText('"code": 4100');
    await page.locator("#transfer-address").fill("tlq1qconformance-address");
    await page.locator("#transfer-amount").fill("1");
    await page.getByRole("button", { name: "Send transfer" }).click();
    await expect(page.getByTestId("result")).toContainText('"code": 4100');
    await page.locator("#sign-pset").fill("cHNldA==");
    await page.locator("#sign-inputs").fill('[{"index":0,"address":"tlq1qexample"}]');
    await page.getByRole("button", { name: "Sign PSET", exact: true }).click();
    await expect(page.getByTestId("result")).toContainText('"code": 4100');
    await page.close();
  });

  test("connects one origin, restores it after reload, isolates another, and disconnects", async () => {
    await seedTestWallet(context, extensionId);

    const page = await context.newPage();
    await page.goto(PLAYGROUND_127);
    await expect(page.getByTestId("provider-name")).toHaveText("Apogee");

    const approvalPromise = context.waitForEvent("page", {
      predicate: (candidate) => candidate.url().includes("/src/prompt/prompt.html"),
    });
    await page.getByRole("button", { name: "Connect · getBalance" }).click();
    const approval = await approvalPromise;
    await expect(approval.getByText("getBalance", { exact: true })).toBeVisible();
    await approval.getByRole("button", { name: "Connect", exact: true }).click();

    await expect(page.getByTestId("result")).toContainText('"accountIdentifier"');
    await expect.poll(() => page.locator("body").getAttribute("data-connection")).toBe("connected");
    await expect(page.getByTestId("timeline")).toContainText("wallet_connectionChanged");
    await expect(page.getByTestId("timeline")).not.toContainText(
      "bip122_walletDescriptorChanged",
    );
    const connectedAccount = await accountIdentifier(page);

    const eventWithoutMethod = await requestDescriptorEventWithoutMethod(page);
    expect(eventWithoutMethod).toMatchObject({
      code: 4200,
      data: { requiredMethod: "getWalletDescriptor" },
    });

    const transferApprovalPromise = context.waitForEvent("page", {
      predicate: (candidate) => candidate.url().includes("/src/prompt/prompt.html"),
    });
    await page.getByRole("button", { name: "Enable · sendTransfer" }).click();
    const transferApproval = await transferApprovalPromise;
    await expect(transferApproval.locator("dd").filter({ hasText: "sendTransfer" })).toBeVisible();
    await transferApproval.getByRole("button", { name: "Connect", exact: true }).click();
    await expect(page.getByTestId("result")).toContainText('"sendTransfer"');

    const signApprovalPromise = context.waitForEvent("page", {
      predicate: (candidate) => candidate.url().includes("/src/prompt/prompt.html"),
    });
    await page.getByRole("button", { name: "Enable · signPset" }).click();
    const signApproval = await signApprovalPromise;
    await expect(signApproval.locator("dd").filter({ hasText: "signPset" })).toBeVisible();
    await expect(signApproval.getByText(/every request still shows/i)).toBeVisible();
    await signApproval.getByRole("button", { name: "Connect", exact: true }).click();
    await expect(page.getByTestId("result")).toContainText('"signPset"');

    // A successful broadcast needs a funded PSET and live chain service, so CI
    // exercises the opt-in control without submitting an irreversible request.
    await expect(
      page.locator("label.check-field").filter({ hasText: "broadcast: true" }),
    ).toBeVisible();
    await page.locator("#sign-broadcast").check();
    await expect(page.locator("#sign-broadcast")).toBeChecked();
    await page.locator("#sign-broadcast").uncheck();

    const utxoApprovalPromise = context.waitForEvent("page", {
      predicate: (candidate) => candidate.url().includes("/src/prompt/prompt.html"),
    });
    await page.getByRole("button", { name: "Enable · getUTXOs" }).click();
    const utxoApproval = await utxoApprovalPromise;
    await expect(utxoApproval.locator("dd").filter({ hasText: "getUTXOs" })).toBeVisible();
    await expect(utxoApproval.getByText(/reveals individual coins/i)).toBeVisible();
    await expect(utxoApproval.getByText(/does not reveal blinding keys/i)).toBeVisible();
    await utxoApproval.getByRole("button", { name: "Connect", exact: true }).click();
    await expect(page.getByTestId("result")).toContainText('"getUTXOs"');

    // Reject a cross-chain filter before doing a network sync. This exercises
    // the granted method through the real extension without making conformance
    // depend on a public testnet indexer's availability.
    await page.locator("#utxo-asset-id").fill(MAINNET_POLICY_ASSET);
    await page.getByRole("button", { name: "Get UTXOs" }).click();
    await expect(page.getByTestId("result")).toContainText('"code": -32602');
    await expect(page.getByTestId("result")).toContainText('"path": "params.assetId"');

    // The current LWK builder cannot add an arbitrary zero-value output. The
    // ELIP makes memo support optional, so Apogee rejects it explicitly rather
    // than constructing and signing a transaction that silently drops bytes.
    await page.locator("#transfer-address").fill("tlq1qconformance-address");
    await page.locator("#transfer-amount").fill("1");
    await page.locator("#transfer-memo").fill("00");
    await page.getByRole("button", { name: "Send transfer" }).click();
    await expect(page.getByTestId("result")).toContainText('"code": 4200');
    await expect(page.getByTestId("result")).toContainText('"capability": "memo"');

    await page.reload();
    await expect(page.getByTestId("provider-name")).toHaveText("Apogee");
    await page.getByRole("button", { name: "Get connection" }).click();
    await expect(page.getByTestId("result")).toContainText(connectedAccount);

    const otherOrigin = await context.newPage();
    await otherOrigin.goto(PLAYGROUND_LOCALHOST);
    await expect(otherOrigin.getByTestId("provider-name")).toHaveText("Apogee");
    await otherOrigin.getByRole("button", { name: "Get connection" }).click();
    await expect(otherOrigin.getByTestId("result")).toHaveText("null");
    await otherOrigin.getByRole("button", { name: "Get balance" }).click();
    await expect(otherOrigin.getByTestId("result")).toContainText('"code": 4100');

    const descriptorApprovalPromise = context.waitForEvent("page", {
      predicate: (candidate) => candidate.url().includes("/src/prompt/prompt.html"),
    });
    await otherOrigin.getByRole("button", { name: "Enable · descriptor + event" }).click();
    const descriptorApproval = await descriptorApprovalPromise;
    await expect(
      descriptorApproval.locator("dd").filter({ hasText: "getWalletDescriptor" }),
    ).toBeVisible();
    await expect(
      descriptorApproval.locator("dd").filter({ hasText: "bip122_walletDescriptorChanged" }),
    ).toBeVisible();
    await expect(descriptorApproval.getByText(/derive and correlate/i)).toBeVisible();
    await expect(descriptorApproval.getByText(/does not reveal private spend keys/i)).toBeVisible();
    await descriptorApproval.getByRole("button", { name: "Connect", exact: true }).click();
    await expect(otherOrigin.getByTestId("result")).toContainText('"getWalletDescriptor"');
    await expect(otherOrigin.getByTestId("timeline")).toContainText(
      "bip122_walletDescriptorChanged",
    );

    await otherOrigin.getByRole("button", { name: "Get wallet descriptor" }).click();
    await expect(otherOrigin.getByTestId("result")).toContainText(
      '"descriptorType": "publicWalletDescriptor"',
    );
    await expect(otherOrigin.getByTestId("result")).toContainText(
      '"format": "bip380-bip389-multipath"',
    );
    const publicDescriptorResult = await otherOrigin.getByTestId("result").textContent();
    expect(publicDescriptorResult).not.toContain("ct(");
    expect(publicDescriptorResult).not.toContain("slip77(");
    expect(publicDescriptorResult).not.toMatch(/(?:xprv|tprv)/);
    expect(publicDescriptorResult).toContain('"canUnblindOutputs": false');

    await otherOrigin.locator("#descriptor-format").selectOption("bip380-split-branches");
    await otherOrigin.getByRole("button", { name: "Get wallet descriptor" }).click();
    await expect(otherOrigin.getByTestId("result")).toContainText('"code": 4200');
    await expect(otherOrigin.getByTestId("result")).toContainText(
      '"reason": "unsupported_descriptor_format"',
    );

    await otherOrigin.locator("#descriptor-format").selectOption("");
    await otherOrigin.locator("#descriptor-type").selectOption("publicConfidentialDescriptor");
    await otherOrigin.getByRole("button", { name: "Get wallet descriptor" }).click();
    await expect(otherOrigin.getByTestId("result")).toContainText('"code": 4200');
    await expect(otherOrigin.getByTestId("result")).toContainText(
      '"descriptorType": "publicConfidentialDescriptor"',
    );

    await page.getByRole("button", { name: "Disconnect" }).click();
    await expect(page.getByTestId("result")).toHaveText("null");
    await expect.poll(() => page.locator("body").getAttribute("data-connection")).toBe("disconnected");
    await expect(page.getByTestId("timeline")).toContainText("wallet_connectionChanged");

    await page.getByRole("button", { name: "Get connection" }).click();
    await expect(page.getByTestId("result")).toHaveText("null");
    await otherOrigin.getByRole("button", { name: "Disconnect" }).click();
    await expect(otherOrigin.getByTestId("result")).toHaveText("null");
    await otherOrigin.close();
    await page.close();
  });
});

async function seedTestWallet(context: BrowserContext, extensionId: string): Promise<void> {
  const extensionPage = await context.newPage();
  await extensionPage.goto(`chrome-extension://${extensionId}/src/sidepanel/index.html`);
  const reply = await extensionPage.evaluate(
    async ({ mnemonic }) => {
      // Restore travels over the dedicated "apogee-secret" port, exactly like
      // the panel's own wallet client — the broadcast channel rejects it.
      const extension = globalThis as typeof globalThis & {
        chrome: {
          runtime: {
            connect(connectInfo: { name: string }): {
              postMessage(message: unknown): void;
              disconnect(): void;
              onMessage: {
                addListener(listener: (message: unknown) => void): void;
                removeListener(listener: (message: unknown) => void): void;
              };
              onDisconnect: {
                addListener(listener: () => void): void;
                removeListener(listener: () => void): void;
              };
            };
          };
        };
      };
      const port = extension.chrome.runtime.connect({ name: "apogee-secret" });
      const reply = await new Promise<{ ok: boolean; error?: string } | null>((resolve) => {
        const done = (r: { ok: boolean; error?: string } | null) => {
          port.onMessage.removeListener(onMessage);
          port.onDisconnect.removeListener(onDisconnect);
          resolve(r);
        };
        const onMessage = (m: unknown) => done(m as { ok: boolean; error?: string });
        const onDisconnect = () => done(null);
        port.onMessage.addListener(onMessage);
        port.onDisconnect.addListener(onDisconnect);
        port.postMessage({
          type: "wallet/restore",
          password: "provider-test-password",
          mnemonic,
          label: "Provider conformance wallet",
          network: "liquidtestnet",
        });
      });
      port.disconnect();
      return reply;
    },
    { mnemonic: TEST_MNEMONIC },
  );
  expect(reply?.ok, reply?.error).toBe(true);
  await extensionPage.close();
}

async function accountIdentifier(page: Page): Promise<string> {
  const result = await page.getByTestId("result").textContent();
  const parsed = JSON.parse(result ?? "null") as { accountIdentifier?: unknown };
  expect(typeof parsed.accountIdentifier).toBe("string");
  return String(parsed.accountIdentifier);
}

async function requestDescriptorEventWithoutMethod(page: Page): Promise<unknown> {
  return page.evaluate(async () => {
    const pageWindow = globalThis as typeof globalThis & {
      addEventListener(type: string, listener: (event: Event) => void): void;
      dispatchEvent(event: Event): boolean;
      removeEventListener(type: string, listener: (event: Event) => void): void;
    };
    const detail = await new Promise<{
      provider: {
        request(args: unknown): Promise<unknown>;
      };
    }>((resolve) => {
      const receive = (event: Event) => {
        pageWindow.removeEventListener("liquid:announceProvider", receive);
        resolve((event as CustomEvent).detail);
      };
      pageWindow.addEventListener("liquid:announceProvider", receive);
      pageWindow.dispatchEvent(new Event("liquid:requestProvider"));
    });
    try {
      await detail.provider.request({
        method: "wallet_connect",
        params: {
          methods: ["getBalance"],
          events: ["bip122_walletDescriptorChanged"],
        },
      });
      return null;
    } catch (error) {
      const providerError = error as Error & { code?: unknown; data?: unknown };
      return { code: providerError.code, data: providerError.data };
    }
  });
}

async function discoveredProviderMethods(page: Page): Promise<string[]> {
  const capabilities = (await discoveredProviderRequest(page, {
    method: "wallet_getCapabilities",
  })) as { methods: string[] };
  return capabilities.methods;
}

async function discoveredProviderRequest(page: Page, request: unknown): Promise<unknown> {
  return page.evaluate(async (providerRequest) => {
    const pageWindow = globalThis as typeof globalThis & {
      addEventListener(type: string, listener: (event: Event) => void): void;
      dispatchEvent(event: Event): boolean;
      removeEventListener(type: string, listener: (event: Event) => void): void;
    };
    const detail = await new Promise<{
      provider: { request(args: unknown): Promise<unknown> };
    }>((resolve) => {
      const receive = (event: Event) => {
        pageWindow.removeEventListener("liquid:announceProvider", receive);
        resolve((event as CustomEvent).detail);
      };
      pageWindow.addEventListener("liquid:announceProvider", receive);
      pageWindow.dispatchEvent(new Event("liquid:requestProvider"));
    });
    return detail.provider.request(providerRequest);
  }, request);
}
