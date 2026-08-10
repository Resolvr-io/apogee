import {
  LIQUID_DESCRIPTOR_TYPES,
  LIQUID_IDENTITY_CURVE,
  LIQUID_IDENTITY_SHARED_KEY_KDF,
  LIQUID_SIGN_MESSAGE_PROTOCOLS,
  LIQUID_WALLET_RPC_METHODS,
  type AnyLiquidRequest,
  type LiquidExecuteTxManifestParams,
  type LiquidGetTxManifestSupportParams,
  type LiquidGetBalanceParams,
  type LiquidGetIdentityPublicKeyParams,
  type LiquidGetIdentitySharedKeyParams,
  type LiquidGetUTXOsParams,
  type LiquidGetWalletDescriptorParams,
  type LiquidProcessConfidentialTransactionParams,
  type LiquidSendTransferParams,
  type LiquidSignIdentityParams,
  type LiquidSignMessageParams,
  type LiquidSignPsetInput,
  type LiquidSignPsetParams,
} from "./liquid-rpc";
import {
  LIQUID_RPC_ERROR_CODES,
  LIQUID_RPC_ERROR_REASONS,
  LiquidRpcError,
} from "./liquid-rpc-errors";

const METHODS = new Set<string>(Object.values(LIQUID_WALLET_RPC_METHODS));
const CHAIN_ID = /^bip122:[0-9a-f]{32}$/;
const ACCOUNT_ID = /^bip122:[0-9a-f]{32}:[0-9a-f]{4}(?:-[0-9a-f]{4}){7}$/;
const ASSET_ID = /^bip122:[0-9a-f]{32}\/elip144:[0-9a-f]{64}$/;
const DECIMAL = /^[0-9]+$/;
const LOWER_HEX = /^[0-9a-f]*$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const PUBLIC_KEY = /^04[0-9a-f]{128}$/;
const SIGHASH_TYPES = new Set([1, 2, 3, 129, 130, 131]);
const BUNDLE_HASH = /^sha256:[0-9a-f]{64}$/;
const TXID = /^[0-9a-f]{64}$/;

/**
 * Validate and copy a page-supplied request into a fresh, trusted object.
 *
 * Unknown object fields (including a caller-supplied `id`) are deliberately
 * dropped. Method-specific validation happens here because TypeScript types do
 * not protect the extension from a page that sends bridge messages directly.
 */
export function parseLiquidRpcRequest(value: unknown): AnyLiquidRequest {
  const request = record(value, "request");
  const method = string(request.method, "method");
  if (!METHODS.has(method)) {
    throw rpcError(
      LIQUID_RPC_ERROR_CODES.METHOD_NOT_FOUND,
      `Unsupported Liquid wallet RPC method: ${method}`,
      LIQUID_RPC_ERROR_REASONS.METHOD_NOT_FOUND,
      "method",
      { method },
    );
  }

  switch (method) {
    case "experimental_getTxManifestSupport":
      return { method, params: parseTxManifestSupport(request.params) };
    case "experimental_executeTxManifest":
      return { method, params: parseTxManifestExecution(request.params) };
    case "getBalance":
      return { method, params: parseAssetFilter(request.params, "params") };
    case "getUTXOs":
      return { method, params: parseAssetFilter(request.params, "params") };
    case "getWalletDescriptor":
      return { method, params: parseWalletDescriptor(request.params) };
    case "sendTransfer":
      return { method, params: parseSendTransfer(request.params) };
    case "getIdentityPublicKey":
      return { method, params: parseIdentityPublicKey(request.params) };
    case "getIdentitySharedKey":
      return { method, params: parseIdentitySharedKey(request.params) };
    case "signIdentity":
      return { method, params: parseSignIdentity(request.params) };
    case "signPset":
      return { method, params: parseSignPset(request.params) };
    case "signMessage":
      return { method, params: parseSignMessage(request.params) };
    case "processConfidentialTransaction":
      return { method, params: parseConfidentialTransaction(request.params) };
  }

  // The method allowlist and exhaustive switch above make this unreachable.
  throw rpcError(
    LIQUID_RPC_ERROR_CODES.METHOD_NOT_FOUND,
    `Unsupported Liquid wallet RPC method: ${method}`,
    LIQUID_RPC_ERROR_REASONS.METHOD_NOT_FOUND,
    "method",
  );
}

function parseTxManifestSupport(value: unknown): LiquidGetTxManifestSupportParams {
  const params = exactRecord(value, "params", ["bundleHash"]);
  return { bundleHash: bundleHash(params.bundleHash, "params.bundleHash") };
}

function parseTxManifestExecution(value: unknown): LiquidExecuteTxManifestParams {
  const params = exactRecord(value, "params", [
    "protocolVersion",
    "requestId",
    "chainId",
    "accountIdentifier",
    "manifest",
    "action",
    "arguments",
    "providedInputs",
    "constraints",
  ]);
  const manifest = exactRecord(params.manifest, "params.manifest", ["bundleHash", "bundle"]);
  const out: LiquidExecuteTxManifestParams = {
    protocolVersion: exact(params.protocolVersion, "0.1", "params.protocolVersion"),
    requestId: boundedString(params.requestId, "params.requestId", 128),
    chainId: chainId(params.chainId, "params.chainId"),
    accountIdentifier: accountId(params.accountIdentifier, "params.accountIdentifier"),
    manifest: {
      bundleHash: bundleHash(manifest.bundleHash, "params.manifest.bundleHash"),
      ...(manifest.bundle === undefined
        ? {}
        : { bundle: jsonRecord(manifest.bundle, "params.manifest.bundle") }),
    },
    action: boundedString(params.action, "params.action", 256),
    arguments: jsonRecord(params.arguments, "params.arguments"),
  };
  if (params.providedInputs !== undefined) {
    const provided = record(params.providedInputs, "params.providedInputs");
    out.providedInputs = Object.fromEntries(
      Object.entries(provided).map(([name, candidate]) => {
        if (name.length === 0 || name.length > 128) {
          throw invalid("params.providedInputs", "Input names must contain 1 to 128 characters.");
        }
        return [
          name,
          Array.isArray(candidate)
            ? candidate.map((entry, index) =>
                manifestOutpoint(entry, `params.providedInputs.${name}[${index}]`),
              )
            : manifestOutpoint(candidate, `params.providedInputs.${name}`),
        ];
      }),
    );
  }
  if (params.constraints !== undefined) {
    const constraints = exactRecord(params.constraints, "params.constraints", [
      "maxFee",
      "validUntilHeight",
    ]);
    out.constraints = {
      ...(constraints.maxFee === undefined
        ? {}
        : { maxFee: unsignedU64(constraints.maxFee, "params.constraints.maxFee") }),
      ...(constraints.validUntilHeight === undefined
        ? {}
        : {
            validUntilHeight: unsignedU32(
              constraints.validUntilHeight,
              "params.constraints.validUntilHeight",
            ),
          }),
    };
  }
  return out;
}

function manifestOutpoint(value: unknown, path: string): { txid: string; vout: number } {
  const candidate = exactRecord(value, path, ["txid", "vout"]);
  const txid = string(candidate.txid, `${path}.txid`);
  if (!TXID.test(txid)) throw invalid(`${path}.txid`, "Expected a lowercase transaction id.");
  return { txid, vout: index(candidate.vout, `${path}.vout`) };
}

function bundleHash(value: unknown, path: string): `sha256:${string}` {
  const result = string(value, path);
  if (!BUNDLE_HASH.test(result)) throw invalid(path, "Expected a lowercase sha256 bundle hash.");
  return result as `sha256:${string}`;
}

function chainId(value: unknown, path: string): string {
  const result = string(value, path);
  if (!CHAIN_ID.test(result)) throw invalid(path, "Expected an ELIP-0144 chain identifier.");
  return result;
}

function boundedString(value: unknown, path: string, maximum: number): string {
  const result = nonEmptyString(value, path);
  if (result.length > maximum) throw invalid(path, `Expected at most ${maximum} characters.`);
  return result;
}

function unsignedU32(value: unknown, path: string): number {
  const result = index(value, path);
  if (result > 0xffff_ffff) throw invalid(path, "Expected an unsigned 32-bit integer.");
  return result;
}

function unsignedU64(value: unknown, path: string): string {
  const result = decimal(value, path).replace(/^0+(?=\d)/, "");
  const maximum = "18446744073709551615";
  if (result.length > maximum.length || (result.length === maximum.length && result > maximum)) {
    throw invalid(path, "Expected an unsigned 64-bit decimal string.");
  }
  return result;
}

function jsonRecord(value: unknown, path: string): Record<string, unknown> {
  const result = record(value, path);
  if (!isJsonValue(result, new Set())) throw invalid(path, "Expected JSON-serializable data.");
  const serialized = JSON.stringify(result);
  if (serialized.length > 1_000_000) throw invalid(path, "TX Manifest data exceeds the 1 MB limit.");
  return JSON.parse(serialized) as Record<string, unknown>;
}

function isJsonValue(value: unknown, seen: Set<object>, depth = 0): boolean {
  if (depth > 64) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isSafeInteger(value);
  if (typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  const valid = Array.isArray(value)
    ? value.every((entry) => isJsonValue(entry, seen, depth + 1))
    : Object.values(value as Record<string, unknown>).every((entry) =>
        isJsonValue(entry, seen, depth + 1),
      );
  seen.delete(value);
  return valid;
}

function exactRecord(value: unknown, path: string, fields: readonly string[]): Record<string, unknown> {
  const result = record(value, path);
  const allowed = new Set(fields);
  for (const field of Object.keys(result)) {
    if (!allowed.has(field)) throw invalid(`${path}.${field}`, "Unknown field.");
  }
  return result;
}

export function isLiquidChainId(value: string): boolean {
  return CHAIN_ID.test(value);
}

export function isLiquidAccountIdentifier(value: string): boolean {
  return ACCOUNT_ID.test(value);
}

export function isLiquidAssetId(value: string): boolean {
  return ASSET_ID.test(value);
}

function parseAssetFilter(value: unknown, path: string): LiquidGetBalanceParams | LiquidGetUTXOsParams {
  if (value === undefined) return {};
  const params = record(value, path);
  if (params.assetId === undefined) return {};
  return { assetId: assetId(params.assetId, `${path}.assetId`) };
}

function parseWalletDescriptor(value: unknown): LiquidGetWalletDescriptorParams {
  if (value === undefined) return {};
  const params = record(value, "params");
  const out: LiquidGetWalletDescriptorParams = {};

  if (params.descriptorType !== undefined) {
    const descriptorType = string(params.descriptorType, "params.descriptorType");
    if (!Object.values(LIQUID_DESCRIPTOR_TYPES).includes(descriptorType as never)) {
      throw invalid("params.descriptorType", "Unsupported descriptor type.");
    }
    out.descriptorType = descriptorType as LiquidGetWalletDescriptorParams["descriptorType"];
  }

  if (params.descriptorFormat !== undefined) {
    if (!Array.isArray(params.descriptorFormat)) {
      throw invalid("params.descriptorFormat", "Expected an array.");
    }
    out.descriptorFormat = params.descriptorFormat.map((entry, index) => {
      const item = record(entry, `params.descriptorFormat[${index}]`);
      return {
        format: nonEmptyString(item.format, `params.descriptorFormat[${index}].format`),
      };
    });
  }
  return out;
}

function parseSendTransfer(value: unknown): LiquidSendTransferParams {
  const params = record(value, "params");
  const out: LiquidSendTransferParams = {
    amount: transferAmount(params.amount, "params.amount"),
    recipientAddress: nonEmptyString(params.recipientAddress, "params.recipientAddress"),
  };
  if (params.account !== undefined) {
    out.account = accountId(params.account, "params.account");
  }
  if (params.assetId !== undefined) {
    out.assetId = assetId(params.assetId, "params.assetId");
  }
  if (params.memo !== undefined) {
    const memo = hex(params.memo, "params.memo");
    if (memo.length > 160) throw invalid("params.memo", "Memo exceeds the 80-byte limit.");
    out.memo = memo;
  }
  return out;
}

function parseIdentityPublicKey(value: unknown): LiquidGetIdentityPublicKeyParams {
  const params = record(value, "params");
  const out: LiquidGetIdentityPublicKeyParams = {
    curve: exact(params.curve, LIQUID_IDENTITY_CURVE, "params.curve"),
    identity: nonEmptyString(params.identity, "params.identity"),
  };
  if (params.index !== undefined) out.index = index(params.index, "params.index");
  return out;
}

function parseIdentitySharedKey(value: unknown): LiquidGetIdentitySharedKeyParams {
  const params = record(value, "params");
  const out: LiquidGetIdentitySharedKeyParams = {
    curve: exact(params.curve, LIQUID_IDENTITY_CURVE, "params.curve"),
    identity: nonEmptyString(params.identity, "params.identity"),
    kdf: exact(params.kdf, LIQUID_IDENTITY_SHARED_KEY_KDF, "params.kdf"),
    kdfInfo: hex(params.kdfInfo, "params.kdfInfo"),
    kdfSalt: hex(params.kdfSalt, "params.kdfSalt"),
    theirPublicKey: publicKey(params.theirPublicKey, "params.theirPublicKey"),
  };
  if (out.kdfInfo.length === 0) {
    throw invalid("params.kdfInfo", "KDF info must provide domain-separation context.");
  }
  if (params.index !== undefined) out.index = index(params.index, "params.index");
  return out;
}

function parseSignIdentity(value: unknown): LiquidSignIdentityParams {
  const params = record(value, "params");
  const out: LiquidSignIdentityParams = {
    challenge: hex(params.challenge, "params.challenge"),
    curve: exact(params.curve, LIQUID_IDENTITY_CURVE, "params.curve"),
    identity: nonEmptyString(params.identity, "params.identity"),
  };
  if (params.index !== undefined) out.index = index(params.index, "params.index");
  return out;
}

function parseSignPset(value: unknown): LiquidSignPsetParams {
  const params = record(value, "params");
  if (!Array.isArray(params.signInputs) || params.signInputs.length === 0) {
    throw invalid("params.signInputs", "Expected at least one signing input.");
  }
  const signInputs = params.signInputs.map(parseSignPsetInput);
  const indexes = new Set<number>();
  for (const input of signInputs) {
    if (indexes.has(input.index)) {
      throw invalid("params.signInputs", `Duplicate input index: ${input.index}.`);
    }
    indexes.add(input.index);
  }

  const out: LiquidSignPsetParams = {
    pset: base64(params.pset, "params.pset"),
    signInputs,
  };
  if (params.broadcast !== undefined) {
    out.broadcast = boolean(params.broadcast, "params.broadcast");
  }
  return out;
}

function parseSignPsetInput(value: unknown, arrayIndex: number): LiquidSignPsetInput {
  const path = `params.signInputs[${arrayIndex}]`;
  const input = record(value, path);
  const out: LiquidSignPsetInput = {
    address: nonEmptyString(input.address, `${path}.address`),
    index: index(input.index, `${path}.index`),
  };
  if (input.sighashTypes !== undefined) {
    if (!Array.isArray(input.sighashTypes) || input.sighashTypes.length === 0) {
      throw invalid(`${path}.sighashTypes`, "Expected at least one sighash type.");
    }
    out.sighashTypes = input.sighashTypes.map((item, sighashIndex) => {
      const n = integer(item, `${path}.sighashTypes[${sighashIndex}]`);
      if (!SIGHASH_TYPES.has(n)) {
        throw invalid(
          `${path}.sighashTypes[${sighashIndex}]`,
          "Unsupported or incomplete Elements sighash type.",
        );
      }
      return n;
    });
  }
  return out;
}

function parseSignMessage(value: unknown): LiquidSignMessageParams {
  const params = record(value, "params");
  const out: LiquidSignMessageParams = {
    address: nonEmptyString(params.address, "params.address"),
    message: string(params.message, "params.message"),
  };
  if (params.protocol !== undefined) {
    const protocol = string(params.protocol, "params.protocol");
    if (!Object.values(LIQUID_SIGN_MESSAGE_PROTOCOLS).includes(protocol as never)) {
      throw invalid("params.protocol", "Unsupported message-signing protocol.");
    }
    out.protocol = protocol as LiquidSignMessageParams["protocol"];
  }
  return out;
}

function parseConfidentialTransaction(value: unknown): LiquidProcessConfidentialTransactionParams {
  const params = record(value, "params");
  return { ...params };
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalid(path, "Expected an object.");
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, path: string): string {
  if (typeof value !== "string") throw invalid(path, "Expected a string.");
  return value;
}

function nonEmptyString(value: unknown, path: string): string {
  const result = string(value, path);
  if (result.length === 0) throw invalid(path, "Expected a non-empty string.");
  return result;
}

function exact<const T extends string>(value: unknown, expected: T, path: string): T {
  if (value !== expected) throw invalid(path, `Expected "${expected}".`);
  return expected;
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw invalid(path, "Expected a boolean.");
  return value;
}

function integer(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value)) throw invalid(path, "Expected a safe integer.");
  return value as number;
}

function index(value: unknown, path: string): number {
  const result = integer(value, path);
  if (result < 0) throw invalid(path, "Expected a non-negative integer.");
  return result;
}

function decimal(value: unknown, path: string): string {
  const result = string(value, path);
  if (!DECIMAL.test(result)) throw invalid(path, "Expected a non-negative decimal string.");
  return result;
}

function transferAmount(value: unknown, path: string): string {
  const result = decimal(value, path);
  const normalized = result.replace(/^0+(?=\d)/, "");
  const maxU64 = "18446744073709551615";
  if (
    normalized === "0" ||
    normalized.length > maxU64.length ||
    (normalized.length === maxU64.length && normalized > maxU64)
  ) {
    throw invalid(path, "Expected a positive unsigned 64-bit base-unit amount.");
  }
  return normalized;
}

function hex(value: unknown, path: string): string {
  const result = string(value, path);
  if (result.length % 2 !== 0 || !LOWER_HEX.test(result)) {
    throw invalid(path, "Expected lowercase, even-length hex without 0x.");
  }
  return result;
}

function publicKey(value: unknown, path: string): string {
  const result = string(value, path);
  // This is the transport-level encoding check. The eventual identity handler
  // must additionally validate that the bytes encode a valid nist256p1 point,
  // as required by the draft.
  if (!PUBLIC_KEY.test(result)) {
    throw invalid(path, "Expected an uncompressed nist256p1 public key as lowercase hex.");
  }
  return result;
}

function base64(value: unknown, path: string): string {
  const result = string(value, path);
  if (result.length === 0 || !BASE64.test(result)) {
    throw invalid(path, "Expected standard base64.");
  }
  return result;
}

function accountId(value: unknown, path: string): string {
  const result = string(value, path);
  if (!isLiquidAccountIdentifier(result)) {
    throw invalid(path, "Expected an ELIP-0144 Liquid account identifier.");
  }
  return result;
}

function assetId(value: unknown, path: string): string {
  const result = string(value, path);
  if (!isLiquidAssetId(result)) {
    throw invalid(path, "Expected an ELIP-0144 Liquid asset identifier.");
  }
  return result;
}

function invalid(path: string, message: string): LiquidRpcError {
  return rpcError(
    LIQUID_RPC_ERROR_CODES.INVALID_PARAMS,
    `Invalid Liquid wallet RPC parameters at ${path}: ${message}`,
    LIQUID_RPC_ERROR_REASONS.INVALID_PARAMS,
    path,
  );
}

function rpcError(
  code: number,
  message: string,
  reason: typeof LIQUID_RPC_ERROR_REASONS.INVALID_PARAMS | typeof LIQUID_RPC_ERROR_REASONS.METHOD_NOT_FOUND,
  path: string,
  data?: Record<string, unknown>,
): LiquidRpcError {
  return new LiquidRpcError(code, message, reason, { ...data, path });
}
