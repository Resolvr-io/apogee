import type {
  LiquidEventMap,
  LiquidParams,
  LiquidRequest,
  LiquidResult,
  LiquidRpcMethod,
} from "./liquid-rpc";

export const LIQUID_BROWSER_PROVIDER_VERSION = "1.0.0";

export const LIQUID_BROWSER_PROVIDER_METHODS = {
  GET_CAPABILITIES: "wallet_getCapabilities",
  CONNECT: "wallet_connect",
  GET_CONNECTION: "wallet_getConnection",
  DISCONNECT: "wallet_disconnect",
} as const;

export const LIQUID_CONNECTION_CHANGED_EVENT = "wallet_connectionChanged";

export type LiquidBrowserProviderMethod =
  (typeof LIQUID_BROWSER_PROVIDER_METHODS)[keyof typeof LIQUID_BROWSER_PROVIDER_METHODS];

export interface LiquidProviderInfo {
  readonly uuid: string;
  readonly name: string;
  readonly icon: string;
  readonly rdns: string;
}

export interface LiquidProviderCapabilities {
  readonly browserProviderVersion: string;
  readonly methods: readonly string[];
  readonly events: readonly string[];
}

export interface LiquidConnectionPermissions {
  readonly methods: readonly string[];
  readonly events: readonly string[];
}

export interface LiquidConnection {
  readonly accountIdentifier: string;
  readonly chainId: string;
  readonly policyAssetId: string;
  readonly permissions: LiquidConnectionPermissions;
}

export interface LiquidConnectParams {
  readonly chains?: readonly string[];
  readonly methods: readonly string[];
  readonly events?: readonly string[];
}

export interface LiquidBrowserProviderSchema {
  wallet_getCapabilities: {
    params: Record<string, never>;
    result: LiquidProviderCapabilities;
  };
  wallet_connect: {
    params: LiquidConnectParams;
    result: LiquidConnection;
  };
  wallet_getConnection: {
    params: Record<string, never>;
    result: LiquidConnection | null;
  };
  wallet_disconnect: {
    params: Record<string, never>;
    result: null;
  };
}

export type LiquidProviderMethod = LiquidRpcMethod | LiquidBrowserProviderMethod;

export type LiquidProviderParams<M extends LiquidProviderMethod> =
  M extends LiquidRpcMethod
    ? LiquidParams<M>
    : M extends LiquidBrowserProviderMethod
      ? LiquidBrowserProviderSchema[M]["params"]
      : never;

export type LiquidProviderResult<M extends LiquidProviderMethod> =
  M extends LiquidRpcMethod
    ? LiquidResult<M>
    : M extends LiquidBrowserProviderMethod
      ? LiquidBrowserProviderSchema[M]["result"]
      : never;

type LiquidLifecycleRequest<M extends LiquidBrowserProviderMethod> = M extends "wallet_connect"
  ? { method: M; params: LiquidConnectParams }
  : { method: M; params?: Record<string, never> };

export type LiquidProviderRequest<M extends LiquidProviderMethod = LiquidProviderMethod> =
  M extends LiquidRpcMethod
    ? LiquidRequest<M>
    : M extends LiquidBrowserProviderMethod
      ? LiquidLifecycleRequest<M>
      : never;

export type AnyLiquidProviderRequest = {
  [M in LiquidProviderMethod]: LiquidProviderRequest<M>;
}[LiquidProviderMethod];

export type LiquidProviderEventMap = LiquidEventMap & {
  wallet_connectionChanged: LiquidConnection | null;
};

export type LiquidProviderEventName = keyof LiquidProviderEventMap;

export interface LiquidProviderError extends Error {
  readonly code: number;
  readonly data?: unknown;
}

export interface LiquidProvider {
  request<M extends LiquidProviderMethod>(
    args: LiquidProviderRequest<M>,
  ): Promise<LiquidProviderResult<M>>;
  on<E extends LiquidProviderEventName>(args: {
    event: E;
    listener: (payload: LiquidProviderEventMap[E]) => void;
  }): () => void;
}

export interface LiquidProviderDetail {
  readonly info: LiquidProviderInfo;
  readonly provider: LiquidProvider;
}
