// Standalone Jade window, opened as a full tab from the side panel / service
// worker. Web Serial needs a user gesture + top-level secure context (not the
// offscreen doc), so Jade lives in its own extension tab with its own lwk_wasm.
//
// Two flows, by URL param, both rendered as a card on the starfield:
//   • pairing  (default)     — Connect › Pair: read jade.wpkh() + fingerprint,
//                              hand the watch-only descriptor to the side panel.
//   • signing  (?sign=<id>)  — Connect › Review › Done: fetch the PSET + review
//                              summary, sign on-device, the SW finalizes +
//                              broadcasts and returns the txid for the Done card.
//
// Device chooser: filtered to Blockstream chips first (clean list); a "show all"
// fallback re-runs unfiltered for Jade revisions lwk's filter doesn't know.

import type * as Lwk from "lwk_wasm";
import type { LiquidNetwork } from "@/keystore/keystore";
import type { SendReview } from "@/engine/protocol";
import { explorerTxUrl } from "@/lib/explorer";
import { formatSats } from "@/lib/format";
import { isValidFingerprint, shortenHex } from "@/lib/utils";

const params = new URLSearchParams(location.search);
const network = (params.get("network") ?? "liquid") as LiquidNetwork;
const signId = params.get("sign"); // present → signing; absent → pairing

const card = document.getElementById("card") as HTMLElement;

const SIGN_STEPS = ["Connect", "Review", "Done"];
const PAIR_STEPS = ["Connect", "Pair"];

function lwkNetwork(lwk: typeof Lwk, net: string): Lwk.Network {
  switch (net) {
    case "liquid":
      return lwk.Network.mainnet();
    case "regtest":
      return lwk.Network.regtestDefault();
    default:
      return lwk.Network.testnet();
  }
}

function networkLabel(net: string): string {
  return net === "liquid" ? "Liquid" : net === "regtest" ? "Regtest" : "Liquid Testnet";
}

/** Master fingerprint parsed from a BIP84 key-origin string ("[fp/84h/..]"). */
function fingerprintOf(keyorigin: string): string {
  return /^\[([0-9a-fA-F]{8})/.exec(keyorigin)?.[1] ?? "";
}

/** Map Jade's cryptic device-state codes to actionable guidance. */
function friendlyJadeError(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  if (m.includes("-32002")) {
    return "This Jade's temporary signer is bound to another connection. Power-cycle the Jade, close any other app or tab using it, then connect once.";
  }
  if (m.includes("-32003")) {
    return "This Jade is locked to a different network for this session. Power-cycle it and connect on the right network first.";
  }
  if (/open serial port|failed to open|already open|port is (already )?in use/i.test(m)) {
    return "Couldn't open the Jade — another tab or app is using it. Close any other Jade tabs (and apps like Blockstream Green), then connect once. Unplug and replug the Jade if it persists.";
  }
  return e instanceof Error ? e.message : String(e);
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&quot;",
  );
}

function stepsHtml(labels: string[], active: number): string {
  const inner = labels
    .map((l, i) => {
      const cls = i < active ? "done" : i === active ? "active" : "";
      return `<span class="${cls}">${i < active ? "✓ " : ""}${l}</span>`;
    })
    .join('<span class="sep">›</span>');
  return `<div class="steps">${inner}</div>`;
}

function badgeHtml(net: string): string {
  if (net === "liquid") return "";
  return `<span class="badge">${net === "regtest" ? "Regtest" : "Testnet"}</span>`;
}

function summaryHtml(s: SendReview): string {
  return `<div class="summary">
      <div class="row"><span class="k">To</span><span class="v mono">${esc(shortenHex(s.address, 10, 8))}</span></div>
      <div class="row"><span class="k">${s.drain ? "Amount (max)" : "Amount"}</span><span class="v">${formatSats(s.recipientSats)} sats</span></div>
      <div class="row"><span class="k">Network fee</span><span class="v">${formatSats(s.fee)} sats</span></div>
      <div class="row total"><span class="k">Total</span><span class="v">${formatSats(s.recipientSats + s.fee)} sats</span></div>
    </div>`;
}

// ---- connect (shared) ------------------------------------------------------

interface ConnectOpts {
  steps: string[];
  cta: string;
  onConnected: (lwk: typeof Lwk, jade: Lwk.Jade) => Promise<void>;
}

function showConnect(opts: ConnectOpts): void {
  card.innerHTML = `
    ${stepsHtml(opts.steps, 0)}
    <h1>Connect your Jade</h1>
    <p class="sub" id="status">Plug in your Jade and unlock it, then connect over USB.</p>
    <button class="btn" id="connect">${esc(opts.cta)}</button>
    <button class="ghost" id="showall" hidden>Don't see your Jade? Show all devices</button>
  `;
  const statusEl = card.querySelector("#status") as HTMLElement;
  const connectBtn = card.querySelector<HTMLButtonElement>("#connect");
  const showAllBtn = card.querySelector<HTMLButtonElement>("#showall");
  if (!connectBtn || !showAllBtn) return;

  async function attempt(filter: boolean): Promise<void> {
    if (!("serial" in navigator)) {
      statusEl.textContent = "Web Serial isn't available in this browser.";
      return;
    }
    connectBtn!.disabled = true;
    statusEl.textContent = "Select your Jade in the chooser, then approve on the device…";
    let lwk: typeof Lwk;
    let jade: Lwk.Jade;
    try {
      lwk = await import("lwk_wasm");
      jade = await lwk.Jade.fromSerial(lwkNetwork(lwk, network), filter);
    } catch (e) {
      const name = (e as { name?: string }).name;
      if (name === "NotFoundError" && filter) {
        statusEl.textContent =
          "No Blockstream device in the list. If your Jade isn't shown, try all devices.";
        showAllBtn!.hidden = false;
      } else if (name === "NotFoundError") {
        statusEl.textContent =
          "No device selected. Plug in and unlock the Jade, then connect and pick it from the list.";
      } else {
        statusEl.textContent = friendlyJadeError(e);
      }
      connectBtn!.disabled = false;
      return;
    }
    // Connected — hand off; from here the flow owns its own UI + errors.
    try {
      await opts.onConnected(lwk, jade);
    } finally {
      // Release the Web Serial port once the flow is done (success or failure), so
      // a lingering Sent/error tab doesn't hold it and block the next Jade op with
      // a "port in use" error. Both flows read everything they need from `jade`
      // before returning, so freeing here is safe; the tab (Done card) stays open.
      try {
        jade.free();
      } catch {
        /* already freed / disposed */
      }
    }
  }

  connectBtn.addEventListener("click", () => void attempt(true));
  showAllBtn.addEventListener("click", () => void attempt(false));
}

// ---- shared status cards ---------------------------------------------------

function showFailed(message: string, onRetry?: () => void): void {
  card.innerHTML = `
    <div class="status-icon err">!</div>
    <h1>Couldn't complete</h1>
    <p class="sub">${esc(message)}</p>
    ${onRetry ? '<button class="btn secondary" id="retry">Try again</button>' : ""}
    <button class="ghost" id="close">Close tab</button>
  `;
  card.querySelector("#close")?.addEventListener("click", () => window.close());
  if (onRetry) card.querySelector("#retry")?.addEventListener("click", () => onRetry());
}

// ---- signing (E3) ----------------------------------------------------------

function showReview(summary: SendReview): void {
  card.innerHTML = `
    ${stepsHtml(SIGN_STEPS, 1)}
    <h1>Review on your Jade</h1>
    ${badgeHtml(network)}
    ${summaryHtml(summary)}
    <div class="wait"><span class="spin"></span> Approve the transaction on your Jade…</div>
  `;
}

function showBroadcasting(): void {
  card.innerHTML = `
    ${stepsHtml(SIGN_STEPS, 2)}
    <h1>Broadcasting</h1>
    <div class="wait"><span class="spin"></span> Sending your transaction to the network…</div>
  `;
}

function showSignDone(summary: SendReview, txid: string): void {
  const explorer = explorerTxUrl(network, txid);
  card.innerHTML = `
    ${stepsHtml(SIGN_STEPS, 3)}
    <div class="status-icon ok">✓</div>
    <h1>Sent</h1>
    <p class="sub">${formatSats(summary.recipientSats)} sats on their way. You can close this tab.</p>
    <div class="txrow">
      <span class="mono">${esc(shortenHex(txid, 10, 8))}</span>
      <button class="copybtn" id="copy">Copy</button>
    </div>
    ${explorer ? `<a class="explorer" href="${esc(explorer)}" target="_blank" rel="noreferrer">View transaction ↗</a>` : ""}
  `;
  const copyBtn = card.querySelector<HTMLButtonElement>("#copy");
  copyBtn?.addEventListener("click", () => {
    void navigator.clipboard.writeText(txid).then(() => {
      copyBtn.textContent = "Copied";
    });
  });
}

function signOnConnected(id: string) {
  return async (lwk: typeof Lwk, jade: Lwk.Jade): Promise<void> => {
    try {
      const res = await chrome.runtime.sendMessage({ type: "apogee/jade-sign-get", id });
      if (!res?.ok) throw new Error(res?.error ?? "Couldn't load the transaction to sign.");

      // Verify this is the wallet's device before asking it to sign — fail CLOSED:
      // a missing/unreadable fingerprint on either side aborts rather than skipping
      // the check, so a wrong device is never handed the PSET.
      const keyorigin = await jade.keyoriginXpub(lwk.Bip.bip84());
      const fp = fingerprintOf(keyorigin);
      if (!isValidFingerprint(fp)) {
        throw new Error("Couldn't read this Jade's fingerprint; reconnect the device.");
      }
      if (!res.fingerprint || fp.toLowerCase() !== String(res.fingerprint).toLowerCase()) {
        throw new Error(
          `This Jade (${fp}) isn't the device for this wallet (${res.fingerprint || "unknown"}). Connect the matching Jade.`,
        );
      }

      const summary = res.summary as SendReview;
      showReview(summary);
      const signed = await jade.sign(new lwk.Pset(String(res.pset)));

      showBroadcasting();
      const out = await chrome.runtime.sendMessage({
        type: "apogee/jade-signed",
        id,
        pset: signed.toString(),
      });
      if (!out?.ok) throw new Error(out?.error ?? "Couldn't broadcast the transaction.");
      showSignDone(summary, String(out.txid));
    } catch (e) {
      const message = friendlyJadeError(e);
      chrome.runtime.sendMessage({ type: "apogee/jade-sign-failed", id, error: message }).catch(() => {});
      showFailed(message);
    }
  };
}

// ---- pairing (E2) ----------------------------------------------------------

function showPaired(): void {
  card.innerHTML = `
    ${stepsHtml(PAIR_STEPS, 2)}
    <div class="status-icon ok">✓</div>
    <h1>Paired</h1>
    <p class="sub">Return to Apogee to finish setup. You can close this tab.</p>
    <button class="ghost" id="close">Close tab</button>
  `;
  card.querySelector("#close")?.addEventListener("click", () => window.close());
  // The side panel takes over now; auto-close the finished tab. (The serial port
  // is already released in attempt()'s finally, so this is just tidiness.)
  setTimeout(() => window.close(), 1800);
}

function showPairConfirm(device: { descriptor: string; fingerprint: string }): void {
  card.innerHTML = `
    ${stepsHtml(PAIR_STEPS, 1)}
    <div class="status-icon ok">✓</div>
    <h1>Jade connected</h1>
    <div class="summary">
      <div class="row"><span class="k">Network</span><span class="v">${esc(networkLabel(network))}</span></div>
      <div class="row"><span class="k">Fingerprint</span><span class="v mono">${esc(device.fingerprint)}</span></div>
    </div>
    <button class="btn" id="pair">Pair with Apogee</button>
  `;
  card.querySelector("#pair")?.addEventListener("click", () => {
    void (async () => {
      // Only show "Paired" once the side panel confirms it received the
      // descriptor (its onboarding listener acks with { ok: true }). With the
      // panel closed there's no receiver — sendMessage rejects or resolves
      // undefined — and pretending success would strand the user.
      let acked = false;
      try {
        const res = await chrome.runtime.sendMessage({
          type: "apogee/jade-paired",
          descriptor: device.descriptor,
          fingerprint: device.fingerprint,
          network,
        });
        acked = Boolean((res as { ok?: boolean } | undefined)?.ok);
      } catch {
        acked = false;
      }
      if (acked) {
        showPaired();
      } else {
        showFailed(
          "Apogee didn't receive the pairing. Open the Apogee side panel, choose Connect hardware wallet, then pair again.",
          () => showPairConfirm(device),
        );
      }
    })();
  });
}

async function pairOnConnected(lwk: typeof Lwk, jade: Lwk.Jade): Promise<void> {
  try {
    const keyorigin = await jade.keyoriginXpub(lwk.Bip.bip84());
    const descriptor = (await jade.wpkh()).toString();
    const fingerprint = fingerprintOf(keyorigin);
    // Refuse to pair without a readable fingerprint: it's what verifies the device
    // at sign time, and an empty one would silently disable that check.
    if (!isValidFingerprint(fingerprint)) {
      throw new Error("Couldn't read this Jade's fingerprint. Reconnect the device and try again.");
    }
    showPairConfirm({ descriptor, fingerprint });
  } catch (e) {
    // Reload to retry: it drops the serial port this tab is holding, so the
    // next connect can reopen it.
    showFailed(friendlyJadeError(e), () => location.reload());
  }
}

function startPairing(): void {
  showConnect({ steps: PAIR_STEPS, cta: "Connect Jade", onConnected: pairOnConnected });
}

if (signId) {
  showConnect({ steps: SIGN_STEPS, cta: "Connect & sign", onConnected: signOnConnected(signId) });
} else {
  startPairing();
}
