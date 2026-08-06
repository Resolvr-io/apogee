export interface PlaygroundProviderInfo {
  readonly uuid: string;
  readonly name: string;
  readonly icon: string;
  readonly rdns: string;
}

export interface PlaygroundProvider {
  request(args: unknown): Promise<unknown>;
  on(args: unknown): () => void;
}

export interface PlaygroundProviderDetail {
  readonly info: PlaygroundProviderInfo;
  readonly provider: PlaygroundProvider;
}

export interface ProviderCapabilities {
  browserProviderVersion: string;
  methods: string[];
  events: string[];
}

export interface ConformanceEnvironment {
  isSecureContext: boolean;
  isTopLevel: boolean;
  legacyProvider?: unknown;
}

export interface ConformanceCheck {
  id: string;
  name: string;
  status: "pass" | "fail" | "skip";
  detail: string;
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ICON_DATA_URI = /^data:image\/(svg\+xml|webp|png|gif)(?:;[^,]*)?,/i;
const REQUIRED_LIFECYCLE_METHODS = [
  "wallet_getCapabilities",
  "wallet_connect",
  "wallet_getConnection",
  "wallet_disconnect",
];
const PROFILE_METHODS = [
  "getBalance",
  "getUTXOs",
  "getWalletDescriptor",
  "sendTransfer",
  "getIdentityPublicKey",
  "getIdentitySharedKey",
  "signIdentity",
  "signPset",
  "signMessage",
  "processConfidentialTransaction",
];
const PROFILE_EVENTS = ["bip122_walletDescriptorChanged"];

export async function runSafeConformanceChecks(
  detail: PlaygroundProviderDetail,
  rediscover: () => PlaygroundProviderDetail[],
  environment: ConformanceEnvironment,
): Promise<ConformanceCheck[]> {
  const checks: ConformanceCheck[] = [];
  let capabilities: ProviderCapabilities | null = null;

  await check(checks, "context", "secure top-level context", () => {
    assert(environment.isSecureContext, "the playground is not a secure context");
    assert(environment.isTopLevel, "the provider was discovered outside the top-level context");
  });

  await check(checks, "metadata", "provider metadata", () => {
    assert(UUID_V4.test(detail.info.uuid), "uuid is not UUID v4");
    assert(detail.info.name.trim().length > 0, "name is empty");
    assert(ICON_DATA_URI.test(detail.info.icon), "icon is not an allowed image data URI");
    assert(detail.info.rdns.includes("."), "rdns is not a reverse-DNS identifier");
  });

  await check(checks, "immutability", "immutable announcement", () => {
    assert(Object.isFrozen(detail), "announcement detail is mutable");
    assert(Object.isFrozen(detail.info), "provider info is mutable");
    assert(Object.isFrozen(detail.provider), "provider object is mutable");
  });

  await check(checks, "interface", "minimal provider interface", () => {
    assert(typeof detail.provider.request === "function", "request is missing");
    assert(typeof detail.provider.on === "function", "on is missing");
  });

  await check(checks, "rediscovery", "stable rediscovery", () => {
    const repeated = rediscover().filter((entry) => entry.info.uuid === detail.info.uuid);
    assert(repeated.length > 0, "provider did not re-announce");
    assert(repeated.every((entry) => entry === detail), "detail identity changed on re-announcement");
    assert(
      repeated.every((entry) => entry.provider === detail.provider),
      "provider identity changed on re-announcement",
    );
  });

  await check(checks, "legacy", "standard provider is independent of the legacy global", () => {
    if (environment.legacyProvider === undefined) return;
    assert(detail.provider !== environment.legacyProvider, "standard provider aliases window.liquid");
  });

  await check(checks, "capabilities", "capability declaration", async () => {
    const raw = await detail.provider.request({ method: "wallet_getCapabilities" });
    assert(isRecord(raw), "capabilities result is not an object");
    assert(!("jsonrpc" in raw) && !("result" in raw), "provider returned a JSON-RPC envelope");
    assert(typeof raw.browserProviderVersion === "string", "provider version is missing");
    assert(Array.isArray(raw.methods) && raw.methods.every(isString), "methods is not a string array");
    assert(Array.isArray(raw.events) && raw.events.every(isString), "events is not a string array");
    for (const method of REQUIRED_LIFECYCLE_METHODS) {
      assert(raw.methods.includes(method), `missing lifecycle method ${method}`);
    }
    assert(raw.methods.includes("getBalance"), "Apogee does not advertise getBalance");
    assert(raw.methods.includes("sendTransfer"), "Apogee does not advertise sendTransfer");
    assert(raw.events.includes("wallet_connectionChanged"), "missing connection event");
    assert(!containsPrivateState(raw), "capabilities disclose account state");
    capabilities = raw as unknown as ProviderCapabilities;
  });

  await check(checks, "caller-id", "caller identifiers are ignored", async () => {
    const first = await detail.provider.request({ method: "wallet_getCapabilities" });
    const second = await detail.provider.request({
      id: "caller-controlled-id",
      method: "wallet_getCapabilities",
    });
    assert(JSON.stringify(first) === JSON.stringify(second), "caller id changed the result");
  });

  await check(checks, "invalid-request", "malformed requests reject asynchronously", async () => {
    await expectRejectionCode(() => detail.provider.request(null), -32600);
    await expectRejectionCode(
      () => detail.provider.request({ method: "wallet_getCapabilities", params: [] }),
      -32600,
    );
  });

  await check(checks, "unsupported-method", "unsupported profile methods use 4200", async () => {
    assert(capabilities !== null, "capabilities were unavailable");
    const unsupported = PROFILE_METHODS.find((method) => !capabilities?.methods.includes(method));
    if (!unsupported) throw new SkipCheck("every known profile method is supported");
    await expectRejectionCode(() => detail.provider.request({ method: unsupported }), 4200);
  });

  await check(checks, "unknown-method", "unknown methods use -32601", async () => {
    await expectRejectionCode(
      () => detail.provider.request({ method: "__liquid_conformance_unknown__" }),
      -32601,
    );
  });

  await check(checks, "concurrency", "concurrent results stay associated", async () => {
    const [caps, connection] = await Promise.all([
      detail.provider.request({ method: "wallet_getCapabilities" }),
      detail.provider.request({ method: "wallet_getConnection" }),
    ]);
    assert(isRecord(caps) && Array.isArray(caps.methods), "capability result was misrouted");
    assert(connection === null || isConnection(connection), "connection result was misrouted");
  });

  await check(checks, "subscription-validation", "subscription validation is synchronous", () => {
    expectSynchronousError(() => detail.provider.on(null), (error) => error instanceof TypeError);
    const unsupported = PROFILE_EVENTS.find((event) => !capabilities?.events.includes(event));
    if (unsupported) {
      expectSynchronousError(
        () => detail.provider.on({ event: unsupported, listener: () => undefined }),
        (error) => errorCode(error) === 4200,
      );
    }
  });

  await check(checks, "unsubscribe", "unsubscribe is idempotent", () => {
    const off = detail.provider.on({
      event: "wallet_connectionChanged",
      listener: () => undefined,
    });
    assert(typeof off === "function", "on did not return a function");
    off();
    off();
  });

  return checks;
}

async function check(
  results: ConformanceCheck[],
  id: string,
  name: string,
  run: () => void | Promise<void>,
): Promise<void> {
  try {
    await run();
    results.push({ id, name, status: "pass", detail: "Passed" });
  } catch (error) {
    if (error instanceof SkipCheck) {
      results.push({ id, name, status: "skip", detail: error.message });
      return;
    }
    results.push({
      id,
      name,
      status: "fail",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

async function expectRejectionCode(invoke: () => Promise<unknown>, expected: number): Promise<void> {
  let promise: Promise<unknown>;
  try {
    promise = invoke();
  } catch {
    throw new Error("request threw synchronously instead of returning a Promise");
  }
  assert(promise instanceof Promise, "request did not return a Promise");
  try {
    await promise;
  } catch (error) {
    assert(error instanceof Error, "request rejected with a non-Error value");
    assert(errorCode(error) === expected, `expected error ${expected}, received ${errorCode(error)}`);
    return;
  }
  throw new Error(`request resolved instead of rejecting with ${expected}`);
}

function expectSynchronousError(invoke: () => unknown, matches: (error: unknown) => boolean): void {
  try {
    invoke();
  } catch (error) {
    assert(matches(error), "received the wrong synchronous error");
    return;
  }
  throw new Error("call did not throw synchronously");
}

function containsPrivateState(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsPrivateState);
  if (!isRecord(value)) return false;
  const forbidden = new Set([
    "account",
    "accounts",
    "accountIdentifier",
    "address",
    "balance",
    "chainId",
    "policyAssetId",
  ]);
  return Object.entries(value).some(
    ([key, entry]) => forbidden.has(key) || containsPrivateState(entry),
  );
}

function isConnection(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.accountIdentifier === "string" &&
    typeof value.chainId === "string" &&
    isRecord(value.permissions)
  );
}

function errorCode(error: unknown): unknown {
  return isRecord(error) ? error.code : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

class SkipCheck extends Error {}
