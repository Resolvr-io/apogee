import {
  type ConformanceCheck,
  type PlaygroundProviderDetail,
  runSafeConformanceChecks,
} from "./conformance";

type ProviderRecord = {
  detail: PlaygroundProviderDetail;
  announcements: number;
};

const providers = new Map<string, ProviderRecord>();
const frameReports = new Map<string, number>();
let selectedUuid: string | null = null;
let unsubscribeConnection: (() => void) | null = null;

const providerList = element("providers");
const empty = element("provider-empty");
const selection = element("selection");
const result = element("result");
const resultStatus = element("result-status");
const timeline = element("timeline");
const checks = element("checks");
const checkSummary = element("check-summary");
const frameResult = element("frame-result");
const assetInput = element("asset-id") as HTMLInputElement;
const utxoAssetInput = element("utxo-asset-id") as HTMLInputElement;
const transferAddress = element("transfer-address") as HTMLInputElement;
const transferAmount = element("transfer-amount") as HTMLInputElement;
const transferAsset = element("transfer-asset") as HTMLInputElement;
const transferMemo = element("transfer-memo") as HTMLInputElement;

element("origin").textContent = window.location.origin;

window.addEventListener("liquid:announceProvider", receiveAnnouncement as EventListener);
window.addEventListener("message", (event) => {
  if (!isRecord(event.data) || event.data.source !== "liquid-provider-frame-probe") return;
  if (typeof event.data.kind !== "string" || typeof event.data.announcements !== "number") return;
  frameReports.set(event.data.kind, event.data.announcements);
  const same = frameReports.get("same-origin");
  const opaque = frameReports.get("opaque");
  frameResult.textContent = `same-origin: ${same ?? "…"} · opaque: ${opaque ?? "…"}`;
  if (same === 0 && opaque === 0) frameResult.className = "pass-text";
});

element("rediscover").addEventListener("click", () => {
  const found = rediscover();
  log("discovery", `Requested providers; received ${found.length} announcement(s).`);
});
element("run-checks").addEventListener("click", () => void runChecks());
element("capabilities").addEventListener("click", () =>
  void invoke("wallet_getCapabilities", {}),
);
element("connect").addEventListener("click", () =>
  void invoke("wallet_connect", { methods: ["getBalance"], events: [] }),
);
element("connect-transfer").addEventListener("click", () =>
  void invoke("wallet_connect", { methods: ["sendTransfer"], events: [] }),
);
element("connect-utxos").addEventListener("click", () =>
  void invoke("wallet_connect", { methods: ["getUTXOs"], events: [] }),
);
element("connection").addEventListener("click", () => void invoke("wallet_getConnection", {}));
element("disconnect").addEventListener("click", () => void invoke("wallet_disconnect", {}));
element("balance").addEventListener("click", () => {
  const assetId = assetInput.value.trim();
  void invoke("getBalance", assetId ? { assetId } : {});
});
element("utxos").addEventListener("click", () => {
  const assetId = utxoAssetInput.value.trim();
  void invoke("getUTXOs", assetId ? { assetId } : {});
});
element("transfer").addEventListener("click", () => {
  const recipientAddress = transferAddress.value.trim();
  const amount = transferAmount.value.trim();
  if (!recipientAddress || !amount) {
    showError(new Error("Recipient address and amount are required."));
    return;
  }
  const assetId = transferAsset.value.trim();
  const memo = transferMemo.value.trim();
  void invoke("sendTransfer", {
    recipientAddress,
    amount,
    ...(assetId ? { assetId } : {}),
    ...(memo ? { memo } : {}),
  });
});
element("clear-log").addEventListener("click", () => {
  timeline.replaceChildren();
});

rediscover();
window.setTimeout(() => {
  if (providers.size === 0) log("discovery", "No Liquid providers announced.", "error");
}, 1_000);

function receiveAnnouncement(event: CustomEvent<unknown>): void {
  if (!isDetail(event.detail)) {
    log("discovery", "Ignored a malformed provider announcement.", "error");
    return;
  }
  const incoming = event.detail;
  const current = providers.get(incoming.info.uuid);
  if (current) {
    if (current.detail !== incoming || current.detail.provider !== incoming.provider) {
      log("discovery", `Ignored conflicting announcement for ${incoming.info.uuid}.`, "error");
      return;
    }
    current.announcements += 1;
    renderProviders();
    return;
  }

  providers.set(incoming.info.uuid, { detail: incoming, announcements: 1 });
  log("discovery", `Discovered ${incoming.info.name} (${incoming.info.rdns}).`);
  if (!selectedUuid) selectProvider(incoming.info.uuid);
  renderProviders();
}

function rediscover(): PlaygroundProviderDetail[] {
  const announcements: PlaygroundProviderDetail[] = [];
  const collect = (event: Event) => {
    const detail = (event as CustomEvent<unknown>).detail;
    if (isDetail(detail)) announcements.push(detail);
  };
  window.addEventListener("liquid:announceProvider", collect);
  window.dispatchEvent(new Event("liquid:requestProvider"));
  window.removeEventListener("liquid:announceProvider", collect);
  return announcements;
}

function selectProvider(uuid: string): void {
  if (selectedUuid === uuid) return;
  unsubscribeConnection?.();
  unsubscribeConnection = null;
  selectedUuid = uuid;
  const record = providers.get(uuid);
  if (!record) return;
  unsubscribeConnection = record.detail.provider.on({
    event: "wallet_connectionChanged",
    listener: (payload: unknown) => {
      document.body.dataset.connection = payload === null ? "disconnected" : "connected";
      log("wallet_connectionChanged", payload);
    },
  });
  selection.textContent = record.detail.info.name;
  renderProviders();
}

function renderProviders(): void {
  empty.hidden = providers.size > 0;
  providerList.replaceChildren(
    ...[...providers.values()].map(({ detail, announcements }) => {
      const selected = detail.info.uuid === selectedUuid;
      const button = document.createElement("button");
      button.type = "button";
      button.className = `provider-card${selected ? " selected" : ""}`;
      button.dataset.uuid = detail.info.uuid;
      button.addEventListener("click", () => selectProvider(detail.info.uuid));
      const icon = document.createElement("img");
      icon.src = detail.info.icon;
      icon.alt = "";
      const copy = document.createElement("span");
      copy.className = "provider-copy";
      const name = document.createElement("strong");
      name.textContent = detail.info.name;
      name.dataset.testid = "provider-name";
      const rdns = document.createElement("small");
      rdns.textContent = detail.info.rdns;
      const uuid = document.createElement("code");
      uuid.textContent = detail.info.uuid;
      copy.append(name, rdns, uuid);
      const count = document.createElement("span");
      count.className = "announcement-count";
      count.textContent = `${announcements}×`;
      count.title = "Announcements received";
      button.append(icon, copy, count);
      return button;
    }),
  );
}

async function runChecks(): Promise<void> {
  const record = currentProvider();
  if (!record) return showError("No provider is selected.");
  setBusy(true, "Running");
  checks.replaceChildren();
  const checkResults = await runSafeConformanceChecks(record.detail, rediscover, {
    isSecureContext: window.isSecureContext,
    isTopLevel: window.top === window,
    legacyProvider: (window as Window & { liquid?: unknown }).liquid,
  });
  renderChecks(checkResults);
  setBusy(false, "Complete");
}

function renderChecks(values: ConformanceCheck[]): void {
  const failed = values.filter((check) => check.status === "fail").length;
  const passed = values.filter((check) => check.status === "pass").length;
  const skipped = values.filter((check) => check.status === "skip").length;
  checkSummary.className = `check-summary ${failed ? "failed" : "passed"}`;
  checkSummary.textContent = `${passed} passed · ${failed} failed${skipped ? ` · ${skipped} skipped` : ""}`;
  checks.replaceChildren(
    ...values.map((value) => {
      const item = document.createElement("li");
      item.className = `check ${value.status}`;
      item.dataset.check = value.id;
      const marker = document.createElement("span");
      marker.className = "check-marker";
      marker.textContent = value.status === "pass" ? "✓" : value.status === "skip" ? "–" : "×";
      const copy = document.createElement("span");
      const name = document.createElement("strong");
      name.textContent = value.name;
      const detail = document.createElement("small");
      detail.textContent = value.detail;
      copy.append(name, detail);
      item.append(marker, copy);
      return item;
    }),
  );
}

async function invoke(method: string, params: Record<string, unknown>): Promise<void> {
  const record = currentProvider();
  if (!record) return showError("No provider is selected.");
  setBusy(true, method);
  log("request", { method, params });
  try {
    const value = await record.detail.provider.request({ method, params });
    if (method === "wallet_connect") document.body.dataset.connection = "connected";
    if (method === "wallet_disconnect") document.body.dataset.connection = "disconnected";
    showResult(value);
    log("result", value);
  } catch (error) {
    showError(error);
    log("error", serializeError(error), "error");
  } finally {
    setBusy(false, "Idle");
  }
}

function currentProvider(): ProviderRecord | null {
  return selectedUuid ? providers.get(selectedUuid) ?? null : null;
}

function setBusy(busy: boolean, label: string): void {
  resultStatus.textContent = label;
  resultStatus.className = `result-status${busy ? " busy" : ""}`;
}

function showResult(value: unknown): void {
  result.className = "success-result";
  result.textContent = stringify(value);
}

function showError(error: unknown): void {
  result.className = "error-result";
  result.textContent = stringify(serializeError(error));
}

function log(kind: string, payload: unknown, tone: "normal" | "error" = "normal"): void {
  const item = document.createElement("li");
  item.className = tone === "error" ? "timeline-error" : "";
  const time = document.createElement("time");
  time.textContent = new Date().toLocaleTimeString([], { hour12: false });
  const label = document.createElement("strong");
  label.textContent = kind;
  const value = document.createElement("pre");
  value.textContent = typeof payload === "string" ? payload : stringify(payload);
  item.append(time, label, value);
  timeline.prepend(item);
}

function serializeError(error: unknown): unknown {
  if (!(error instanceof Error)) return error;
  const providerError = error as Error & { code?: unknown; data?: unknown };
  return {
    name: error.name,
    message: error.message,
    ...(typeof providerError.code === "number" ? { code: providerError.code } : {}),
    ...(providerError.data === undefined ? {} : { data: providerError.data }),
  };
}

function stringify(value: unknown): string {
  if (value === undefined) return "undefined";
  return JSON.stringify(value, null, 2);
}

function isDetail(value: unknown): value is PlaygroundProviderDetail {
  if (!isRecord(value) || !isRecord(value.info) || !isRecord(value.provider)) return false;
  return (
    typeof value.info.uuid === "string" &&
    typeof value.info.name === "string" &&
    typeof value.info.icon === "string" &&
    typeof value.info.rdns === "string" &&
    typeof value.provider.request === "function" &&
    typeof value.provider.on === "function"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function element(id: string): HTMLElement {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing #${id}`);
  return value;
}
