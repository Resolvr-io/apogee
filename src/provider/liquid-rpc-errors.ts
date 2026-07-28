/** Structured errors shared by the future page provider and service-worker RPC router. */

export const LIQUID_RPC_ERROR_CODES = {
  INTERNAL_ERROR: -32603,
  INVALID_PARAMS: -32602,
  METHOD_NOT_FOUND: -32601,
} as const;

export const LIQUID_RPC_ERROR_REASONS = {
  INTERNAL_ERROR: "internal_error",
  INVALID_PARAMS: "invalid_params",
  METHOD_NOT_FOUND: "method_not_found",
  UNSUPPORTED_DESCRIPTOR_FORMAT: "unsupported_descriptor_format",
} as const;

export type LiquidRpcErrorCode =
  (typeof LIQUID_RPC_ERROR_CODES)[keyof typeof LIQUID_RPC_ERROR_CODES];

export type LiquidRpcErrorReason =
  (typeof LIQUID_RPC_ERROR_REASONS)[keyof typeof LIQUID_RPC_ERROR_REASONS];

export type LiquidRpcErrorData = {
  reason: LiquidRpcErrorReason;
  [key: string]: unknown;
};

export type SerializedLiquidRpcError = {
  code: number;
  data?: LiquidRpcErrorData;
  message: string;
};

export class LiquidRpcError extends Error {
  readonly code: number;
  readonly data: LiquidRpcErrorData;

  constructor(code: number, message: string, reason: LiquidRpcErrorReason, data?: unknown) {
    super(message);
    this.name = "LiquidRpcError";
    this.code = code;
    this.data = errorData(reason, data);
  }
}

export function serializeLiquidRpcError(error: unknown): SerializedLiquidRpcError {
  if (error instanceof LiquidRpcError) {
    return { code: error.code, message: error.message, data: error.data };
  }
  return {
    code: LIQUID_RPC_ERROR_CODES.INTERNAL_ERROR,
    message: "Internal wallet error.",
    data: { reason: LIQUID_RPC_ERROR_REASONS.INTERNAL_ERROR },
  };
}

export function deserializeLiquidRpcError(error: SerializedLiquidRpcError): LiquidRpcError {
  return new LiquidRpcError(
    error.code,
    error.message,
    error.data?.reason ?? LIQUID_RPC_ERROR_REASONS.INTERNAL_ERROR,
    error.data,
  );
}

function errorData(reason: LiquidRpcErrorReason, data?: unknown): LiquidRpcErrorData {
  if (isRecord(data)) return { ...data, reason };
  if (data === undefined) return { reason };
  return { reason, details: data };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
