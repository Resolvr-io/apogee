#!/usr/bin/env node

import { createHash } from "node:crypto";
import { appendFile, readFile, stat, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const API_ORIGIN = "https://chromewebstore.googleapis.com";
const DEFAULT_GET_ATTEMPTS = 5;
const DEFAULT_POLL_ATTEMPTS = 10;
const DEFAULT_POLL_DELAY_MS = 2_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

const TRANSIENT_HTTP_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const AMBIGUOUS_MUTATION_HTTP_STATUSES = new Set([
  408,
  409,
  425,
  429,
  500,
  502,
  503,
  504,
]);

const UPLOAD_IN_PROGRESS_STATES = new Set(["IN_PROGRESS", "UPLOAD_IN_PROGRESS"]);
const PUBLIC_STATES = new Set(["PUBLISHED"]);
const ACTIVE_SUBMISSION_STATES = new Set(["PENDING_REVIEW"]);

export class CwsError extends Error {
  constructor(
    message,
    {
      code = "CWS_ERROR",
      httpStatus,
      apiStatus,
      details,
      warnings = [],
      retryable = false,
      ambiguous = false,
      retryAfter,
      cause,
    } = {},
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "CwsError";
    this.code = code;
    this.httpStatus = httpStatus;
    this.apiStatus = apiStatus;
    this.details = details;
    this.warnings = warnings;
    this.retryable = retryable;
    this.ambiguous = ambiguous;
    this.retryAfter = retryAfter;
  }

  toJSON() {
    return compactObject({
      code: this.code,
      message: this.message,
      httpStatus: this.httpStatus,
      apiStatus: this.apiStatus,
      retryable: this.retryable || undefined,
      ambiguous: this.ambiguous || undefined,
      warnings: this.warnings.length > 0 ? this.warnings : undefined,
      details: this.details,
    });
  }
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function requiredString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new CwsError(`${name} is required`, { code: "INVALID_CONFIGURATION" });
  }
  return value.trim();
}

function validateResourceId(value, name) {
  const normalized = requiredString(value, name);
  if (!/^[A-Za-z0-9._-]+$/.test(normalized)) {
    throw new CwsError(`${name} contains unsupported characters`, {
      code: "INVALID_CONFIGURATION",
    });
  }
  return normalized;
}

export function validateVersion(value) {
  const version = requiredString(value, "CWS_VERSION");
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new CwsError(`CWS_VERSION must be an exact stable X.Y.Z version; received ${version}`, {
      code: "INVALID_VERSION",
    });
  }
  const components = version.split(".").map(Number);
  if (components.some((component) => component > 65_535) || components.every((component) => component === 0)) {
    throw new CwsError(
      `CWS_VERSION must use Chrome components from 0 to 65535 and cannot be all zero; received ${version}`,
      { code: "INVALID_VERSION" },
    );
  }
  return version;
}

function parseVersion(value) {
  if (typeof value !== "string" || !/^\d+(?:\.\d+){0,3}$/.test(value)) return undefined;
  const components = value.split(".").map(Number);
  if (components.some((component) => component > 65_535)) return undefined;
  return components;
}

export function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return undefined;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

function revisionSummary(revision) {
  if (!revision || typeof revision !== "object") return undefined;
  const channels = Array.isArray(revision.distributionChannels)
    ? revision.distributionChannels.map((channel) =>
        compactObject({
          crxVersion: channel?.crxVersion,
          deployPercentage: channel?.deployPercentage,
        }),
      )
    : [];
  return {
    state: revision.state,
    distributionChannels: channels,
    versions: [...new Set(channels.map((channel) => channel.crxVersion).filter(Boolean))],
  };
}

export function normalizeStatus(rawStatus) {
  if (!rawStatus || typeof rawStatus !== "object") {
    throw new CwsError("fetchStatus returned a non-object response", {
      code: "INVALID_API_RESPONSE",
      details: rawStatus,
    });
  }
  return compactObject({
    name: rawStatus.name,
    itemId: rawStatus.itemId,
    published: revisionSummary(rawStatus.publishedItemRevisionStatus),
    submitted: revisionSummary(rawStatus.submittedItemRevisionStatus),
    lastAsyncUploadState: rawStatus.lastAsyncUploadState,
    takenDown: rawStatus.takenDown === true,
    warned: rawStatus.warned === true,
  });
}

function containsVersion(revision, expectedVersion) {
  return (
    revision?.versions?.some((version) => compareVersions(version, expectedVersion) === 0) === true
  );
}

function highestKnownVersion(status) {
  const versions = [
    ...(status.published?.versions ?? []),
    ...(status.submitted?.versions ?? []),
  ].filter((version) => parseVersion(version));
  return versions.sort((left, right) => compareVersions(right, left))[0];
}

function validateSha256(value) {
  const digest = requiredString(value, "CWS_ZIP_SHA256").toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(digest)) {
    throw new CwsError("CWS_ZIP_SHA256 must contain exactly 64 hexadecimal characters", {
      code: "INVALID_PACKAGE_DIGEST",
    });
  }
  return digest;
}

function validateMutationAttemptId(value) {
  const attemptId = requiredString(value, "CWS_MUTATION_ATTEMPT_ID");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(attemptId)) {
    throw new CwsError(
      "CWS_MUTATION_ATTEMPT_ID must be 1-128 safe identifier characters",
      { code: "INVALID_MUTATION_ATTEMPT_ID" },
    );
  }
  return attemptId;
}

/**
 * Turn the v2 fetchStatus representation into a conservative next action.
 *
 * fetchStatus deliberately does not expose the version or digest of an uploaded
 * but unsubmitted draft. Therefore `upload` means "there is no externally
 * observable target revision" rather than proof that no draft exists.
 */
export function reconcileStatus(rawStatus, expectedVersion) {
  const version = validateVersion(expectedVersion);
  const status = rawStatus?.published || rawStatus?.submitted ? rawStatus : normalizeStatus(rawStatus);

  if (status.takenDown) {
    return {
      action: "blocked",
      reason: "ITEM_TAKEN_DOWN",
      message: "The Chrome Web Store item is taken down; resolve the policy action in the dashboard.",
      status,
    };
  }
  if (status.warned) {
    return {
      action: "blocked",
      reason: "ITEM_POLICY_WARNING",
      message: "The Chrome Web Store item has an unresolved policy warning.",
      status,
    };
  }

  const knownVersion = highestKnownVersion(status);
  if (knownVersion && compareVersions(knownVersion, version) > 0) {
    return {
      action: "blocked",
      reason: "NEWER_VERSION_EXISTS",
      message: `Chrome Web Store already knows newer version ${knownVersion}; refusing to release ${version}.`,
      status,
    };
  }

  if (status.submitted && !containsVersion(status.submitted, version)) {
    const staleTerminalSubmission =
      (status.submitted.state === "REJECTED" || status.submitted.state === "CANCELLED") &&
      status.submitted.versions.length > 0 &&
      status.submitted.versions.every(
        (submittedVersion) => compareVersions(submittedVersion, version) < 0,
      );
    if (!staleTerminalSubmission) {
      return {
        action: "blocked",
        reason: "OTHER_SUBMISSION_EXISTS",
        message: `A different version (${status.submitted.versions.join(", ") || "unknown"}) has a ${status.submitted.state ?? "unknown"} submission.`,
        status,
      };
    }
  }

  if (status.published && status.published.versions.length === 0) {
    return {
      action: "blocked",
      reason: "PUBLISHED_VERSION_NOT_REPORTED",
      message: "Chrome reports a published revision without its package version; refusing to upload.",
      status,
    };
  }

  if (status.published && !PUBLIC_STATES.has(status.published.state)) {
    return {
      action: "blocked",
      reason: `UNEXPECTED_PUBLISHED_STATE_${status.published.state ?? "UNKNOWN"}`,
      message: `The current store revision is ${status.published.state ?? "an unknown state"}, not publicly published.`,
      status,
    };
  }

  if (containsVersion(status.submitted, version)) {
    const state = status.submitted.state;
    if (ACTIVE_SUBMISSION_STATES.has(state)) {
      const matchingChannels = status.submitted.distributionChannels.filter(
        (channel) => compareVersions(channel.crxVersion, version) === 0,
      );
      const fullyConfigured = matchingChannels.some(
        (channel) => channel.deployPercentage === 100,
      );
      if (!fullyConfigured) {
        return {
          action: "blocked",
          reason: "TARGET_SUBMISSION_NOT_AT_100_PERCENT",
          message: `${version} is pending review, but its submitted distribution is not configured for 100%.`,
          status,
        };
      }
      return {
        action: "submitted",
        reason: "TARGET_ALREADY_PENDING_REVIEW",
        message: `${version} is already pending Chrome Web Store review.`,
        status,
      };
    }
    return {
      action: "blocked",
      reason: `UNEXPECTED_TARGET_STATE_${state ?? "UNKNOWN"}`,
      message: `${version} is in unexpected submitted state ${state ?? "unknown"}; inspect the dashboard.`,
      status,
    };
  }

  if (containsVersion(status.published, version)) {
    const matchingChannels = status.published.distributionChannels.filter(
      (channel) => compareVersions(channel.crxVersion, version) === 0,
    );
    const fullyDeployed = matchingChannels.some((channel) => channel.deployPercentage === 100);
    if (!PUBLIC_STATES.has(status.published.state) || !fullyDeployed) {
      return {
        action: "blocked",
        reason: "TARGET_NOT_PUBLIC_AT_100_PERCENT",
        message: `${version} exists as ${status.published.state ?? "an unknown state"}, but is not publicly deployed at 100%.`,
        status,
      };
    }
    return {
      action: "complete",
      reason: "TARGET_ALREADY_PUBLISHED",
      message: `${version} is already published at 100%.`,
      status,
    };
  }

  if (UPLOAD_IN_PROGRESS_STATES.has(status.lastAsyncUploadState)) {
    return {
      action: "blocked",
      reason: "UNATTRIBUTED_UPLOAD_IN_PROGRESS",
      message: "An asynchronous upload is in progress, but fetchStatus cannot identify its version.",
      status,
    };
  }

  return {
    action: "upload",
    reason: "TARGET_NOT_OBSERVED",
    message: `${version} is not published or submitted and may be uploaded.`,
    status,
  };
}

function collectWarnings(value, destination = []) {
  if (Array.isArray(value)) {
    for (const entry of value) collectWarnings(entry, destination);
    return destination;
  }
  if (!value || typeof value !== "object") return destination;
  if (typeof value.reason === "string" && typeof value.description === "string") {
    destination.push({ reason: value.reason, description: value.description });
  }
  for (const [key, entry] of Object.entries(value)) {
    if (key === "warnings" || key === "warningInfo" || key === "details") {
      collectWarnings(entry, destination);
    }
  }
  return destination;
}

async function parseResponseBody(response) {
  const text = await response.text();
  if (text === "") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return { rawText: text.slice(0, 4_096) };
  }
}

function apiErrorFromResponse(response, body, operation, mutation) {
  const payload = body?.error ?? body;
  const warnings = collectWarnings(payload);
  const retryable = TRANSIENT_HTTP_STATUSES.has(response.status);
  const ambiguous = mutation && AMBIGUOUS_MUTATION_HTTP_STATUSES.has(response.status);
  return new CwsError(
    payload?.message ?? `${operation} failed with HTTP ${response.status}`,
    {
      code: warnings.length > 0 ? "CWS_VALIDATION_WARNING" : "CWS_API_ERROR",
      httpStatus: response.status,
      apiStatus: payload?.status,
      details: payload?.details,
      warnings,
      retryable,
      ambiguous,
      retryAfter: response.headers.get("retry-after") ?? undefined,
    },
  );
}

function networkError(error, operation, mutation) {
  if (error instanceof CwsError) return error;
  return new CwsError(`${operation} failed before a response was received: ${error.message}`, {
    code: mutation ? "AMBIGUOUS_MUTATION" : "CWS_NETWORK_ERROR",
    retryable: true,
    ambiguous: mutation,
    cause: error,
  });
}

function retryDelayMs(attempt, retryAfter) {
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.min(10_000, Math.max(0, seconds * 1_000));
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.min(10_000, Math.max(0, date - Date.now()));
  }
  return Math.min(4_000, 250 * 2 ** attempt);
}

export function createCwsClient({
  accessToken,
  publisherId,
  itemId,
  fetchImpl = globalThis.fetch,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  getAttempts = DEFAULT_GET_ATTEMPTS,
  pollAttempts = DEFAULT_POLL_ATTEMPTS,
  pollDelayMs = DEFAULT_POLL_DELAY_MS,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
} = {}) {
  const token = requiredString(accessToken, "CWS_ACCESS_TOKEN");
  const publisher = validateResourceId(publisherId, "CWS_PUBLISHER_ID");
  const item = validateResourceId(itemId, "CWS_EXTENSION_ID");
  if (typeof fetchImpl !== "function") {
    throw new CwsError("A fetch implementation is required", { code: "INVALID_CONFIGURATION" });
  }
  const resourceName = `publishers/${publisher}/items/${item}`;
  const resourcePath = `publishers/${encodeURIComponent(publisher)}/items/${encodeURIComponent(item)}`;

  async function requestOnce(method, url, { body, headers = {}, mutation = false } = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
    timeout.unref?.();
    try {
      const response = await fetchImpl(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          ...headers,
        },
        body,
        signal: controller.signal,
      });
      const responseBody = await parseResponseBody(response);
      if (!response.ok) throw apiErrorFromResponse(response, responseBody, method, mutation);
      return { body: responseBody, response };
    } catch (error) {
      throw networkError(error, method, mutation);
    } finally {
      clearTimeout(timeout);
    }
  }

  async function fetchStatus() {
    let lastError;
    for (let attempt = 0; attempt < getAttempts; attempt += 1) {
      try {
        const { body } = await requestOnce(
          "GET",
          `${API_ORIGIN}/v2/${resourcePath}:fetchStatus`,
        );
        const normalized = normalizeStatus(body);
        if (normalized.itemId !== item || (normalized.name && normalized.name !== resourceName)) {
          throw new CwsError("fetchStatus returned a different Chrome Web Store item", {
            code: "RESOURCE_ID_MISMATCH",
            details: { expectedName: resourceName, actualName: normalized.name, actualItemId: normalized.itemId },
          });
        }
        return normalized;
      } catch (error) {
        lastError = error;
        if (!error.retryable || attempt === getAttempts - 1) throw error;
        await sleep(retryDelayMs(attempt, error.retryAfter));
      }
    }
    throw lastError;
  }

  async function upload(packageBytes) {
    const { body } = await requestOnce(
      "POST",
      `${API_ORIGIN}/upload/v2/${resourcePath}:upload`,
      {
        body: packageBytes,
        headers: { "Content-Type": "application/zip" },
        mutation: true,
      },
    );
    if (body?.itemId !== item || (body?.name && body.name !== resourceName)) {
      throw new CwsError("upload returned a different Chrome Web Store item", {
        code: "RESOURCE_ID_MISMATCH",
        ambiguous: true,
        details: { expectedName: resourceName, actualName: body?.name, actualItemId: body?.itemId },
      });
    }
    return body;
  }

  async function publish() {
    const requestBody = {
      publishType: "DEFAULT_PUBLISH",
      deployInfos: [{ deployPercentage: 100 }],
      skipReview: false,
      blockOnWarnings: true,
    };
    const { body } = await requestOnce(
      "POST",
      `${API_ORIGIN}/v2/${resourcePath}:publish`,
      {
        body: JSON.stringify(requestBody),
        headers: { "Content-Type": "application/json" },
        mutation: true,
      },
    );
    if (body?.itemId !== item || (body?.name && body.name !== resourceName)) {
      throw new CwsError("publish returned a different Chrome Web Store item", {
        code: "RESOURCE_ID_MISMATCH",
        ambiguous: true,
        details: { expectedName: resourceName, actualName: body?.name, actualItemId: body?.itemId },
      });
    }
    return body;
  }

  return {
    publisherId: publisher,
    itemId: item,
    resourceName,
    fetchStatus,
    upload,
    publish,
    sleep,
    pollAttempts,
    pollDelayMs,
  };
}

export async function loadExactPackage({ zipPath, expectedSha256 }) {
  const path = requiredString(zipPath, "CWS_ZIP_PATH");
  const expectedDigest = validateSha256(expectedSha256);
  let metadata;
  let bytes;
  try {
    [metadata, bytes] = await Promise.all([stat(path), readFile(path)]);
  } catch (error) {
    throw new CwsError(`Unable to read Chrome package at ${path}: ${error.message}`, {
      code: "PACKAGE_READ_FAILED",
      cause: error,
    });
  }
  if (!metadata.isFile()) {
    throw new CwsError(`Chrome package path is not a regular file: ${path}`, {
      code: "PACKAGE_READ_FAILED",
    });
  }
  const actualDigest = createHash("sha256").update(bytes).digest("hex");
  if (actualDigest !== expectedDigest) {
    throw new CwsError(
      `Chrome package SHA-256 mismatch: expected ${expectedDigest}, got ${actualDigest}`,
      { code: "PACKAGE_DIGEST_MISMATCH" },
    );
  }
  return { path, bytes, sha256: actualDigest, size: bytes.byteLength };
}

function assertExactPackage(exactPackage) {
  if (!exactPackage || !(exactPackage.bytes instanceof Uint8Array)) {
    throw new CwsError("The exact Chrome package must contain immutable byte data", {
      code: "INVALID_PACKAGE",
    });
  }
  const expectedDigest = validateSha256(exactPackage.sha256);
  const actualDigest = createHash("sha256").update(exactPackage.bytes).digest("hex");
  if (actualDigest !== expectedDigest) {
    throw new CwsError(
      `In-memory Chrome package SHA-256 mismatch: expected ${expectedDigest}, got ${actualDigest}`,
      { code: "PACKAGE_DIGEST_MISMATCH" },
    );
  }
  if (exactPackage.size !== undefined && exactPackage.size !== exactPackage.bytes.byteLength) {
    throw new CwsError("In-memory Chrome package size does not match its byte length", {
      code: "PACKAGE_SIZE_MISMATCH",
    });
  }
  return { ...exactPackage, sha256: expectedDigest, size: exactPackage.bytes.byteLength };
}

function assertActionAllowed(reconciliation, allowedActions) {
  if (allowedActions.has(reconciliation.action)) return;
  throw new CwsError(reconciliation.message, {
    code: reconciliation.reason,
    details: reconciliation.status,
  });
}

async function poll(client, inspect) {
  let lastStatus;
  for (let attempt = 0; attempt < client.pollAttempts; attempt += 1) {
    lastStatus = await client.fetchStatus();
    const result = inspect(lastStatus);
    if (result) return result;
    if (attempt < client.pollAttempts - 1) await client.sleep(client.pollDelayMs);
  }
  return { status: lastStatus };
}

async function reconcileAmbiguousUpload(client, version, baselineStatus, originalError) {
  let observedInProgress = false;
  const result = await poll(client, (status) => {
    const reconciliation = reconcileStatus(status, version);
    if (reconciliation.action === "complete" || reconciliation.action === "submitted") {
      return { outcome: reconciliation.action, reconciliation, status };
    }
    if (UPLOAD_IN_PROGRESS_STATES.has(status.lastAsyncUploadState)) {
      observedInProgress = true;
      return undefined;
    }
    if (
      status.lastAsyncUploadState === "SUCCEEDED" &&
      (observedInProgress || baselineStatus.lastAsyncUploadState !== "SUCCEEDED")
    ) {
      return { outcome: "uploaded", status };
    }
    if (
      status.lastAsyncUploadState === "FAILED" &&
      (observedInProgress || baselineStatus.lastAsyncUploadState !== "FAILED")
    ) {
      throw new CwsError("Chrome reported that the asynchronous upload failed", {
        code: "UPLOAD_FAILED",
        details: status,
      });
    }
    return undefined;
  });
  if (result.outcome) return result;
  throw new CwsError(
    "The upload outcome is ambiguous. fetchStatus cannot identify the version or digest of an unsubmitted draft, so the helper will not retry the POST blindly.",
    {
      code: "AMBIGUOUS_UPLOAD",
      ambiguous: true,
      details: { originalError: originalError.toJSON(), lastStatus: result.status },
      cause: originalError,
    },
  );
}

function preserveMutationAmbiguity(operation, originalError, reconciliationError) {
  if (reconciliationError instanceof CwsError) {
    const reconciliationDetails = reconciliationError.details;
    reconciliationError.ambiguous = true;
    reconciliationError.retryable = false;
    reconciliationError.details = {
      originalMutationError: originalError.toJSON(),
      reconciliationError: reconciliationDetails,
    };
    return reconciliationError;
  }
  return new CwsError(
    `Could not reconcile an ambiguous ${operation} after the mutation request`,
    {
      code: `AMBIGUOUS_${operation.toUpperCase()}_RECONCILIATION_FAILED`,
      ambiguous: true,
      details: { originalMutationError: originalError.toJSON() },
      cause: reconciliationError,
    },
  );
}

async function waitForAcceptedUpload(client, version, uploadResponse, baselineStatus) {
  const uploadState = uploadResponse?.uploadState;
  if (uploadState === "SUCCEEDED") {
    if (compareVersions(uploadResponse.crxVersion, version) !== 0) {
      throw new CwsError(
        `Chrome accepted unexpected package version ${uploadResponse.crxVersion ?? "unknown"}; expected ${version}.`,
        { code: "UPLOADED_VERSION_MISMATCH", details: uploadResponse },
      );
    }
    return { outcome: "uploaded", uploadResponse };
  }
  if (!UPLOAD_IN_PROGRESS_STATES.has(uploadState)) {
    throw new CwsError(`Chrome returned unexpected upload state ${uploadState ?? "unknown"}`, {
      code: uploadState === "FAILED" ? "UPLOAD_FAILED" : "INVALID_API_RESPONSE",
      details: uploadResponse,
      ambiguous: uploadState !== "FAILED",
    });
  }

  let observedInProgress = false;
  const result = await poll(client, (status) => {
    if (UPLOAD_IN_PROGRESS_STATES.has(status.lastAsyncUploadState)) {
      observedInProgress = true;
      return undefined;
    }
    if (
      status.lastAsyncUploadState === "SUCCEEDED" &&
      (observedInProgress || baselineStatus.lastAsyncUploadState !== "SUCCEEDED")
    ) {
      return { outcome: "uploaded", status };
    }
    if (
      status.lastAsyncUploadState === "FAILED" &&
      (observedInProgress || baselineStatus.lastAsyncUploadState !== "FAILED")
    ) {
      throw new CwsError("Chrome reported that the asynchronous upload failed", {
        code: "UPLOAD_FAILED",
        details: status,
      });
    }
    const reconciliation = reconcileStatus(status, version);
    if (reconciliation.action === "complete" || reconciliation.action === "submitted") {
      return { outcome: reconciliation.action, reconciliation, status };
    }
    return undefined;
  });
  if (result.outcome) return { ...result, uploadResponse };
  throw new CwsError("Timed out waiting for Chrome to process the uploaded package", {
    code: "UPLOAD_PROCESSING_TIMEOUT",
    ambiguous: true,
    details: result.status,
  });
}

function makeReceipt(client, version, exactPackage, uploadResult) {
  return {
    schemaVersion: 1,
    resourceName: client.resourceName,
    version,
    sha256: exactPackage.sha256,
    size: exactPackage.size,
    uploadState: "SUCCEEDED",
    evidence: uploadResult.uploadResponse?.uploadState === "SUCCEEDED" ? "upload-response" : "fetch-status",
  };
}

function makeUploadAttempt(
  client,
  version,
  exactPackage,
  baselineStatus,
  attemptId,
  state = "prepared",
) {
  return {
    schemaVersion: 1,
    resourceName: client.resourceName,
    version,
    sha256: exactPackage.sha256,
    size: exactPackage.size,
    uploadState: "ATTEMPTED",
    mutationGuard: {
      operation: "upload",
      state,
      attemptId,
      baselineAsyncUploadState: baselineStatus.lastAsyncUploadState ?? null,
    },
  };
}

function withPublishGuard(receipt, state, extra = {}) {
  return {
    ...receipt,
    mutationGuard: {
      operation: "publish",
      state,
      ...extra,
    },
  };
}

function validateJournalIdentity(record, client, version, expectedSha256, expectedSize) {
  if (!record || typeof record !== "object") return undefined;
  const expected = {
    schemaVersion: 1,
    resourceName: client.resourceName,
    version,
    sha256: expectedSha256,
  };
  if (expectedSize !== undefined) expected.size = expectedSize;
  for (const [field, value] of Object.entries(expected)) {
    if (record[field] !== value) {
      throw new CwsError(`Mutation journal ${field} does not match the release candidate`, {
        code: "INVALID_MUTATION_JOURNAL",
        details: { field, expected: value, actual: record[field] },
      });
    }
  }
  return record;
}

export function validateReceipt(receipt, client, version, expectedSha256) {
  if (!receipt || typeof receipt !== "object") {
    throw new CwsError("A successful upload receipt is required before publishing an unsubmitted draft", {
      code: "UPLOAD_RECEIPT_REQUIRED",
    });
  }
  const expected = {
    schemaVersion: 1,
    resourceName: client.resourceName,
    version,
    sha256: expectedSha256,
    uploadState: "SUCCEEDED",
  };
  for (const [field, value] of Object.entries(expected)) {
    if (receipt[field] !== value) {
      throw new CwsError(`Upload receipt ${field} does not match the release candidate`, {
        code: "INVALID_UPLOAD_RECEIPT",
        details: { field, expected: value, actual: receipt[field] },
      });
    }
  }
  return receipt;
}

export async function uploadExactPackage({ client, version, exactPackage, beforeUpload }) {
  const releaseVersion = validateVersion(version);
  const verifiedPackage = assertExactPackage(exactPackage);
  const baselineStatus = await client.fetchStatus();
  const reconciliation = reconcileStatus(baselineStatus, releaseVersion);
  if (reconciliation.action === "complete" || reconciliation.action === "submitted") {
    return { outcome: reconciliation.action, reconciliation, status: baselineStatus };
  }
  assertActionAllowed(reconciliation, new Set(["upload"]));

  let uploadResult;
  let acceptedUploadResponse;
  try {
    if (beforeUpload) await beforeUpload({ baselineStatus, exactPackage: verifiedPackage });
    const uploadResponse = await client.upload(verifiedPackage.bytes);
    acceptedUploadResponse = uploadResponse;
    uploadResult = await waitForAcceptedUpload(
      client,
      releaseVersion,
      uploadResponse,
      baselineStatus,
    );
  } catch (error) {
    if (
      acceptedUploadResponse &&
      error?.code !== "UPLOAD_FAILED" &&
      error?.code !== "UPLOADED_VERSION_MISMATCH" &&
      !error?.ambiguous
    ) {
      const acceptedEvidence = new CwsError("Chrome accepted the upload mutation", {
        code: "UPLOAD_ACCEPTED",
        ambiguous: true,
        details: acceptedUploadResponse,
      });
      error = preserveMutationAmbiguity("upload", acceptedEvidence, error);
    }
    if (!(error instanceof CwsError) || !error.ambiguous) throw error;
    try {
      uploadResult = await reconcileAmbiguousUpload(
        client,
        releaseVersion,
        baselineStatus,
        error,
      );
    } catch (reconciliationError) {
      if (reconciliationError?.code === "UPLOAD_FAILED") throw reconciliationError;
      throw preserveMutationAmbiguity("upload", error, reconciliationError);
    }
  }

  if (uploadResult.outcome !== "uploaded") return uploadResult;
  return {
    outcome: "uploaded",
    receipt: makeReceipt(client, releaseVersion, verifiedPackage, uploadResult),
    uploadResponse: uploadResult.uploadResponse,
    status: uploadResult.status,
  };
}

async function reconcileAmbiguousPublish(client, version, originalError) {
  const result = await poll(client, (status) => {
    const reconciliation = reconcileStatus(status, version);
    if (reconciliation.action === "complete" || reconciliation.action === "submitted") {
      return { outcome: reconciliation.action, reconciliation, status };
    }
    if (reconciliation.action === "blocked") {
      throw new CwsError(reconciliation.message, {
        code: reconciliation.reason,
        details: { originalError: originalError.toJSON(), status },
      });
    }
    return undefined;
  });
  if (result.outcome) return result;
  throw new CwsError(
    "The publish outcome is still ambiguous after polling fetchStatus. Re-run later; the next run will reconcile status before attempting another publish.",
    {
      code: "AMBIGUOUS_PUBLISH",
      ambiguous: true,
      details: { originalError: originalError.toJSON(), lastStatus: result.status },
      cause: originalError,
    },
  );
}

async function verifyPublishedSubmission(client, version, publishResponse) {
  const responseWarnings = collectWarnings(publishResponse?.warningInfo);
  if (responseWarnings.length > 0) {
    throw new CwsError("Chrome returned warnings despite blockOnWarnings=true", {
      code: "CWS_VALIDATION_WARNING",
      warnings: responseWarnings,
      details: publishResponse,
    });
  }
  if (publishResponse?.state === "STAGED") {
    throw new CwsError("Chrome staged the release despite DEFAULT_PUBLISH", {
      code: "UNEXPECTED_STAGED_RELEASE",
      details: publishResponse,
      ambiguous: true,
    });
  }
  if (!publishResponse?.state) {
    throw new CwsError("Chrome publish response did not include a state", {
      code: "INVALID_API_RESPONSE",
      details: publishResponse,
      ambiguous: true,
    });
  }
  if (!ACTIVE_SUBMISSION_STATES.has(publishResponse.state) && !PUBLIC_STATES.has(publishResponse.state)) {
    throw new CwsError(`Chrome returned unexpected publish state ${publishResponse.state}`, {
      code: "UNEXPECTED_PUBLISH_STATE",
      details: publishResponse,
      ambiguous: true,
    });
  }

  let result;
  try {
    result = await poll(client, (status) => {
      const reconciliation = reconcileStatus(status, version);
      if (reconciliation.action === "complete" || reconciliation.action === "submitted") {
        return { outcome: reconciliation.action, reconciliation, status };
      }
      if (reconciliation.action === "blocked") {
        throw new CwsError(reconciliation.message, {
          code: reconciliation.reason,
          details: status,
        });
      }
      return undefined;
    });
  } catch (error) {
    if (error?.httpStatus || error?.code === "CWS_NETWORK_ERROR") {
      return {
        outcome: publishResponse.state === "PUBLISHED" ? "complete" : "submitted",
        verificationPending: true,
        publishResponse,
        verificationError: error instanceof CwsError ? error.toJSON() : { message: error.message },
      };
    }
    throw error;
  }
  if (result.outcome) return { ...result, publishResponse };

  // A successful mutation response is authoritative even if fetchStatus is
  // briefly stale. The upload receipt binds it to the expected package.
  return {
    outcome: publishResponse?.state === "PUBLISHED" ? "complete" : "submitted",
    verificationPending: true,
    publishResponse,
    status: result.status,
  };
}

export async function publishUploadedPackage({
  client,
  version,
  expectedSha256,
  receipt,
  beforePublish,
}) {
  const releaseVersion = validateVersion(version);
  const digest = validateSha256(expectedSha256);
  const initialStatus = await client.fetchStatus();
  const reconciliation = reconcileStatus(initialStatus, releaseVersion);
  if (reconciliation.action === "complete" || reconciliation.action === "submitted") {
    return { outcome: reconciliation.action, reconciliation, status: initialStatus };
  }
  assertActionAllowed(reconciliation, new Set(["upload"]));
  validateReceipt(receipt, client, releaseVersion, digest);

  try {
    if (beforePublish) await beforePublish({ initialStatus, receipt });
    const publishResponse = await client.publish();
    return await verifyPublishedSubmission(client, releaseVersion, publishResponse);
  } catch (error) {
    if (!(error instanceof CwsError) || !error.ambiguous) throw error;
    try {
      return await reconcileAmbiguousPublish(client, releaseVersion, error);
    } catch (reconciliationError) {
      throw preserveMutationAmbiguity("publish", error, reconciliationError);
    }
  }
}

export async function releaseExactPackage({ client, version, exactPackage, onUploadReceipt }) {
  const uploadResult = await uploadExactPackage({ client, version, exactPackage });
  if (uploadResult.outcome === "complete" || uploadResult.outcome === "submitted") {
    return uploadResult;
  }
  if (uploadResult.receipt && onUploadReceipt) await onUploadReceipt(uploadResult.receipt);
  const publishResult = await publishUploadedPackage({
    client,
    version,
    expectedSha256: exactPackage.sha256,
    receipt: uploadResult.receipt,
  });
  return compactObject({
    ...publishResult,
    uploadReceipt: uploadResult.receipt,
    uploadOutcome: uploadResult.outcome,
  });
}

function resolveItemId(environment) {
  const extensionId = environment.CWS_EXTENSION_ID?.trim();
  const itemId = environment.CWS_ITEM_ID?.trim();
  if (extensionId && itemId && extensionId !== itemId) {
    throw new CwsError("CWS_EXTENSION_ID and CWS_ITEM_ID disagree", {
      code: "INVALID_CONFIGURATION",
    });
  }
  return extensionId || itemId;
}

async function readReceipt(environment, { allowInlineSeed = true } = {}) {
  if (environment.CWS_UPLOAD_RECEIPT_PATH) {
    try {
      return JSON.parse(await readFile(environment.CWS_UPLOAD_RECEIPT_PATH, "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") {
        // A job output may seed the path on its first use below. Once a journal
        // file exists it always wins, so an old inline receipt cannot erase an
        // ambiguous or accepted mutation guard on a rerun.
      } else {
        throw new CwsError(`Unable to read CWS_UPLOAD_RECEIPT_PATH: ${error.message}`, {
          code: "INVALID_UPLOAD_RECEIPT",
          cause: error,
        });
      }
    }
  }
  if (allowInlineSeed && environment.CWS_UPLOAD_RECEIPT) {
    try {
      return JSON.parse(environment.CWS_UPLOAD_RECEIPT);
    } catch (error) {
      throw new CwsError(`CWS_UPLOAD_RECEIPT is not valid JSON: ${error.message}`, {
        code: "INVALID_UPLOAD_RECEIPT",
        cause: error,
      });
    }
  }
  return undefined;
}

async function persistReceipt(receipt, environment) {
  if (!receipt || !environment.CWS_UPLOAD_RECEIPT_PATH) return;
  await writeFile(environment.CWS_UPLOAD_RECEIPT_PATH, `${JSON.stringify(receipt, null, 2)}\n`, {
    mode: 0o600,
  });
}

function requireMutationJournalPath(environment) {
  return requiredString(environment.CWS_UPLOAD_RECEIPT_PATH, "CWS_UPLOAD_RECEIPT_PATH");
}

function withoutMutationGuard(record) {
  if (!record) return undefined;
  const { mutationGuard: _mutationGuard, ...receipt } = record;
  return receipt;
}

function observedOutcome(status, version) {
  const reconciliation = reconcileStatus(status, version);
  if (reconciliation.action === "complete" || reconciliation.action === "submitted") {
    return { outcome: reconciliation.action, reconciliation, status };
  }
  assertActionAllowed(reconciliation, new Set(["upload"]));
  return undefined;
}

function matchingPreparedGuard(record, operation, attemptId) {
  const guard = record?.mutationGuard;
  return (
    guard?.operation === operation &&
    guard.state === "prepared" &&
    guard.attemptId === attemptId
  );
}

function assertMatchingPreparedGuard(record, operation, attemptId) {
  if (matchingPreparedGuard(record, operation, attemptId)) return record.mutationGuard;
  const guard = record?.mutationGuard;
  throw new CwsError(
    `The ${operation} mutation is not prepared for this exact attempt ID; refusing to POST.`,
    {
      code: `${operation.toUpperCase()}_NOT_PREPARED`,
      details: {
        expectedAttemptId: attemptId,
        actualGuard: guard,
      },
    },
  );
}

async function prepareCliUpload({
  client,
  version,
  exactPackage,
  environment,
  storedRecord,
  attemptId,
}) {
  const currentStatus = await client.fetchStatus();
  const outcome = observedOutcome(currentStatus, version);
  if (outcome) return outcome;
  requireMutationJournalPath(environment);

  if (storedRecord) {
    validateJournalIdentity(
      storedRecord,
      client,
      version,
      exactPackage.sha256,
      exactPackage.size,
    );
    if (matchingPreparedGuard(storedRecord, "upload", attemptId)) {
      return {
        outcome: "prepared",
        receipt: storedRecord,
        reusedPreparation: true,
        status: currentStatus,
      };
    }
    if (
      storedRecord.mutationGuard &&
      storedRecord.mutationGuard.state !== "definitive-failure"
    ) {
      throw new CwsError(
        "An older or unresolved upload checkpoint exists; refusing to replace it with a new attempt.",
        {
          code: "UPLOAD_PREPARATION_BLOCKED",
          details: storedRecord.mutationGuard,
        },
      );
    }
    if (storedRecord.uploadState === "SUCCEEDED") {
      validateReceipt(storedRecord, client, version, exactPackage.sha256);
      return { outcome: "uploaded", receipt: storedRecord, reusedReceipt: true };
    }
  }

  const preparedRecord = makeUploadAttempt(
    client,
    version,
    exactPackage,
    currentStatus,
    attemptId,
    "prepared",
  );
  await persistReceipt(preparedRecord, environment);
  return {
    outcome: "prepared",
    receipt: preparedRecord,
    status: currentStatus,
  };
}

async function guardedCliUpload({
  client,
  version,
  exactPackage,
  environment,
  storedRecord,
  attemptId,
}) {
  const currentStatus = await client.fetchStatus();
  const outcome = observedOutcome(currentStatus, version);
  if (outcome) return outcome;
  requireMutationJournalPath(environment);

  if (storedRecord) {
    validateJournalIdentity(
      storedRecord,
      client,
      version,
      exactPackage.sha256,
      exactPackage.size,
    );
    if (storedRecord.uploadState === "SUCCEEDED" && !storedRecord.mutationGuard) {
      validateReceipt(storedRecord, client, version, exactPackage.sha256);
      return { outcome: "uploaded", receipt: storedRecord, reusedReceipt: true };
    }
  }
  assertMatchingPreparedGuard(storedRecord, "upload", attemptId);

  let attemptRecord;
  try {
    const result = await uploadExactPackage({
      client,
      version,
      exactPackage,
      beforeUpload: async ({ baselineStatus, exactPackage: verifiedPackage }) => {
        attemptRecord = makeUploadAttempt(
          client,
          version,
          verifiedPackage,
          baselineStatus,
          attemptId,
          "started",
        );
        await persistReceipt(attemptRecord, environment);
      },
    });
    if (result.receipt) await persistReceipt(result.receipt, environment);
    return result;
  } catch (error) {
    if (attemptRecord) {
      const definitiveFailure =
        error?.code === "UPLOAD_FAILED" || (error?.httpStatus && !error?.ambiguous);
      await persistReceipt(
        {
          ...attemptRecord,
          mutationGuard: {
            ...attemptRecord.mutationGuard,
            state: definitiveFailure ? "definitive-failure" : "ambiguous",
            errorCode: error?.code ?? "UNEXPECTED_ERROR",
          },
        },
        environment,
      );
    }
    throw error;
  }
}

async function prepareCliPublish({
  client,
  version,
  sha256,
  environment,
  storedRecord,
  attemptId,
}) {
  const currentStatus = await client.fetchStatus();
  const outcome = observedOutcome(currentStatus, version);
  if (outcome) return outcome;
  requireMutationJournalPath(environment);
  validateJournalIdentity(storedRecord, client, version, sha256);
  const baseReceipt = withoutMutationGuard(storedRecord);
  validateReceipt(baseReceipt, client, version, sha256);

  if (matchingPreparedGuard(storedRecord, "publish", attemptId)) {
    return {
      outcome: "prepared",
      receipt: storedRecord,
      reusedPreparation: true,
      status: currentStatus,
    };
  }
  if (storedRecord?.mutationGuard?.state !== undefined) {
    throw new CwsError(
      "An older or unresolved publish checkpoint exists; refusing to replace it with a new attempt.",
      {
        code: "PUBLISH_PREPARATION_BLOCKED",
        details: storedRecord.mutationGuard,
      },
    );
  }
  const preparedRecord = withPublishGuard(baseReceipt, "prepared", { attemptId });
  await persistReceipt(preparedRecord, environment);
  return {
    outcome: "prepared",
    receipt: preparedRecord,
    status: currentStatus,
  };
}

async function guardedCliPublish({
  client,
  version,
  sha256,
  environment,
  storedRecord,
  attemptId,
}) {
  const baseReceipt = withoutMutationGuard(storedRecord);
  let attemptedRecord;
  try {
    const result = await publishUploadedPackage({
      client,
      version,
      expectedSha256: sha256,
      receipt: baseReceipt,
      beforePublish: async () => {
        requireMutationJournalPath(environment);
        assertMatchingPreparedGuard(storedRecord, "publish", attemptId);
        attemptedRecord = withPublishGuard(baseReceipt, "started", { attemptId });
        await persistReceipt(attemptedRecord, environment);
      },
    });
    if (attemptedRecord || storedRecord?.mutationGuard?.operation === "publish") {
      const completedAttemptId =
        attemptedRecord?.mutationGuard?.attemptId ?? storedRecord.mutationGuard.attemptId;
      await persistReceipt(
        withPublishGuard(baseReceipt, "accepted", {
          attemptId: completedAttemptId,
          outcome: result.outcome,
        }),
        environment,
      );
    }
    return result;
  } catch (error) {
    if (attemptedRecord) {
      const definitiveFailure =
        error?.code === "CWS_VALIDATION_WARNING" ||
        Boolean(error?.httpStatus && !error?.ambiguous);
      await persistReceipt(
        definitiveFailure
          ? baseReceipt
          : withPublishGuard(baseReceipt, "ambiguous", {
              attemptId,
              errorCode: error?.code ?? "UNEXPECTED_ERROR",
            }),
        environment,
      );
    }
    throw error;
  }
}

async function writeGithubOutputs(result, environment, error) {
  if (!environment.GITHUB_OUTPUT) return;
  const values = error
    ? {
        cws_outcome: "failed",
        cws_error_code: error.code ?? "UNEXPECTED_ERROR",
        cws_warning_count: String(error.warnings?.length ?? 0),
        cws_error_json: JSON.stringify(
          error instanceof CwsError ? error.toJSON() : { message: error.message },
        ),
      }
    : {
        cws_outcome: result.outcome ?? result.action ?? "ok",
        cws_state:
          result.status?.submitted?.state ??
          result.status?.published?.state ??
          result.reconciliation?.status?.submitted?.state ??
          result.reconciliation?.status?.published?.state ??
          "",
        cws_version: environment.CWS_VERSION ?? "",
        cws_result_json: JSON.stringify(result),
        cws_upload_receipt: result.receipt
          ? JSON.stringify(result.receipt)
          : result.uploadReceipt
            ? JSON.stringify(result.uploadReceipt)
            : "",
      };
  await appendFile(
    environment.GITHUB_OUTPUT,
    `${Object.entries(values)
      .map(([key, value]) => `${key}=${String(value).replaceAll("\n", "\\n")}`)
      .join("\n")}\n`,
  );
}

function usage() {
  return `Usage: node scripts/chrome-web-store.mjs <command>

Commands:
  status      Fetch and print normalized Chrome Web Store status.
  reconcile   Fetch status and decide whether the target is complete, submitted,
              ready to publish, blocked, or needs upload.
  prepare-upload
              Validate the exact ZIP and durably checkpoint one upload attempt.
  upload      Consume the matching prepared upload checkpoint and POST once.
  prepare-publish
              Validate the upload receipt and durably checkpoint one publish attempt.
  publish     Consume the matching prepared publish checkpoint and POST once with
              DEFAULT_PUBLISH at 100%.

Required environment:
  CWS_ACCESS_TOKEN
  CWS_PUBLISHER_ID
  CWS_EXTENSION_ID (CWS_ITEM_ID is accepted as an alias)

For reconcile/prepare-upload/upload/prepare-publish/publish:
  CWS_VERSION

For prepare-upload/upload:
  CWS_ZIP_PATH
  CWS_ZIP_SHA256

For every prepare or mutation command:
  CWS_MUTATION_ATTEMPT_ID (unique per operation and workflow run attempt)
  CWS_UPLOAD_RECEIPT_PATH (durable mutation journal; preserve between phases)

For prepare-publish/publish when fetchStatus cannot observe the draft:
  CWS_ZIP_SHA256
  CWS_UPLOAD_RECEIPT (optional prepare-publish seed when the path does not exist)

The upload receipt and pre-POST mutation guards contain no credential. Preserve
the file as a workflow artifact so a rerun can reconcile instead of replaying an
ambiguous POST.`;
}

export async function runCli(
  argv = process.argv.slice(2),
  environment = process.env,
  {
    fetchImpl = globalThis.fetch,
    sleep,
    getAttempts,
    pollAttempts,
    pollDelayMs,
    requestTimeoutMs,
  } = {},
) {
  const command = argv[0];
  if (!command || command === "help" || command === "--help" || command === "-h") {
    return { help: usage() };
  }
  const client = createCwsClient({
    accessToken: environment.CWS_ACCESS_TOKEN,
    publisherId: environment.CWS_PUBLISHER_ID,
    itemId: resolveItemId(environment),
    fetchImpl,
    sleep,
    getAttempts,
    pollAttempts,
    pollDelayMs,
    requestTimeoutMs,
  });
  if (command === "status") {
    return { outcome: "status", status: await client.fetchStatus() };
  }

  const version = validateVersion(environment.CWS_VERSION);
  if (command === "reconcile") {
    const status = await client.fetchStatus();
    const reconciliation = reconcileStatus(status, version);
    if (reconciliation.action === "blocked") {
      throw new CwsError(reconciliation.message, {
        code: reconciliation.reason,
        details: reconciliation.status,
      });
    }
    return reconciliation;
  }
  if (command === "prepare-publish" || command === "publish") {
    const attemptId = validateMutationAttemptId(environment.CWS_MUTATION_ATTEMPT_ID);
    const publishArguments = {
      client,
      version,
      sha256: validateSha256(environment.CWS_ZIP_SHA256),
      environment,
      storedRecord: await readReceipt(environment, {
        allowInlineSeed: command === "prepare-publish",
      }),
      attemptId,
    };
    return command === "prepare-publish"
      ? await prepareCliPublish(publishArguments)
      : await guardedCliPublish(publishArguments);
  }
  if (command === "release") {
    throw new CwsError(
      "The combined release command is disabled because each mutation requires a separately persisted prepare checkpoint.",
      { code: "UNSAFE_COMBINED_RELEASE_DISABLED" },
    );
  }
  if (command !== "prepare-upload" && command !== "upload") {
    throw new CwsError(`Unknown command: ${command}`, { code: "INVALID_COMMAND" });
  }

  const attemptId = validateMutationAttemptId(environment.CWS_MUTATION_ATTEMPT_ID);
  const exactPackage = await loadExactPackage({
    zipPath: environment.CWS_ZIP_PATH,
    expectedSha256: environment.CWS_ZIP_SHA256,
  });
  const uploadArguments = {
    client,
    version,
    exactPackage,
    environment,
    storedRecord: await readReceipt(environment, { allowInlineSeed: false }),
    attemptId,
  };
  return command === "prepare-upload"
    ? await prepareCliUpload(uploadArguments)
    : await guardedCliUpload(uploadArguments);
}

async function main() {
  try {
    const result = await runCli();
    if (result.help) {
      console.log(result.help);
    } else {
      console.log(JSON.stringify(result, null, 2));
    }
    await writeGithubOutputs(result, process.env);
  } catch (error) {
    const structuredError =
      error instanceof CwsError
        ? error
        : new CwsError(error.message ?? String(error), {
            code: "UNEXPECTED_ERROR",
            cause: error,
          });
    console.error(JSON.stringify({ ok: false, error: structuredError.toJSON() }, null, 2));
    try {
      await writeGithubOutputs(undefined, process.env, structuredError);
    } catch (outputError) {
      console.error(`Failed to write GitHub outputs: ${outputError.message}`);
    }
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
if (invokedPath === import.meta.url) await main();
