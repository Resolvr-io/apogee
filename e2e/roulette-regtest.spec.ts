import { chromium, expect, test, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const EXTENSION_PATH = resolve(
  process.env.ROULETTE_REGTEST_EXTENSION_PATH ?? "dist-roulette-regtest",
);
const PLAYER_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const HOUSE_MNEMONIC =
  "legal winner thank year wave sausage worth useful legal winner thank yellow";
const ROULETTE_BUNDLE_HASH =
  "sha256:26f77f6f984ebcdccfb96a626285858fb7bdcb0bfa290ba59f6cee57573c4830";
const ACTIONS = {
  open: "roulette_vault.Open",
  take: "roulette_vault.Take",
  settle: "roulette_vault.Settle",
  cancel: "roulette_vault.Cancel",
  forfeit: "roulette_vault.Forfeit",
  claim: "roulette_vault.ClaimPayout",
} as const;

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required; run pnpm test:roulette:regtest`);
  return value;
}

const DAPP_URL = requiredEnv("ROULETTE_REGTEST_DAPP_URL");
const API_URL = requiredEnv("ROULETTE_REGTEST_API_URL");
const ESPLORA_URL = requiredEnv("ROULETTE_REGTEST_ESPLORA_URL");
const APOGEE_ESPLORA_URL = requiredEnv("ROULETTE_REGTEST_APOGEE_ESPLORA_URL");
const RPC_URL = requiredEnv("ROULETTE_REGTEST_RPC_URL");
const RPC_USER = requiredEnv("ROULETTE_REGTEST_RPC_USER");
const RPC_PASSWORD = requiredEnv("ROULETTE_REGTEST_RPC_PASSWORD");
const MINER_ADDRESS = requiredEnv("ROULETTE_REGTEST_MINER_ADDRESS");

type WalletHistoryRecord = {
  txid: string;
  txManifest?: {
    status: "verified" | "unsupported" | "unverified";
    bundleHash?: string;
    action?: string;
  };
};

type ActionRecord = {
  txid: string;
  roundId: string;
  action: (typeof ACTIONS)[keyof typeof ACTIONS];
  actionCode: number;
  owner: "player" | "house";
};

type OpenMarker = {
  roundId: string;
  assetId: string;
  playerPayoutScript: string;
  secretCommitment: string;
  betKind: number;
  betSelection: number;
  stake: string;
  bond: string;
  openExpiry: number;
  minRevealAge: number;
  revealExpiry: number;
  covenantVout: number;
};

test("funded wallets execute OPEN, TAKE, SETTLE, CANCEL, FORFEIT and ClaimPayout", async () => {
  if (!existsSync(resolve(EXTENSION_PATH, "manifest.json"))) {
    throw new Error("The roulette regtest extension build is missing; run pnpm test:roulette:regtest");
  }

  const playerContext = await launchExtensionContext();
  let houseContext: BrowserContext | undefined;
  try {
    const playerExtensionId = await extensionIdentity(playerContext);
    const playerAddress = await seedRegtestWallet(
      playerContext,
      playerExtensionId,
      PLAYER_MNEMONIC,
      "player",
    );
    houseContext = await launchExtensionContext();
    const houseExtensionId = await extensionIdentity(houseContext);
    const houseAddress = await seedRegtestWallet(
      houseContext,
      houseExtensionId,
      HOUSE_MNEMONIC,
      "house",
    );
    await sendFragments(playerAddress, [0.01, 0.01, 0.01, 0.01]);
    await sendFragments(houseAddress, [0.01, 0.01, 0.01, 0.01]);
    await mineBlocks(1);
    await waitForEsploraTip();

    const playerPage = await connectRouletteDapp(playerContext);
    const housePage = await connectRouletteDapp(houseContext);
    const records: ActionRecord[] = [];
    const onlyForfeit = process.env.ROULETTE_REGTEST_ONLY === "forfeit";

    // Normal path: player OPEN, house TAKE, player SETTLE, then reblind the
    // player's explicit terminal output with the adapter-only ClaimPayout.
    if (!onlyForfeit) {
      const firstOpen = await createOpen(playerPage, playerContext);
      records.push({ ...firstOpen, action: ACTIONS.open, actionCode: 0, owner: "player" });
      await confirmAndWait(firstOpen.roundId, "OPEN", firstOpen.txid);
      const firstTerms = await openMarker(firstOpen.txid);

      const firstTake = await takeOpen(housePage, houseContext, firstOpen.roundId);
      records.push({ ...firstTake, action: ACTIONS.take, actionCode: 1, owner: "house" });
      await confirmAndWait(firstOpen.roundId, "ACTIVE", firstTake.txid);
      // Mine beyond the relative-lock boundary. The manifest unit tests pin the
      // exact BIP68 sequence; this funded browser test leaves one synchronization
      // block so Elements and electrs cannot briefly disagree at the boundary.
      await mineBlocks(firstTerms.minRevealAge + 1);
      await waitForEsploraTip();
      await waitForApiTip();

      const settle = await roundAction(
        playerPage,
        playerContext,
        firstOpen.roundId,
        "Reveal & Spin",
        "Settle roulette spin",
      );
      records.push({ ...settle, action: ACTIONS.settle, actionCode: 2, owner: "player" });
      await confirmAndWait(firstOpen.roundId, "SETTLED", settle.txid);

      const claim = await roundAction(
        playerPage,
        playerContext,
        firstOpen.roundId,
        "Secure payout in wallet",
        "Secure roulette payout",
      );
      records.push({ ...claim, action: ACTIONS.claim, actionCode: 5, owner: "player" });
      await confirmTransaction(claim.txid);
      await waitForEsploraTip();

      // Untaken timeout path.
      const cancelOpen = await createOpen(playerPage, playerContext);
      records.push({ ...cancelOpen, action: ACTIONS.open, actionCode: 0, owner: "player" });
      await confirmAndWait(cancelOpen.roundId, "OPEN", cancelOpen.txid);
      const cancelTerms = await openMarker(cancelOpen.txid);
      await mineBlocks(cancelTerms.openExpiry + 1);
      await waitForEsploraTip();
      await waitForApiTip();
      const cancel = await roundAction(
        playerPage,
        playerContext,
        cancelOpen.roundId,
        "Reclaim untaken bet",
        "Cancel untaken bet",
      );
      records.push({ ...cancel, action: ACTIONS.cancel, actionCode: 3, owner: "player" });
      await confirmAndWait(cancelOpen.roundId, "CANCELED", cancel.txid);
    }

    // Unrevealed ACTIVE timeout path.
    const forfeitOpen = await createOpen(playerPage, playerContext);
    records.push({ ...forfeitOpen, action: ACTIONS.open, actionCode: 0, owner: "player" });
    await confirmAndWait(forfeitOpen.roundId, "OPEN", forfeitOpen.txid);
    const forfeitTerms = await openMarker(forfeitOpen.txid);
    const forfeitTake = await takeOpen(housePage, houseContext, forfeitOpen.roundId);
    records.push({ ...forfeitTake, action: ACTIONS.take, actionCode: 1, owner: "house" });
    await confirmAndWait(forfeitOpen.roundId, "ACTIVE", forfeitTake.txid);
    await mineBlocks(forfeitTerms.revealExpiry + 1);
    await waitForEsploraTip();
    await waitForApiTip();
    const forfeit = await roundAction(
      housePage,
      houseContext,
      forfeitOpen.roundId,
      "Claim player forfeit",
      "Forfeit unrevealed bet",
    );
    records.push({ ...forfeit, action: ACTIONS.forfeit, actionCode: 4, owner: "house" });
    await confirmAndWait(forfeitOpen.roundId, "FORFEITED", forfeit.txid);

    expect(records.map(({ actionCode }) => actionCode)).toEqual(
      onlyForfeit ? [0, 1, 4] : [0, 1, 2, 5, 0, 3, 0, 1, 4],
    );
    for (const record of records) {
      const marker = await rouletteMarker(record.txid);
      expect(marker).toMatchObject({ roundId: record.roundId, actionCode: record.actionCode });
    }

    let histories: Record<"player" | "house", WalletHistoryRecord[]> = { player: [], house: [] };
    await expect.poll(async () => {
      const [player, house] = await Promise.all([
        walletTransactions(playerContext, playerExtensionId),
        walletTransactions(houseContext!, houseExtensionId),
      ]);
      histories = { player, house };
      return records.map((record) =>
        Boolean(histories[record.owner].find(({ txid }) => txid === record.txid)?.txManifest)
      );
    }, { timeout: 30_000 }).toEqual(records.map(() => true));
    for (const record of records) {
      expect(histories[record.owner].find(({ txid }) => txid === record.txid)?.txManifest).toMatchObject({
        status: "verified",
        bundleHash: ROULETTE_BUNDLE_HASH,
        action: record.action,
      });
    }
  } finally {
    await houseContext?.close();
    await playerContext.close();
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

async function extensionIdentity(context: BrowserContext): Promise<string> {
  const bootstrap = await context.newPage();
  await bootstrap.goto(DAPP_URL);
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker", {
    timeout: 30_000,
  });
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
  const result = await extensionPage.evaluate(async ({ mnemonic, esploraUrl, role }) => {
    const extension = globalThis as typeof globalThis & {
      chrome: {
        runtime: {
          sendMessage(message: unknown): Promise<{ ok: boolean; value?: unknown; error?: string }>;
          connect(connectInfo: { name: string }): {
            postMessage(message: unknown): void;
            disconnect(): void;
            onMessage: { addListener(listener: (message: unknown) => void): void; removeListener(listener: (message: unknown) => void): void };
            onDisconnect: { addListener(listener: () => void): void; removeListener(listener: () => void): void };
          };
        };
      };
    };
    const send = async (message: unknown) => {
      const reply = await extension.chrome.runtime.sendMessage(message);
      if (!reply.ok) throw new Error(reply.error ?? "Apogee request failed");
      return reply.value;
    };
    const port = extension.chrome.runtime.connect({ name: "apogee-secret" });
    const restored = await new Promise<{ ok: boolean; error?: string } | null>((resolveReply) => {
      const done = (reply: { ok: boolean; error?: string } | null) => {
        port.onMessage.removeListener(onMessage);
        port.onDisconnect.removeListener(onDisconnect);
        resolveReply(reply);
      };
      const onMessage = (reply: unknown) => done(reply as { ok: boolean; error?: string });
      const onDisconnect = () => done(null);
      port.onMessage.addListener(onMessage);
      port.onDisconnect.addListener(onDisconnect);
      port.postMessage({
        type: "wallet/restore",
        password: "roulette-regtest-password",
        mnemonic,
        label: `Roulette regtest ${role}`,
        network: "regtest",
      });
    });
    port.disconnect();
    if (!restored?.ok) throw new Error(restored?.error ?? "Apogee restore failed");
    await send({ type: "wallet/setChainServer", network: "regtest", url: esploraUrl });
    return await send({ type: "wallet/getAddress" }) as { address: string };
  }, { mnemonic, esploraUrl: APOGEE_ESPLORA_URL, role });
  await extensionPage.close();
  return result.address;
}

async function connectRouletteDapp(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  await page.goto(DAPP_URL);
  const protocol = await api<{ chainId: string }>("/protocol");
  await expect.poll(async () => {
    const support = await discoveredProviderRequest(page, {
      method: "experimental_getTxManifestSupport",
      params: { bundleHash: ROULETTE_BUNDLE_HASH },
    }) as { supported?: unknown };
    return support.supported;
  }).toBe(true);
  const approvalPromise = approvalPage(context);
  const connectionRequest = discoveredProviderRequest(page, {
    method: "wallet_connect",
    params: {
      chains: [protocol.chainId],
      methods: ["experimental_executeTxManifest", "getBalance"],
      events: [],
    },
  });
  const approval = await approvalPromise;
  await expect(approval.getByText("Execute contracts", { exact: true })).toBeVisible();
  await approval.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(connectionRequest).resolves.toMatchObject({ chainId: protocol.chainId });
  await page.reload();
  await expect.poll(async () => {
    const connection = await discoveredProviderRequest(page, { method: "wallet_getConnection" }) as { chainId?: unknown } | null;
    return connection?.chainId;
  }).toBe(protocol.chainId);
  return page;
}

async function createOpen(page: Page, context: BrowserContext): Promise<{ txid: string; roundId: string }> {
  await page.reload();
  await clickNav(page, "Create bet");
  await page.getByRole("button", { name: /Straight 17, pays 35 to 1/ }).click();
  const txid = await executeAction(
    context,
    page.getByRole("button", { name: /Publish open bet/ }),
    "Open roulette bet",
  );
  return { txid, roundId: (await rouletteMarker(txid)).roundId };
}

async function takeOpen(
  page: Page,
  context: BrowserContext,
  roundId: string,
): Promise<{ txid: string; roundId: string }> {
  await page.reload();
  await clickNav(page, "Open bets");
  const card = await offerCard(page, roundId);
  const txid = await executeAction(
    context,
    card.getByRole("button", { name: /Cover 3,500/ }),
    "Take roulette bet",
  );
  return { txid, roundId };
}

async function roundAction(
  page: Page,
  context: BrowserContext,
  roundId: string,
  buttonName: string,
  approvalLabel: string,
): Promise<{ txid: string; roundId: string }> {
  await page.reload();
  await clickNav(page, "My rounds");
  const row = await roundRow(page, roundId);
  const txid = await executeAction(
    context,
    row.getByRole("button", { name: buttonName, exact: true }),
    approvalLabel,
  );
  return { txid, roundId };
}

async function offerCard(page: Page, roundId: string): Promise<Locator> {
  const card = page.locator("article.offer-card").filter({
    has: page.locator(`code[title="${roundId}"]`),
  });
  await expect(card).toBeVisible();
  return card;
}

async function roundRow(page: Page, roundId: string): Promise<Locator> {
  const row = page.locator("article.round-row").filter({
    has: page.locator(`code[title="${roundId}"]`),
  });
  await expect(row).toBeVisible();
  return row;
}

async function clickNav(page: Page, label: string): Promise<void> {
  const clicked = await page.evaluate((expected) => {
    const browserGlobal = globalThis as typeof globalThis & {
      document: {
        querySelectorAll(selector: string): ArrayLike<{
          textContent: string | null;
          click(): void;
        }>;
      };
    };
    const button = Array.from(browserGlobal.document.querySelectorAll("button"))
      .find((candidate) => candidate.textContent?.trim().startsWith(expected));
    button?.click();
    return button !== undefined;
  }, label);
  if (!clicked) throw new Error(`Roulette navigation tab ${label} is missing.`);
}

async function executeAction(
  context: BrowserContext,
  button: Locator,
  approvalLabel: string,
  reviewAttempt = 0,
): Promise<string> {
  await expect(button).toBeEnabled();
  expect(await mempoolTxids()).toEqual([]);
  const page = button.page();
  const previousBroadcasts = await manifestBroadcastTxids(page);
  const approvalPromise = approvalPage(context);
  await button.click();
  const approval = await approvalPromise;
  await expect(approval.getByText(approvalLabel, { exact: true })).toBeVisible();
  await approval.getByRole("button", { name: "Approve & execute" }).click();
  const approvalError = await Promise.race([
    approval.waitForEvent("close", { timeout: 45_000 }).then(() => null),
    approval.getByRole("alert").waitFor({ state: "visible", timeout: 45_000 })
      .then(() => approval.getByRole("alert").innerText()),
  ]);
  if (approvalError) {
    await approval.close();
    if (
      reviewAttempt === 0 &&
      approvalError === "Network fees or wallet state changed. Review the TX Manifest request again."
    ) {
      // A just-confirmed prior action can settle into LWK between preview and
      // the approval-time refresh. Apogee correctly refuses to sign the changed
      // plan; the dapp's durable journal replays the exact invocation for a new
      // review rather than silently accepting different inputs or fees.
      console.log(`[roulette-regtest] ${approvalLabel} requires one refreshed review`);
      await expect(button).toBeEnabled();
      return executeAction(context, button, approvalLabel, reviewAttempt + 1);
    }
    throw new Error(`Apogee approval failed: ${approvalError}`);
  }
  let txid: string | null = null;
  await expect.poll(async () => {
    txid = (await manifestBroadcastTxids(page)).find((candidate) => !previousBroadcasts.includes(candidate)) ?? null;
    return txid;
  }, { timeout: 30_000 }).not.toBeNull();
  expect(txid).toMatch(/^[0-9a-f]{64}$/);
  await expect.poll(() => transactionIsChainVisible(txid!), { timeout: 120_000 }).toBe(true);
  await ensureMinerKnowsTransaction(txid!);
  return txid!;
}

async function manifestBroadcastTxids(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const entries: Array<{ txid: string; updatedAt: number }> = [];
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (!key?.startsWith("simplicity-roulette:manifest-attempt:v1:")) continue;
      try {
        const value = JSON.parse(localStorage.getItem(key) ?? "null") as {
          state?: unknown;
          txid?: unknown;
          updatedAt?: unknown;
        } | null;
        if (
          value?.state === "BROADCAST" &&
          typeof value.txid === "string" &&
          /^[0-9a-f]{64}$/.test(value.txid) &&
          typeof value.updatedAt === "number"
        ) {
          entries.push({ txid: value.txid, updatedAt: value.updatedAt });
        }
      } catch {
        // A foreign local-storage record cannot become a roulette result.
      }
    }
    return entries.sort((left, right) => right.updatedAt - left.updatedAt).map(({ txid }) => txid);
  });
}

async function transactionIsChainVisible(txid: string): Promise<boolean> {
  if ((await mempoolTxids()).includes(txid)) return true;
  const response = await fetch(`${ESPLORA_URL}/tx/${txid}/hex`, {
    headers: { "cache-control": "no-cache" },
  });
  if (!response.ok) return false;
  const transactionHex = (await response.text()).trim();
  return transactionHex.length > 0 && transactionHex.length % 2 === 0 && /^[0-9a-f]+$/.test(transactionHex);
}

function approvalPage(context: BrowserContext) {
  return context.waitForEvent("page", {
    predicate: (candidate) => candidate.url().includes("/src/prompt/prompt.html"),
    timeout: 30_000,
  });
}

async function discoveredProviderRequest(page: Page, request: unknown) {
  return page.evaluate(async (providerRequest) => {
    const browserWindow = globalThis as typeof globalThis & {
      addEventListener(type: string, listener: (event: Event) => void): void;
      removeEventListener(type: string, listener: (event: Event) => void): void;
      dispatchEvent(event: Event): boolean;
    };
    const announced = new Promise<{ provider: { request(args: unknown): Promise<unknown> } }>((resolveProvider) => {
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

async function walletTransactions(
  context: BrowserContext,
  extensionId: string,
): Promise<WalletHistoryRecord[]> {
  const extensionPage = await context.newPage();
  await extensionPage.goto(`chrome-extension://${extensionId}/src/sidepanel/index.html`);
  const records = await extensionPage.evaluate(async () => {
    const extension = globalThis as typeof globalThis & {
      chrome: { runtime: { sendMessage(message: unknown): Promise<{ ok: boolean; value?: unknown; error?: string }> } };
    };
    const send = async (message: unknown) => {
      const reply = await extension.chrome.runtime.sendMessage(message);
      if (!reply.ok) throw new Error(reply.error ?? "Apogee request failed");
      return reply.value;
    };
    await send({ type: "wallet/sync" });
    return await send({ type: "wallet/getTransactions" });
  }) as WalletHistoryRecord[];
  await extensionPage.close();
  return records;
}

async function confirmAndWait(roundId: string, phase: string, txid: string): Promise<void> {
  await confirmTransaction(txid);
  await waitForEsploraTip();
  if (phase === "OPEN") {
    await registerOpen(txid);
  }
  await waitForOfferPhase(roundId, phase);
  console.log(`[roulette-regtest] ${phase} verified for ${roundId.slice(0, 12)}…`);
}

async function confirmTransaction(txid: string): Promise<void> {
  await ensureMinerKnowsTransaction(txid);
  if (!(await rpcTransactionIsConfirmed(txid))) await mineBlocks(1);
  await expect.poll(() => rpcTransactionIsConfirmed(txid), { timeout: 30_000 }).toBe(true);
}

async function ensureMinerKnowsTransaction(txid: string): Promise<void> {
  if (await rpcTransactionIsVisible(txid)) return;

  let transactionHex = "";
  await expect.poll(async () => {
    const response = await fetch(`${ESPLORA_URL}/tx/${txid}/hex`, {
      headers: { "cache-control": "no-cache" },
    });
    transactionHex = response.ok ? (await response.text()).trim() : "";
    return transactionHex;
  }, { timeout: 30_000 }).toMatch(/^[0-9a-f]+$/);

  try {
    await rpc("sendrawtransaction", [transactionHex]);
  } catch (error) {
    // A propagation race can make the node learn the transaction between the
    // visibility check and this deterministic re-broadcast. Only tolerate the
    // RPC error if the exact transaction is now available to the miner.
    if (!(await rpcTransactionIsVisible(txid))) throw error;
  }
  await expect.poll(() => rpcTransactionIsVisible(txid), { timeout: 30_000 }).toBe(true);
}

async function rpcTransactionIsVisible(txid: string): Promise<boolean> {
  try {
    await rpc("getrawtransaction", [txid, true]);
    return true;
  } catch {
    return false;
  }
}

async function rpcTransactionIsConfirmed(txid: string): Promise<boolean> {
  try {
    const transaction = await rpc("getrawtransaction", [txid, true]) as {
      blockhash?: unknown;
      confirmations?: unknown;
    };
    return typeof transaction.confirmations === "number"
      ? transaction.confirmations > 0
      : typeof transaction.blockhash === "string";
  } catch {
    return false;
  }
}

async function registerOpen(txid: string): Promise<void> {
  const response = await fetch(`${API_URL}/offers`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ txid, vout: 0 }),
  });
  if (response.ok) return;
  const transaction = await rpc("getrawtransaction", [txid, true]) as {
    vout: Array<{ n: number; value?: number; asset?: string; scriptPubKey?: { hex?: string } }>;
  };
  const marker = await openMarker(txid);
  const error = await response.text();
  throw new Error([
    `Roulette API rejected confirmed OPEN ${txid} (${response.status}): ${error}`,
    `output0=${JSON.stringify(transaction.vout[0])}`,
    `marker=${JSON.stringify(marker)}`,
  ].join("\n"));
}

async function waitForOfferPhase(roundId: string, phase: string): Promise<void> {
  await expect.poll(async () => {
    try {
      return (await api<{ offer: { phase: string } }>(`/offers/${roundId}`)).offer.phase;
    } catch {
      return null;
    }
  }, { timeout: 60_000 }).toBe(phase);
}

async function waitForApiTip(): Promise<void> {
  const expected = Number(await rpc("getblockcount"));
  await expect.poll(async () => (await api<{ tip: { height: number } }>("/protocol")).tip.height)
    .toBe(expected);
}

async function rouletteMarker(txid: string): Promise<{ roundId: string; actionCode: number }> {
  const transaction = await rpc("getrawtransaction", [txid, true]) as {
    vout: Array<{ scriptPubKey?: { hex?: string } }>;
  };
  const txmf = transaction.vout.filter(({ scriptPubKey }) => scriptPubKey?.hex?.includes("54584d4601"));
  expect(txmf).toHaveLength(1);
  for (const output of transaction.vout) {
    const script = output.scriptPubKey?.hex;
    if (!script) continue;
    const raw = Buffer.from(script, "hex");
    if (raw[0] !== 0x6a) continue;
    const offset = raw[1] === 0x4c ? 3 : 2;
    const payload = raw.subarray(offset);
    if (payload.subarray(0, 4).toString("hex") !== "524c5431" || payload[6] !== 0) continue;
    return { actionCode: payload[5]!, roundId: payload.subarray(16, 48).toString("hex") };
  }
  throw new Error(`Transaction ${txid} has no initial RLT1 chunk.`);
}

async function openMarker(txid: string): Promise<OpenMarker> {
  const transaction = await rpc("getrawtransaction", [txid, true]) as {
    vout: Array<{ scriptPubKey?: { hex?: string } }>;
  };
  const bodies: Buffer[] = [];
  for (const output of transaction.vout) {
    const script = output.scriptPubKey?.hex;
    if (!script) continue;
    const raw = Buffer.from(script, "hex");
    if (raw[0] !== 0x6a) continue;
    const offset = raw[1] === 0x4c ? 3 : 2;
    const payload = raw.subarray(offset);
    if (payload.subarray(0, 4).toString("hex") !== "524c5431" || payload[5] !== 0) continue;
    bodies[payload[6]!] = payload.subarray(16);
  }
  const body = Buffer.concat(bodies);
  if (body.length !== 146) throw new Error(`OPEN ${txid} has ${body.length} RLT1 body bytes.`);
  return {
    roundId: body.subarray(0, 32).toString("hex"),
    assetId: body.subarray(32, 64).toString("hex"),
    playerPayoutScript: body.subarray(64, 86).toString("hex"),
    secretCommitment: body.subarray(86, 118).toString("hex"),
    betKind: body.readUInt8(118),
    betSelection: body.readUInt8(119),
    stake: body.readBigUInt64BE(120).toString(),
    bond: body.readBigUInt64BE(128).toString(),
    openExpiry: body.readUInt16BE(136),
    minRevealAge: body.readUInt16BE(138),
    revealExpiry: body.readUInt16BE(140),
    covenantVout: body.readUInt32BE(142),
  };
}

async function api<T>(path: string): Promise<T> {
  const response = await fetch(`${API_URL}${path}`);
  if (!response.ok) throw new Error(`Roulette API ${path} failed (${response.status})`);
  return response.json() as Promise<T>;
}

async function rpc(method: string, params: unknown[] = []): Promise<unknown> {
  const authorization = Buffer.from(`${RPC_USER}:${RPC_PASSWORD}`).toString("base64");
  const response = await fetch(RPC_URL, {
    method: "POST",
    headers: { authorization: `Basic ${authorization}`, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "1.0", id: "apogee-roulette-e2e", method, params }),
  });
  const body = await response.json() as { result?: unknown; error?: { message?: string } | null };
  if (!response.ok || body.error) throw new Error(body.error?.message ?? `Elements RPC ${method} failed`);
  return body.result;
}

async function mempoolTxids(): Promise<string[]> {
  return rpc("getrawmempool") as Promise<string[]>;
}

async function mineBlocks(count: number): Promise<void> {
  await rpc("generatetoaddress", [count, MINER_ADDRESS]);
}

async function sendFragments(address: string, amounts: readonly number[]): Promise<void> {
  for (const amount of amounts) await rpc("sendtoaddress", [address, amount]);
}

async function waitForEsploraTip(): Promise<void> {
  const expected = Number(await rpc("getblockcount"));
  await expect.poll(async () => {
    const response = await fetch(`${ESPLORA_URL}/blocks/tip/height`);
    return response.ok ? Number(await response.text()) : -1;
  }).toBe(expected);
}
