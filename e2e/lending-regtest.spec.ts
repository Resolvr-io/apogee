import { chromium, expect, test, type BrowserContext } from "@playwright/test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const EXTENSION_PATH = resolve(
  process.env.LENDING_REGTEST_EXTENSION_PATH ?? "dist-lending-regtest",
);
const TEST_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const LENDING_V3_BUNDLE_HASH =
  "sha256:debdae89777fdd21fec2d763efe028876f267ff214aca9ddf9b3735d7657be15";
const REGTEST_CHAIN_ID = "bip122:00902a6b70c2ca83b5d9c815d96a0e2f";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required; run pnpm test:lending:regtest`);
  return value;
}

const DAPP_URL = requiredEnv("LENDING_REGTEST_DAPP_URL");
const ESPLORA_URL = requiredEnv("LENDING_REGTEST_ESPLORA_URL");
const RPC_URL = requiredEnv("LENDING_REGTEST_RPC_URL");
const RPC_USER = requiredEnv("LENDING_REGTEST_RPC_USER");
const RPC_PASSWORD = requiredEnv("LENDING_REGTEST_RPC_PASSWORD");
const MINER_ADDRESS = requiredEnv("LENDING_REGTEST_MINER_ADDRESS");
const PRINCIPAL_ASSET_ID = requiredEnv("LENDING_REGTEST_PRINCIPAL_ASSET_ID");

test("real lending UI executes every trusted lending action through Apogee", async () => {
  if (!existsSync(resolve(EXTENSION_PATH, "manifest.json"))) {
    throw new Error("The regtest extension build is missing; run pnpm test:lending:regtest");
  }

  const context = await launchExtensionContext();
  let lenderContext: BrowserContext | undefined;

  try {
    const extensionId = await extensionIdentity(context);
    const address = await seedRegtestWallet(context, extensionId, TEST_MNEMONIC, "borrower");
    await sendAsset(address, 1);
    await sendAsset(address, 2, PRINCIPAL_ASSET_ID);
    await mineBlock();
    await waitForEsploraTip();

    const page = await connectLendingDapp(context);

    await page.goto(new URL("/borrow", DAPP_URL).href);
    await expect(page.getByText("Your Borrows", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Create Borrow Offer" }).click();
    await expect(page.getByText("Enable Borrowing", { exact: true }).first()).toBeVisible();

    await executeManifestAction(page, context, "Enable borrowing", "Enable");

    await createBorrowOffer(page, context);
    const pendingOffer = page.getByRole("row").filter({ hasText: "Open Offer" }).first();
    await expect(pendingOffer).toBeVisible();
    await pendingOffer.click();
    await expect(page.getByText("Cancel Offer", { exact: true }).first()).toBeVisible();
    await executeManifestAction(page, context, "Cancel borrow offer", "Cancel Offer");
    await expect(page.getByRole("row").filter({ hasText: "Cancelled" }).first()).toBeVisible();

    lenderContext = await launchExtensionContext();
    const lenderExtensionId = await extensionIdentity(lenderContext);
    const lenderAddress = await seedRegtestWallet(
      lenderContext,
      lenderExtensionId,
      "legal winner thank year wave sausage worth useful legal winner thank yellow",
      "lender",
    );
    await sendAsset(lenderAddress, 1);
    await sendAsset(lenderAddress, 2, PRINCIPAL_ASSET_ID);
    await mineBlock();
    await waitForEsploraTip();
    const lenderPage = await connectLendingDapp(lenderContext);

    await page.bringToFront();
    await page.goto(new URL("/borrow", DAPP_URL).href);
    await createBorrowOffer(page, context);

    await lenderPage.bringToFront();
    await lenderPage.goto(new URL("/supply", DAPP_URL).href);
    const fundableOffer = lenderPage.getByRole("row").filter({ hasText: "Open Offer" }).first();
    await expect(fundableOffer).toBeVisible();
    await fundableOffer.click();
    await expect(lenderPage.getByRole("heading", { name: /^Accept Offer/ })).toBeVisible();
    await executeManifestAction(lenderPage, lenderContext, "Fund loan offer", "Accept & Supply");

    await page.bringToFront();
    await page.goto(new URL("/borrow", DAPP_URL).href);
    const activeOffer = page.getByRole("row").filter({ hasText: "Active" }).first();
    await expect(activeOffer).toBeVisible();
    await activeOffer.click();
    await expect(page.getByRole("heading", { name: /^Claim Principal Offer/ })).toBeVisible();
    await executeManifestAction(page, context, "Claim borrowed funds", "Claim Principal");

    await page.goto(new URL("/borrow", DAPP_URL).href);
    const repayableOffer = page.getByRole("row").filter({ hasText: "Active" }).first();
    await expect(repayableOffer).toBeVisible();
    await repayableOffer.click();
    await expect(page.getByRole("heading", { name: /^Repay Offer/ })).toBeVisible();
    await executeManifestAction(page, context, "Repay loan in full", "Repay Loan");

    await lenderPage.bringToFront();
    await lenderPage.goto(new URL("/supply", DAPP_URL).href);
    const repaidOffer = lenderPage.getByRole("row").filter({ hasText: "Repaid" }).first();
    await expect(repaidOffer).toBeVisible();
    await repaidOffer.click();
    await expect(lenderPage.getByRole("heading", { name: /^Claim Offer/ })).toBeVisible();
    await executeManifestAction(lenderPage, lenderContext, "Collect loan repayment", "Claim");
    await expect(lenderPage.getByRole("row").filter({ hasText: "Claimed" }).first()).toBeVisible();

    await page.bringToFront();
    await page.goto(new URL("/borrow", DAPP_URL).href);
    await createBorrowOffer(page, context);

    await lenderPage.bringToFront();
    await lenderPage.goto(new URL("/supply", DAPP_URL).href);
    const expiringOffer = lenderPage.getByRole("row").filter({ hasText: "Open Offer" }).first();
    await expect(expiringOffer).toBeVisible();
    await expiringOffer.click();
    await executeManifestAction(lenderPage, lenderContext, "Fund loan offer", "Accept & Supply");
    await mineBlocks(6);
    await waitForEsploraTip();
    await lenderPage.goto(new URL("/supply", DAPP_URL).href);
    const expiredOffer = lenderPage
      .getByRole("row")
      .filter({ hasText: "Active" })
      .filter({ hasText: "Expired" })
      .first();
    await expect.poll(async () => {
      await lenderPage.getByRole("button", { name: "Refresh offers" }).click();
      return expiredOffer.isVisible();
    }, { timeout: 60_000 }).toBe(true);
    await expiredOffer.click();
    await expect(lenderPage.getByRole("heading", { name: /^Liquidate Offer/ })).toBeVisible();
    await executeManifestAction(
      lenderPage,
      lenderContext,
      "Liquidate expired loan",
      "Liquidate & Claim Collateral",
    );
    await expect(
      lenderPage.getByRole("row").filter({ hasText: "Liquidated" }).first(),
    ).toBeVisible();
  } finally {
    await lenderContext?.close();
    await context.close();
  }
});

async function launchExtensionContext(): Promise<BrowserContext> {
  return chromium.launchPersistentContext("", {
    channel: "chromium",
    headless: true,
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
    ],
  });
}

async function connectLendingDapp(context: BrowserContext) {
  const page = await context.newPage();
  await page.goto(DAPP_URL);
  await expect.poll(async () => {
    const support = await discoveredProviderRequest(page, {
      method: "experimental_getTxManifestSupport",
      params: { bundleHash: LENDING_V3_BUNDLE_HASH },
    }) as { supported?: unknown };
    return support.supported;
  }).toBe(true);
  const connectionApprovalPromise = approvalPage(context);
  const connectionRequest = discoveredProviderRequest(page, {
    method: "wallet_connect",
    params: {
      chains: [REGTEST_CHAIN_ID],
      methods: ["experimental_executeTxManifest", "getBalance"],
      events: [],
    },
  });
  const connectionApproval = await connectionApprovalPromise;
  await expect(
    connectionApproval.locator("dd").filter({ hasText: "experimental_executeTxManifest" }),
  ).toBeVisible();
  await connectionApproval.getByRole("button", { name: "Connect", exact: true }).click();
  await connectionRequest;
  await page.evaluate(() => {
    sessionStorage.setItem("jade_wallet_session", JSON.stringify({ backend: "apogee" }));
  });
  await page.reload();
  await expect(page.getByRole("button", { name: "Apogee", exact: true }).first()).toBeVisible();
  return page;
}

async function createBorrowOffer(
  page: import("@playwright/test").Page,
  context: BrowserContext,
): Promise<void> {
  await expect(page.getByRole("button", { name: "Create Borrow Offer" })).toBeEnabled();
  await activateButton(page, "Create Borrow Offer");
  await expect(page.getByText("Create Borrow Offer", { exact: true }).last()).toBeVisible();
  await page.getByLabel("Collateral to Lock").fill("0.01");
  await page.getByLabel("Loan Amount").fill("1");
  await page.getByLabel("Fee").fill("0.1");
  await page.getByLabel("Term").click();
  await page.getByRole("option", { name: /5 minutes/ }).click();
  await executeManifestAction(page, context, "Create borrow offer", "Create Borrow Offer");
  await expect(page.getByRole("row").filter({ hasText: "Open Offer" }).first()).toBeVisible();
}

async function executeManifestAction(
  page: import("@playwright/test").Page,
  context: BrowserContext,
  actionLabel: string,
  buttonName: string,
): Promise<void> {
  const manifestApprovalPromise = approvalPage(context);
  await activateButton(page, buttonName);
  const manifestApproval = await manifestApprovalPromise;
  await expect(manifestApproval.getByText(actionLabel, { exact: true })).toBeVisible();
  await manifestApproval.getByRole("button", { name: "Approve & execute" }).click();

  await expect(page.getByRole("button", { name: "Done", exact: true })).toBeEnabled();
  await expect(page.getByText("Transaction ID", { exact: true })).toBeVisible();
  await mineBlock();
  await waitForEsploraTip();
  await expect(page.getByText(/Confirmed|Finalized/, { exact: true })).toBeVisible();
  await activateButton(page, "Done");
}

async function activateButton(page: import("@playwright/test").Page, name: string): Promise<void> {
  await page.getByRole("button", { name, exact: true }).last().focus();
  await page.keyboard.press("Enter");
}

async function extensionIdentity(context: BrowserContext): Promise<string> {
  const bootstrap = await context.newPage();
  await bootstrap.goto(DAPP_URL);
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker", {
    timeout: 30_000,
  }));
  await bootstrap.close();
  return new URL(worker.url()).host;
}

async function seedRegtestWallet(
  context: BrowserContext,
  extensionId: string,
  mnemonic: string,
  role: string,
): Promise<string> {
  const extensionPage = await context.newPage();
  await extensionPage.goto(`chrome-extension://${extensionId}/src/sidepanel/index.html`);
  const result = await extensionPage.evaluate(
    async ({ mnemonic, esploraUrl, role }) => {
      const extension = globalThis as typeof globalThis & {
        chrome: {
          runtime: {
            sendMessage(message: unknown): Promise<{
              ok: boolean;
              value?: unknown;
              error?: string;
            }>;
          };
        };
      };
      const send = async (message: unknown) => {
        const reply = await extension.chrome.runtime.sendMessage(message);
        if (!reply.ok) throw new Error(reply.error ?? "Apogee request failed");
        return reply.value;
      };
      await send({
        type: "wallet/restore",
        password: "lending-regtest-password",
        mnemonic,
        label: `Lending regtest ${role}`,
        network: "regtest",
      });
      await send({ type: "wallet/setChainServer", network: "regtest", url: esploraUrl });
      return await send({ type: "wallet/getAddress" }) as { address: string };
    },
    { mnemonic, esploraUrl: ESPLORA_URL, role },
  );
  await extensionPage.close();
  return result.address;
}

function approvalPage(context: BrowserContext) {
  return context.waitForEvent("page", {
    predicate: (candidate) => candidate.url().includes("/src/prompt/prompt.html"),
    timeout: 20_000,
  });
}

async function discoveredProviderRequest(page: import("@playwright/test").Page, request: unknown) {
  return page.evaluate(async (providerRequest) => {
    const browserWindow = globalThis as typeof globalThis & {
      addEventListener(type: string, listener: (event: Event) => void): void;
      removeEventListener(type: string, listener: (event: Event) => void): void;
      dispatchEvent(event: Event): boolean;
    };
    const announced = new Promise<{
      provider: { request(args: unknown): Promise<unknown> };
    }>((resolveProvider) => {
      const receive = (event: Event) => {
        browserWindow.removeEventListener("liquid:announceProvider", receive);
        resolveProvider((event as CustomEvent).detail);
      };
      browserWindow.addEventListener("liquid:announceProvider", receive);
      browserWindow.dispatchEvent(new Event("liquid:requestProvider"));
    });
    return (await announced).provider.request(providerRequest);
  }, request);
}

async function rpc(method: string, params: unknown[] = []): Promise<unknown> {
  const authorization = Buffer.from(`${RPC_USER}:${RPC_PASSWORD}`).toString("base64");
  const response = await fetch(RPC_URL, {
    method: "POST",
    headers: {
      authorization: `Basic ${authorization}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ jsonrpc: "1.0", id: "apogee-e2e", method, params }),
  });
  const body = await response.json() as { result?: unknown; error?: { message?: string } | null };
  if (!response.ok || body.error) {
    throw new Error(body.error?.message ?? `Elements RPC ${method} failed (${response.status})`);
  }
  return body.result;
}

async function mineBlock(): Promise<void> {
  await mineBlocks(1);
}

async function mineBlocks(count: number): Promise<void> {
  await rpc("generatetoaddress", [count, MINER_ADDRESS]);
}

async function sendAsset(address: string, amount: number, assetId?: string): Promise<void> {
  const params: unknown[] = [address, amount];
  if (assetId) params.push("", "", false, true, 1, "UNSET", false, assetId);
  await rpc("sendtoaddress", params);
}

async function waitForEsploraTip(): Promise<void> {
  const expected = Number(await rpc("getblockcount"));
  await expect.poll(async () => {
    const response = await fetch(`${ESPLORA_URL}/blocks/tip/height`);
    return response.ok ? Number(await response.text()) : -1;
  }).toBe(expected);
}
