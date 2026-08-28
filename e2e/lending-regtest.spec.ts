import { chromium, expect, test, type BrowserContext, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
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
const SIMPLICITY_LENDING_V3_CREATE_FACTORY = "issuance_factory.CreateFactory";
const SIMPLICITY_LENDING_V3_CREATE_OFFER = "lending_contract.CreateOffer";
const SIMPLICITY_LENDING_V3_ACCEPT_OFFER = "lending_contract.AcceptOffer";
const SIMPLICITY_LENDING_V3_CLAIM_PRINCIPAL = "lending_contract.ClaimPrincipal";
const SIMPLICITY_LENDING_V3_REPAY_LOAN = "lending_contract.RepayLoan";
const SIMPLICITY_LENDING_V3_CANCEL_OFFER = "lending_contract.CancelOffer";
const SIMPLICITY_LENDING_V3_LIQUIDATE_OFFER = "lending_contract.LiquidateOffer";
const SIMPLICITY_LENDING_V3_CLAIM_LENDER_VAULT = "lending_contract.ClaimLenderVault";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required; run pnpm test:lending:regtest`);
  return value;
}

const DAPP_URL = requiredEnv("LENDING_REGTEST_DAPP_URL");
const ESPLORA_URL = requiredEnv("LENDING_REGTEST_ESPLORA_URL");
const APOGEE_ESPLORA_URL = requiredEnv("LENDING_REGTEST_APOGEE_ESPLORA_URL");
const PROXY_CONTROL_URL = requiredEnv("LENDING_REGTEST_PROXY_CONTROL_URL");
const RPC_URL = requiredEnv("LENDING_REGTEST_RPC_URL");
const RPC_USER = requiredEnv("LENDING_REGTEST_RPC_USER");
const RPC_PASSWORD = requiredEnv("LENDING_REGTEST_RPC_PASSWORD");
const MINER_ADDRESS = requiredEnv("LENDING_REGTEST_MINER_ADDRESS");
const PRINCIPAL_ASSET_ID = requiredEnv("LENDING_REGTEST_PRINCIPAL_ASSET_ID");
const LENDING_ACTIONS = [
  SIMPLICITY_LENDING_V3_CREATE_FACTORY,
  SIMPLICITY_LENDING_V3_CREATE_OFFER,
  SIMPLICITY_LENDING_V3_ACCEPT_OFFER,
  SIMPLICITY_LENDING_V3_CLAIM_PRINCIPAL,
  SIMPLICITY_LENDING_V3_REPAY_LOAN,
  SIMPLICITY_LENDING_V3_CANCEL_OFFER,
  SIMPLICITY_LENDING_V3_LIQUIDATE_OFFER,
  SIMPLICITY_LENDING_V3_CLAIM_LENDER_VAULT,
] as const;

test("real lending UI executes every trusted lending action through Apogee", async () => {
  if (!existsSync(resolve(EXTENSION_PATH, "manifest.json"))) {
    throw new Error("The regtest extension build is missing; run pnpm test:lending:regtest");
  }

  const context = await launchExtensionContext();
  let lenderContext: BrowserContext | undefined;

  try {
    const extensionId = await extensionIdentity(context);
    const address = await seedRegtestWallet(context, extensionId, TEST_MNEMONIC, "borrower");
    await sendAssetFragments(address, Array(8).fill(0.006));
    // Regtest USDT has two display decimals, but Elements RPC amounts always
    // use eight. Forty base units is therefore 0.00000040 at the RPC boundary.
    await sendAssetFragments(address, Array(5).fill(0.0000004), PRINCIPAL_ASSET_ID);
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
    await sendAssetFragments(lenderAddress, Array(4).fill(0.006));
    await sendAssetFragments(
      lenderAddress,
      Array(4).fill(0.0000006),
      PRINCIPAL_ASSET_ID,
    );
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

    const supersessionRace = await exerciseExpiredLoanSupersessionRace(
      page,
      context,
      lenderPage,
      lenderContext,
    );

    await page.bringToFront();
    const reliabilityTxid = await exerciseManifestRetryReliability(page, context, extensionId);
    await expect.poll(
      async () =>
        (await walletTransactions(context, extensionId)).some(
          ({ txid }) => txid === reliabilityTxid,
        ),
      { timeout: 60_000 },
    ).toBe(true);

    const borrowerBeforeRecords = await walletTransactions(context, extensionId);
    const lenderBeforeRecords = await walletTransactions(lenderContext, lenderExtensionId);
    const borrowerBefore = borrowerBeforeRecords.map(({ txid }) => txid);
    const lenderBefore = lenderBeforeRecords.map(({ txid }) => txid);
    const observed = await inspectActionHints([...new Set([...borrowerBefore, ...lenderBefore])]);
    expect(countActions(observed)).toEqual({
      [SIMPLICITY_LENDING_V3_CREATE_FACTORY]: 2,
      [SIMPLICITY_LENDING_V3_CREATE_OFFER]: 4,
      [SIMPLICITY_LENDING_V3_ACCEPT_OFFER]: 3,
      [SIMPLICITY_LENDING_V3_CLAIM_PRINCIPAL]: 2,
      [SIMPLICITY_LENDING_V3_REPAY_LOAN]:
        supersessionRace.winnerAction === SIMPLICITY_LENDING_V3_REPAY_LOAN ? 2 : 1,
      [SIMPLICITY_LENDING_V3_CANCEL_OFFER]: 1,
      [SIMPLICITY_LENDING_V3_LIQUIDATE_OFFER]:
        supersessionRace.winnerAction === SIMPLICITY_LENDING_V3_LIQUIDATE_OFFER ? 2 : 1,
      [SIMPLICITY_LENDING_V3_CLAIM_LENDER_VAULT]: 1,
    });
    const historyByTxid = new Map(
      [...borrowerBeforeRecords, ...lenderBeforeRecords].map((record) => [record.txid, record]),
    );
    const manifestFees = observed.map(({ txid }) => historyByTxid.get(txid)?.fee);
    expect(manifestFees.every((fee) => fee !== undefined && fee > 0 && fee <= 1_000)).toBe(true);
    expect(manifestFees.some((fee) => fee !== 1_000)).toBe(true);
    expect(
      observed.some(
        ({ action, inputCount }) =>
          action === SIMPLICITY_LENDING_V3_CREATE_OFFER && inputCount > 3,
      ),
    ).toBe(true);
    expect(
      observed.some(
        ({ action, inputCount }) =>
          action === SIMPLICITY_LENDING_V3_ACCEPT_OFFER && inputCount > 4,
      ),
    ).toBe(true);
    expect(
      observed.some(
        ({ action, inputCount }) =>
          action === SIMPLICITY_LENDING_V3_REPAY_LOAN && inputCount > 4,
      ),
    ).toBe(true);

    const borrowerAfterRecords = await restoreAndReadTransactions(
      context,
      extensionId,
      TEST_MNEMONIC,
      "borrower-restored",
    );
    const lenderAfterRecords = await restoreAndReadTransactions(
      lenderContext,
      lenderExtensionId,
      "legal winner thank year wave sausage worth useful legal winner thank yellow",
      "lender-restored",
    );
    const borrowerAfter = borrowerAfterRecords.map(({ txid }) => txid);
    const lenderAfter = lenderAfterRecords.map(({ txid }) => txid);
    expect([...borrowerAfter].sort()).toEqual([...borrowerBefore].sort());
    expect([...lenderAfter].sort()).toEqual([...lenderBefore].sort());
    const restoredByTxid = new Map(
      [...borrowerAfterRecords, ...lenderAfterRecords].map((record) => [record.txid, record]),
    );
    for (const row of observed) {
      expect(restoredByTxid.get(row.txid)?.txManifest).toMatchObject({
        status: "verified",
        bundleHash: LENDING_V3_BUNDLE_HASH,
        action: row.action,
      });
    }
    await expectWalletHistoryAction(context, extensionId, "Repay loan in full");
    await expectWalletHistoryAction(
      lenderContext,
      lenderExtensionId,
      "Collect loan repayment",
    );

    console.log("[txmf-spike] action marker compatibility");
    for (const row of observed) {
      console.log(JSON.stringify({
        ...row,
        borrowerRecovered: borrowerAfter.includes(row.txid),
        lenderRecovered: lenderAfter.includes(row.txid),
      }));
    }
  } finally {
    await lenderContext?.close();
    await context.close();
  }
});

test("durably recovers TX Manifest broadcast checkpoints after worker termination", async () => {
  if (!existsSync(resolve(EXTENSION_PATH, "manifest.json"))) {
    throw new Error("The regtest extension build is missing; run pnpm test:lending:regtest");
  }

  const context = await launchExtensionContext();
  try {
    const extensionId = await extensionIdentity(context);
    const address = await seedRegtestWallet(context, extensionId, TEST_MNEMONIC, "recovery");
    await sendAssetFragments(address, Array(4).fill(0.006));
    await mineBlock();
    await waitForEsploraTip();
    const page = await connectLendingDapp(context);
    await exerciseDurableBroadcastRecovery(page, context, extensionId);
  } finally {
    await context.close();
  }
});

type ActionHintObservation = {
  txid: string;
  action: (typeof LENDING_ACTIONS)[number];
  markerOutputIndex: number;
  outputCount: number;
  inputCount: number;
};

type WalletHistoryRecord = {
  txid: string;
  fee: number;
  txManifest?: {
    status: "verified" | "unsupported" | "unverified";
    bundleHash?: string;
    action?: string;
  };
};

type PendingTxRecordSnapshot = {
  txid: string;
  kind: string;
  conflictOutpoint?: string;
  confirmationStatus: string;
  failureReason?: string;
  supersededByTxid?: string;
};

type SupersessionRaceResult = {
  winnerTxid: string;
  loserTxid: string;
  winnerAction:
    | typeof SIMPLICITY_LENDING_V3_REPAY_LOAN
    | typeof SIMPLICITY_LENDING_V3_LIQUIDATE_OFFER;
};

async function exerciseExpiredLoanSupersessionRace(
  borrowerPage: Page,
  borrowerContext: BrowserContext,
  lenderPage: Page,
  lenderContext: BrowserContext,
): Promise<SupersessionRaceResult> {
  await borrowerPage.bringToFront();
  await borrowerPage.goto(new URL("/borrow", DAPP_URL).href);
  const offerId = await createBorrowOffer(borrowerPage, borrowerContext);

  await lenderPage.bringToFront();
  await lenderPage.goto(new URL("/supply", DAPP_URL).href);
  const fundableOffer = await waitForOfferRow(lenderPage, offerId, "Open Offer");
  await fundableOffer.click();
  await executeManifestAction(lenderPage, lenderContext, "Fund loan offer", "Accept & Supply");

  await borrowerPage.bringToFront();
  await borrowerPage.goto(new URL("/borrow", DAPP_URL).href);
  const activeOffer = await waitForOfferRow(borrowerPage, offerId, "Active");
  await activeOffer.click();
  await executeManifestAction(borrowerPage, borrowerContext, "Claim borrowed funds", "Claim Principal");

  await mineBlocks(6);
  await waitForEsploraTip();

  await borrowerPage.goto(new URL("/borrow", DAPP_URL).href);
  const borrowerExpiredOffer = await waitForExpiredActiveOffer(borrowerPage, offerId);
  await borrowerExpiredOffer.click();
  await expect(borrowerPage.getByRole("heading", { name: /^Repay Offer/ })).toBeVisible();

  await lenderPage.bringToFront();
  await lenderPage.goto(new URL("/supply", DAPP_URL).href);
  const lenderExpiredOffer = await waitForExpiredActiveOffer(lenderPage, offerId);
  await lenderExpiredOffer.click();
  await expect(lenderPage.getByRole("heading", { name: /^Liquidate Offer/ })).toBeVisible();

  const repaymentApprovalPromise = approvalPage(borrowerContext);
  const liquidationApprovalPromise = approvalPage(lenderContext);
  await Promise.all([
    activateButton(borrowerPage, "Repay Loan"),
    activateButton(lenderPage, "Liquidate & Claim Collateral"),
  ]);
  const [repaymentApproval, liquidationApproval] = await Promise.all([
    repaymentApprovalPromise,
    liquidationApprovalPromise,
  ]);
  await expect(repaymentApproval.getByText("Repay loan in full", { exact: true })).toBeVisible();
  await expect(
    liquidationApproval.getByText("Liquidate expired loan", { exact: true }),
  ).toBeVisible();

  // Both parties have independently built and reviewed a valid transaction for
  // the same active-offer outpoint. Simulate one broadcast response being
  // accepted by the caller but never reaching the node, while its competitor
  // is submitted normally. This deterministically reproduces the eventual
  // double-spend resolution state without choosing which party wins.
  const armed = await fetch(
    `${PROXY_CONTROL_URL}/ack-next-broadcast-without-submission`,
    { method: "POST" },
  );
  expect(armed.ok).toBe(true);
  await Promise.all([
    repaymentApproval.getByRole("button", { name: "Approve & execute" }).click(),
    liquidationApproval.getByRole("button", { name: "Approve & execute" }).click(),
  ]);

  const [repaymentTxid, liquidationTxid] = await Promise.all([
    transactionIdFromOpenModal(borrowerPage),
    transactionIdFromOpenModal(lenderPage),
  ]);
  expect(repaymentTxid).not.toBe(liquidationTxid);

  const [repaymentRecord, liquidationRecord] = await Promise.all([
    waitForPendingTxRecord(borrowerPage, repaymentTxid),
    waitForPendingTxRecord(lenderPage, liquidationTxid),
  ]);
  expect(repaymentRecord).toMatchObject({
    txid: repaymentTxid,
    kind: "repay_offer",
  });
  expect(liquidationRecord).toMatchObject({
    txid: liquidationTxid,
    kind: "liquidate_offer",
  });
  expect(["processing", "failed"]).toContain(repaymentRecord.confirmationStatus);
  expect(["processing", "failed"]).toContain(liquidationRecord.confirmationStatus);
  expect(repaymentRecord.conflictOutpoint).toMatch(/^[0-9a-f]{64}:\d+$/);
  expect(liquidationRecord.conflictOutpoint).toBe(repaymentRecord.conflictOutpoint);

  const mempool = await mempoolTxids();
  expect(mempool).toHaveLength(1);
  const winnerTxid = mempool[0]!;
  expect([repaymentTxid, liquidationTxid]).toContain(winnerTxid);
  const borrowerWon = winnerTxid === repaymentTxid;
  const winnerRecord = borrowerWon ? repaymentRecord : liquidationRecord;
  expect(winnerRecord.confirmationStatus).toBe("processing");
  const loserTxid = borrowerWon ? liquidationTxid : repaymentTxid;
  const loserPage = borrowerWon ? lenderPage : borrowerPage;
  const winnerPage = borrowerWon ? borrowerPage : lenderPage;
  const expectedFailure = borrowerWon
    ? "Liquidation was superseded by repayment."
    : "Repayment was superseded by liquidation.";

  await mineBlock();
  await waitForEsploraTip();
  await expect(winnerPage.getByText(/Confirmed|Finalized/, { exact: true })).toBeVisible({
    timeout: 60_000,
  });
  await expect(loserPage.getByText("Transaction Superseded", { exact: true })).toBeVisible({
    timeout: 60_000,
  });
  await expect(loserPage.getByText(expectedFailure, { exact: true })).toBeVisible();
  await expect(loserPage.getByText("Winning Transaction", { exact: true })).toBeVisible();
  await expect(loserPage.locator(`a[href*="${winnerTxid}"]`)).toBeVisible();

  const persistedLoser = await waitForPendingTxRecord(loserPage, loserTxid, {
    confirmationStatus: "failed",
    failureReason: "superseded",
    supersededByTxid: winnerTxid,
  });
  expect(persistedLoser.conflictOutpoint).toBe(repaymentRecord.conflictOutpoint);

  await expect(rpc("getrawtransaction", [loserTxid])).rejects.toThrow();
  await expect(inspectActionHints([winnerTxid])).resolves.toMatchObject([
    {
      txid: winnerTxid,
      action: borrowerWon
        ? SIMPLICITY_LENDING_V3_REPAY_LOAN
        : SIMPLICITY_LENDING_V3_LIQUIDATE_OFFER,
    },
  ]);

  await activateButton(winnerPage, "Done");
  await loserPage.reload();
  await expect(loserPage.getByRole("button", { name: "Apogee", exact: true }).first()).toBeVisible();
  await loserPage.getByRole("button", { name: "Notifications" }).evaluate((button) => {
    (button as { click(): void }).click();
  });
  await expect(loserPage.getByText("Notifications", { exact: true })).toBeVisible();
  await expect(loserPage.getByText(expectedFailure, { exact: true })).toBeVisible();
  await expect(loserPage.getByText(`Winning transaction:`, { exact: false })).toBeVisible();
  await expect(loserPage.locator(`a[href*="${winnerTxid}"]`)).toBeVisible();

  await lenderPage.goto(new URL("/supply", DAPP_URL).href);
  const terminalStatus = borrowerWon ? "Repaid" : "Liquidated";
  await expect.poll(async () => {
    const terminalOffer = offerRow(lenderPage, offerId).filter({ hasText: terminalStatus });
    if (await terminalOffer.isVisible()) return true;
    await reloadConnectedDapp(lenderPage);
    return terminalOffer.isVisible();
  }, { timeout: 60_000 }).toBe(true);

  return {
    winnerTxid,
    loserTxid,
    winnerAction: borrowerWon
      ? SIMPLICITY_LENDING_V3_REPAY_LOAN
      : SIMPLICITY_LENDING_V3_LIQUIDATE_OFFER,
  };
}

async function waitForExpiredActiveOffer(page: Page, offerId: string) {
  const expiredOffer = offerRow(page, offerId)
    .filter({ hasText: "Active" })
    .filter({ hasText: "Expired" });
  await expect.poll(async () => {
    if (await expiredOffer.isVisible()) return true;
    await reloadConnectedDapp(page);
    return expiredOffer.isVisible();
  }, { timeout: 60_000 }).toBe(true);
  return expiredOffer;
}

async function waitForOfferRow(page: Page, offerId: string, status: string) {
  const row = offerRow(page, offerId).filter({ hasText: status });
  await expect.poll(async () => {
    if (await row.isVisible()) return true;
    await reloadConnectedDapp(page);
    return row.isVisible();
  }, { timeout: 60_000 }).toBe(true);
  return row;
}

async function reloadConnectedDapp(page: Page): Promise<void> {
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByRole("button", { name: "Apogee", exact: true }).first()).toBeVisible();
}

function offerRow(page: Page, offerId: string) {
  return page.locator(`[role="row"][data-key=${JSON.stringify(offerId)}]`);
}

async function offerIdByCreationTxid(txid: string): Promise<string> {
  let offerId: string | undefined;
  await expect.poll(async () => {
    const response = await fetch(new URL("/backend/offers?limit=100", PROXY_CONTROL_URL));
    if (!response.ok) return false;
    const body = await response.json() as {
      items?: Array<{ id?: unknown; created_at_txid?: unknown }>;
    };
    const offer = body.items?.find((item) => item.created_at_txid === txid);
    offerId = typeof offer?.id === "string" ? offer.id : undefined;
    return offerId !== undefined;
  }, { timeout: 60_000 }).toBe(true);
  if (!offerId) throw new Error(`Indexer did not expose offer created by ${txid}`);
  return offerId;
}

async function transactionIdFromOpenModal(page: Page): Promise<string> {
  const transactionLabel = page.getByText(/^(Transaction ID|Attempted Transaction)$/);
  await expect(transactionLabel).toBeVisible({ timeout: 60_000 });
  const href = await transactionLabel.locator("..").getByRole("link").getAttribute("href");
  const txid = href?.match(/[0-9a-f]{64}/i)?.[0]?.toLowerCase();
  if (!txid) throw new Error(`Transaction modal did not contain a full txid link: ${href}`);
  return txid;
}

async function waitForPendingTxRecord(
  page: Page,
  txid: string,
  expected: Partial<PendingTxRecordSnapshot> = {},
): Promise<PendingTxRecordSnapshot> {
  let snapshot: PendingTxRecordSnapshot | null = null;
  await expect.poll(async () => {
    snapshot = await pendingTxRecord(page, txid);
    if (!snapshot) return false;
    return Object.entries(expected).every(
      ([key, value]) => snapshot?.[key as keyof PendingTxRecordSnapshot] === value,
    );
  }, { timeout: 60_000 }).toBe(true);
  if (!snapshot) throw new Error(`Pending transaction ${txid} was not persisted.`);
  return snapshot;
}

async function pendingTxRecord(page: Page, txid: string): Promise<PendingTxRecordSnapshot | null> {
  const connection = await discoveredProviderRequest(page, {
    method: "wallet_getConnection",
  }) as { chainId: string; accountIdentifier: string };
  const walletScope = `apogee:${connection.chainId}:${connection.accountIdentifier}`;
  return page.evaluate(async ({ walletScope, txid }) => {
    const modulePath = "/src/providers/pendingTransactions/storage.ts";
    const storage = await import(modulePath) as {
      loadPendingTxsForWallet(scope: string): Promise<PendingTxRecordSnapshot[]>;
    };
    return (await storage.loadPendingTxsForWallet(walletScope)).find(
      (record) => record.txid === txid,
    ) ?? null;
  }, { walletScope, txid });
}

async function inspectActionHints(txids: string[]): Promise<ActionHintObservation[]> {
  const observations: ActionHintObservation[] = [];
  for (const txid of txids) {
    const transaction = await rpc("getrawtransaction", [txid, true]) as {
      vin: unknown[];
      vout: Array<{ n: number; scriptPubKey: { hex: string } }>;
    };
    const found = transaction.vout.flatMap((output) => {
      const hint = actionHintFromScript(output.scriptPubKey.hex);
      return hint ? [{ output, hint }] : [];
    });
    if (found.length === 0) continue;
    expect(found).toHaveLength(1);
    expect(found[0]?.hint.bundleHash).toBe(LENDING_V3_BUNDLE_HASH);
    const matches: Array<(typeof LENDING_ACTIONS)[number]> = [];
    for (const action of LENDING_ACTIONS) {
      if (found[0]!.hint.actionTag === actionTag(found[0]!.hint.bundleHash, action)) {
        matches.push(action);
      }
    }
    expect(matches).toHaveLength(1);
    observations.push({
      txid,
      action: matches[0]!,
      markerOutputIndex: found[0]!.output.n,
      outputCount: transaction.vout.length,
      inputCount: transaction.vin.length,
    });
  }
  return observations;
}

function countActions(
  observations: ActionHintObservation[],
): Record<(typeof LENDING_ACTIONS)[number], number> {
  const counts = Object.fromEntries(LENDING_ACTIONS.map((action) => [action, 0])) as Record<
    (typeof LENDING_ACTIONS)[number],
    number
  >;
  for (const observation of observations) counts[observation.action] += 1;
  return counts;
}

function actionHintFromScript(
  scriptHex: string,
): { bundleHash: string; actionTag: string } | null {
  if (!/^(?:[0-9a-f]{2})+$/i.test(scriptHex)) return null;
  const bytes = Buffer.from(scriptHex, "hex");
  if (bytes[0] !== 0x6a) return null;
  let cursor = 1;
  while (cursor < bytes.length) {
    const opcode = bytes[cursor];
    if (opcode === undefined || opcode > 0x4b) return null;
    const start = cursor + 1;
    const end = start + opcode;
    if (end > bytes.length) return null;
    const payload = bytes.subarray(start, end).toString("hex");
    if (payload.length === 106 && payload.startsWith("54584d4601")) {
      return {
        bundleHash: `sha256:${payload.slice(10, 74)}`,
        actionTag: payload.slice(74),
      };
    }
    cursor = end;
  }
  return null;
}

function actionTag(bundleHash: string, action: string): string {
  const tag = createHash("sha256").update("tx-manifest/action/v1").digest();
  return createHash("sha256")
    .update(tag)
    .update(tag)
    .update(Buffer.from(bundleHash.slice("sha256:".length), "hex"))
    .update(action, "utf8")
    .digest("hex")
    .slice(0, 32);
}

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
    connectionApproval.getByText("Execute contracts", { exact: true }),
  ).toBeVisible();
  await expect(connectionApproval.getByText("Read balances", { exact: true })).toBeVisible();
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
): Promise<string> {
  await expect(page.getByRole("button", { name: "Create Borrow Offer" })).toBeEnabled();
  await activateButton(page, "Create Borrow Offer");
  await expect(page.getByText("Create Borrow Offer", { exact: true }).last()).toBeVisible();
  await page.getByLabel("Collateral to Lock").fill("0.01");
  await page.getByLabel("Loan Amount").fill("1");
  await page.getByLabel("Fee").fill("0.1");
  await page.getByLabel("Term").click();
  await page.getByRole("option", { name: /5 minutes/ }).click();
  const txid = await executeManifestAction(
    page,
    context,
    "Create borrow offer",
    "Create Borrow Offer",
  );
  const offerId = await offerIdByCreationTxid(txid);
  await waitForOfferRow(page, offerId, "Open Offer");
  return offerId;
}

async function executeManifestAction(
  page: import("@playwright/test").Page,
  context: BrowserContext,
  actionLabel: string,
  buttonName: string,
): Promise<string> {
  const manifestApprovalPromise = approvalPage(context);
  await activateButton(page, buttonName);
  const manifestApproval = await manifestApprovalPromise;
  await expect(manifestApproval.getByText(actionLabel, { exact: true })).toBeVisible();
  await manifestApproval.getByRole("button", { name: "Approve & execute" }).click();

  await expect(page.getByRole("button", { name: "Done", exact: true })).toBeEnabled();
  await expect(page.getByText("Transaction ID", { exact: true })).toBeVisible();
  const txid = await transactionIdFromOpenModal(page);
  await mineBlock();
  await waitForEsploraTip();
  await expect(page.getByText(/Confirmed|Finalized/, { exact: true })).toBeVisible();
  await activateButton(page, "Done");
  return txid;
}

type ProviderSettlement =
  | { ok: true; value: unknown }
  | {
      ok: false;
      error: { code?: number; message: string; data?: unknown };
    };

async function exerciseManifestRetryReliability(
  page: import("@playwright/test").Page,
  context: BrowserContext,
  extensionId: string,
): Promise<string> {
  const connection = await discoveredProviderRequest(page, {
    method: "wallet_getConnection",
  }) as { chainId: string; accountIdentifier: string };
  const invocation = {
    protocolVersion: "0.1",
    requestId: "regtest-create-factory-retry-reliability",
    chainId: connection.chainId,
    accountIdentifier: connection.accountIdentifier,
    manifest: { bundleHash: LENDING_V3_BUNDLE_HASH },
    action: SIMPLICITY_LENDING_V3_CREATE_FACTORY,
    arguments: {},
    providedInputs: {},
    constraints: { maxFee: "1000" },
  };
  const request = { method: "experimental_executeTxManifest", params: invocation };

  expect(await mempoolTxids()).toEqual([]);

  // Approval-time authorization is authoritative: locking after the review is
  // shown must fail the request without signing or broadcasting anything.
  const lockedApprovalPromise = approvalPage(context);
  const lockedRequest = settledDiscoveredProviderRequest(page, request);
  const lockedApproval = await lockedApprovalPromise;
  await expect(lockedApproval.getByText("Enable borrowing", { exact: true })).toBeVisible();
  await setWalletLocked(context, extensionId, true);
  await lockedApproval.getByRole("button", { name: "Approve & execute" }).click();
  await expect(lockedRequest).resolves.toMatchObject({
    ok: false,
    error: { code: 4100, data: { reason: "unauthorized" } },
  });
  await lockedApproval.close();
  await setWalletLocked(context, extensionId, false);
  expect(await mempoolTxids()).toEqual([]);

  // A definitive user rejection is not cached. The exact same invocation and
  // requestId remains safe to retry.
  const rejectedApprovalPromise = approvalPage(context);
  const rejectedRequest = settledDiscoveredProviderRequest(page, request);
  const rejectedApproval = await rejectedApprovalPromise;
  await expect(rejectedApproval.getByText("Enable borrowing", { exact: true })).toBeVisible();
  await clickPopupButtonAndWaitForClose(rejectedApproval, "Reject");
  await expect(rejectedRequest).resolves.toMatchObject({
    ok: false,
    error: { code: 4001, data: { reason: "user_rejected" } },
  });
  expect(await mempoolTxids()).toEqual([]);

  // Concurrent identical retries share one execution and one approval. Both
  // callers receive the same terminal result, but only one tx reaches mempool.
  const retryApprovalPromise = approvalPage(context);
  const concurrentRetries = settledDiscoveredProviderRequests(page, request, 2, 120_000);
  const retryApproval = await retryApprovalPromise;
  await expect(retryApproval.getByText("Enable borrowing", { exact: true })).toBeVisible();
  await retryApproval.waitForTimeout(750);
  expect(openApprovalPages(context)).toHaveLength(1);
  await retryApproval.getByRole("button", { name: "Approve & execute" }).click();
  const retryResults = await concurrentRetries;
  expect(retryResults).toHaveLength(2);
  expect(retryResults.every((result) => result.ok)).toBe(true);
  const successfulResults = retryResults.flatMap((result) => result.ok ? [result.value] : []) as Array<{
    requestId: string;
    status: string;
    txid: string;
  }>;
  expect(successfulResults).toHaveLength(2);
  expect(successfulResults[0]).toMatchObject({
    requestId: invocation.requestId,
    status: "broadcast",
  });
  expect(successfulResults[1]?.txid).toBe(successfulResults[0]?.txid);
  expect(await mempoolTxids()).toEqual([successfulResults[0]!.txid]);
  await expect.poll(() => openApprovalPages(context).length).toBe(0);

  // Once successful, a same-data replay is served from durable terminal state
  // without another approval or broadcast.
  const replay = await settledDiscoveredProviderRequest(page, request, 5_000);
  expect(replay).toEqual(retryResults[0]);
  expect(openApprovalPages(context)).toHaveLength(0);
  expect(await mempoolTxids()).toEqual([successfulResults[0]!.txid]);

  // The idempotency key cannot be repurposed for different request data.
  const conflicting = await settledDiscoveredProviderRequest(
    page,
    {
      ...request,
      params: { ...invocation, constraints: { maxFee: "999" } },
    },
    5_000,
  );
  expect(conflicting).toMatchObject({
    ok: false,
    error: { code: -32602, data: { reason: "invalid_params" } },
  });
  expect(openApprovalPages(context)).toHaveLength(0);
  expect(await mempoolTxids()).toEqual([successfulResults[0]!.txid]);

  await mineBlock();
  await waitForEsploraTip();
  const onChain = await inspectActionHints([successfulResults[0]!.txid]);
  expect(onChain).toMatchObject([
    { txid: successfulResults[0]!.txid, action: SIMPLICITY_LENDING_V3_CREATE_FACTORY },
  ]);

  // Disconnecting revokes an approval that is already open. Reconnect and a
  // full page reload must preserve the prior terminal result without another
  // approval or transaction.
  const disconnectRequest = {
    ...request,
    params: {
      ...invocation,
      requestId: "regtest-create-factory-disconnect-invalidation",
    },
  };
  const disconnectApprovalPromise = approvalPage(context);
  const interrupted = settledDiscoveredProviderRequest(page, disconnectRequest);
  const disconnectApproval = await disconnectApprovalPromise;
  await expect(disconnectApproval.getByText("Enable borrowing", { exact: true })).toBeVisible();
  await discoveredProviderRequest(page, { method: "wallet_disconnect" });
  await expect(interrupted).resolves.toMatchObject({
    ok: false,
    error: { code: 4100, data: { reason: "unauthorized" } },
  });
  await expect.poll(() => openApprovalPages(context).length).toBe(0);
  expect(await mempoolTxids()).toEqual([]);
  expect(await discoveredProviderRequest(page, { method: "wallet_getConnection" })).toBeNull();

  const reconnectApprovalPromise = approvalPage(context);
  const reconnectRequest = discoveredProviderRequest(page, {
    method: "wallet_connect",
    params: {
      chains: [REGTEST_CHAIN_ID],
      methods: ["experimental_executeTxManifest", "getBalance"],
      events: [],
    },
  });
  const reconnectApproval = await reconnectApprovalPromise;
  await reconnectApproval.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(reconnectRequest).resolves.toMatchObject({
    chainId: connection.chainId,
    accountIdentifier: connection.accountIdentifier,
  });
  await expect.poll(() => openApprovalPages(context).length).toBe(0);

  await page.reload();
  await expect.poll(async () => {
    const current = await discoveredProviderRequest(page, { method: "wallet_getConnection" }) as {
      accountIdentifier?: unknown;
    } | null;
    return current?.accountIdentifier;
  }).toBe(connection.accountIdentifier);
  const postReloadReplay = await settledDiscoveredProviderRequest(page, request, 5_000);
  expect(postReloadReplay).toEqual(retryResults[0]);
  expect(openApprovalPages(context)).toHaveLength(0);
  expect(await mempoolTxids()).toEqual([]);

  return successfulResults[0]!.txid;
}

async function exerciseDurableBroadcastRecovery(
  page: import("@playwright/test").Page,
  context: BrowserContext,
  extensionId: string,
): Promise<string> {
  const connection = await discoveredProviderRequest(page, {
    method: "wallet_getConnection",
  }) as { accountIdentifier: string; chainId: string };
  const walletScope = `apogee:${connection.chainId}:${connection.accountIdentifier}`;

  const classification = await page.evaluate(async () => {
    const modulePath = "/src/lib/liquid-provider/types.ts";
    const providerTypes = await import(modulePath) as {
      shouldAbandonTxManifestAttempt(error: unknown): boolean;
    };
    return {
      chainUnavailable: providerTypes.shouldAbandonTxManifestAttempt({ code: 4901 }),
      broadcastUnknown: providerTypes.shouldAbandonTxManifestAttempt({
        code: 4901,
        data: { cause: "broadcast_unconfirmed" },
      }),
      invalidCheckpoint: providerTypes.shouldAbandonTxManifestAttempt({
        code: -32603,
        data: { cause: "checkpoint_invalid" },
      }),
      invalidParams: providerTypes.shouldAbandonTxManifestAttempt({ code: -32602 }),
    };
  });
  expect(classification).toEqual({
    chainUnavailable: false,
    broadcastUnknown: false,
    invalidCheckpoint: true,
    invalidParams: true,
  });

  await page.goto(new URL("/borrow", DAPP_URL).href);
  await expect(page.getByText("Your Borrows", { exact: true })).toBeVisible();
  await activateButton(page, "Create Borrow Offer");
  await expect(page.getByText("Enable Borrowing", { exact: true }).first()).toBeVisible();

  expect(await mempoolTxids()).toEqual([]);
  const armed = await fetch(`${PROXY_CONTROL_URL}/fail-next-broadcast`, { method: "POST" });
  expect(armed.ok).toBe(true);

  // The proxy submits the transaction upstream, then deliberately returns 502.
  // Apogee must leave its encrypted pre-broadcast checkpoint unresolved.
  const approvalPromise = approvalPage(context);
  await activateButton(page, "Enable");
  const approval = await approvalPromise;
  await expect(approval.getByText("Enable borrowing", { exact: true })).toBeVisible();
  await expect.poll(() => manifestAttemptRequestId(page, walletScope, "enable-borrowing"))
    .not.toBeNull();
  const originalRequestId = await manifestAttemptRequestId(
    page,
    walletScope,
    "enable-borrowing",
  );
  expect(originalRequestId).not.toBeNull();
  await approval.getByRole("button", { name: "Approve & execute" }).click();
  await expect(page.getByText("Transaction Failed", { exact: true })).toBeVisible();
  await expect(page.getByText(/Retry the same requestId to recover safely/)).toBeVisible();
  await expect.poll(() => manifestAttemptRequestId(page, walletScope, "enable-borrowing"))
    .toBe(originalRequestId);
  await approval.close();
  const accepted = await mempoolTxids();
  expect(accepted).toHaveLength(1);
  const txid = accepted[0]!;
  await activateButton(page, "Close");

  // Kill the MV3 worker so the retry cannot rely on any in-memory operation.
  await terminateExtensionWorker(page, extensionId);
  await page.reload();
  await expect.poll(async () => {
    const current = await discoveredProviderRequest(page, { method: "wallet_getConnection" }) as {
      accountIdentifier?: unknown;
    } | null;
    return current?.accountIdentifier;
  }).toBe(connection.accountIdentifier);

  // The real dapp loads the saved invocation and requestId from IndexedDB. Its
  // retry finds the accepted tx by checkpointed txid, without a second approval
  // or another broadcast, then completes normal portfolio-script recovery.
  await expect(page.getByRole("button", { name: "Create Borrow Offer" })).toBeEnabled();
  await activateButton(page, "Create Borrow Offer");
  await expect(page.getByText("Enable Borrowing", { exact: true }).first()).toBeVisible();
  await activateButton(page, "Enable");
  await expect(page.getByText("Transaction ID", { exact: true })).toBeVisible();
  await expect(page.locator(`a[href*="${txid}"]`)).toBeVisible();
  expect(openApprovalPages(context)).toHaveLength(0);
  expect(await mempoolTxids()).toEqual([txid]);
  await expect.poll(() => manifestAttemptRequestId(page, walletScope, "enable-borrowing"))
    .toBeNull();

  await mineBlock();
  await waitForEsploraTip();
  await expect(page.getByText(/Confirmed|Finalized/, { exact: true })).toBeVisible();
  await activateButton(page, "Done");
  return txid;
}

async function manifestAttemptRequestId(
  page: import("@playwright/test").Page,
  walletScope: string,
  offerId: string,
): Promise<string | null> {
  return page.evaluate(async ({ scope, targetOfferId }) => {
    const modulePath = "/src/lib/liquid-provider/storage.ts";
    const storage = await import(modulePath) as {
      getManifestAttempt(
        scope: string,
        offerId: string,
      ): Promise<{ invocation?: unknown } | undefined>;
    };
    const record = await storage.getManifestAttempt(scope, targetOfferId);
    if (!record?.invocation || typeof record.invocation !== "object") return null;
    const requestId = (record.invocation as { requestId?: unknown }).requestId;
    return typeof requestId === "string" ? requestId : null;
  }, { scope: walletScope, targetOfferId: offerId });
}

async function terminateExtensionWorker(
  page: import("@playwright/test").Page,
  extensionId: string,
): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  try {
    const targets = await cdp.send("Target.getTargets");
    const worker = targets.targetInfos.find(
      (target) =>
        target.type === "service_worker" &&
        target.url.startsWith(`chrome-extension://${extensionId}/`),
    );
    if (!worker) throw new Error("Apogee service worker target was not found");
    const closed = await cdp.send("Target.closeTarget", { targetId: worker.targetId });
    expect(closed.success).toBe(true);
    await expect.poll(
      async () => {
        const current = await cdp.send("Target.getTargets");
        return current.targetInfos.some((target) => target.targetId === worker.targetId);
      },
      { timeout: 10_000 },
    ).toBe(false);
  } finally {
    await cdp.detach();
  }
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
      const send = async (message: unknown) => {
        const reply = await extension.chrome.runtime.sendMessage(message);
        if (!reply.ok) throw new Error(reply.error ?? "Apogee request failed");
        return reply.value;
      };
      const restore = async (message: unknown) => {
        const port = extension.chrome.runtime.connect({ name: "apogee-secret" });
        const reply = await new Promise<{
          ok: boolean;
          value?: unknown;
          error?: string;
        } | null>((resolve) => {
          const done = (result: { ok: boolean; value?: unknown; error?: string } | null) => {
            port.onMessage.removeListener(onMessage);
            port.onDisconnect.removeListener(onDisconnect);
            resolve(result);
          };
          const onMessage = (result: unknown) =>
            done(result as { ok: boolean; value?: unknown; error?: string });
          const onDisconnect = () => done(null);
          port.onMessage.addListener(onMessage);
          port.onDisconnect.addListener(onDisconnect);
          port.postMessage(message);
        });
        port.disconnect();
        if (!reply?.ok) throw new Error(reply?.error ?? "Apogee restore failed");
        return reply.value;
      };
      await restore({
        type: "wallet/restore",
        password: "lending-regtest-password",
        mnemonic,
        label: `Lending regtest ${role}`,
        network: "regtest",
      });
      await send({ type: "wallet/setChainServer", network: "regtest", url: esploraUrl });
      return await send({ type: "wallet/getAddress" }) as { address: string };
    },
    { mnemonic, esploraUrl: APOGEE_ESPLORA_URL, role },
  );
  await extensionPage.close();
  return result.address;
}

async function walletTransactions(
  context: BrowserContext,
  extensionId: string,
): Promise<WalletHistoryRecord[]> {
  const extensionPage = await context.newPage();
  await extensionPage.goto(`chrome-extension://${extensionId}/src/sidepanel/index.html`);
  const result = await extensionPage.evaluate(async () => {
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
    await send({ type: "wallet/sync" });
    return await send({ type: "wallet/getTransactions" }) as WalletHistoryRecord[];
  });
  await extensionPage.close();
  return result;
}

async function restoreAndReadTransactions(
  context: BrowserContext,
  extensionId: string,
  mnemonic: string,
  role: string,
): Promise<WalletHistoryRecord[]> {
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
      const send = async (message: unknown) => {
        const reply = await extension.chrome.runtime.sendMessage(message);
        if (!reply.ok) throw new Error(reply.error ?? "Apogee request failed");
        return reply.value;
      };
      const restore = async (message: unknown) => {
        const port = extension.chrome.runtime.connect({ name: "apogee-secret" });
        const reply = await new Promise<{
          ok: boolean;
          value?: unknown;
          error?: string;
        } | null>((resolve) => {
          const done = (result: { ok: boolean; value?: unknown; error?: string } | null) => {
            port.onMessage.removeListener(onMessage);
            port.onDisconnect.removeListener(onDisconnect);
            resolve(result);
          };
          const onMessage = (result: unknown) =>
            done(result as { ok: boolean; value?: unknown; error?: string });
          const onDisconnect = () => done(null);
          port.onMessage.addListener(onMessage);
          port.onDisconnect.addListener(onDisconnect);
          port.postMessage(message);
        });
        port.disconnect();
        if (!reply?.ok) throw new Error(reply?.error ?? "Apogee restore failed");
        return reply.value;
      };
      await restore({
        type: "wallet/restore",
        password: "lending-regtest-password",
        mnemonic,
        label: `Lending regtest ${role}`,
        network: "regtest",
        replace: true,
      });
      await send({ type: "wallet/setChainServer", network: "regtest", url: esploraUrl });
      await send({ type: "wallet/sync" });
      return await send({ type: "wallet/getTransactions" }) as WalletHistoryRecord[];
    },
    { mnemonic, esploraUrl: APOGEE_ESPLORA_URL, role },
  );
  await extensionPage.close();
  return result;
}

async function expectWalletHistoryAction(
  context: BrowserContext,
  extensionId: string,
  actionLabel: string,
): Promise<void> {
  const extensionPage = await context.newPage();
  await extensionPage.goto(`chrome-extension://${extensionId}/src/sidepanel/index.html`);
  await expect(extensionPage.getByText(actionLabel, { exact: true }).first()).toBeVisible({
    timeout: 60_000,
  });
  await extensionPage.close();
}

function approvalPage(context: BrowserContext) {
  return context.waitForEvent("page", {
    predicate: (candidate) => candidate.url().includes("/src/prompt/prompt.html"),
    timeout: 20_000,
  });
}

function openApprovalPages(context: BrowserContext) {
  return context.pages().filter(
    (candidate) =>
      !candidate.isClosed() && candidate.url().includes("/src/prompt/prompt.html"),
  );
}

async function clickPopupButtonAndWaitForClose(page: Page, buttonName: string): Promise<void> {
  const closed = page.waitForEvent("close");
  try {
    await page.getByRole("button", { name: buttonName, exact: true }).click();
  } catch (error) {
    // Chromium can report TargetClosed after the click handler has completed:
    // rejecting an approval intentionally closes its own popup. Only suppress
    // that race when the expected close actually happened.
    if (!page.isClosed()) throw error;
  }
  await closed;
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

async function settledDiscoveredProviderRequest(
  page: import("@playwright/test").Page,
  request: unknown,
  timeoutMs = 60_000,
): Promise<ProviderSettlement> {
  return (await settledDiscoveredProviderRequests(page, request, 1, timeoutMs))[0]!;
}

async function settledDiscoveredProviderRequests(
  page: import("@playwright/test").Page,
  request: unknown,
  count: number,
  timeoutMs = 60_000,
): Promise<ProviderSettlement[]> {
  return page.evaluate(async ({ providerRequest, count, timeoutMs }) => {
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
    const provider = (await announced).provider;
    const settle = async (): Promise<ProviderSettlement> => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const value = await Promise.race([
          provider.request(providerRequest),
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(
              () => reject(new Error("Provider request timed out in test.")),
              timeoutMs,
            );
          }),
        ]);
        return { ok: true, value };
      } catch (error) {
        const candidate = error as { code?: unknown; message?: unknown; data?: unknown };
        return {
          ok: false,
          error: {
            ...(typeof candidate.code === "number" ? { code: candidate.code } : {}),
            message:
              typeof candidate.message === "string" ? candidate.message : String(error),
            ...(candidate.data === undefined ? {} : { data: candidate.data }),
          },
        };
      } finally {
        if (timeout !== undefined) clearTimeout(timeout);
      }
    };
    return Promise.all(Array.from({ length: count }, () => settle()));
  }, { providerRequest: request, count, timeoutMs });
}

async function setWalletLocked(
  context: BrowserContext,
  extensionId: string,
  locked: boolean,
): Promise<void> {
  const extensionPage = await context.newPage();
  await extensionPage.goto(`chrome-extension://${extensionId}/src/sidepanel/index.html`);
  await extensionPage.evaluate(async ({ locked }) => {
    const extension = globalThis as typeof globalThis & {
      chrome: {
        runtime: {
          sendMessage(message: unknown): Promise<{ ok: boolean; error?: string }>;
        };
      };
    };
    const reply = await extension.chrome.runtime.sendMessage(
      locked
        ? { type: "wallet/lock" }
        : { type: "wallet/unlock", password: "lending-regtest-password" },
    );
    if (!reply.ok) throw new Error(reply.error ?? "Apogee lock state change failed");
  }, { locked });
  await extensionPage.close();
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

async function mempoolTxids(): Promise<string[]> {
  return await rpc("getrawmempool") as string[];
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

async function sendAssetFragments(
  address: string,
  amounts: readonly number[],
  assetId?: string,
): Promise<void> {
  for (const amount of amounts) await sendAsset(address, amount, assetId);
}

async function waitForEsploraTip(): Promise<void> {
  const expected = Number(await rpc("getblockcount"));
  await expect.poll(async () => {
    const response = await fetch(`${ESPLORA_URL}/blocks/tip/height`);
    return response.ok ? Number(await response.text()) : -1;
  }).toBe(expected);
}
