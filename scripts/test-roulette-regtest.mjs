#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { Readable } from "node:stream";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const APOGEE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ROULETTE_DIR = resolve(
  process.env.SIMPLICITY_ROULETTE_DIR ?? resolve(APOGEE_DIR, "../liquid-dapps/simplicity-roulette"),
);
const SIMPLEX = process.env.SIMPLEX_BIN ?? "simplex";
const simplexEnv = {
  ...process.env,
  PATH: `${dirname(resolve(SIMPLEX))}:${process.env.PATH ?? ""}`,
};
const TEST_EXTENSION_DIR = resolve(APOGEE_DIR, "dist-roulette-regtest");
const children = new Set();
const dataDir = await mkdtemp(join(tmpdir(), "apogee-roulette-regtest-"));
let proxy;
let cleaned = false;

try {
  await access(resolve(ROULETTE_DIR, "contracts/Simplex.toml"));
  await access(resolve(ROULETTE_DIR, "src/server/index.ts"));
} catch {
  fail(`Simplicity Roulette was not found at ${ROULETTE_DIR}. Set SIMPLICITY_ROULETTE_DIR.`);
}

process.on("SIGINT", () => void cleanup(130));
process.on("SIGTERM", () => void cleanup(143));
process.on("uncaughtException", (error) => void cleanup(1, error));
process.on("unhandledRejection", (error) => void cleanup(1, error));

try {
  console.log("[roulette-regtest] Compiling the repository-pinned roulette contract…");
  await run(SIMPLEX, ["build"], {
    cwd: resolve(ROULETTE_DIR, "contracts"),
    env: simplexEnv,
  });

  console.log("[roulette-regtest] Starting the repository-pinned Elements/electrs stack…");
  const simplex = start(SIMPLEX, ["regtest"], {
    cwd: resolve(ROULETTE_DIR, "contracts"),
    env: simplexEnv,
    capture: true,
  });
  const services = await parseSimplexServices(simplex);
  const [expectedGenesisHash, assetLabels] = await Promise.all([
    elementsRpc(services, "getblockhash", [0]),
    elementsRpc(services, "dumpassetlabels"),
  ]);
  const policyAssetId = assetLabels?.bitcoin;
  if (!/^[0-9a-f]{64}$/.test(expectedGenesisHash) || !/^[0-9a-f]{64}$/.test(policyAssetId ?? "")) {
    throw new Error("Disposable Elements did not report canonical genesis and policy-asset identifiers");
  }
  const [apiPort, webPort, proxyPort] = await Promise.all([freePort(), freePort(), freePort()]);

  proxy = createEsploraProxy(proxyPort, services);
  await new Promise((resolveReady, reject) => {
    proxy.once("listening", resolveReady);
    proxy.once("error", reject);
    proxy.listen(proxyPort, "127.0.0.1");
  });

  console.log("[roulette-regtest] Starting the read-only roulette indexer and web app…");
  start(process.execPath, ["--disable-warning=ExperimentalWarning", "src/server/index.ts"], {
    cwd: ROULETTE_DIR,
    env: {
      ...process.env,
      PORT: String(apiPort),
      ALLOWED_ORIGINS: `http://127.0.0.1:${webPort}`,
      DATA_DIR: dataDir,
      RECONCILE_MS: "1000",
      CHAIN_BACKEND: "esplora",
      ESPLORA_URLS: services.esploraUrl,
      EXPECTED_GENESIS_HASH: expectedGenesisHash,
      POLICY_ASSET_ID: policyAssetId,
      ESPLORA_REQUEST_TIMEOUT_MS: "5000",
      // A call here would fail the run, proving the website uses Esplora only.
      ELEMENTS_RPC_URL: "http://127.0.0.1:1",
      EXPECTED_CHAIN: "liquidregtest",
      REQUIRED_CONFIRMATIONS: "1",
      DEFAULT_OPEN_DELAY_BLOCKS: "2",
      DEFAULT_MIN_REVEAL_AGE_BLOCKS: "1",
      DEFAULT_ACTIVE_DELAY_BLOCKS: "3",
    },
    label: "roulette-indexer",
  });
  await waitForHttp(`http://127.0.0.1:${apiPort}/api/v1/health`, 60_000);

  start(resolve(ROULETTE_DIR, "node_modules/.bin/vite"), [
    "--host",
    "127.0.0.1",
    "--port",
    String(webPort),
    "--strictPort",
  ], {
    cwd: ROULETTE_DIR,
    env: { ...process.env, API_PORT: String(apiPort), WEB_PORT: String(webPort) },
    label: "roulette-web",
  });
  await waitForHttp(`http://127.0.0.1:${webPort}/`, 60_000);

  console.log("[roulette-regtest] Building the regtest-gated Apogee extension…");
  await run(resolve(APOGEE_DIR, "node_modules/.bin/vite"), [
    "build",
    "--outDir",
    TEST_EXTENSION_DIR,
  ], {
    cwd: APOGEE_DIR,
    env: { ...process.env, APOGEE_TX_MANIFEST_REGTEST: "1" },
  });

  console.log("[roulette-regtest] Running the funded two-wallet lifecycle in Chromium…");
  const playwrightArgs = ["test", "--config=playwright.roulette-regtest.config.ts"];
  if (process.env.ROULETTE_REGTEST_PLAYWRIGHT_GREP) {
    playwrightArgs.push("--grep", process.env.ROULETTE_REGTEST_PLAYWRIGHT_GREP);
  }
  const code = await run(resolve(APOGEE_DIR, "node_modules/.bin/playwright"), playwrightArgs, {
    cwd: APOGEE_DIR,
    env: {
      ...process.env,
      ROULETTE_REGTEST_DAPP_URL: `http://127.0.0.1:${webPort}/`,
      ROULETTE_REGTEST_API_URL: `http://127.0.0.1:${apiPort}/api/v1`,
      ROULETTE_REGTEST_EXTENSION_PATH: TEST_EXTENSION_DIR,
      ROULETTE_REGTEST_ESPLORA_URL: services.esploraUrl,
      ROULETTE_REGTEST_APOGEE_ESPLORA_URL: `http://127.0.0.1:${proxyPort}/esplora/api`,
      ROULETTE_REGTEST_RPC_URL: services.rpcUrl,
      ROULETTE_REGTEST_RPC_USER: services.rpcUser,
      ROULETTE_REGTEST_RPC_PASSWORD: services.rpcPassword,
      ROULETTE_REGTEST_MINER_ADDRESS: services.signerAddress,
    },
    returnCode: true,
  });
  await cleanup(code);
} catch (error) {
  await cleanup(1, error);
}

function start(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  child.once("exit", () => children.delete(child));
  if (!options.capture) pipeLines(child, options.label ?? command);
  return child;
}

function pipeLines(child, label) {
  for (const stream of [child.stdout, child.stderr]) {
    stream?.on("data", (chunk) => {
      for (const line of String(chunk).split(/\r?\n/).filter(Boolean)) {
        console.log(`[${label}] ${line}`);
      }
    });
  }
}

async function run(command, args, options = {}) {
  const child = start(command, args, options);
  const code = await new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (exitCode, signal) => {
      if (signal) reject(new Error(`${command} stopped by ${signal}`));
      else resolveExit(exitCode ?? 1);
    });
  });
  if (options.returnCode) return code;
  if (code !== 0) throw new Error(`${command} ${args.join(" ")} failed with exit code ${code}`);
  return code;
}

async function parseSimplexServices(child) {
  let output = "";
  const parsed = new Promise((resolveParsed, reject) => {
    const consume = (chunk) => {
      output += String(chunk);
      const rpc = output.match(/RPC:\s+(http:\/\/[^\s]+)/)?.[1];
      const esplora = output.match(/Esplora:\s+(http:\/\/[^\s]+)/)?.[1];
      const credentials = output.match(/User:\s+"([^"]+)", Password:\s+"([^"]+)"/);
      const signer = output.match(/Signer:\s+([^\s]+)/)?.[1];
      if (rpc && esplora && credentials && signer) {
        resolveParsed({
          rpcUrl: rpc,
          esploraUrl: esplora.replace(/\/+$/, ""),
          rpcUser: credentials[1],
          rpcPassword: credentials[2],
          signerAddress: signer,
        });
      }
    };
    child.stdout.on("data", consume);
    child.stderr.on("data", consume);
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(
      `simplex regtest exited before it became ready (${code ?? "signal"}).\n${output}`,
    )));
  });
  return Promise.race([
    parsed,
    timeout(60_000, "Timed out waiting for simplex regtest. Install the pinned Simplex CLI."),
  ]);
}

function createEsploraProxy(port, services) {
  return createServer(async (request, response) => {
    try {
      if (request.method === "OPTIONS") {
        response.writeHead(204, corsHeaders());
        response.end();
        return;
      }
      const incoming = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
      if (!incoming.pathname.startsWith("/esplora/api/")) {
        response.writeHead(404, corsHeaders());
        response.end();
        return;
      }
      const path = incoming.pathname.slice("/esplora/api".length);
      const body = request.method === "GET" || request.method === "HEAD"
        ? undefined
        : await readRequestBody(request);
      const upstream = await fetch(`${services.esploraUrl}${path}${incoming.search}`, {
        method: request.method,
        headers: request.headers,
        body,
      });
      if (request.method === "POST" && path === "/tx") {
        const result = (await upstream.clone().text()).trim();
        const log = upstream.ok ? console.log : console.error;
        log(`[roulette-esplora] broadcast ${upstream.status}: ${result}`);
        if (!upstream.ok && body) {
          try {
            const decoded = await elementsRpc(services, "decoderawtransaction", [body.toString("utf8")]);
            console.error(`[roulette-esplora] rejected transaction ${JSON.stringify({
              txid: decoded.txid,
              vin: decoded.vin.map(({ txid, vout }) => ({ txid, vout })),
            })}`);
          } catch (error) {
            console.error(`[roulette-esplora] could not decode rejected transaction: ${error}`);
          }
        }
      }
      response.writeHead(upstream.status, {
        ...Object.fromEntries(upstream.headers),
        ...corsHeaders(),
      });
      if (upstream.body) Readable.fromWeb(upstream.body).pipe(response);
      else response.end();
    } catch (error) {
      response.writeHead(502, { ...corsHeaders(), "content-type": "text/plain" });
      response.end(String(error));
    }
  });
}

async function readRequestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function elementsRpc(services, method, params = []) {
  const authorization = Buffer.from(`${services.rpcUser}:${services.rpcPassword}`).toString("base64");
  const response = await fetch(services.rpcUrl, {
    method: "POST",
    headers: { authorization: `Basic ${authorization}`, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "1.0", id: "roulette-regtest-proxy", method, params }),
  });
  const payload = await response.json();
  if (!response.ok || payload.error) {
    throw new Error(payload.error?.message ?? `Elements RPC ${method} failed`);
  }
  return payload.result;
}

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "Content-Type, Authorization",
  };
}

async function freePort() {
  const server = createTcpServer();
  await new Promise((resolveReady, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveReady);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolveClose) => server.close(resolveClose));
  return port;
}

async function waitForHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Service is still starting.
    }
    await delay(300);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function timeout(ms, message) {
  return new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    timer.unref();
  });
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function cleanup(exitCode, error) {
  if (cleaned) return;
  cleaned = true;
  if (error) console.error(error instanceof Error ? error.stack ?? error.message : error);
  proxy?.close();
  for (const child of children) child.kill("SIGINT");
  await delay(300);
  for (const child of children) child.kill("SIGKILL");
  await rm(dataDir, { recursive: true, force: true });
  process.exitCode = exitCode;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
