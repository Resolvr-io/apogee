import { chromium, expect, test, type BrowserContext, type Page } from "@playwright/test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const EXTENSION_PATH = resolve("dist");
const PLAYGROUND_127 = "http://127.0.0.1:4173/";
const PLAYGROUND_LOCALHOST = "http://localhost:4173/";
const TEST_MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

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

    // getBalance is implemented, but account data remains unavailable until the
    // calling origin obtains an explicit connection grant.
    await page.getByRole("button", { name: "Get balance" }).click();
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
    const connectedAccount = await accountIdentifier(page);

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

    await page.getByRole("button", { name: "Disconnect" }).click();
    await expect(page.getByTestId("result")).toHaveText("null");
    await expect.poll(() => page.locator("body").getAttribute("data-connection")).toBe("disconnected");
    await expect(page.getByTestId("timeline")).toContainText("wallet_connectionChanged");

    await page.getByRole("button", { name: "Get connection" }).click();
    await expect(page.getByTestId("result")).toHaveText("null");
    await otherOrigin.close();
    await page.close();
  });
});

async function seedTestWallet(context: BrowserContext, extensionId: string): Promise<void> {
  const extensionPage = await context.newPage();
  await extensionPage.goto(`chrome-extension://${extensionId}/src/sidepanel/index.html`);
  const reply = await extensionPage.evaluate(
    async ({ mnemonic }) => {
      const extension = globalThis as typeof globalThis & {
        chrome: {
          runtime: {
            sendMessage(message: unknown): Promise<{ ok: boolean; error?: string }>;
          };
        };
      };
      return extension.chrome.runtime.sendMessage({
        type: "wallet/restore",
        password: "provider-test-password",
        mnemonic,
        label: "Provider conformance wallet",
        network: "liquidtestnet",
      });
    },
    { mnemonic: TEST_MNEMONIC },
  );
  expect(reply.ok, reply.error).toBe(true);
  await extensionPage.close();
}

async function accountIdentifier(page: Page): Promise<string> {
  const result = await page.getByTestId("result").textContent();
  const parsed = JSON.parse(result ?? "null") as { accountIdentifier?: unknown };
  expect(typeof parsed.accountIdentifier).toBe("string");
  return String(parsed.accountIdentifier);
}
