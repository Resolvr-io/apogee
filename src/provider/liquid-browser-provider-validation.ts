import {
  LIQUID_BROWSER_PROVIDER_METHODS,
  LIQUID_CONNECTION_CHANGED_EVENT,
  type AnyLiquidProviderRequest,
  type LiquidConnectParams,
} from "./liquid-browser-provider";
import { LIQUID_WALLET_RPC_METHODS } from "./liquid-rpc";
import {
  LIQUID_RPC_ERROR_CODES,
  LIQUID_RPC_ERROR_REASONS,
  LiquidRpcError,
} from "./liquid-rpc-errors";
import { isLiquidChainId, parseLiquidRpcRequest } from "./liquid-rpc-validation";

const PROFILE_METHODS = new Set<string>(Object.values(LIQUID_WALLET_RPC_METHODS));
const LIFECYCLE_METHODS = new Set<string>(Object.values(LIQUID_BROWSER_PROVIDER_METHODS));

/** Validate a page request again at the trusted extension boundary. */
export function parseLiquidProviderRequest(value: unknown): AnyLiquidProviderRequest {
  if (!isRecord(value)) throw invalidRequest("The provider request must be an object.");
  if (typeof value.method !== "string" || value.method.length === 0) {
    throw invalidRequest("The provider request method must be a non-empty string.");
  }
  if (value.params !== undefined && !isRecord(value.params)) {
    throw invalidRequest("Provider request params must be an object when present.");
  }

  const request = { method: value.method, params: value.params };
  if (PROFILE_METHODS.has(value.method)) return parseLiquidRpcRequest(request);

  switch (value.method) {
    case "wallet_getCapabilities":
    case "wallet_getConnection":
    case "wallet_disconnect":
      return { method: value.method, params: parseEmptyParams(value.params) };
    case "wallet_connect":
      return { method: value.method, params: parseConnectParams(value.params) };
    default:
      throw new LiquidRpcError(
        LIQUID_RPC_ERROR_CODES.METHOD_NOT_FOUND,
        `Unknown Liquid provider method: ${value.method}`,
        LIQUID_RPC_ERROR_REASONS.METHOD_NOT_FOUND,
        { method: value.method },
      );
  }
}

function parseConnectParams(value: unknown): LiquidConnectParams {
  if (!isRecord(value)) {
    throw invalidParams("wallet_connect requires a params object.", "params");
  }
  const methods = stringArray(value.methods, "params.methods", true);
  for (const method of methods) {
    if (LIFECYCLE_METHODS.has(method) || method.startsWith("wallet_")) {
      throw invalidParams("Browser lifecycle methods cannot be requested as permissions.", "params.methods");
    }
  }

  const events = value.events === undefined ? [] : stringArray(value.events, "params.events", false);
  if (events.includes(LIQUID_CONNECTION_CHANGED_EVENT)) {
    throw invalidParams(
      "wallet_connectionChanged is always available and must not be requested.",
      "params.events",
    );
  }

  let chains: string[] | undefined;
  if (value.chains !== undefined) {
    chains = stringArray(value.chains, "params.chains", true);
    for (const chain of chains) {
      if (!isLiquidChainId(chain)) {
        throw invalidParams("Expected an ELIP-0144 chain identifier.", "params.chains");
      }
    }
  }

  return { ...(chains ? { chains } : {}), methods, ...(events.length > 0 ? { events } : {}) };
}

function parseEmptyParams(value: unknown): Record<string, never> {
  if (value === undefined) return {};
  if (!isRecord(value) || Object.keys(value).length > 0) {
    throw invalidParams("This method accepts no parameters.", "params");
  }
  return {};
}

function stringArray(value: unknown, path: string, requireNonEmpty: boolean): string[] {
  if (!Array.isArray(value) || (requireNonEmpty && value.length === 0)) {
    throw invalidParams(
      requireNonEmpty ? "Expected a non-empty array." : "Expected an array.",
      path,
    );
  }
  const result = value.map((entry, index) => {
    if (typeof entry !== "string" || entry.length === 0) {
      throw invalidParams("Expected a non-empty string.", `${path}[${index}]`);
    }
    return entry;
  });
  if (new Set(result).size !== result.length) {
    throw invalidParams("Duplicate values are not allowed.", path);
  }
  return result;
}

function invalidRequest(message: string): LiquidRpcError {
  return new LiquidRpcError(
    LIQUID_RPC_ERROR_CODES.INVALID_REQUEST,
    message,
    LIQUID_RPC_ERROR_REASONS.INVALID_REQUEST,
  );
}

function invalidParams(message: string, path: string): LiquidRpcError {
  return new LiquidRpcError(
    LIQUID_RPC_ERROR_CODES.INVALID_PARAMS,
    message,
    LIQUID_RPC_ERROR_REASONS.INVALID_PARAMS,
    { path },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
