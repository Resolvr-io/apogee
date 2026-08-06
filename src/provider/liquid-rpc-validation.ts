import {
  LIQUID_DESCRIPTOR_TYPES,
  LIQUID_IDENTITY_CURVE,
  LIQUID_IDENTITY_SHARED_KEY_KDF,
  LIQUID_SIGN_MESSAGE_PROTOCOLS,
  LIQUID_WALLET_RPC_METHODS,
  type AnyLiquidRequest,
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
