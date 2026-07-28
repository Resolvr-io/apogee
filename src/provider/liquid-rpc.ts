/**
 * Transport-neutral TypeScript contract for the Liquid Wallet RPC Profile.
 *
 * Source: ElementsProject/ELIPs#36 at ELIP_DRAFT_REVISION. The proposal is
 * still a draft, so keep the pinned revision and these types in sync when the
 * upstream document changes.
 *
 * This module deliberately describes RPC methods and events only. Connection
 * negotiation, discovery, correlation ids, and the page/content-script bridge
 * are transport concerns layered around this contract.
 */

export const ELIP_DRAFT_URL = "https://github.com/ElementsProject/ELIPs/pull/36";
export const ELIP_DRAFT_REVISION = "d5b713cbbad5a13f15baa35073e8dda53886f0b0";

export const LIQUID_WALLET_RPC_METHODS = {
  GET_BALANCE: "getBalance",
  GET_IDENTITY_PUBLIC_KEY: "getIdentityPublicKey",
  GET_IDENTITY_SHARED_KEY: "getIdentitySharedKey",
  GET_UTXOS: "getUTXOs",
  GET_WALLET_DESCRIPTOR: "getWalletDescriptor",
  PROCESS_CONFIDENTIAL_TRANSACTION: "processConfidentialTransaction",
  SEND_TRANSFER: "sendTransfer",
  SIGN_IDENTITY: "signIdentity",
  SIGN_MESSAGE: "signMessage",
  SIGN_PSET: "signPset",
} as const;

export const LIQUID_WALLET_DESCRIPTOR_CHANGED_EVENT = "bip122_walletDescriptorChanged";

/** ELIP-0144 `bip122:<32 lowercase hex>` chain identifier. */
export type LiquidChainId = string;

/** ELIP-0144 `chain_id:dwid` connected-account identifier. */
export type LiquidAccountIdentifier = string;

/** ELIP-0144 `chain_id/elip144:<64 lowercase hex>` asset identifier. */
export type LiquidAssetId = string;

/** A non-negative integer encoded in base ten without a sign. */
export type LiquidAmount = string;

export type LiquidGetBalanceParams = {
  assetId?: LiquidAssetId;
};

export type LiquidGetBalanceResult = {
  accountIdentifier: LiquidAccountIdentifier;
  assetId: LiquidAssetId;
  balance: LiquidAmount;
  chainId: LiquidChainId;
  policyAssetId: LiquidAssetId;
};

export type LiquidGetUTXOsParams = {
  assetId?: LiquidAssetId;
};

export type LiquidUTXO = {
  address: string;
  amount: LiquidAmount;
  assetId: LiquidAssetId;
  confidential: boolean;
  scriptPubKey: string;
  spendable: boolean;
  txid: string;
  txOut: string;
  vout: number;
};

export type LiquidGetUTXOsResult = {
  accountIdentifier: LiquidAccountIdentifier;
  assetId: LiquidAssetId;
  chainId: LiquidChainId;
  policyAssetId: LiquidAssetId;
  utxos: LiquidUTXO[];
};

export const LIQUID_DESCRIPTOR_TYPES = {
  PUBLIC_CONFIDENTIAL_DESCRIPTOR: "publicConfidentialDescriptor",
  PUBLIC_WALLET_DESCRIPTOR: "publicWalletDescriptor",
} as const;

export const LIQUID_DESCRIPTOR_FORMATS = {
  BIP380_BIP389_MULTIPATH: "bip380-bip389-multipath",
  BIP380_SPLIT_BRANCHES: "bip380-split-branches",
  ELIP150_PUBLIC_CT_BIP389_MULTIPATH: "elip150-public-ct-bip389-multipath",
  ELIP150_PUBLIC_CT_SPLIT_BRANCHES: "elip150-public-ct-split-branches",
} as const;

export type LiquidDescriptorType =
  (typeof LIQUID_DESCRIPTOR_TYPES)[keyof typeof LIQUID_DESCRIPTOR_TYPES];

export type LiquidDescriptorFormat =
  (typeof LIQUID_DESCRIPTOR_FORMATS)[keyof typeof LIQUID_DESCRIPTOR_FORMATS];

export type LiquidGetWalletDescriptorParams = {
  /**
   * Ordered format preferences. Unknown names are allowed by the draft so a
   * newer dapp can fall back to a format an older wallet understands.
   */
  descriptorFormat?: Array<{ format: LiquidDescriptorFormat | (string & {}) }>;
  /** Defaults to publicWalletDescriptor when omitted. */
  descriptorType?: LiquidDescriptorType;
};

export type LiquidDescriptorBranch = {
  addressIndex: "*";
  branch: "external" | "internal";
  change: 0 | 1;
};

export type LiquidDescriptorBranchDescriptor = {
  branch: "external" | "internal";
  change: 0 | 1;
  descriptor: string;
};

type LiquidWalletDescriptorEntryBase = {
  canDeriveConfidentialAddresses: boolean;
  canDeriveScriptPubKeys: boolean;
  canUnblindOutputs: false;
  descriptorType: LiquidDescriptorType;
  format: LiquidDescriptorFormat;
  standardsUsed: string[];
};

export type LiquidMultipathWalletDescriptorEntry = LiquidWalletDescriptorEntryBase & {
  branchDescriptors?: never;
  branches?: LiquidDescriptorBranch[];
  branchLayout: "multipath";
  descriptor: string;
};

export type LiquidSplitWalletDescriptorEntry = LiquidWalletDescriptorEntryBase & {
  branchDescriptors: LiquidDescriptorBranchDescriptor[];
  branches?: never;
  branchLayout: "split";
  descriptor?: never;
};

/** The branch layout determines which descriptor field is present. */
export type LiquidWalletDescriptorEntry =
  | LiquidMultipathWalletDescriptorEntry
  | LiquidSplitWalletDescriptorEntry;

export type LiquidGetWalletDescriptorResult = {
  accountIdentifier: LiquidAccountIdentifier;
  chainId: LiquidChainId;
  descriptors: LiquidWalletDescriptorEntry[];
  policyAssetId: LiquidAssetId;
};

export type LiquidSendTransferParams = {
  account?: LiquidAccountIdentifier;
  amount: LiquidAmount;
  assetId?: LiquidAssetId;
  /** Hex-encoded OP_RETURN bytes, limited by the draft to 80 bytes. */
  memo?: string;
  recipientAddress: string;
};

export type LiquidSendTransferResult = {
  txid: string;
};

export const LIQUID_IDENTITY_CURVE = "nist256p1";
export const LIQUID_IDENTITY_PUBLIC_KEY_TYPE = "slip-0013";
export const LIQUID_IDENTITY_SHARED_KEY_KDF = "hkdf-sha256";
export const LIQUID_IDENTITY_SHARED_KEY_TYPE = "slip-0017";

export type LiquidIdentityCurve = typeof LIQUID_IDENTITY_CURVE;
export type LiquidIdentityPublicKeyType = typeof LIQUID_IDENTITY_PUBLIC_KEY_TYPE;
export type LiquidIdentitySharedKeyKdf = typeof LIQUID_IDENTITY_SHARED_KEY_KDF;
export type LiquidIdentitySharedKeyType = typeof LIQUID_IDENTITY_SHARED_KEY_TYPE;

export type LiquidGetIdentityPublicKeyParams = {
  curve: LiquidIdentityCurve;
  identity: string;
  index?: number;
};

export type LiquidGetIdentityPublicKeyResult = {
  curve: LiquidIdentityCurve;
  identity: string;
  index: number;
  publicKey: string;
  type: LiquidIdentityPublicKeyType;
};

export type LiquidGetIdentitySharedKeyParams = {
  curve: LiquidIdentityCurve;
  identity: string;
  index?: number;
  kdf: LiquidIdentitySharedKeyKdf;
  kdfInfo: string;
  kdfSalt: string;
  theirPublicKey: string;
};

export type LiquidGetIdentitySharedKeyResult = {
  curve: LiquidIdentityCurve;
  identity: string;
  index: number;
  kdf: LiquidIdentitySharedKeyKdf;
  publicKey: string;
  sharedKey: string;
  type: LiquidIdentitySharedKeyType;
};

export type LiquidSignIdentityParams = {
  challenge: string;
  curve: LiquidIdentityCurve;
  identity: string;
  index?: number;
};

export type LiquidSignIdentityResult = {
  curve: LiquidIdentityCurve;
  identity: string;
  index: number;
  publicKey: string;
  signature: string;
  type: LiquidIdentityPublicKeyType;
};

export type LiquidSignPsetInput = {
  address: string;
  index: number;
  sighashTypes?: number[];
};

export type LiquidSignPsetParams = {
  broadcast?: boolean;
  pset: string;
  signInputs: LiquidSignPsetInput[];
};

export type LiquidSignPsetResult = {
  pset: string;
  /** Required by the draft when the wallet broadcast the transaction. */
  txid?: string;
};

export const LIQUID_SIGN_MESSAGE_PROTOCOLS = {
  BIP322: "bip322",
  ECDSA: "ecdsa",
} as const;

export type LiquidSignMessageProtocol =
  (typeof LIQUID_SIGN_MESSAGE_PROTOCOLS)[keyof typeof LIQUID_SIGN_MESSAGE_PROTOCOLS];

export type LiquidSignMessageParams = {
  address: string;
  message: string;
  /** Defaults to ecdsa when omitted. */
  protocol?: LiquidSignMessageProtocol;
};

type LiquidSignMessageResultBase = {
  address: string;
  signature: string;
};

export type LiquidEcdsaSignMessageResult = LiquidSignMessageResultBase & {
  messageHash: string;
  protocol: "ecdsa";
  signatureEncoding: "hex-recoverable-ecdsa-65";
};

export type LiquidBip322SignMessageResult = LiquidSignMessageResultBase & {
  messageHash?: never;
  protocol: "bip322";
  signatureEncoding: "bip322";
};

export type LiquidSignMessageResult =
  | LiquidEcdsaSignMessageResult
  | LiquidBip322SignMessageResult;

/**
 * The draft delegates this shape to the provisional Wallet ABI proposal.
 * Keep it opaque until that proposal has a canonical, versioned schema.
 */
export type LiquidProcessConfidentialTransactionParams = Record<string, unknown>;
export type LiquidProcessConfidentialTransactionResult = Record<string, unknown>;

type RpcMethod<Params, Result> = {
  params: Params;
  result: Result;
};

export interface LiquidRpcSchema {
  getBalance: RpcMethod<LiquidGetBalanceParams, LiquidGetBalanceResult>;
  getIdentityPublicKey: RpcMethod<
    LiquidGetIdentityPublicKeyParams,
    LiquidGetIdentityPublicKeyResult
  >;
  getIdentitySharedKey: RpcMethod<
    LiquidGetIdentitySharedKeyParams,
    LiquidGetIdentitySharedKeyResult
  >;
  getUTXOs: RpcMethod<LiquidGetUTXOsParams, LiquidGetUTXOsResult>;
  getWalletDescriptor: RpcMethod<
    LiquidGetWalletDescriptorParams,
    LiquidGetWalletDescriptorResult
  >;
  processConfidentialTransaction: RpcMethod<
    LiquidProcessConfidentialTransactionParams,
    LiquidProcessConfidentialTransactionResult
  >;
  sendTransfer: RpcMethod<LiquidSendTransferParams, LiquidSendTransferResult>;
  signIdentity: RpcMethod<LiquidSignIdentityParams, LiquidSignIdentityResult>;
  signMessage: RpcMethod<LiquidSignMessageParams, LiquidSignMessageResult>;
  signPset: RpcMethod<LiquidSignPsetParams, LiquidSignPsetResult>;
}

export type LiquidRpcMethod = keyof LiquidRpcSchema;
export type LiquidParams<M extends LiquidRpcMethod> = LiquidRpcSchema[M]["params"];
export type LiquidResult<M extends LiquidRpcMethod> = LiquidRpcSchema[M]["result"];

type LiquidMethodWithOptionalParams = "getBalance" | "getUTXOs" | "getWalletDescriptor";

export type LiquidRequest<M extends LiquidRpcMethod = LiquidRpcMethod> =
  M extends LiquidMethodWithOptionalParams
    ? { method: M; params?: LiquidParams<M> }
    : { method: M; params: LiquidParams<M> };

/** A discriminated union of every request accepted by the draft profile. */
export type AnyLiquidRequest = {
  [M in LiquidRpcMethod]: LiquidRequest<M>;
}[LiquidRpcMethod];

export interface LiquidEventMap {
  bip122_walletDescriptorChanged: LiquidGetWalletDescriptorResult;
}

export type LiquidEventName = keyof LiquidEventMap;

/**
 * Minimal injected-provider surface proposed for Apogee.
 *
 * The provider owns JSON-RPC correlation ids. Callers supply a method and its
 * parameters, receive the method result, and unsubscribe events with the
 * function returned by on().
 */
export interface LiquidProvider {
  request<M extends LiquidRpcMethod>(args: LiquidRequest<M>): Promise<LiquidResult<M>>;
  on<E extends LiquidEventName>(args: {
    event: E;
    listener: (data: LiquidEventMap[E]) => void;
  }): () => void;
}

/** Internal JSON-RPC 2.0 envelope types for transports that need them. */
export type JsonRpcId = string | number;

export type JsonRpcRequest<M extends string = string, Params = unknown> = {
  id: JsonRpcId;
  jsonrpc: "2.0";
  method: M;
  params?: Params;
};

export type JsonRpcSuccess<Result = unknown> = {
  id: JsonRpcId;
  jsonrpc: "2.0";
  result: Result;
};

export type JsonRpcFailure<ErrorData = unknown> = {
  error: {
    code: number;
    data?: ErrorData;
    message: string;
  };
  id: JsonRpcId;
  jsonrpc: "2.0";
};

export type JsonRpcResponse<Result = unknown, ErrorData = unknown> =
  | JsonRpcSuccess<Result>
  | JsonRpcFailure<ErrorData>;
