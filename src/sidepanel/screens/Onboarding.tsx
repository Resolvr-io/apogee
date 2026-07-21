// First-run onboarding: create a new wallet or restore from a seed phrase.
// A single create/restore call also initializes the password-protected
// keystore (see the SW's wallet/create|restore handlers).

import { Check, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { LiquidNetwork } from "@/keystore/keystore";
import { Button, Card, CopyButton, ErrorText, Field, Input, Modal, Spinner, Textarea, WelcomeShell } from "@/sidepanel/components/ui";
import { errMessage, wallet } from "@/sidepanel/wallet-client";
import { openJadeWindow } from "@/sidepanel/jade-window";
import { cn } from "@/lib/utils";
import { browser } from "@/lib/ext";

type Step = "choose" | "create" | "backup" | "restore" | "hardware-connect" | "hardware" | "watch";

// Watch-only material messaged back from the Jade window (apogee/jade-paired).
interface PairedJade {
  descriptor: string;
  fingerprint: string;
  network: LiquidNetwork;
}

// Mainnet is the default selection; Testnet stays available for development.
const NETWORKS: { value: LiquidNetwork; label: string }[] = [
  { value: "liquid", label: "Mainnet" },
  { value: "liquidtestnet", label: "Testnet" },
];

const PASSWORD_MAX = 128;

export function Onboarding({
  onDone,
  initialStep = "choose",
  replace = false,
  onCancel,
}: {
  onDone: () => void;
  initialStep?: Extract<Step, "choose" | "restore">;
  // Forgot-password recovery: `replace` wipes the old vault on a valid restore;
  // `onCancel` exits recovery (back to the lock screen) instead of the chooser.
  replace?: boolean;
  onCancel?: () => void;
}) {
  const [step, setStep] = useState<Step>(initialStep);
  const [network, setNetwork] = useState<LiquidNetwork>("liquid");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [phrase, setPhrase] = useState(""); // restore input
  const [descriptor, setDescriptor] = useState(""); // watch-only descriptor import
  const [created, setCreated] = useState(""); // generated mnemonic to back up
  const [pairedJade, setPairedJade] = useState<PairedJade | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [savedConfirmed, setSavedConfirmed] = useState(false); // seed backup gate
  const [showHwModal, setShowHwModal] = useState(false); // Firefox HW-wallet limitation notice

  // Every step starts with clean form fields: a password typed in one flow must
  // not silently carry into another (e.g. seed-restore -> back -> watch-only
  // arrived with the password invisibly pre-filled), and a typed seed phrase or
  // descriptor should not linger in state after leaving its flow.
  useEffect(() => {
    setPassword("");
    setConfirm("");
    setPhrase("");
    setDescriptor("");
    setError("");
  }, [step]);

  // The Jade window pairs over Web Serial and messages the watch-only descriptor
  // back; advance to the password step to finish setup. The ack (sendResponse)
  // tells the Jade tab its pairing actually landed here — without it the tab
  // shows a retry hint instead of a false "Paired" success.
  useEffect(() => {
    const onMsg = (
      msg: unknown,
      _sender: chrome.runtime.MessageSender,
      sendResponse: (response?: unknown) => void,
    ) => {
      if (!msg || typeof msg !== "object" || (msg as { type?: string }).type !== "apogee/jade-paired") {
        return;
      }
      const m = msg as PairedJade & { descriptor?: unknown };
      if (typeof m.descriptor !== "string" || !m.descriptor) return;
      setPairedJade({ descriptor: m.descriptor, fingerprint: m.fingerprint, network: m.network });
      setError("");
      setStep("hardware");
      sendResponse({ ok: true });
    };
    browser.runtime.onMessage.addListener(onMsg);
    return () => browser.runtime.onMessage.removeListener(onMsg);
  }, []);

  function validatePassword(): string | null {
    if (password.length < 8) return "Password must be at least 8 characters.";
    if (password.length > PASSWORD_MAX) return `Password must be at most ${PASSWORD_MAX} characters.`;
    if (password !== confirm) return "Passwords don't match.";
    return null;
  }

  // Keep the submit button dimmed until the password reaches the 8-character
  // minimum AND the confirmation matches (the confirm field shows a live hint
  // for the mismatch; validatePassword stays as the on-submit backstop).
  const passwordReady =
    password.length >= 8 && password.length <= PASSWORD_MAX && password === confirm;

  async function doCreate() {
    const bad = validatePassword();
    if (bad) return setError(bad);
    setBusy(true);
    setError("");
    try {
      const { mnemonic } = await wallet.create(password, "Main wallet", network);
      setCreated(mnemonic);
      setStep("backup");
    } catch (e) {
      setError(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function doRestore() {
    const bad = validatePassword();
    if (bad) return setError(bad);
    setBusy(true);
    setError("");
    try {
      await wallet.restore(password, phrase, "Restored wallet", network, replace);
      onDone();
    } catch (e) {
      setError(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function doPairHardware() {
    if (!pairedJade) return;
    const bad = validatePassword();
    if (bad) return setError(bad);
    setBusy(true);
    setError("");
    try {
      await wallet.addHardwareWallet({
        password,
        signer: "jade",
        descriptor: pairedJade.descriptor,
        fingerprint: pairedJade.fingerprint,
        label: "Jade wallet",
        network: pairedJade.network,
      });
      onDone();
    } catch (e) {
      setError(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function doAddWatchOnly() {
    const bad = validatePassword();
    if (bad) return setError(bad);
    if (!descriptor.trim()) return setError("Paste a wallet descriptor to import.");
    setBusy(true);
    setError("");
    try {
      await wallet.addWatchOnlyWallet({ password, descriptor, label: "Watch-only wallet", network });
      onDone();
    } catch (e) {
      setError(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const networkPicker = (
    <Field label="Network">
      <div className="flex gap-2">
        {NETWORKS.map((n) => (
          <button
            key={n.value}
            type="button"
            onClick={() => setNetwork(n.value)}
            className={
              network === n.value
                ? "highlight-glow flex-1 rounded-md px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.08em]"
                : "flex-1 rounded-md border border-[color:var(--border-default)] px-3 py-2 text-[11px] font-medium uppercase tracking-[0.08em] text-[color:var(--text-secondary)]"
            }
          >
            {n.label}
          </button>
        ))}
      </div>
    </Field>
  );

  if (step === "choose") {
    return (
      <WelcomeShell subtitle="A self-custodial Liquid Bitcoin wallet.">
        <div className="flex flex-col gap-3">
          <Button onClick={() => setStep("create")}>Create a new wallet</Button>
          <Button variant="secondary" onClick={() => setStep("restore")}>
            Restore from seed phrase
          </Button>
          {!__FIREFOX__ && (
            <Button variant="secondary" onClick={() => setStep("hardware-connect")}>
              Connect hardware wallet
            </Button>
          )}
          {/* De-emphasized: plain muted text links, not buttons. */}
          <div className="mt-1 flex flex-col items-center gap-1.5 text-xs text-[color:var(--text-subtle)]">
            <button
              type="button"
              onClick={() => setStep("watch")}
              className="hover:text-[color:var(--text-secondary)]"
            >
              Import watch-only wallet
            </button>
            {__FIREFOX__ && (
              <button
                type="button"
                onClick={() => setShowHwModal(true)}
                className="hover:text-[color:var(--text-secondary)]"
              >
                Use a hardware wallet
              </button>
            )}
          </div>
        </div>
        {__FIREFOX__ && (
          <Modal open={showHwModal} onClose={() => setShowHwModal(false)} title="Hardware wallet">
            <img src="/icons/sad-jade.svg" alt="" className="mx-auto block h-28" />
            <p>
              Hardware wallet signing isn't available on Firefox yet. Firefox blocks the
              Web Serial API in extension pages, which Jade needs to connect over USB.
            </p>
            <button
              type="button"
              onClick={() => void browser.tabs.create({ url: "https://apogee.resolvr.io" })}
              className="font-medium text-[color:var(--accent)] hover:underline"
            >
              Get Apogee for Chrome →
            </button>
          </Modal>
        )}
      </WelcomeShell>
    );
  }

  if (step === "hardware-connect") {
    return (
      <Screen
        title="Connect your Jade"
        subtitle="Pick the network, then open the Jade window to pair it over USB."
      >
        {networkPicker}
        <Button onClick={() => openJadeWindow(network)}>Connect Jade</Button>
        <p className="text-center text-xs text-[color:var(--text-subtle)]">
          A Jade window opens to pair. Come back here when it's done. Mainnet needs a
          mainnet-ready Jade; testnet needs a testnet signer.
        </p>
        <BackLink onClick={() => reset(setStep, setError)} />
      </Screen>
    );
  }

  if (step === "watch") {
    return (
      <Screen
        title="Import a watch-only wallet"
        subtitle="Paste a Liquid descriptor to track a wallet's balance and receive to it. It can't sign or send. This password unlocks Apogee on this device."
      >
        <form
          className="contents"
          onSubmit={(e) => {
            e.preventDefault();
            void doAddWatchOnly();
          }}
        >
          {networkPicker}
          <Field label="Wallet descriptor">
            <Textarea
              value={descriptor}
              onChange={(e) => setDescriptor(e.target.value)}
              placeholder="ct(slip77(…),elwpkh([fingerprint/84h/…]xpub…/<0;1>/*))"
              rows={4}
              autoFocus
            />
          </Field>
          <PasswordFields
            password={password}
            confirm={confirm}
            onPassword={setPassword}
            onConfirm={setConfirm}
          />
          <ErrorText>{error}</ErrorText>
          <Button type="submit" disabled={busy || !passwordReady || !descriptor.trim()}>
            {busy ? <Spinner /> : "Add watch-only wallet"}
          </Button>
        </form>
        <BackLink onClick={() => reset(setStep, setError)} />
      </Screen>
    );
  }

  if (step === "create") {
    return (
      <Screen title="Create a wallet" subtitle="This password encrypts your seed on this device.">
        <form
          className="contents"
          onSubmit={(e) => {
            e.preventDefault();
            void doCreate();
          }}
        >
          {networkPicker}
          <PasswordFields
            password={password}
            confirm={confirm}
            onPassword={setPassword}
            onConfirm={setConfirm}
            autoFocus
          />
          <ErrorText>{error}</ErrorText>
          <Button type="submit" disabled={busy || !passwordReady}>
            {busy ? <Spinner /> : "Create wallet"}
          </Button>
        </form>
        <BackLink onClick={() => reset(setStep, setError)} />
      </Screen>
    );
  }

  if (step === "hardware") {
    return (
      <Screen
        title="Connect your Jade"
        subtitle="Your Jade signs transactions; this password unlocks Apogee on this device."
      >
        <div className="rounded-lg border border-[color:var(--border-default)] bg-[color:var(--surface-soft)] p-3 text-xs">
          <div className="text-[color:var(--text-subtle)]">
            Hardware wallet ·{" "}
            {pairedJade?.network === "liquid"
              ? "Mainnet"
              : pairedJade?.network === "liquidtestnet"
                ? "Testnet"
                : pairedJade?.network}
          </div>
          <div className="mt-1 font-mono text-[color:var(--text-strong)]">
            Jade {pairedJade?.fingerprint}
          </div>
        </div>
        <form
          className="contents"
          onSubmit={(e) => {
            e.preventDefault();
            void doPairHardware();
          }}
        >
          <PasswordFields
            password={password}
            confirm={confirm}
            onPassword={setPassword}
            onConfirm={setConfirm}
            autoFocus
          />
          <ErrorText>{error}</ErrorText>
          <Button type="submit" disabled={busy || !passwordReady}>
            {busy ? <Spinner /> : "Add hardware wallet"}
          </Button>
        </form>
        <BackLink onClick={() => reset(setStep, setError)} />
      </Screen>
    );
  }

  if (step === "backup") {
    return (
      <Screen
        title="Back up your seed phrase"
        subtitle="Write these 12 words down in order. They are the only way to recover your wallet."
      >
        <ol className="selectable grid grid-cols-2 gap-1.5 rounded-xl border border-[color:var(--border-default)] bg-[color:var(--surface-soft)] p-3">
          {created.split(" ").map((word, i) => (
            <li key={i} className="flex gap-2 font-mono text-xs text-[color:var(--text-strong)]">
              <span className="w-4 text-right text-[color:var(--text-subtle)]">{i + 1}</span>
              {word}
            </li>
          ))}
        </ol>
        <CopyButton value={created} label="Copy seed phrase" className="w-full" />
        <label className="flex items-start gap-2 text-xs text-[color:var(--text-secondary)]">
          <input
            type="checkbox"
            checked={savedConfirmed}
            onChange={(e) => setSavedConfirmed(e.target.checked)}
            className="mt-0.5"
          />
          I&apos;ve written down my recovery phrase and stored it safely.
        </label>
        <Button
          disabled={!savedConfirmed}
          onClick={() => {
            setCreated(""); // drop the mnemonic from memory once backed up
            onDone();
          }}
        >
          Continue
        </Button>
      </Screen>
    );
  }

  // restore
  return (
    <Screen title="Restore a wallet" subtitle="Enter your 12 or 24 word seed phrase.">
      {replace && (
        <p className="rounded-lg border border-[color:var(--warning-border)] bg-[color:var(--warning-bg)] px-3 py-2 text-xs text-[color:var(--warning-text)]">
          Recovery mode replaces everything on this device: all existing wallets
          (including any hardware wallets) are removed and only this phrase is
          restored. Your funds stay safe on-chain.
        </p>
      )}
      <form
        className="contents"
        onSubmit={(e) => {
          e.preventDefault();
          void doRestore();
        }}
      >
        {networkPicker}
        <Field label="Seed phrase">
          <Textarea
            value={phrase}
            onChange={(e) => setPhrase(e.target.value)}
            placeholder="word1 word2 word3 …"
            autoFocus
          />
        </Field>
        <PasswordFields
          password={password}
          confirm={confirm}
          onPassword={setPassword}
          onConfirm={setConfirm}
        />
        <ErrorText>{error}</ErrorText>
        <Button type="submit" disabled={busy || !passwordReady}>
          {busy ? <Spinner /> : "Restore wallet"}
        </Button>
      </form>
      <BackLink onClick={onCancel ?? (() => reset(setStep, setError))} />
    </Screen>
  );
}

function reset(setStep: (s: Step) => void, setError: (s: string) => void) {
  setError("");
  setStep("choose");
}

function Screen({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-1 flex-col justify-center gap-3 px-5 py-5">
      <img src="/icons/apogee-logo.svg" alt="Apogee" className="h-6 w-auto" />
      <Card className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="console-title text-base">{title}</h1>
          <p className="text-sm text-[color:var(--text-secondary)]">{subtitle}</p>
        </div>
        <div className="flex flex-col gap-3">{children}</div>
      </Card>
    </div>
  );
}

function BackLink({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-xs text-[color:var(--text-subtle)] hover:text-[color:var(--text-secondary)]"
    >
      ← Back
    </button>
  );
}

type IndicatorState = "ok" | "bad" | null;

// A password input with a validity indicator at its right edge: a green check
// when the value is valid, a red x on a genuine mismatch.
function ValidatedInput({
  value,
  onChange,
  indicator,
  autoFocus,
}: {
  value: string;
  onChange: (v: string) => void;
  indicator: IndicatorState;
  autoFocus?: boolean;
}) {
  return (
    <div className="relative">
      <Input
        type="password"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        maxLength={PASSWORD_MAX}
        autoFocus={autoFocus}
        className="pr-10"
      />
      {indicator && (
        <span
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute right-3 top-1/2 -translate-y-1/2",
            indicator === "ok"
              ? "text-[color:var(--success-text)]"
              : "text-[color:var(--danger-text)]",
          )}
        >
          {indicator === "ok" ? <Check size={18} /> : <X size={18} />}
        </span>
      )}
    </div>
  );
}

// Password + confirmation pair, shared by the create/restore/hardware screens.
// A green check appears in the password box once it's long enough, and in the
// confirm box once it matches; a red x flags a genuine mismatch — held back
// until the user pauses typing so it doesn't flash while a matching value is
// still being entered.
const CONFIRM_MISMATCH_DELAY = 700; // ms idle before showing the mismatch x

function PasswordFields({
  password,
  confirm,
  onPassword,
  onConfirm,
  autoFocus,
}: {
  password: string;
  confirm: string;
  onPassword: (v: string) => void;
  onConfirm: (v: string) => void;
  autoFocus?: boolean;
}) {
  const passwordOk = password.length >= 8 && password.length <= PASSWORD_MAX;
  const matches = confirm.length > 0 && confirm === password;

  // Defer the red x on a mismatch so it doesn't appear mid-keystroke.
  const [showMismatch, setShowMismatch] = useState(false);
  useEffect(() => {
    if (confirm.length === 0 || confirm === password) {
      setShowMismatch(false);
      return;
    }
    const t = window.setTimeout(() => setShowMismatch(true), CONFIRM_MISMATCH_DELAY);
    return () => window.clearTimeout(t);
  }, [password, confirm]);

  const confirmIndicator: IndicatorState =
    confirm.length === 0
      ? null
      : matches
        ? passwordOk
          ? "ok"
          : null
        : showMismatch
          ? "bad"
          : null;

  return (
    <>
      <Field label="Password">
        <ValidatedInput
          value={password}
          onChange={onPassword}
          indicator={passwordOk ? "ok" : null}
          autoFocus={autoFocus}
        />
      </Field>
      <Field label="Confirm password">
        <ValidatedInput value={confirm} onChange={onConfirm} indicator={confirmIndicator} />
      </Field>
      {/* The red x carries the mismatch visually; mirror it to screen readers
          without occupying a visible line. */}
      <p className="sr-only" role="status">
        {showMismatch ? "Passwords don't match." : ""}
      </p>
    </>
  );
}
