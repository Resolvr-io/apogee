// Multiple passkeys, multiple devices — the slot model's whole point, driven
// against TWO distinct virtual authenticators (docs/passkey-unlock.md §2).
//
// Why a separate spec from passkey-unlock.spec.ts: that one proves the PRF
// round-trip through a single platform authenticator. This one proves the
// property a second device actually depends on — that enrolling passkey #2
// leaves passkey #1 opening the vault, that either one alone suffices, and
// that removing one is not removing the other. Those are four different ways
// the slot array can be got wrong, and none of them are visible with one
// authenticator on the bench.
//
// The two authenticators stand in for two real devices: an `internal` platform
// one (this machine's biometric) and a `usb` cross-platform one (a security
// key, which is also the closest a virtual authenticator gets to a phone —
// Chrome has no virtual hybrid transport). They differ in credential store,
// which is exactly what makes them two devices rather than one.
//
// Steering which one answers: both stay registered the whole run (a removed
// virtual authenticator loses its PRF secret, so its credential can never be
// re-injected and slot #1 would fail for a reason that has nothing to do with
// the code). Instead `WebAuthn.setAutomaticPresenceSimulation` mutes one at a
// time, so every ceremony below has exactly one authenticator willing to
// answer it and the dispatch is never a coin flip.
//
// Requires a DEVELOPMENT build first (`pnpm build:dev`) — see the note atop
// passkey-unlock.spec.ts about the RP host permission.

import { chromium, expect, test, type BrowserContext, type CDPSession, type Page } from "@playwright/test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const EXTENSION_PATH = resolve("dist");
const PASSWORD = "correct horse battery staple";
const TEST_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

/** Everything a PRF-serving virtual authenticator needs; the two below differ
 *  only in transport, so the delta under test is the credential store and not
 *  some capability asymmetry. (`hasPrf` is the field that makes PRF available
 *  at all; `hasLargeBlob` is deliberately absent — this Chrome gates it behind
 *  CTAP2.1, which the virtual ctap2 protocol rejects.) */
function authenticatorOptions(transport: "internal" | "usb") {
  return {
    protocol: "ctap2" as const,
    transport,
    hasResidentKey: true,
    hasUserVerification: true,
    isUserVerified: true,
    ...({ hasPrf: true } as Record<string, unknown>),
  };
}

test.describe.serial("Passkeys from more than one device", () => {
  let context: BrowserContext;
  let extensionId: string;
  let cdp: CDPSession;
  let panel: Page;
  /** The platform authenticator — "this device". */
  let deviceAuth: string;
  /** The cross-platform one — a security key, standing in for a second device. */
  let keyAuth: string;
  /** Each device's credential id, captured as it is minted and carried into
   *  the removal test below (serial describe, one vault throughout). */
  let deviceIds: string[] = [];
  let keyIds: string[] = [];

  test.beforeAll(async () => {
    if (!existsSync(resolve(EXTENSION_PATH, "manifest.json"))) {
      throw new Error("dist/manifest.json is missing; run pnpm build:dev before the passkey tests");
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
    panel = await context.newPage();
    await panel.goto(`chrome-extension://${extensionId}/src/sidepanel/index.html`);
    // WebAuthn is per-target, so the authenticators live on the PANEL's session.
    cdp = await context.newCDPSession(panel);
    await cdp.send("WebAuthn.enable");
    deviceAuth = (
      await cdp.send("WebAuthn.addVirtualAuthenticator", {
        options: authenticatorOptions("internal"),
      })
    ).authenticatorId;
    keyAuth = (
      await cdp.send("WebAuthn.addVirtualAuthenticator", {
        options: authenticatorOptions("usb"),
      })
    ).authenticatorId;
  });

  test.afterAll(async () => {
    await context?.close();
  });

  /** Mute every authenticator but one, so the next ceremony has a single
   *  possible responder. Presence simulation off means that authenticator
   *  never completes the request rather than declining it — which is why the
   *  ceremonies carry a timeout (see passkey-ceremony.ts). */
  async function onlyAuthenticator(keep: string): Promise<void> {
    for (const authenticatorId of [deviceAuth, keyAuth]) {
      await cdp.send("WebAuthn.setAutomaticPresenceSimulation", {
        authenticatorId,
        enabled: authenticatorId === keep,
      });
    }
  }

  /** Which credentials this authenticator holds, in the vault's spelling —
   *  CDP hands back padded base64, the slots store base64URL. This is the
   *  ground truth for "the ceremony really went to the device the test meant",
   *  and for which slot a removal actually took. */
  async function credentialIdsOn(authenticatorId: string): Promise<string[]> {
    const { credentials } = await cdp.send("WebAuthn.getCredentials", { authenticatorId });
    return credentials.map((c) =>
      c.credentialId.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
    );
  }

  /** The vault's own answer to "which passkeys open me" — the same call the
   *  unlock screen makes, read straight out of the panel. Comparing this
   *  against credentialIdsOn() is what makes the assertions below about
   *  WHICH device is enrolled, not merely how many. */
  async function enrolledCredentials(): Promise<{ id: string; transports?: string[] }[]> {
    const challenge = await panel.evaluate(async () => {
      const ext = globalThis as unknown as {
        chrome: { runtime: { sendMessage(m: unknown): Promise<unknown> } };
      };
      return (await ext.chrome.runtime.sendMessage({ type: "wallet/passkeyChallenge" })) as {
        ok: boolean;
        value: { credentials: { id: string; transports?: string[] }[]; prfSalt: string } | null;
      };
    });
    return challenge?.value?.credentials ?? [];
  }

  async function enrolledCredentialIds(): Promise<string[]> {
    return (await enrolledCredentials()).map((c) => c.id);
  }

  /** Let every authenticator answer. Used for the "Another device" leg, where
   *  the POINT is that the request steers itself: the ceremony pins
   *  cross-platform, so the platform authenticator is ineligible and the
   *  credential can only land on the security key. Muting one would hide
   *  exactly the behavior under test. */
  async function allAuthenticators(): Promise<void> {
    for (const authenticatorId of [deviceAuth, keyAuth]) {
      await cdp.send("WebAuthn.setAutomaticPresenceSimulation", {
        authenticatorId,
        enabled: true,
      });
    }
  }

  /** Restore over the secret port — same path as passkey-unlock.spec.ts. */
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
            label: "Passkey multi-device wallet",
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

  async function openSettings(): Promise<void> {
    await panel.getByRole("button", { name: "Settings", exact: true }).click();
  }
  async function closeSettings(): Promise<void> {
    await panel.getByRole("button", { name: "Close settings" }).click();
  }

  test("two devices enroll into two slots, and either one alone unlocks", async () => {
    await seedVault(panel, TEST_MNEMONIC);
    await panel.reload();
    await expect(panel.getByRole("button", { name: "Set up passkey" })).toBeVisible({ timeout: 60_000 });

    // ---- device #1: the platform authenticator, enrolled from the offer ----
    await onlyAuthenticator(deviceAuth);
    await panel.getByRole("button", { name: "Set up passkey" }).click();
    await expect(panel.getByRole("button", { name: "Set up passkey" })).toBeHidden({ timeout: 30_000 });
    deviceIds = await credentialIdsOn(deviceAuth);
    expect(deviceIds).toHaveLength(1);
    expect(await credentialIdsOn(keyAuth)).toHaveLength(0);
    expect(await enrolledCredentialIds()).toEqual(deviceIds);

    // ---- device #2, through the "Another device" entry, with BOTH
    // authenticators live. The ceremony pins cross-platform, so the platform
    // one is ineligible and the credential can only land on the security key —
    // which is the steering that makes a second device reachable at all on a
    // machine whose platform authenticator already holds a passkey for this
    // vault. This is also the leg that fails if enrollment #2 re-mints the
    // vault salt, excludes the wrong credentials, or wraps under a DEK the
    // first slot no longer matches. ----
    await allAuthenticators();
    await openSettings();
    await expect(panel.getByText("This device", { exact: true })).toBeVisible();
    await panel.getByRole("button", { name: "Another device" }).click();
    await expect(panel.getByText("Security key", { exact: true })).toBeVisible({ timeout: 30_000 });
    // Both rows stand: two slots, not one replaced.
    await expect(panel.getByText("This device", { exact: true })).toBeVisible();
    keyIds = await credentialIdsOn(keyAuth);
    expect(keyIds).toHaveLength(1);
    expect(await credentialIdsOn(deviceAuth)).toEqual(deviceIds);
    // Both devices' credentials, and only those, are what the vault now opens
    // for — the slot array tracks the authenticators one-to-one.
    expect([...(await enrolledCredentialIds())].sort()).toEqual([...deviceIds, ...keyIds].sort());
    // Each slot carries the transports its own authenticator reported, which
    // is what a later ceremony needs to reach that device again.
    const byId = new Map((await enrolledCredentials()).map((c) => [c.id, c.transports]));
    expect(byId.get(deviceIds[0])).toEqual(["internal"]);
    expect(byId.get(keyIds[0])).toEqual(["usb"]);
    await closeSettings();

    // ---- slot #1 still opens the vault, cold, now that slot #2 exists ----
    await panel.getByRole("button", { name: "Lock", exact: true }).click();
    await expect(panel.getByRole("button", { name: "Unlock with passkey" })).toBeVisible({ timeout: 30_000 });
    await onlyAuthenticator(deviceAuth);
    await panel.getByRole("button", { name: "Unlock with passkey" }).click();
    await expect(panel.getByRole("button", { name: "Settings", exact: true })).toBeVisible({ timeout: 30_000 });

    // ---- and so does slot #2, on its own, from a wiped session ----
    await panel.getByRole("button", { name: "Lock", exact: true }).click();
    await expect(panel.getByRole("button", { name: "Unlock with passkey" })).toBeVisible({ timeout: 30_000 });
    await panel.evaluate(async () => {
      const ext = globalThis as unknown as {
        chrome: { storage: { session: { clear(): Promise<void> } } };
      };
      await ext.chrome.storage.session.clear();
    });
    await onlyAuthenticator(keyAuth);
    await panel.getByRole("button", { name: "Unlock with passkey" }).click();
    await expect(panel.getByRole("button", { name: "Settings", exact: true })).toBeVisible({ timeout: 30_000 });
  });

  test("re-enrolling the same device is refused, and points at the other route", async () => {
    // The dead end that made a second device unreachable: this authenticator
    // already holds the vault's passkey, so excludeCredentials refuses it.
    // What matters is that the user is told where to go instead of being left
    // with a spinner or a bare DOMException name.
    await onlyAuthenticator(deviceAuth);
    await openSettings();
    await panel.getByRole("button", { name: "Add passkey" }).click();
    // Loose on wording, strict on the thing that matters: the refusal has to
    // name the route that actually works, or the user is back at a dead end.
    await expect(panel.getByText(/Use .Another device./)).toBeVisible({ timeout: 30_000 });
    // Nothing was added, and nothing was lost.
    expect(await enrolledCredentialIds()).toHaveLength(2);
    expect(await credentialIdsOn(deviceAuth)).toEqual(deviceIds);
    await closeSettings();
  });

  test("removing one device's passkey leaves the other one opening the vault", async () => {
    await openSettings();
    // Remove the security key's row specifically — with two rows on screen,
    // the wrong slot going is exactly the bug this leg is here to catch.
    const keyRow = panel.locator("div", { has: panel.getByText("Security key", { exact: true }) }).last();
    await keyRow.getByRole("button", { name: "Remove", exact: true }).click();
    await panel.getByRole("button", { name: "Remove", exact: true }).last().click();
    await expect(panel.getByText("Security key", { exact: true })).toBeHidden({ timeout: 15_000 });
    await expect(panel.getByText("This device", { exact: true })).toBeVisible();
    // Precisely the security key's slot went, and precisely the platform one
    // stayed — "one row disappeared" alone would also pass if removal took the
    // wrong slot and the labels happened to line up.
    expect(await enrolledCredentialIds()).toEqual(deviceIds);
    await closeSettings();

    // The platform passkey — untouched by the removal — still opens the vault.
    await panel.getByRole("button", { name: "Lock", exact: true }).click();
    await expect(panel.getByRole("button", { name: "Unlock with passkey" })).toBeVisible({ timeout: 30_000 });
    await onlyAuthenticator(deviceAuth);
    await panel.getByRole("button", { name: "Unlock with passkey" }).click();
    await expect(panel.getByRole("button", { name: "Settings", exact: true })).toBeVisible({ timeout: 30_000 });

    // The removed device is now refused: its credential still exists in the
    // authenticator (WebAuthn has no delete), but no slot answers to it.
    await panel.getByRole("button", { name: "Lock", exact: true }).click();
    await expect(panel.getByRole("button", { name: "Unlock with passkey" })).toBeVisible({ timeout: 30_000 });
    await onlyAuthenticator(keyAuth);
    await panel.getByRole("button", { name: "Unlock with passkey" }).click();
    // Still locked: the vault does not open for a device it no longer knows.
    // (The refusal reads as a cancelled prompt rather than an error, because
    // the removed credential is not in allowCredentials at all — the
    // authenticator is never asked, so there is nothing to report.)
    await expect(panel.getByRole("button", { name: "Unlock with passkey" })).toBeVisible({ timeout: 30_000 });
    await expect(panel.getByRole("button", { name: "Settings", exact: true })).toBeHidden();
    // The credential itself is still sitting in the authenticator — WebAuthn
    // has no delete, and the Settings copy promises exactly that.
    expect(await credentialIdsOn(keyAuth)).toEqual(keyIds);
  });
});
