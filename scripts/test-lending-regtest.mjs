#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { Readable } from "node:stream";
import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const APOGEE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LENDING_DIR = resolve(
  process.env.SIMPLICITY_LENDING_DIR ?? resolve(APOGEE_DIR, "../simplicity-lending"),
);
const SIMPLEX = process.env.SIMPLEX_BIN ?? "simplex";
const simplexEnv = {
  ...process.env,
  PATH: `${dirname(resolve(SIMPLEX))}:${process.env.PATH ?? ""}`,
};
const POSTGRES_IMAGE = process.env.LENDING_REGTEST_POSTGRES_IMAGE ?? "postgres:16-alpine";
const TEST_EXTENSION_DIR = resolve(APOGEE_DIR, "dist-lending-regtest");
const containerName = `apogee-lending-regtest-${process.pid}`;
const children = new Set();
let proxy;
let cleaned = false;

try {
  await access(resolve(LENDING_DIR, "crates/contracts/Simplex.toml"));
} catch {
  fail(`Simplicity Lending was not found at ${LENDING_DIR}. Set SIMPLICITY_LENDING_DIR.`);
}

process.on("SIGINT", () => void cleanup(130));
process.on("SIGTERM", () => void cleanup(143));
process.on("uncaughtException", (error) => void cleanup(1, error));
process.on("unhandledRejection", (error) => void cleanup(1, error));

try {
  console.log("[regtest] Generating the repository-pinned Simplicity contract artifacts…");
  await run(SIMPLEX, ["build"], {
    cwd: resolve(LENDING_DIR, "crates/contracts"),
    env: simplexEnv,
  });

  console.log("[regtest] Starting the repository-pinned Simplex Elements/electrs stack…");
  const simplex = start(SIMPLEX, ["regtest"], {
    cwd: resolve(LENDING_DIR, "crates/contracts"),
    env: simplexEnv,
    capture: true,
  });
  const services = await parseSimplexServices(simplex);

  const [postgresPort, apiPort, webPort, proxyPort] = await Promise.all([
    freePort(),
    freePort(),
    freePort(),
    freePort(),
  ]);
  const principalAssetId = await issuePrincipalAsset(services);

  console.log("[regtest] Starting disposable Postgres and the lending API/indexer…");
  await run("docker", [
    "run",
    "--rm",
    "--name",
    containerName,
    "-e",
    "POSTGRES_USER=postgres",
    "-e",
    "POSTGRES_PASSWORD=password",
    "-e",
    "POSTGRES_DB=lending-indexer",
    "-p",
    `127.0.0.1:${postgresPort}:5432`,
    "-d",
    POSTGRES_IMAGE,
  ]);
  await waitForTcp(postgresPort);
  await waitForPostgres(containerName);
  const migration = await readFile(
    resolve(LENDING_DIR, "crates/indexer/migrations/20260205141654_tables_creation.sql"),
  );
  await run("docker", [
    "exec",
    "-i",
    containerName,
    "psql",
    "-v",
    "ON_ERROR_STOP=1",
    "-U",
    "postgres",
    "-d",
    "lending-indexer",
  ], { input: migration });

  const indexerEnv = {
    ...process.env,
    APP_ENVIRONMENT: "local",
    APPLICATION__PORT: String(apiPort),
    DATABASE__HOST: "127.0.0.1",
    DATABASE__PORT: String(postgresPort),
    DATABASE__USERNAME: "postgres",
    DATABASE__PASSWORD: "password",
    DATABASE__DATABASE_NAME: "lending-indexer",
    ESPLORA__BASE_URL: services.esploraUrl,
    ESPLORA__NETWORK: "regtest",
    INDEXER__PROTOCOL_FEE_KEEPER_ASSET_ID: principalAssetId,
    INDEXER__INTERVAL: "200",
    INDEXER__LAST_INDEXED_HEIGHT: "0",
  };
  start("cargo", ["run", "-p", "lending-indexer"], {
    cwd: resolve(LENDING_DIR, "crates/indexer"),
    env: indexerEnv,
    label: "api",
  });
  start("cargo", ["run", "-p", "lending-indexer"], {
    cwd: resolve(LENDING_DIR, "crates/indexer"),
    env: { ...indexerEnv, RUN_MODE: "indexer" },
    label: "indexer",
  });
  await waitForHttp(`http://127.0.0.1:${apiPort}/health`, 180_000);

  proxy = createRegtestProxy(
    proxyPort,
    services.esploraUrl,
    `http://127.0.0.1:${apiPort}`,
  );
  await new Promise((resolveReady, reject) => {
    proxy.once("listening", resolveReady);
    proxy.once("error", reject);
    proxy.listen(proxyPort, "127.0.0.1");
  });

  console.log("[regtest] Building the test-gated Apogee extension and starting the real lending UI…");
  await run(resolve(APOGEE_DIR, "node_modules/.bin/vite"), [
    "build",
    "--outDir",
    TEST_EXTENSION_DIR,
  ], {
    cwd: APOGEE_DIR,
    env: { ...process.env, APOGEE_TX_MANIFEST_REGTEST: "1" },
  });
  start(resolve(LENDING_DIR, "web/node_modules/.bin/vite"), [
    "--host",
    "127.0.0.1",
    "--port",
    String(webPort),
    "--strictPort",
  ], {
    cwd: resolve(LENDING_DIR, "web"),
    env: {
      ...process.env,
      VITE_NETWORK: "regtest",
      VITE_API_URL: `http://127.0.0.1:${proxyPort}/backend`,
      VITE_ESPLORA_BASE_URL: `http://127.0.0.1:${proxyPort}/esplora`,
      VITE_WATERFALLS_URL: "http://127.0.0.1:1",
      VITE_WATERFALLS_RECIPIENT: "",
      VITE_REGTEST_PRINCIPAL_ASSET_ID: principalAssetId,
      VITE_DEMO_MODE: "true",
    },
    label: "web",
  });
  await waitForHttp(`http://127.0.0.1:${webPort}/`, 60_000);

  console.log("[regtest] Running Chromium against the production extension and lending UI…");
  const playwrightArgs = [
    "test",
    "--config=playwright.lending-regtest.config.ts",
  ];
  if (process.env.LENDING_REGTEST_PLAYWRIGHT_GREP) {
    playwrightArgs.push("--grep", process.env.LENDING_REGTEST_PLAYWRIGHT_GREP);
  }
  const code = await run(resolve(APOGEE_DIR, "node_modules/.bin/playwright"), playwrightArgs, {
    cwd: APOGEE_DIR,
    env: {
      ...process.env,
      LENDING_REGTEST_DAPP_URL: `http://127.0.0.1:${webPort}/`,
      LENDING_REGTEST_EXTENSION_PATH: TEST_EXTENSION_DIR,
      LENDING_REGTEST_ESPLORA_URL: services.esploraUrl,
      LENDING_REGTEST_APOGEE_ESPLORA_URL: `http://127.0.0.1:${proxyPort}/esplora/api`,
      LENDING_REGTEST_PROXY_CONTROL_URL: `http://127.0.0.1:${proxyPort}/control`,
      LENDING_REGTEST_RPC_URL: services.rpcUrl,
      LENDING_REGTEST_RPC_USER: services.rpcUser,
      LENDING_REGTEST_RPC_PASSWORD: services.rpcPassword,
      LENDING_REGTEST_MINER_ADDRESS: services.signerAddress,
      LENDING_REGTEST_PRINCIPAL_ASSET_ID: principalAssetId,
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
    stdio: [options.input ? "pipe" : "ignore", "pipe", "pipe"],
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
  if (options.input) child.stdin?.end(options.input);
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
          esploraUrl: esplora,
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
  return await Promise.race([
    parsed,
    timeout(60_000, "Timed out waiting for simplex regtest. Install the pinned CLI used by the lending CI."),
  ]);
}

async function issuePrincipalAsset(services) {
  const issued = await rpc(services, "issueasset", [1_000_000, 0, false]);
  await rpc(services, "generatetoaddress", [1, services.signerAddress]);
  return issued.asset;
}

async function rpc(services, method, params = []) {
  const authorization = Buffer.from(`${services.rpcUser}:${services.rpcPassword}`).toString("base64");
  const response = await fetch(services.rpcUrl, {
    method: "POST",
    headers: { authorization: `Basic ${authorization}`, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "1.0", id: "apogee-runner", method, params }),
  });
  const body = await response.json();
  if (!response.ok || body.error) throw new Error(body.error?.message ?? `RPC ${method} failed`);
  return body.result;
}

function createRegtestProxy(port, esploraTarget, apiTarget) {
  let nextBroadcastFailure = null;
  let nextTransactionStatusFailure = false;
  return createServer(async (request, response) => {
    try {
      if (request.method === "OPTIONS") {
        response.writeHead(204, corsHeaders());
        response.end();
        return;
      }
      const incoming = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
      if (request.method === "POST" && incoming.pathname === "/control/fail-next-broadcast") {
        nextBroadcastFailure = "after-accept";
        response.writeHead(204, corsHeaders());
        response.end();
        return;
      }
      const backend = incoming.pathname.startsWith("/backend/");
      const path = backend
        ? incoming.pathname.slice("/backend".length)
        : incoming.pathname.startsWith("/esplora/api/")
          ? incoming.pathname.slice("/esplora/api".length)
          : incoming.pathname;
      if (
        nextTransactionStatusFailure &&
        !backend &&
        request.method === "GET" &&
        /^\/tx\/[0-9a-f]{64}\/status$/i.test(path)
      ) {
        nextTransactionStatusFailure = false;
        response.writeHead(502, { ...corsHeaders(), "content-type": "text/plain" });
        response.end("injected ambiguous transaction status");
        return;
      }
      const target = backend ? apiTarget : esploraTarget;
      const upstream = await fetch(`${target}${path}${incoming.search}`, {
        method: request.method,
        headers: request.headers,
        body: request.method === "GET" || request.method === "HEAD" ? undefined : request,
        duplex: "half",
      });
      if (
        nextBroadcastFailure === "after-accept" &&
        !backend &&
        request.method === "POST" &&
        path === "/tx" &&
        upstream.ok
      ) {
        nextBroadcastFailure = null;
        nextTransactionStatusFailure = true;
        await upstream.arrayBuffer();
        response.writeHead(502, { ...corsHeaders(), "content-type": "text/plain" });
        response.end("injected lost broadcast response");
        return;
      }
      response.writeHead(upstream.status, {
        ...Object.fromEntries(upstream.headers),
        ...corsHeaders(),
      });
      if (upstream.body) Readable.fromWeb(upstream.body).pipe(response);
      else response.end();
    } catch (error) {
      response.writeHead(502, { "content-type": "text/plain" });
      response.end(String(error));
    }
  });
}

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
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

async function waitForTcp(port, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise((resolveConnection) => {
      const socket = createTcpServer().listen({ port, host: "127.0.0.1", exclusive: true });
      socket.once("error", () => resolveConnection(true));
      socket.once("listening", () => socket.close(() => resolveConnection(false)));
    });
    if (ok) return;
    await delay(200);
  }
  throw new Error(`Timed out waiting for port ${port}`);
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
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 300));
  for (const child of children) child.kill("SIGKILL");
  try {
    await runDetached("docker", ["stop", "--time", "1", containerName]);
  } catch {
    // Container may not have been created yet.
  }
  process.exitCode = exitCode;
}

async function runDetached(command, args) {
  const child = spawn(command, args, { stdio: "ignore" });
  const code = await new Promise((resolveExit) => child.once("exit", resolveExit));
  if (code !== 0) throw new Error(`${command} cleanup failed`);
}

async function waitForPostgres(name, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await runDetached("docker", [
        "exec",
        name,
        "psql",
        "-U",
        "postgres",
        "-d",
        "lending-indexer",
        "-c",
        "SELECT 1",
      ]);
      return;
    } catch {
      await delay(250);
    }
  }
  throw new Error("Timed out waiting for disposable Postgres");
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
