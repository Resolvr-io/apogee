import {
  type LiquidProvider,
  type LiquidProviderDetail,
  type LiquidProviderEventMap,
  type LiquidProviderEventName,
  type LiquidProviderMethod,
  type LiquidProviderRequest,
  type LiquidProviderResult,
} from "./liquid-browser-provider";
import {
  LIQUID_RPC_ERROR_CODES,
  LIQUID_RPC_ERROR_REASONS,
  LiquidRpcError,
} from "./liquid-rpc-errors";

type ProviderTransport = (request: {
  method: string;
  params?: Record<string, unknown>;
}) => Promise<unknown>;

type Subscription = {
  event: string;
  listener: (payload: unknown) => void;
};

export interface LiquidProviderController {
  readonly provider: LiquidProvider;
  emit(event: string, payload: unknown): void;
}

/** Install race-free request/announce discovery for one immutable detail. */
export function installLiquidProviderDiscovery(
  target: EventTarget,
  detail: LiquidProviderDetail,
): () => void {
  const announce = () => {
    target.dispatchEvent(new CustomEvent("liquid:announceProvider", { detail }));
  };
  target.addEventListener("liquid:requestProvider", announce);
  announce();
  return () => target.removeEventListener("liquid:requestProvider", announce);
}

/** Build the page-visible provider around an implementation-owned transport. */
export function createLiquidProviderController(
  transport: ProviderTransport,
  supportedEvents: readonly string[],
  reportListenerError: (error: unknown) => void = (error) => console.error(error),
): LiquidProviderController {
  const subscriptions = new Set<Subscription>();
  const events = new Set(supportedEvents);

  async function request<M extends LiquidProviderMethod>(
    args: LiquidProviderRequest<M>,
  ): Promise<LiquidProviderResult<M>> {
    if (typeof args !== "object" || args === null || Array.isArray(args)) {
      throw invalidRequest("The provider request must be an object.");
    }
    const raw = args as { method?: unknown; params?: unknown };
    if (typeof raw.method !== "string" || raw.method.length === 0) {
      throw invalidRequest("The provider request method must be a non-empty string.");
    }
    if (
      raw.params !== undefined &&
      (typeof raw.params !== "object" || raw.params === null || Array.isArray(raw.params))
    ) {
      throw invalidRequest("Provider request params must be an object.");
    }
    if (raw.params !== undefined && !isJsonValue(raw.params, new Set())) {
      throw invalidRequest("Provider request params must be JSON-serializable.");
    }
    const normalized = {
      method: raw.method,
      ...(raw.params === undefined
        ? {}
        : { params: raw.params as Record<string, unknown> }),
    };
    return (await transport(normalized)) as LiquidProviderResult<M>;
  }

  function on<E extends LiquidProviderEventName>(args: {
    event: E;
    listener: (payload: LiquidProviderEventMap[E]) => void;
  }): () => void {
    if (
      typeof args !== "object" ||
      args === null ||
      typeof args.event !== "string" ||
      typeof args.listener !== "function"
    ) {
      throw new TypeError("on requires { event, listener }.");
    }
    if (!events.has(args.event)) {
      throw new LiquidRpcError(
        LIQUID_RPC_ERROR_CODES.UNSUPPORTED_CAPABILITY,
        `Unsupported event: ${String(args.event)}`,
        LIQUID_RPC_ERROR_REASONS.UNSUPPORTED_CAPABILITY,
        { event: args.event },
      );
    }
    const subscription: Subscription = {
      event: args.event,
      listener: args.listener as (payload: unknown) => void,
    };
    subscriptions.add(subscription);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      subscriptions.delete(subscription);
    };
  }

  const provider: LiquidProvider = Object.freeze({ request, on });
  return {
    provider,
    emit(event, payload) {
      if (!events.has(event)) return;
      for (const subscription of [...subscriptions]) {
        if (subscription.event !== event) continue;
        try {
          subscription.listener(payload);
        } catch (error) {
          reportListenerError(error);
        }
      }
    },
  };
}

function invalidRequest(message: string): LiquidRpcError {
  return new LiquidRpcError(
    LIQUID_RPC_ERROR_CODES.INVALID_REQUEST,
    message,
    LIQUID_RPC_ERROR_REASONS.INVALID_REQUEST,
  );
}

function isJsonValue(value: unknown, seen: Set<object>): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  const valid = Array.isArray(value)
    ? value.every((entry) => isJsonValue(entry, seen))
    : Object.values(value as Record<string, unknown>).every((entry) =>
        isJsonValue(entry, seen),
      );
  seen.delete(value);
  return valid;
}
