import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CwsError,
  createCwsClient,
  loadExactPackage,
  publishUploadedPackage,
  reconcileStatus,
  releaseExactPackage,
  runCli,
  uploadExactPackage,
  validateVersion,
} from "./chrome-web-store.mjs";

const PUBLISHER_ID = "publisher-1";
const ITEM_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const VERSION = "0.8.0";
const SHA256 = "a".repeat(64);
const UPLOAD_ATTEMPT_ID = "run-1-upload-1";
const PUBLISH_ATTEMPT_ID = "run-1-publish-1";

function revision(state, version, deployPercentage = 100) {
  return {
    state,
    distributionChannels: [{ crxVersion: version, deployPercentage }],
  };
}

function status({ published, submitted, lastAsyncUploadState, takenDown, warned } = {}) {
  return {
    name: `publishers/${PUBLISHER_ID}/items/${ITEM_ID}`,
    itemId: ITEM_ID,
    ...(published ? { publishedItemRevisionStatus: published } : {}),
    ...(submitted ? { submittedItemRevisionStatus: submitted } : {}),
    ...(lastAsyncUploadState ? { lastAsyncUploadState } : {}),
    ...(takenDown ? { takenDown: true } : {}),
    ...(warned ? { warned: true } : {}),
  };
}

function jsonResponse(body, responseStatus = 200, headers = {}) {
  return new Response(body === undefined ? undefined : JSON.stringify(body), {
    status: responseStatus,
    headers: { "content-type": "application/json", ...headers },
  });
}

function sequenceFetch(sequence) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    assert.ok(sequence.length > 0, `Unexpected request: ${init.method} ${url}`);
    const next = sequence.shift();
    if (typeof next === "function") return await next(url, init);
    if (next instanceof Error) throw next;
    return next;
  };
  fetchImpl.calls = calls;
  fetchImpl.remaining = sequence;
  return fetchImpl;
}

function clientFor(fetchImpl, options = {}) {
  return createCwsClient({
    accessToken: "test-token",
    publisherId: PUBLISHER_ID,
    itemId: ITEM_ID,
    fetchImpl,
    sleep: async () => {},
    pollAttempts: 3,
    pollDelayMs: 0,
    ...options,
  });
}

function uploadReceipt(sha256 = SHA256) {
  return {
    schemaVersion: 1,
    resourceName: `publishers/${PUBLISHER_ID}/items/${ITEM_ID}`,
    version: VERSION,
    sha256,
    size: 123,
    uploadState: "SUCCEEDED",
    evidence: "upload-response",
  };
}

test("reconcile treats the exact public 100% version as complete", () => {
  const result = reconcileStatus(
    status({ published: revision("PUBLISHED", VERSION, 100) }),
    VERSION,
  );
  assert.equal(result.action, "complete");
  assert.equal(result.reason, "TARGET_ALREADY_PUBLISHED");
});

test("Chrome-equivalent one-to-four-component store versions cannot bypass duplicate guards", () => {
  for (const storeVersion of ["1", "1.0", "1.0.0", "1.0.0.0"]) {
    const result = reconcileStatus(
      status({ published: revision("PUBLISHED", storeVersion, 100) }),
      "1.0.0",
    );
    assert.equal(result.action, "complete", storeVersion);
  }
  assert.throws(() => validateVersion("0.0.0"), (error) => error.code === "INVALID_VERSION");
  assert.throws(() => validateVersion("65536.0.1"), (error) => error.code === "INVALID_VERSION");
});

test("reconcile safely no-ops for the exact pending version", () => {
  const result = reconcileStatus(
    status({
      published: revision("PUBLISHED", "0.7.0"),
      submitted: revision("PENDING_REVIEW", VERSION),
    }),
    VERSION,
  );
  assert.equal(result.action, "submitted");
});

test("reconcile blocks a pending target without an exact 100% submitted channel", () => {
  const partial = reconcileStatus(
    status({
      published: revision("PUBLISHED", "0.7.0"),
      submitted: revision("PENDING_REVIEW", VERSION, 50),
    }),
    VERSION,
  );
  assert.equal(partial.action, "blocked");
  assert.equal(partial.reason, "TARGET_SUBMISSION_NOT_AT_100_PERCENT");

  const missingPercentage = reconcileStatus(
    status({
      published: revision("PUBLISHED", "0.7.0"),
      submitted: {
        state: "PENDING_REVIEW",
        distributionChannels: [{ crxVersion: VERSION }],
      },
    }),
    VERSION,
  );
  assert.equal(missingPercentage.action, "blocked");
  assert.equal(missingPercentage.reason, "TARGET_SUBMISSION_NOT_AT_100_PERCENT");
});

test("reconcile blocks partial rollout, policy warnings, and version rollback", () => {
  assert.equal(
    reconcileStatus(status({ published: revision("PUBLISHED", VERSION, 50) }), VERSION).reason,
    "TARGET_NOT_PUBLIC_AT_100_PERCENT",
  );
  assert.equal(
    reconcileStatus(status({ published: revision("PUBLISHED", "0.7.0"), warned: true }), VERSION)
      .reason,
    "ITEM_POLICY_WARNING",
  );
  assert.equal(
    reconcileStatus(status({ published: revision("PUBLISHED", "0.9.0") }), VERSION).reason,
    "NEWER_VERSION_EXISTS",
  );
  for (const state of ["REJECTED", "CANCELLED", "STAGED"]) {
    const result = reconcileStatus(
      status({
        published: revision("PUBLISHED", "0.7.0"),
        submitted: revision(state, VERSION),
      }),
      VERSION,
    );
    assert.equal(result.action, "blocked");
    assert.equal(result.reason, `UNEXPECTED_TARGET_STATE_${state}`);
  }
});

test("an older rejected or cancelled submission does not permanently block a patch release", () => {
  for (const state of ["REJECTED", "CANCELLED"]) {
    const result = reconcileStatus(
      status({
        published: revision("PUBLISHED", "0.7.0"),
        submitted: revision(state, "0.8.0"),
      }),
      "0.8.1",
    );
    assert.equal(result.action, "upload");
  }
});

test("fetchStatus retries transient GET failures only", async () => {
  const delays = [];
  const fetchImpl = sequenceFetch([
    jsonResponse(
      { error: { message: "busy", status: "UNAVAILABLE" } },
      503,
      { "retry-after": "999" },
    ),
    jsonResponse(status({ published: revision("PUBLISHED", "0.7.0") })),
  ]);
  const client = clientFor(fetchImpl, {
    sleep: async (delay) => delays.push(delay),
    getAttempts: 2,
  });

  const result = await client.fetchStatus();
  assert.equal(result.published.versions[0], "0.7.0");
  assert.equal(fetchImpl.calls.length, 2);
  assert.deepEqual(delays, [10_000]);
});

test("the reconcile CLI fails the readiness gate for a blocked store state", async () => {
  const fetchImpl = sequenceFetch([
    jsonResponse(status({ published: revision("PUBLISHED", "0.9.0") })),
  ]);
  await assert.rejects(
    runCli(
      ["reconcile"],
      {
        CWS_ACCESS_TOKEN: "test-token",
        CWS_PUBLISHER_ID: PUBLISHER_ID,
        CWS_EXTENSION_ID: ITEM_ID,
        CWS_VERSION: VERSION,
      },
      { fetchImpl, sleep: async () => {} },
    ),
    (error) => error instanceof CwsError && error.code === "NEWER_VERSION_EXISTS",
  );
});

test("release uploads the exact bytes once and publishes with the fixed safe policy", async () => {
  const packageBytes = Buffer.from("immutable extension zip");
  const digest = createHash("sha256").update(packageBytes).digest("hex");
  const fetchImpl = sequenceFetch([
    jsonResponse(status({ published: revision("PUBLISHED", "0.7.0") })),
    jsonResponse({
      name: `publishers/${PUBLISHER_ID}/items/${ITEM_ID}`,
      itemId: ITEM_ID,
      crxVersion: VERSION,
      uploadState: "SUCCEEDED",
    }),
    jsonResponse(status({ published: revision("PUBLISHED", "0.7.0") })),
    jsonResponse({
      name: `publishers/${PUBLISHER_ID}/items/${ITEM_ID}`,
      itemId: ITEM_ID,
      state: "PENDING_REVIEW",
    }),
    jsonResponse(
      status({
        published: revision("PUBLISHED", "0.7.0"),
        submitted: revision("PENDING_REVIEW", VERSION),
      }),
    ),
  ]);

  const result = await releaseExactPackage({
    client: clientFor(fetchImpl),
    version: VERSION,
    exactPackage: { bytes: packageBytes, sha256: digest, size: packageBytes.length },
  });

  assert.equal(result.outcome, "submitted");
  assert.equal(result.uploadReceipt.sha256, digest);
  assert.equal(fetchImpl.calls.filter((call) => call.init.method === "POST").length, 2);

  const uploadCall = fetchImpl.calls[1];
  assert.match(uploadCall.url, /\/upload\/v2\/publishers\//);
  assert.strictEqual(uploadCall.init.body, packageBytes);
  assert.equal(uploadCall.init.headers["Content-Type"], "application/zip");

  const publishCall = fetchImpl.calls[3];
  assert.deepEqual(JSON.parse(publishCall.init.body), {
    publishType: "DEFAULT_PUBLISH",
    deployInfos: [{ deployPercentage: 100 }],
    skipReview: false,
    blockOnWarnings: true,
  });
});

test("publish warning details are structured and the POST is not retried", async () => {
  const fetchImpl = sequenceFetch([
    jsonResponse(status({ published: revision("PUBLISHED", "0.7.0") })),
    jsonResponse(
      {
        error: {
          code: 400,
          message: "Validation warnings blocked publishing",
          status: "FAILED_PRECONDITION",
          details: [
            {
              "@type": "type.googleapis.com/chromewebstore.v2.WarningsInfo",
              warnings: [{ reason: "MISSING_JUSTIFICATION", description: "Add a justification." }],
            },
          ],
        },
      },
      400,
    ),
  ]);

  await assert.rejects(
    publishUploadedPackage({
      client: clientFor(fetchImpl),
      version: VERSION,
      expectedSha256: SHA256,
      receipt: uploadReceipt(),
    }),
    (error) => {
      assert.ok(error instanceof CwsError);
      assert.equal(error.code, "CWS_VALIDATION_WARNING");
      assert.deepEqual(error.warnings, [
        { reason: "MISSING_JUSTIFICATION", description: "Add a justification." },
      ]);
      return true;
    },
  );
  assert.equal(fetchImpl.calls.filter((call) => call.init.method === "POST").length, 1);
  assert.equal(fetchImpl.remaining.length, 0);
});

test("release exposes the upload receipt before a later publish warning", async () => {
  const packageBytes = Buffer.from("receipt survives publish failure");
  const digest = createHash("sha256").update(packageBytes).digest("hex");
  const fetchImpl = sequenceFetch([
    jsonResponse(status({ published: revision("PUBLISHED", "0.7.0") })),
    jsonResponse({
      name: `publishers/${PUBLISHER_ID}/items/${ITEM_ID}`,
      itemId: ITEM_ID,
      crxVersion: VERSION,
      uploadState: "SUCCEEDED",
    }),
    jsonResponse(status({ published: revision("PUBLISHED", "0.7.0") })),
    jsonResponse(
      {
        error: {
          code: 400,
          message: "Validation warning",
          status: "FAILED_PRECONDITION",
          details: [
            {
              warnings: [{ reason: "STORE_METADATA", description: "Fix listing metadata." }],
            },
          ],
        },
      },
      400,
    ),
  ]);
  let persistedReceipt;

  await assert.rejects(
    releaseExactPackage({
      client: clientFor(fetchImpl),
      version: VERSION,
      exactPackage: { bytes: packageBytes, sha256: digest, size: packageBytes.length },
      onUploadReceipt: async (receipt) => {
        persistedReceipt = receipt;
      },
    }),
    (error) => error instanceof CwsError && error.code === "CWS_VALIDATION_WARNING",
  );
  assert.equal(persistedReceipt.sha256, digest);
  assert.equal(persistedReceipt.version, VERSION);
});

test("an ambiguous publish is reconciled through fetchStatus without a second POST", async () => {
  const fetchImpl = sequenceFetch([
    jsonResponse(status({ published: revision("PUBLISHED", "0.7.0") })),
    new TypeError("connection reset"),
    jsonResponse(
      status({
        published: revision("PUBLISHED", "0.7.0"),
        submitted: revision("PENDING_REVIEW", VERSION),
      }),
    ),
  ]);

  const result = await publishUploadedPackage({
    client: clientFor(fetchImpl),
    version: VERSION,
    expectedSha256: SHA256,
    receipt: uploadReceipt(),
  });
  assert.equal(result.outcome, "submitted");
  assert.equal(fetchImpl.calls.filter((call) => call.init.method === "POST").length, 1);
});

test("malformed 2xx mutation responses reconcile status instead of repeating POST", async () => {
  const packageBytes = Buffer.from("malformed response package");
  const digest = createHash("sha256").update(packageBytes).digest("hex");
  const pendingStatus = status({
    published: revision("PUBLISHED", "0.7.0"),
    submitted: revision("PENDING_REVIEW", VERSION),
  });
  const uploadFetch = sequenceFetch([
    jsonResponse(status({ published: revision("PUBLISHED", "0.7.0") })),
    jsonResponse({
      name: `publishers/${PUBLISHER_ID}/items/${ITEM_ID}`,
      itemId: ITEM_ID,
      // Deliberately missing uploadState after a successful HTTP response.
    }),
    jsonResponse(pendingStatus),
  ]);
  const uploadResult = await uploadExactPackage({
    client: clientFor(uploadFetch),
    version: VERSION,
    exactPackage: { bytes: packageBytes, sha256: digest, size: packageBytes.length },
  });
  assert.equal(uploadResult.outcome, "submitted");
  assert.equal(uploadFetch.calls.filter((call) => call.init.method === "POST").length, 1);

  const publishFetch = sequenceFetch([
    jsonResponse(status({ published: revision("PUBLISHED", "0.7.0") })),
    jsonResponse({
      name: `publishers/${PUBLISHER_ID}/items/${ITEM_ID}`,
      itemId: ITEM_ID,
      // Deliberately missing state after a successful HTTP response.
    }),
    jsonResponse(pendingStatus),
  ]);
  const publishResult = await publishUploadedPackage({
    client: clientFor(publishFetch),
    version: VERSION,
    expectedSha256: SHA256,
    receipt: uploadReceipt(),
  });
  assert.equal(publishResult.outcome, "submitted");
  assert.equal(publishFetch.calls.filter((call) => call.init.method === "POST").length, 1);
});

test("an ambiguous upload can be reconciled from a new async state transition", async () => {
  const packageBytes = Buffer.from("zip");
  const digest = createHash("sha256").update(packageBytes).digest("hex");
  const fetchImpl = sequenceFetch([
    jsonResponse(status({ published: revision("PUBLISHED", "0.7.0") })),
    new TypeError("connection reset"),
    jsonResponse(
      status({
        published: revision("PUBLISHED", "0.7.0"),
        lastAsyncUploadState: "IN_PROGRESS",
      }),
    ),
    jsonResponse(
      status({
        published: revision("PUBLISHED", "0.7.0"),
        lastAsyncUploadState: "SUCCEEDED",
      }),
    ),
  ]);

  const result = await uploadExactPackage({
    client: clientFor(fetchImpl),
    version: VERSION,
    exactPackage: { bytes: packageBytes, sha256: digest, size: packageBytes.length },
  });
  assert.equal(result.outcome, "uploaded");
  assert.equal(result.receipt.evidence, "fetch-status");
  assert.equal(fetchImpl.calls.filter((call) => call.init.method === "POST").length, 1);
});

test("an accepted async upload ignores a stale pre-existing SUCCEEDED state", async () => {
  const packageBytes = Buffer.from("async zip");
  const digest = createHash("sha256").update(packageBytes).digest("hex");
  const fetchImpl = sequenceFetch([
    jsonResponse(
      status({
        published: revision("PUBLISHED", "0.7.0"),
        lastAsyncUploadState: "SUCCEEDED",
      }),
    ),
    jsonResponse({
      name: `publishers/${PUBLISHER_ID}/items/${ITEM_ID}`,
      itemId: ITEM_ID,
      uploadState: "IN_PROGRESS",
    }),
    // This first success is indistinguishable from the baseline's retained
    // async-upload state, so it must not mint a receipt for the new package.
    jsonResponse(
      status({
        published: revision("PUBLISHED", "0.7.0"),
        lastAsyncUploadState: "SUCCEEDED",
      }),
    ),
    jsonResponse(
      status({
        published: revision("PUBLISHED", "0.7.0"),
        lastAsyncUploadState: "IN_PROGRESS",
      }),
    ),
    jsonResponse(
      status({
        published: revision("PUBLISHED", "0.7.0"),
        lastAsyncUploadState: "SUCCEEDED",
      }),
    ),
  ]);

  const result = await uploadExactPackage({
    client: clientFor(fetchImpl),
    version: VERSION,
    exactPackage: { bytes: packageBytes, sha256: digest, size: packageBytes.length },
  });
  assert.equal(result.outcome, "uploaded");
  assert.equal(result.receipt.evidence, "fetch-status");
  assert.equal(fetchImpl.calls.length, 5);
});

test("an ambiguous upload fails closed when fetchStatus only shows a stale success", async () => {
  const packageBytes = Buffer.from("zip");
  const digest = createHash("sha256").update(packageBytes).digest("hex");
  const staleStatus = status({
    published: revision("PUBLISHED", "0.7.0"),
    lastAsyncUploadState: "SUCCEEDED",
  });
  const fetchImpl = sequenceFetch([
    jsonResponse(staleStatus),
    new TypeError("connection reset"),
    jsonResponse(staleStatus),
    jsonResponse(staleStatus),
  ]);

  await assert.rejects(
    uploadExactPackage({
      client: clientFor(fetchImpl, { pollAttempts: 2 }),
      version: VERSION,
      exactPackage: { bytes: packageBytes, sha256: digest, size: packageBytes.length },
    }),
    (error) => error instanceof CwsError && error.code === "AMBIGUOUS_UPLOAD",
  );
  assert.equal(fetchImpl.calls.filter((call) => call.init.method === "POST").length, 1);
});

test("publishing an unobservable draft requires a matching upload receipt", async () => {
  const fetchImpl = sequenceFetch([
    jsonResponse(status({ published: revision("PUBLISHED", "0.7.0") })),
  ]);
  await assert.rejects(
    publishUploadedPackage({
      client: clientFor(fetchImpl),
      version: VERSION,
      expectedSha256: SHA256,
    }),
    (error) => error instanceof CwsError && error.code === "UPLOAD_RECEIPT_REQUIRED",
  );
  assert.equal(fetchImpl.calls.length, 1);
});

test("loadExactPackage binds the uploaded bytes to the caller-provided SHA-256", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "apogee-cws-test-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "extension.zip");
  const bytes = Buffer.from("verified package bytes");
  const digest = createHash("sha256").update(bytes).digest("hex");
  await writeFile(path, bytes);

  const exactPackage = await loadExactPackage({ zipPath: path, expectedSha256: digest });
  assert.deepEqual(exactPackage.bytes, bytes);
  assert.equal(exactPackage.sha256, digest);

  await assert.rejects(
    loadExactPackage({ zipPath: path, expectedSha256: "0".repeat(64) }),
    (error) => error instanceof CwsError && error.code === "PACKAGE_DIGEST_MISMATCH",
  );
});

test("split upload and publish CLI commands hand off a non-secret receipt file", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "apogee-cws-split-test-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const zipPath = join(directory, "extension.zip");
  const receiptPath = join(directory, "upload-receipt.json");
  const bytes = Buffer.from("split command package");
  const digest = createHash("sha256").update(bytes).digest("hex");
  await writeFile(zipPath, bytes);
  const environment = {
    CWS_ACCESS_TOKEN: "test-token",
    CWS_PUBLISHER_ID: PUBLISHER_ID,
    CWS_EXTENSION_ID: ITEM_ID,
    CWS_VERSION: VERSION,
    CWS_ZIP_PATH: zipPath,
    CWS_ZIP_SHA256: digest,
    CWS_UPLOAD_RECEIPT_PATH: receiptPath,
    CWS_MUTATION_ATTEMPT_ID: UPLOAD_ATTEMPT_ID,
  };

  const prepareUploadFetch = sequenceFetch([
    jsonResponse(status({ published: revision("PUBLISHED", "0.7.0") })),
  ]);
  const prepareUploadResult = await runCli(["prepare-upload"], environment, {
    fetchImpl: prepareUploadFetch,
    sleep: async () => {},
  });
  assert.equal(prepareUploadResult.outcome, "prepared");
  assert.equal(prepareUploadFetch.calls.filter((call) => call.init.method === "POST").length, 0);
  const preparedUpload = JSON.parse(await readFile(receiptPath, "utf8"));
  assert.deepEqual(preparedUpload.mutationGuard, {
    operation: "upload",
    state: "prepared",
    attemptId: UPLOAD_ATTEMPT_ID,
    baselineAsyncUploadState: null,
  });

  const uploadFetch = sequenceFetch([
    jsonResponse(status({ published: revision("PUBLISHED", "0.7.0") })),
    jsonResponse(status({ published: revision("PUBLISHED", "0.7.0") })),
    jsonResponse({
      name: `publishers/${PUBLISHER_ID}/items/${ITEM_ID}`,
      itemId: ITEM_ID,
      crxVersion: VERSION,
      uploadState: "SUCCEEDED",
    }),
  ]);
  const uploadResult = await runCli(["upload"], environment, {
    fetchImpl: uploadFetch,
    sleep: async () => {},
  });
  assert.equal(uploadResult.outcome, "uploaded");
  const persistedReceipt = JSON.parse(await readFile(receiptPath, "utf8"));
  assert.equal(persistedReceipt.sha256, digest);
  assert.equal(persistedReceipt.mutationGuard, undefined);

  environment.CWS_MUTATION_ATTEMPT_ID = PUBLISH_ATTEMPT_ID;
  const preparePublishFetch = sequenceFetch([
    jsonResponse(status({ published: revision("PUBLISHED", "0.7.0") })),
  ]);
  const preparePublishResult = await runCli(["prepare-publish"], environment, {
    fetchImpl: preparePublishFetch,
    sleep: async () => {},
  });
  assert.equal(preparePublishResult.outcome, "prepared");
  const preparedPublish = JSON.parse(await readFile(receiptPath, "utf8"));
  assert.deepEqual(preparedPublish.mutationGuard, {
    operation: "publish",
    state: "prepared",
    attemptId: PUBLISH_ATTEMPT_ID,
  });

  const publishFetch = sequenceFetch([
    jsonResponse(status({ published: revision("PUBLISHED", "0.7.0") })),
    jsonResponse({
      name: `publishers/${PUBLISHER_ID}/items/${ITEM_ID}`,
      itemId: ITEM_ID,
      state: "PENDING_REVIEW",
    }),
    jsonResponse(
      status({
        published: revision("PUBLISHED", "0.7.0"),
        submitted: revision("PENDING_REVIEW", VERSION),
      }),
    ),
  ]);
  const publishResult = await runCli(["publish"], environment, {
    fetchImpl: publishFetch,
    sleep: async () => {},
  });
  assert.equal(publishResult.outcome, "submitted");
  assert.equal(publishFetch.calls.filter((call) => call.init.method === "POST").length, 1);
  const acceptedPublish = JSON.parse(await readFile(receiptPath, "utf8"));
  assert.deepEqual(acceptedPublish.mutationGuard, {
    operation: "publish",
    state: "accepted",
    attemptId: PUBLISH_ATTEMPT_ID,
    outcome: "submitted",
  });
});

test("a prior prepared upload checkpoint blocks a new attempt before POST", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "apogee-cws-upload-replay-test-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const zipPath = join(directory, "extension.zip");
  const receiptPath = join(directory, "mutation-journal.json");
  const bytes = Buffer.from("ambiguous upload package");
  const digest = createHash("sha256").update(bytes).digest("hex");
  await writeFile(zipPath, bytes);
  const environment = {
    CWS_ACCESS_TOKEN: "test-token",
    CWS_PUBLISHER_ID: PUBLISHER_ID,
    CWS_EXTENSION_ID: ITEM_ID,
    CWS_VERSION: VERSION,
    CWS_ZIP_PATH: zipPath,
    CWS_ZIP_SHA256: digest,
    CWS_UPLOAD_RECEIPT_PATH: receiptPath,
    CWS_MUTATION_ATTEMPT_ID: UPLOAD_ATTEMPT_ID,
  };
  const oldStatus = status({ published: revision("PUBLISHED", "0.7.0") });
  const prepareFetch = sequenceFetch([jsonResponse(oldStatus)]);
  const prepared = await runCli(["prepare-upload"], environment, {
    fetchImpl: prepareFetch,
    sleep: async () => {},
  });
  assert.equal(prepared.outcome, "prepared");
  const journal = JSON.parse(await readFile(receiptPath, "utf8"));
  assert.equal(journal.mutationGuard.state, "prepared");
  assert.equal(journal.mutationGuard.attemptId, UPLOAD_ATTEMPT_ID);

  environment.CWS_MUTATION_ATTEMPT_ID = "run-1-upload-2";
  const rerunFetch = sequenceFetch([jsonResponse(oldStatus)]);
  await assert.rejects(
    runCli(["upload"], environment, {
      fetchImpl: rerunFetch,
      sleep: async () => {},
    }),
    (error) => error instanceof CwsError && error.code === "UPLOAD_NOT_PREPARED",
  );
  assert.equal(rerunFetch.calls.filter((call) => call.init.method === "POST").length, 0);

  const reprepareFetch = sequenceFetch([jsonResponse(oldStatus)]);
  await assert.rejects(
    runCli(["prepare-upload"], environment, {
      fetchImpl: reprepareFetch,
      sleep: async () => {},
    }),
    (error) => error instanceof CwsError && error.code === "UPLOAD_PREPARATION_BLOCKED",
  );
  assert.equal(reprepareFetch.calls.filter((call) => call.init.method === "POST").length, 0);
});

test("a prior prepared publish checkpoint blocks a new attempt before POST", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "apogee-cws-publish-replay-test-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const receiptPath = join(directory, "mutation-journal.json");
  await writeFile(receiptPath, `${JSON.stringify(uploadReceipt())}\n`);
  const environment = {
    CWS_ACCESS_TOKEN: "test-token",
    CWS_PUBLISHER_ID: PUBLISHER_ID,
    CWS_EXTENSION_ID: ITEM_ID,
    CWS_VERSION: VERSION,
    CWS_ZIP_SHA256: SHA256,
    CWS_UPLOAD_RECEIPT_PATH: receiptPath,
    CWS_MUTATION_ATTEMPT_ID: PUBLISH_ATTEMPT_ID,
  };
  const oldStatus = status({ published: revision("PUBLISHED", "0.7.0") });
  const prepareFetch = sequenceFetch([jsonResponse(oldStatus)]);
  const prepared = await runCli(["prepare-publish"], environment, {
    fetchImpl: prepareFetch,
    sleep: async () => {},
  });
  assert.equal(prepared.outcome, "prepared");
  const journal = JSON.parse(await readFile(receiptPath, "utf8"));
  assert.equal(journal.mutationGuard.state, "prepared");
  assert.equal(journal.mutationGuard.attemptId, PUBLISH_ATTEMPT_ID);

  environment.CWS_MUTATION_ATTEMPT_ID = "run-1-publish-2";
  const rerunFetch = sequenceFetch([jsonResponse(oldStatus)]);
  await assert.rejects(
    runCli(["publish"], environment, {
      fetchImpl: rerunFetch,
      sleep: async () => {},
    }),
    (error) => error instanceof CwsError && error.code === "PUBLISH_NOT_PREPARED",
  );
  assert.equal(rerunFetch.calls.filter((call) => call.init.method === "POST").length, 0);
});

test("a file-backed publish guard takes precedence over an older inline receipt", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "apogee-cws-receipt-precedence-test-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const receiptPath = join(directory, "mutation-journal.json");
  const plainReceipt = uploadReceipt();
  const oldStatus = status({ published: revision("PUBLISHED", "0.7.0") });
  for (const guardState of ["prepared", "started", "ambiguous", "accepted"]) {
    await writeFile(
      receiptPath,
      `${JSON.stringify({
        ...plainReceipt,
        mutationGuard: {
          operation: "publish",
          state: guardState,
          attemptId: "older-publish-attempt",
        },
      })}\n`,
    );
    const fetchImpl = sequenceFetch([jsonResponse(oldStatus)]);
    await assert.rejects(
      runCli(
        ["publish"],
        {
          CWS_ACCESS_TOKEN: "test-token",
          CWS_PUBLISHER_ID: PUBLISHER_ID,
          CWS_EXTENSION_ID: ITEM_ID,
          CWS_VERSION: VERSION,
          CWS_ZIP_SHA256: SHA256,
          CWS_UPLOAD_RECEIPT: JSON.stringify(plainReceipt),
          CWS_UPLOAD_RECEIPT_PATH: receiptPath,
          CWS_MUTATION_ATTEMPT_ID: PUBLISH_ATTEMPT_ID,
        },
        { fetchImpl, sleep: async () => {} },
      ),
      (error) => error instanceof CwsError && error.code === "PUBLISH_NOT_PREPARED",
    );
    assert.equal(fetchImpl.calls.filter((call) => call.init.method === "POST").length, 0);
  }
});

test("accepted mutations stay guarded when their verification GET fails", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "apogee-cws-accepted-guard-test-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const zipPath = join(directory, "extension.zip");
  const receiptPath = join(directory, "mutation-journal.json");
  const bytes = Buffer.from("accepted async package");
  const digest = createHash("sha256").update(bytes).digest("hex");
  await writeFile(zipPath, bytes);
  const oldStatus = status({ published: revision("PUBLISHED", "0.7.0") });
  const environment = {
    CWS_ACCESS_TOKEN: "test-token",
    CWS_PUBLISHER_ID: PUBLISHER_ID,
    CWS_EXTENSION_ID: ITEM_ID,
    CWS_VERSION: VERSION,
    CWS_ZIP_PATH: zipPath,
    CWS_ZIP_SHA256: digest,
    CWS_UPLOAD_RECEIPT_PATH: receiptPath,
    CWS_MUTATION_ATTEMPT_ID: UPLOAD_ATTEMPT_ID,
  };
  const unavailable = () =>
    jsonResponse({ error: { message: "status unavailable", status: "UNAVAILABLE" } }, 503);

  const prepareUploadFetch = sequenceFetch([jsonResponse(oldStatus)]);
  await runCli(["prepare-upload"], environment, {
    fetchImpl: prepareUploadFetch,
    sleep: async () => {},
  });

  const uploadFetch = sequenceFetch([
    jsonResponse(oldStatus),
    jsonResponse(oldStatus),
    jsonResponse({
      name: `publishers/${PUBLISHER_ID}/items/${ITEM_ID}`,
      itemId: ITEM_ID,
      uploadState: "IN_PROGRESS",
    }),
    unavailable(),
    unavailable(),
  ]);
  await assert.rejects(
    runCli(["upload"], environment, {
      fetchImpl: uploadFetch,
      sleep: async () => {},
      getAttempts: 1,
    }),
    (error) => error instanceof CwsError && error.ambiguous === true,
  );
  assert.equal(
    JSON.parse(await readFile(receiptPath, "utf8")).mutationGuard.state,
    "ambiguous",
  );

  // Reset to a confirmed upload receipt to exercise the publish half.
  const publishReceipt = uploadReceipt(digest);
  await writeFile(receiptPath, `${JSON.stringify(publishReceipt)}\n`);
  environment.CWS_MUTATION_ATTEMPT_ID = PUBLISH_ATTEMPT_ID;
  const preparePublishFetch = sequenceFetch([jsonResponse(oldStatus)]);
  await runCli(["prepare-publish"], environment, {
    fetchImpl: preparePublishFetch,
    sleep: async () => {},
  });
  const publishFetch = sequenceFetch([
    jsonResponse(oldStatus),
    jsonResponse({
      name: `publishers/${PUBLISHER_ID}/items/${ITEM_ID}`,
      itemId: ITEM_ID,
      state: "PENDING_REVIEW",
    }),
    unavailable(),
  ]);
  const publishResult = await runCli(["publish"], environment, {
    fetchImpl: publishFetch,
    sleep: async () => {},
    getAttempts: 1,
  });
  assert.equal(publishResult.outcome, "submitted");
  assert.equal(publishResult.verificationPending, true);
  assert.equal(
    JSON.parse(await readFile(receiptPath, "utf8")).mutationGuard.state,
    "accepted",
  );

  environment.CWS_MUTATION_ATTEMPT_ID = "run-2-publish-1";
  const rerunFetch = sequenceFetch([jsonResponse(oldStatus)]);
  await assert.rejects(
    runCli(["publish"], environment, {
      fetchImpl: rerunFetch,
      sleep: async () => {},
    }),
    (error) => error instanceof CwsError && error.code === "PUBLISH_NOT_PREPARED",
  );
  assert.equal(rerunFetch.calls.filter((call) => call.init.method === "POST").length, 0);
});

test("a definitive publish warning restores the receipt for an explicit remediation retry", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "apogee-cws-warning-retry-test-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const receiptPath = join(directory, "mutation-journal.json");
  await writeFile(receiptPath, `${JSON.stringify(uploadReceipt())}\n`);
  const environment = {
    CWS_ACCESS_TOKEN: "test-token",
    CWS_PUBLISHER_ID: PUBLISHER_ID,
    CWS_EXTENSION_ID: ITEM_ID,
    CWS_VERSION: VERSION,
    CWS_ZIP_SHA256: SHA256,
    CWS_UPLOAD_RECEIPT_PATH: receiptPath,
    CWS_MUTATION_ATTEMPT_ID: PUBLISH_ATTEMPT_ID,
  };
  const oldStatus = status({ published: revision("PUBLISHED", "0.7.0") });
  const prepareWarningAttemptFetch = sequenceFetch([jsonResponse(oldStatus)]);
  const preparedWarningAttempt = await runCli(["prepare-publish"], environment, {
    fetchImpl: prepareWarningAttemptFetch,
    sleep: async () => {},
  });
  assert.equal(preparedWarningAttempt.outcome, "prepared");
  const warningFetch = sequenceFetch([
    jsonResponse(oldStatus),
    jsonResponse(
      {
        error: {
          code: 400,
          message: "Validation warning",
          status: "FAILED_PRECONDITION",
          details: [
            { warnings: [{ reason: "STORE_METADATA", description: "Fix metadata." }] },
          ],
        },
      },
      400,
    ),
  ]);
  await assert.rejects(
    runCli(["publish"], environment, {
      fetchImpl: warningFetch,
      sleep: async () => {},
    }),
    (error) => error instanceof CwsError && error.code === "CWS_VALIDATION_WARNING",
  );
  const restoredReceipt = JSON.parse(await readFile(receiptPath, "utf8"));
  assert.equal(restoredReceipt.uploadState, "SUCCEEDED");
  assert.equal(restoredReceipt.mutationGuard, undefined);

  environment.CWS_MUTATION_ATTEMPT_ID = "run-2-publish-1";
  const prepareRetryFetch = sequenceFetch([jsonResponse(oldStatus)]);
  const preparedRetry = await runCli(["prepare-publish"], environment, {
    fetchImpl: prepareRetryFetch,
    sleep: async () => {},
  });
  assert.equal(preparedRetry.outcome, "prepared");
  assert.equal(
    JSON.parse(await readFile(receiptPath, "utf8")).mutationGuard.attemptId,
    "run-2-publish-1",
  );

  const retryFetch = sequenceFetch([
    jsonResponse(oldStatus),
    jsonResponse({
      name: `publishers/${PUBLISHER_ID}/items/${ITEM_ID}`,
      itemId: ITEM_ID,
      state: "PENDING_REVIEW",
    }),
    jsonResponse(
      status({
        published: revision("PUBLISHED", "0.7.0"),
        submitted: revision("PENDING_REVIEW", VERSION),
      }),
    ),
  ]);
  const result = await runCli(["publish"], environment, {
    fetchImpl: retryFetch,
    sleep: async () => {},
  });
  assert.equal(result.outcome, "submitted");
  assert.equal(retryFetch.calls.filter((call) => call.init.method === "POST").length, 1);
});

test("the combined release CLI is disabled because mutations need separate durable checkpoints", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "apogee-cws-release-rerun-test-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const zipPath = join(directory, "extension.zip");
  const receiptPath = join(directory, "mutation-journal.json");
  const bytes = Buffer.from("combined release retry package");
  const digest = createHash("sha256").update(bytes).digest("hex");
  await writeFile(zipPath, bytes);
  const environment = {
    CWS_ACCESS_TOKEN: "test-token",
    CWS_PUBLISHER_ID: PUBLISHER_ID,
    CWS_EXTENSION_ID: ITEM_ID,
    CWS_VERSION: VERSION,
    CWS_ZIP_PATH: zipPath,
    CWS_ZIP_SHA256: digest,
    CWS_UPLOAD_RECEIPT_PATH: receiptPath,
  };
  const firstFetch = sequenceFetch([]);
  await assert.rejects(
    runCli(["release"], environment, {
      fetchImpl: firstFetch,
      sleep: async () => {},
    }),
    (error) =>
      error instanceof CwsError && error.code === "UNSAFE_COMBINED_RELEASE_DISABLED",
  );
  assert.equal(firstFetch.calls.length, 0);
});

test("prepare-publish no-ops when fetchStatus already shows the exact target", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "apogee-cws-observed-submit-test-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const receiptPath = join(directory, "missing-journal.json");
  const fetchImpl = sequenceFetch([
    jsonResponse(
      status({
        published: revision("PUBLISHED", "0.7.0"),
        submitted: revision("PENDING_REVIEW", VERSION),
      }),
    ),
  ]);

  const result = await runCli(
    ["prepare-publish"],
    {
      CWS_ACCESS_TOKEN: "test-token",
      CWS_PUBLISHER_ID: PUBLISHER_ID,
      CWS_EXTENSION_ID: ITEM_ID,
      CWS_VERSION: VERSION,
      CWS_ZIP_SHA256: SHA256,
      CWS_UPLOAD_RECEIPT_PATH: receiptPath,
      CWS_MUTATION_ATTEMPT_ID: PUBLISH_ATTEMPT_ID,
    },
    { fetchImpl, sleep: async () => {} },
  );

  assert.equal(result.outcome, "submitted");
  assert.equal(fetchImpl.calls.filter((call) => call.init.method === "POST").length, 0);
  await assert.rejects(readFile(receiptPath, "utf8"), (error) => error?.code === "ENOENT");
});

test("mutation commands never POST without a matching prepared journal", async () => {
  const directory = await mkdtemp(join(tmpdir(), "apogee-cws-no-journal-test-"));
  const zipPath = join(directory, "extension.zip");
  const receiptPath = join(directory, "mutation-journal.json");
  const bytes = Buffer.from("must journal before upload");
  const digest = createHash("sha256").update(bytes).digest("hex");
  await writeFile(zipPath, bytes);
  try {
    const fetchImpl = sequenceFetch([
      jsonResponse(status({ published: revision("PUBLISHED", "0.7.0") })),
    ]);
    await assert.rejects(
      runCli(
        ["upload"],
        {
          CWS_ACCESS_TOKEN: "test-token",
          CWS_PUBLISHER_ID: PUBLISHER_ID,
          CWS_EXTENSION_ID: ITEM_ID,
          CWS_VERSION: VERSION,
          CWS_ZIP_PATH: zipPath,
          CWS_ZIP_SHA256: digest,
          CWS_UPLOAD_RECEIPT_PATH: receiptPath,
          CWS_MUTATION_ATTEMPT_ID: UPLOAD_ATTEMPT_ID,
        },
        { fetchImpl, sleep: async () => {} },
      ),
      (error) => error instanceof CwsError && error.code === "UPLOAD_NOT_PREPARED",
    );
    assert.equal(fetchImpl.calls.filter((call) => call.init.method === "POST").length, 0);

    await writeFile(receiptPath, `${JSON.stringify(uploadReceipt(digest))}\n`);
    const publishFetch = sequenceFetch([
      jsonResponse(status({ published: revision("PUBLISHED", "0.7.0") })),
    ]);
    await assert.rejects(
      runCli(
        ["publish"],
        {
          CWS_ACCESS_TOKEN: "test-token",
          CWS_PUBLISHER_ID: PUBLISHER_ID,
          CWS_EXTENSION_ID: ITEM_ID,
          CWS_VERSION: VERSION,
          CWS_ZIP_SHA256: digest,
          CWS_UPLOAD_RECEIPT_PATH: receiptPath,
          CWS_MUTATION_ATTEMPT_ID: PUBLISH_ATTEMPT_ID,
        },
        { fetchImpl: publishFetch, sleep: async () => {} },
      ),
      (error) => error instanceof CwsError && error.code === "PUBLISH_NOT_PREPARED",
    );
    assert.equal(publishFetch.calls.filter((call) => call.init.method === "POST").length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
