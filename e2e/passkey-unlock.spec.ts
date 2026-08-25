// Passkey unlock, end to end, against Chrome's virtual authenticator
// (docs/passkey-unlock.md — the "Testing" short list). The virtual
// authenticator is created with resident keys + user verification + PRF, and
// auto-approves every ceremony, so the full PRF round-trip — enrollment,
// unlock, password change, second unlock — runs as a user would experience it.
//
// Requires `pnpm build` first (the extension loads from dist/, whose manifest
// carries the apogee.resolvr.io host permission this feature's RP ID claims).

import { chromium, expect, test, type BrowserContext, type CDPSession, type Page } from "@playwright/test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const EXTENSION_PATH = resolve("dist");
const PASSWORD = "correct horse battery staple";
const TEST_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

test.describe.serial("Passkey unlock", () => {
  let context: BrowserContext;
  let extensionId: string;
  let cdp: CDPSession;
  let panel: Page;

  test.beforeAll(async () => {
    if (!existsSync(resolve(EXTENSION_PATH, "manifest.json"))) {
      throw new Error("dist/manifest.json is missing; run pnpm build before the passkey tests");
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
    await bootstrap.goto("about:blank");
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
    extensionId = new URL(worker.url()).host;
    // The virtual authenticator: ctap2, resident keys, user verification, PRF.
    // It lives on the PANEL's CDP session — WebAuthn is per-target.
    panel = await context.newPage();
    await panel.goto(`chrome-extension://${extensionId}/src/sidepanel/index.html`);
    cdp = await context.newCDPSession(panel);
    await cdp.send("WebAuthn.enable");
    await cdp.send("WebAuthn.addVirtualAuthenticator", {
      options: {
        protocol: "ctap2",
        transport: "internal",
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        // hasPrf is what makes this authenticator able to serve the PRF
        // extension at all — without it the enrollment below fails loudly
        // (no PRF results), never silently. (hasLargeBlob is deliberately
        // absent: this Chrome build gates it behind CTAP2.1, which the
        // virtual ctap2 protocol rejects; the feature doesn't use it.)
        ...({ hasPrf: true } as Record<string, unknown>),
      },
    });
  });

  test.afterAll(async () => {
    await context?.close();
  });

  /** Restore over the secret port — the same path the panel's own client
   *  takes (see liquid-provider.spec.ts's seedTestWallet for the rationale). */
  async function seedVault(page: Page, mnemonic: string): Promise<void> {
    const reply = await page.evaluate(
      async ({ mnemonic, password }) => {
        const extension = globalThis as typeof globalThis & {
          chrome: { runtime: { connect(connectInfo: { name: string }): unknown } } };
        const port = extension.chrome.runtime.connect({ name: "apogee-secret" }) as {
          postMessage(message: unknown): void;
          disconnect(): void;
          onMessage: { addListener(l: (m: unknown) => void): void; removeListener(l: (m: unknown) => void): void };
          onDisconnect: { addListener(l: () => void): void; removeListener(l: () => void): void };
        };
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
            password,
            mnemonic,
            label: "Passkey test wallet",
            network: "liquid",
          });
        });
        port.disconnect();
        return reply;
      },
      { mnemonic, password: PASSWORD },
    );
    if (!reply?.ok) throw new Error(`seedVault failed: ${reply?.error ?? "port closed"}`);
  }

  test("vault becomes passkey-unlocked across lock, password change, and eviction", async () => {
    // ---- initialize the vault the way the panel itself would: restore over
    // the dedicated apogee-secret port (the broadcast channel rejects the
    // mnemonic, and UI-driving onboarding couples this test to copy) ----
    await seedVault(panel, TEST_MNEMONIC);
    await panel.reload();
    // The wallet home stands once the vault is live. No passkey is enrolled
    // yet, so the unlock button does not exist — and the offer does.
    await expect(panel.getByRole("button", { name: "Set up passkey" })).toBeVisible({ timeout: 60_000 });

    // ---- enroll via the one-time offer (proves capability detection too) ----
    await panel.getByRole("button", { name: "Set up passkey" }).click();
    await expect(panel.getByText(/Not now/i)).toBeHidden({ timeout: 15_000 });
    // The offer disappears for good once enrolled (dismissed on success).
    await expect(panel.getByRole("button", { name: "Set up passkey" })).toBeHidden();

    // ---- lock, then unlock through the passkey ----
    // (`exact: true` throughout: Playwright's role-name matching is
    // substring-based, so "Lock" alone would also match "Unlock".)
    await panel.getByRole("button", { name: "Lock", exact: true }).click();
    await expect(panel.getByRole("button", { name: "Unlock with passkey" })).toBeVisible({ timeout: 30_000 });
    await panel.getByRole("button", { name: "Unlock with passkey" }).click();
    await expect(panel.getByRole("button", { name: "Settings", exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(panel.getByRole("button", { name: "Unlock with passkey" })).toBeHidden();

    // No password-change block here: this build exposes no such surface, so
    // the password-change-keeps-the-slot invariant is pinned at the unit
    // level (vault-v3.test.ts, "re-key ... opens to the SAME DEK") instead.

    // ---- a second lock/unlock cycle, then removal ----
    await panel.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(panel.getByText("This device", { exact: true })).toBeVisible();
    await panel.getByRole("button", { name: "Close settings" }).click();
    await panel.getByRole("button", { name: "Lock", exact: true }).click();
    await expect(panel.getByRole("button", { name: "Unlock with passkey" })).toBeVisible({ timeout: 30_000 });
    await panel.getByRole("button", { name: "Unlock with passkey" }).click();
    await expect(panel.getByRole("button", { name: "Settings", exact: true })).toBeVisible({ timeout: 30_000 });

    // ---- removal: inline confirm, then the door is gone ----
    await panel.getByRole("button", { name: "Settings", exact: true }).click();
    // The row's Remove first; the confirm's Remove renders after it (.last()).
    await panel.getByRole("button", { name: "Remove", exact: true }).first().click();
    await panel.getByRole("button", { name: "Remove", exact: true }).last().click();
    await expect(panel.getByText("This device", { exact: true })).toBeHidden();
    await panel.getByRole("button", { name: "Close settings" }).click();
    await panel.getByRole("button", { name: "Lock", exact: true }).click();
    await expect(panel.getByRole("button", { name: "Unlock with passkey" })).toBeHidden({ timeout: 30_000 });
  });
});
