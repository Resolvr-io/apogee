// Passkey unlock, end to end, against Chrome's virtual authenticator
// (docs/passkey-unlock.md — the "Testing" short list). The virtual
// authenticator is created with resident keys + user verification + PRF, and
// auto-approves every ceremony, so the full PRF round-trip — enrollment,
// unlock, password change, second unlock — runs as a user would experience it.
//
// Requires a DEVELOPMENT build first (`pnpm build:dev` — the extension loads
// from dist/). No host permission is involved: ceremonies claim no RP ID, so
// credentials bind to the extension's own origin and there is nothing for a
// native permission dialog to ask about (docs/passkey-unlock.md §4) — which is
// also why this suite needs no permission-granting workaround.

import { chromium, expect, test, type BrowserContext, type CDPSession, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const EXTENSION_PATH = resolve("dist");
const PASSWORD = "correct horse battery staple";
const TEST_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

/** The published Chrome Web Store id. Passkeys bind to the extension's origin,
 *  so this string IS the relying party — see the manifest pin below. */
const STORE_EXTENSION_ID = "lbepaaibhmjmloagoggjhocdkelogamo";

/** Chrome's extension id: the first 128 bits of SHA-256 over the DER public
 *  key, hex digits mapped onto a–p. */
function extensionIdFor(base64Key: string): string {
  const digest = createHash("sha256").update(Buffer.from(base64Key, "base64")).digest("hex");
  return [...digest.slice(0, 32)]
    .map((c) => String.fromCharCode("a".charCodeAt(0) + parseInt(c, 16)))
    .join("");
}

// The single most destructive thing that can silently go wrong with this
// feature. Credentials are baked to the extension's origin, so if the store key
// is dropped or edited, a SHIPPED build loads under a different id and every
// enrolled passkey orphans — field-wide, permanently, with no way for users to
// clear the dead entries from their password manager (WebAuthn has no delete).
// Nothing else in this suite would notice: a fresh profile enrolls and unlocks
// perfectly well under the wrong id.
//
// Asserted against manifest.config.ts's SOURCE rather than the built manifest,
// because the key is deliberately absent from development builds (see the long
// comment there) and dist/ here is a dev build — reading the source is what
// makes a deleted key fail this suite anyway.
test("the store key still derives the published extension id", () => {
  const source = readFileSync(resolve("manifest.config.ts"), "utf8");
  const key = /key:\s*"([A-Za-z0-9+/=]+)"/.exec(source)?.[1];
  expect(key, "manifest.config.ts must still carry the store public key").toBeTruthy();
  expect(extensionIdFor(key!)).toBe(STORE_EXTENSION_ID);
});

test("a development build stays off the published identity, and claims no passkey domain", () => {
  const manifest = JSON.parse(readFileSync(resolve(EXTENSION_PATH, "manifest.json"), "utf8")) as {
    key?: string;
    host_permissions?: string[];
    optional_host_permissions?: string[];
  };
  // A dev build carrying the store key would load under the store id and so
  // share chrome.storage.local with the user's real installed wallet — where a
  // wallet/reset or a restore-with-test-mnemonic destroys real access.
  expect(manifest.key).toBeUndefined();
  // And the abandoned RP-ID design leaves nothing behind: a resolvr.io host
  // permission would mean someone reintroduced the domain claim that is
  // accepted and never dispatched from a side panel (docs/passkey-unlock.md §4).
  expect(manifest.optional_host_permissions ?? []).toEqual([]);
  expect((manifest.host_permissions ?? []).filter((h) => h.includes("resolvr.io"))).toEqual([]);
});

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

  test("vault becomes passkey-unlocked across locks with a wiped session, then removal", async () => {
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

    // No password-change leg here: this build exposes no such surface, so the
    // composed invariant — an enrolled passkey still opening the vault, cold,
    // after a changePassword — is pinned at the unit level instead
    // (keystore-passkey.test.ts, "a passkey enrolled before the change ...").

    // ---- second cycle, cold: wipe storage.session on top of the lock. The
    // MV3 equivalent of waking a service worker with nothing warm — lock()
    // already dropped the worker's in-memory DEK and its session copy, so the
    // only bridges left anywhere are the persisted slots, and this cycle's
    // whole job is opening on those alone (chrome.runtime.reload() is the
    // other route to this state, but it tears down the panel page AND the
    // virtual authenticator with it, so the session wipe stands in). ----
    await panel.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(panel.getByText("This device", { exact: true })).toBeVisible();
    await panel.getByRole("button", { name: "Close settings" }).click();
    await panel.getByRole("button", { name: "Lock", exact: true }).click();
    await expect(panel.getByRole("button", { name: "Unlock with passkey" })).toBeVisible({ timeout: 30_000 });
    await panel.evaluate(async () => {
      const ext = globalThis as unknown as {
        chrome: { storage: { session: { clear(): Promise<void> } } };
      };
      await ext.chrome.storage.session.clear();
    });
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

  // Regression: Settings enrolls through a hook instance of its own while the
  // home offer's instance keeps running underneath (neither unmounts). Before
  // the fix, coming back home still saw an empty list — offer on screen, and
  // clicking it ran a second ceremony that excludeCredentials rejects.
  test("enrolling in Settings leaves no stale offer on returning home", async () => {
    // Prior test ended locked, zero passkeys. Dismissal persists by design for
    // the life of a vault (a reset clears it — pinned in keystore-passkey.test.ts),
    // and no reset happened here, so clear the flag directly to make the offer
    // observable again.
    await panel.evaluate(async () => {
      const ext = globalThis as unknown as {
        chrome: { storage: { local: { remove(k: string): Promise<void> } } };
      };
      await ext.chrome.storage.local.remove("apogee:passkeyOfferDismissed");
    });
    await panel.reload();
    await panel.locator('input[type="password"]').fill(PASSWORD);
    await panel.getByRole("button", { name: "Unlock", exact: true }).click();
    const offer = panel.getByRole("button", { name: "Set up passkey" });
    await expect(offer).toBeVisible({ timeout: 60_000 });

    // Enroll from SETTINGS, not from the offer.
    await panel.getByRole("button", { name: "Settings", exact: true }).click();
    await panel.getByRole("button", { name: "Add passkey" }).click();
    await expect(panel.getByText("This device", { exact: true })).toBeVisible({ timeout: 30_000 });
    await panel.getByRole("button", { name: "Close settings" }).click();

    // Back home: one enrolled passkey means no offer, whatever the stale list said.
    await expect(offer).toBeHidden({ timeout: 15_000 });
  });
});
