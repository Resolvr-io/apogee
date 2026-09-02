import { taggedCanonicalJsonHash, type TxManifestBundle } from "./bundle";
import {
  assertDeclarativeChainAllowed,
  declarativeActionRequiresWalletSigning,
  declarativeBytesHex,
  parseDeclarativeArguments,
  type DeclarativeActionRecipe,
  type DeclarativeManifest,
  type DeclarativeTypedValue,
} from "./declarative";
import {
  resolveDeclarativeTxManifest,
  type TxManifestBundleHash,
} from "./registry";
import type {
  TxManifestInvocation,
  TxManifestOutpoint,
} from "./requirements";

export type DeclarativeRequirementPlan = {
  planVersion: "apogee-declarative-requirements/v1";
  requestId: string;
  chainId: string;
  accountIdentifier: string;
  bundleHash: TxManifestBundleHash;
  action: string;
  constraints: { maxFee?: string; validUntilHeight?: number };
  requirementDigest: `sha256:${string}`;
  /** Full normalized, untrusted execution authority. Never replace with prose or a cache hit. */
  bundle: TxManifestBundle;
  declarative: DeclarativeManifest;
  recipe: DeclarativeActionRecipe;
  arguments: Record<string, string>;
  providedInputs: readonly {
    roleId: string;
    providedInput: string;
    authorization: "covenant" | "wallet";
    outpoint: TxManifestOutpoint;
  }[];
  publisher: {
    protocol: string;
    action: string;
    description?: string;
  };
};

/**
 * Turn a compatible untrusted invocation into a deterministic requirements
 * plan without touching wallet, signer, or chain state.
 */
export async function resolveDeclarativeRequirements(
  invocation: TxManifestInvocation,
): Promise<DeclarativeRequirementPlan> {
  if (invocation.protocolVersion !== "0.1") {
    throw new Error("Unsupported TX Manifest protocol version.");
  }
  if (invocation.manifest.bundle === undefined) {
    throw new Error("Generic TX Manifest execution requires the full bundle on every request.");
  }
  const resolved = await resolveDeclarativeTxManifest(
    invocation.manifest.bundleHash,
    invocation.manifest.bundle,
  );
  assertDeclarativeChainAllowed(resolved.declarative, invocation.chainId);
  if (!Object.hasOwn(resolved.declarative.actions, invocation.action)) {
    throw new Error("This declarative TX Manifest does not declare the requested action.");
  }
  const recipe = resolved.declarative.actions[invocation.action];

  const parsedArguments = parseDeclarativeArguments(recipe, invocation.arguments);
  const arguments_: Record<string, string> = {};
  for (const [name, value] of parsedArguments) {
    arguments_[name] = canonicalTypedValue(value);
  }
  const providedInputs = resolveProvidedInputs(recipe, invocation.providedInputs);
  const common = {
    planVersion: "apogee-declarative-requirements/v1" as const,
    requestId: nonEmpty(invocation.requestId, "requestId"),
    chainId: nonEmpty(invocation.chainId, "chainId"),
    accountIdentifier: nonEmpty(invocation.accountIdentifier, "accountIdentifier"),
    bundleHash: invocation.manifest.bundleHash,
    action: invocation.action,
    constraints: constraints(invocation.constraints),
    bundle: resolved.bundle,
    declarative: resolved.declarative,
    recipe,
    arguments: arguments_,
    providedInputs,
    publisher: {
      protocol: String(resolved.bundle.manifest.protocol),
      action: invocation.action,
      ...(publisherActionDescription(resolved.bundle, invocation.action) === undefined
        ? {}
        : { description: publisherActionDescription(resolved.bundle, invocation.action) }),
    },
  };
  return {
    ...common,
    requirementDigest: await taggedCanonicalJsonHash(
      "apogee/declarative-requirements/v1",
      common,
    ),
  };
}

export function declarativeSigningMode(
  plan: Pick<DeclarativeRequirementPlan, "recipe">,
): "wallet" | "none" {
  return declarativeActionRequiresWalletSigning(plan.recipe) ? "wallet" : "none";
}

function resolveProvidedInputs(
  recipe: DeclarativeActionRecipe,
  value: TxManifestInvocation["providedInputs"],
): DeclarativeRequirementPlan["providedInputs"] {
  const roles = recipe.inputs.filter((input) => input.kind === "provided");
  const expected = roles.map((role) => role.provided_input).sort();
  const actual = Object.keys(value ?? {}).sort();
  if (expected.length !== actual.length || expected.some((name, index) => name !== actual[index])) {
    throw new Error(
      `providedInputs must contain exactly: ${expected.length === 0 ? "none" : expected.join(", ")}.`,
    );
  }
  return roles.map((role) => {
    const candidate = value?.[role.provided_input];
    if (Array.isArray(candidate)) {
      throw new Error("Declarative v1 provided input roles accept one exact outpoint each.");
    }
    if (!candidate) throw new Error(`Missing provided input ${role.provided_input}.`);
    return {
      roleId: role.id,
      providedInput: role.provided_input,
      authorization: role.authorization,
      outpoint: { txid: candidate.txid, vout: candidate.vout },
    };
  });
}

function canonicalTypedValue(value: DeclarativeTypedValue): string {
  return value.kind === "uint" ? value.value.toString() : declarativeBytesHex(value);
}

function constraints(
  value: TxManifestInvocation["constraints"],
): DeclarativeRequirementPlan["constraints"] {
  const out: DeclarativeRequirementPlan["constraints"] = {};
  if (value?.maxFee !== undefined) {
    out.maxFee = decimal(value.maxFee, 0xffff_ffff_ffff_ffffn, "constraints.maxFee", true);
  }
  if (value?.validUntilHeight !== undefined) {
    if (!Number.isSafeInteger(value.validUntilHeight) || value.validUntilHeight < 0 || value.validUntilHeight > 0xffff_ffff) {
      throw new Error("constraints.validUntilHeight must fit u32.");
    }
    out.validUntilHeight = value.validUntilHeight;
  }
  return out;
}

function publisherActionDescription(bundle: TxManifestBundle, action: string): string | undefined {
  const direct = actionDescription(bundle.manifest.actions, action);
  if (direct !== undefined) return direct;
  const templates = bundle.manifest.contract_templates;
  if (typeof templates !== "object" || templates === null || Array.isArray(templates)) return undefined;
  const separator = action.lastIndexOf(".");
  if (separator <= 0 || separator === action.length - 1) return undefined;
  const templateName = action.slice(0, separator);
  const localAction = action.slice(separator + 1);
  const template = (templates as Record<string, unknown>)[templateName];
  if (typeof template !== "object" || template === null || Array.isArray(template)) return undefined;
  return actionDescription((template as Record<string, unknown>).actions, localAction);
}

function actionDescription(container: unknown, action: string): string | undefined {
  if (typeof container !== "object" || container === null || Array.isArray(container)) return undefined;
  const value = (container as Record<string, unknown>)[action];
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const description = (value as Record<string, unknown>).description;
  return typeof description === "string" && description.length > 0
    ? description.slice(0, 1_024)
    : undefined;
}

function decimal(value: string, maximum: bigint, label: string, positive: boolean): string {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) throw new Error(`${label} must be a canonical integer.`);
  const parsed = BigInt(value);
  if ((positive && parsed === 0n) || parsed > maximum) {
    throw new Error(`${label} is outside the supported range.`);
  }
  return parsed.toString();
}

function nonEmpty(value: string, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must not be empty.`);
  return value;
}
