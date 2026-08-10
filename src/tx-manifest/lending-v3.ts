import { SIMPLICITY_LENDING_V3_BUNDLE } from "./builtins/simplicity-lending-v3";
import {
  compileTxManifestCovenant,
  type SimplicityArgument,
  type TxManifestCovenantCommitments,
  type TxManifestCovenantCompileSpec,
} from "./runtime";

export type LendingV3Instance = {
  COLLATERAL_ASSET_ID: string;
  PRINCIPAL_ASSET_ID: string;
  BORROWER_NFT_ASSET_ID: string;
  LENDER_NFT_ASSET_ID: string;
  PROTOCOL_FEE_KEEPER_ASSET_ID: string;
  COLLATERAL_AMOUNT: string;
  PRINCIPAL_AMOUNT: string;
  PRINCIPAL_INTEREST_RATE: string;
  LOAN_EXPIRATION_TIME: string;
};

export type LendingV3AcceptOfferCovenants = {
  currentDebt: string;
  finalizedLenderVault: TxManifestCovenantCommitments;
  lenderVault: TxManifestCovenantCommitments;
  finalizedProtocolFeeVault: TxManifestCovenantCommitments;
  protocolFeeVault: TxManifestCovenantCommitments;
  principalOutput: TxManifestCovenantCommitments;
  pendingOffer: TxManifestCovenantCommitments;
  activeOffer: TxManifestCovenantCommitments;
  lenderNftAuthorization: TxManifestCovenantCommitments;
  lendingArguments: Record<string, SimplicityArgument>;
};

type CovenantCompiler = (
  spec: TxManifestCovenantCompileSpec,
) => Promise<TxManifestCovenantCommitments>;

const NETWORK = "liquid-testnet" as const;
const ZERO_HASH = "00".repeat(32);

/** Compile the complete nested covenant chain that lending-v3 commits into AcceptOffer. */
export async function compileLendingV3AcceptOfferCovenants(
  instance: LendingV3Instance,
  compile: CovenantCompiler = compileTxManifestCovenant,
): Promise<LendingV3AcceptOfferCovenants> {
  validateInstance(instance);
  const sources = SIMPLICITY_LENDING_V3_BUNDLE.sources;
  const vaultSource = sources["asset_auth_vault.simf"];

  const finalizedLenderVault = await compile(
    compileSpec(
      vaultSource,
      vaultArguments(instance, instance.LENDER_NFT_ASSET_ID, false, true, ZERO_HASH),
    ),
  );
  const lenderVault = await compile(
    compileSpec(
      vaultSource,
      vaultArguments(
        instance,
        instance.LENDER_NFT_ASSET_ID,
        true,
        true,
        finalizedLenderVault.script_hash,
      ),
    ),
  );
  const finalizedProtocolFeeVault = await compile(
    compileSpec(
      vaultSource,
      vaultArguments(
        instance,
        instance.PROTOCOL_FEE_KEEPER_ASSET_ID,
        false,
        false,
        ZERO_HASH,
      ),
    ),
  );
  const protocolFeeVault = await compile(
    compileSpec(
      vaultSource,
      vaultArguments(
        instance,
        instance.PROTOCOL_FEE_KEEPER_ASSET_ID,
        true,
        false,
        finalizedProtocolFeeVault.script_hash,
      ),
    ),
  );
  const principalOutput = await compile(
    compileSpec(sources["asset_auth.simf"], {
      ASSET_ID: assetArgument(instance.BORROWER_NFT_ASSET_ID),
      ASSET_AMOUNT: argument("1", "u64"),
      WITH_ASSET_BURN: argument("false", "bool"),
    }),
  );
  const lendingArguments = {
    COLLATERAL_ASSET_ID: assetArgument(instance.COLLATERAL_ASSET_ID),
    PRINCIPAL_ASSET_ID: assetArgument(instance.PRINCIPAL_ASSET_ID),
    BORROWER_NFT_ASSET_ID: assetArgument(instance.BORROWER_NFT_ASSET_ID),
    LENDER_NFT_ASSET_ID: assetArgument(instance.LENDER_NFT_ASSET_ID),
    COLLATERAL_AMOUNT: argument(instance.COLLATERAL_AMOUNT, "u64"),
    PRINCIPAL_AMOUNT: argument(instance.PRINCIPAL_AMOUNT, "u64"),
    PRINCIPAL_INTEREST_RATE: argument(instance.PRINCIPAL_INTEREST_RATE, "u64"),
    LOAN_EXPIRATION_TIME: argument(instance.LOAN_EXPIRATION_TIME, "u32"),
    LENDER_VAULT_COV_HASH: hashArgument(lenderVault.script_hash),
    FINALIZED_LENDER_VAULT_COV_HASH: hashArgument(finalizedLenderVault.script_hash),
    PROTOCOL_FEE_VAULT_COV_HASH: hashArgument(protocolFeeVault.script_hash),
    FINALIZED_PROTOCOL_FEE_VAULT_COV_HASH: hashArgument(
      finalizedProtocolFeeVault.script_hash,
    ),
    PRINCIPAL_OUTPUT_SCRIPT_HASH: hashArgument(principalOutput.script_hash),
  };
  const principal = BigInt(instance.PRINCIPAL_AMOUNT);
  const rate = BigInt(instance.PRINCIPAL_INTEREST_RATE);
  const currentDebt = (principal + (principal * rate) / 10_000n).toString();
  const debtLeaf = u64StorageLeaf(currentDebt);
  const lendingSource = sources["lending.simf"];
  const pendingOffer = await compile(
    compileSpec(lendingSource, lendingArguments, [ZERO_HASH, debtLeaf]),
  );
  const activeOffer = await compile(
    compileSpec(lendingSource, lendingArguments, [`${"00".repeat(31)}01`, debtLeaf]),
  );
  const lenderNftAuthorization = await compile(
    compileSpec(sources["script_auth.simf"], {
      SCRIPT_HASH: hashArgument(pendingOffer.script_hash),
    }),
  );

  return {
    currentDebt,
    finalizedLenderVault,
    lenderVault,
    finalizedProtocolFeeVault,
    protocolFeeVault,
    principalOutput,
    pendingOffer,
    activeOffer,
    lenderNftAuthorization,
    lendingArguments,
  };
}
function compileSpec(
  source: string,
  args: Record<string, SimplicityArgument>,
  extraLeaves: string[] = [],
): TxManifestCovenantCompileSpec {
  return {
    source,
    arguments: args,
    extra_leaf_payloads: extraLeaves,
    network: NETWORK,
    include_debug_symbols: true,
  };
}

function vaultArguments(
  instance: LendingV3Instance,
  keeperAssetId: string,
  active: boolean,
  keeperBurn: boolean,
  finalizedHash: string,
): Record<string, SimplicityArgument> {
  return {
    VAULT_ASSET_ID: assetArgument(instance.PRINCIPAL_ASSET_ID),
    KEEPER_AUTH_ASSET_ID: assetArgument(keeperAssetId),
    SUPPLIER_AUTH_ASSET_ID: assetArgument(instance.BORROWER_NFT_ASSET_ID),
    KEEPER_AUTH_ASSET_AMOUNT: argument("1", "u64"),
    FINALIZED_VAULT_COV_HASH: hashArgument(finalizedHash),
    IS_ACTIVE: argument(String(active), "bool"),
    WITH_KEEPER_ASSET_BURN: argument(String(keeperBurn), "bool"),
    WITH_SUPPLIER_ASSET_BURN: argument("true", "bool"),
  };
}

function assetArgument(assetId: string): SimplicityArgument {
  const bytes = assetId.match(/../g);
  if (!bytes || bytes.length !== 32) throw new Error("Invalid lending asset id.");
  return argument(`0x${bytes.reverse().join("")}`, "u256");
}

function hashArgument(hash: string): SimplicityArgument {
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error("Invalid lending covenant hash.");
  return argument(`0x${hash}`, "u256");
}

function argument(value: string, type: string): SimplicityArgument {
  return { value, type };
}

function u64StorageLeaf(value: string): string {
  return `${"00".repeat(24)}${BigInt(value).toString(16).padStart(16, "0")}`;
}

function validateInstance(instance: LendingV3Instance): void {
  for (const [name, value] of Object.entries(instance)) {
    if (name.endsWith("_ASSET_ID")) {
      if (!/^[0-9a-f]{64}$/.test(value)) throw new Error(`${name} is not an asset id.`);
    } else if (!/^(?:0|[1-9][0-9]*)$/.test(value)) {
      throw new Error(`${name} is not a canonical unsigned decimal string.`);
    }
  }
}
