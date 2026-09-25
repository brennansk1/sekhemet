/**
 * Waterfall lifecycle hook engine (design §136, §1438).
 *
 * SECURITY (design §136): hooks run **outside the sandbox with the user's own
 * privileges**. That is deliberate — formatters, lint fixers and desktop
 * notifications are useless confined to a card's worktree — but it means a
 * registered hook is arbitrary local code with full user rights, not agent-
 * supplied content. Never register a handler built from model output, and
 * treat `.sekhemet/hooks/` as trusted configuration on par with a git hook.
 */

export type LifecycleHookEvent =
  | "card/start"
  | "pre-step"
  | "pre-tool"
  | "post-tool"
  | "pre-gate"
  | "post-gate"
  | "card/end"
  | "review/return"
  | "playbook/propose"
  | "turn-stopping";

/**
 * Events where a handler that throws blocks by default.
 *
 * WHY fail-closed here specifically: these are the gating points. `pre-tool` is
 * where a permission or secret-scanning hook decides whether a write happens at
 * all, so a crashed hook that is treated as "no objection" converts a broken
 * guard into a silent allow. Everywhere else — notifications, post-hoc
 * formatting — a crash is a nuisance and must not stall the card, so those
 * events fail open and merely record the error.
 */
const DEFAULT_FAIL_CLOSED_EVENTS: readonly LifecycleHookEvent[] = [
  "pre-step",
  "pre-tool",
  "pre-gate",
];

export interface LifecycleHookContext {
  cardId: string;
  step?: number;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolResult?: unknown;
  gateRungs?: string[];
  gateResult?: unknown;
  data?: Record<string, unknown>;
}

/** A message a hook adds to the next model turn. */
export interface HookMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/**
 * What a handler may return.
 *
 * Returning nothing means "observed, no objection" — the common case, and the
 * reason the return type is optional.
 */
export interface HookOutcome {
  /** Stop the action this hook guards. Requires a reason the caller can show. */
  block?: boolean;
  /** Why the action was blocked, or why the hook objected. */
  reason?: string;
  /** Messages to prepend to the next model turn, in registration order. */
  inject?: Array<string | HookMessage>;
  /** Arbitrary data merged into the dispatch result for the caller. */
  data?: Record<string, unknown>;
}

/**
 * `void` in the return union is load-bearing: the common hook is a statement
 * body with no return — a notifier, a formatter. Narrowing to `undefined` makes
 * every such handler a type error and forces `return undefined` boilerplate on
 * the case that only observes.
 */
export type HookHandler = (
  context: LifecycleHookContext,
  // biome-ignore lint/suspicious/noConfusingVoidType: see the note above.
) => Promise<HookOutcome | void> | HookOutcome | void;

/** An error thrown by one handler, kept rather than propagated. */
export interface HookError {
  event: LifecycleHookEvent;
  error: Error;
}

export interface HookDispatchResult {
  /** True when a handler (or a fail-closed crash) stopped the action. */
  blocked: boolean;
  /** Reason from the first blocking handler. */
  reason?: string;
  /** Zero-based index of the handler that blocked, in registration order. */
  blockedByIndex?: number;
  /**
   * The blocking handler's name, when it was registered with one (a user
   * hook's configured name or its command), so a veto names the hook rather
   * than its position (worker-loop WL-T3-4).
   */
  blockedBy?: string;
  /** Injected messages, accumulated in registration order. */
  messages: HookMessage[];
  /** Merged `data` from every handler that ran, later keys winning. */
  data: Record<string, unknown>;
  /** How many handlers actually ran before the waterfall short-circuited. */
  handlersRun: number;
  errors: HookError[];
}

export interface LifecycleHookEngineOptions {
  /** Events where a thrown handler blocks. Defaults to the `pre-*` gates. */
  failClosedEvents?: readonly LifecycleHookEvent[];
  /** Observability sink for handler crashes; dispatch continues regardless. */
  onHookError?: (error: Error, event: LifecycleHookEvent, context: LifecycleHookContext) => void;
}

/** Registration record, so identity survives duplicate handler functions. */
interface Registration {
  handler: HookHandler;
  name?: string;
}

export class LifecycleHookEngine {
  private handlers: Map<LifecycleHookEvent, Registration[]> = new Map();
  private failClosedEvents: ReadonlySet<LifecycleHookEvent>;
  private options: LifecycleHookEngineOptions;

  constructor(options: LifecycleHookEngineOptions = {}) {
    this.options = options;
    this.failClosedEvents = new Set(options.failClosedEvents ?? DEFAULT_FAIL_CLOSED_EVENTS);
  }

  /**
   * Register a handler and get back its own unregister function.
   *
   * The registration is identified by a private record, not by the handler
   * function, so registering the same function twice yields two independent
   * subscriptions and unregistering one does not silently remove the other.
   * `name` is how a block by this handler is reported (`blockedBy`).
   */
  public register(event: LifecycleHookEvent, handler: HookHandler, name?: string): () => void {
    const registration: Registration = name ? { handler, name } : { handler };
    const list = this.handlers.get(event) ?? [];
    list.push(registration);
    this.handlers.set(event, list);

    return () => {
      const current = this.handlers.get(event);
      if (!current) return;
      const index = current.indexOf(registration);
      if (index === -1) return;
      // Replace rather than splice in place: an in-flight `emit` iterates a
      // snapshot, so mutation during dispatch cannot skip a handler.
      this.handlers.set(event, [...current.slice(0, index), ...current.slice(index + 1)]);
    };
  }

  public listenerCount(event: LifecycleHookEvent): number {
    return this.handlers.get(event)?.length ?? 0;
  }

  /**
   * Run every handler for `event` in registration order.
   *
   * Waterfall semantics:
   *  - **observe** — a handler returning nothing has no effect;
   *  - **block** — the first handler returning `{block: true}` wins and stops
   *    the waterfall: later handlers do not run, because they would be
   *    reasoning about an action that is no longer going to happen;
   *  - **inject** — messages accumulate in order across every handler that ran,
   *    including the blocking one (its explanation is usually the message the
   *    model most needs to see).
   */
  public async emit(
    event: LifecycleHookEvent,
    context: LifecycleHookContext,
  ): Promise<HookDispatchResult> {
    const list = [...(this.handlers.get(event) ?? [])];
    const result: HookDispatchResult = {
      blocked: false,
      messages: [],
      data: {},
      handlersRun: 0,
      errors: [],
    };

    for (let index = 0; index < list.length; index++) {
      const registration = list[index];
      if (!registration) continue;

      let outcome: HookOutcome | undefined;
      try {
        outcome = (await registration.handler(context)) ?? undefined;
        result.handlersRun++;
      } catch (err) {
        result.handlersRun++;
        const error = err instanceof Error ? err : new Error(String(err));
        result.errors.push({ event, error });
        this.options.onHookError?.(error, event, context);

        if (this.failClosedEvents.has(event)) {
          result.blocked = true;
          result.reason = `Hook for '${event}' failed: ${error.message}`;
          result.blockedByIndex = index;
          if (registration.name) result.blockedBy = registration.name;
          return result;
        }
        continue;
      }

      if (!outcome) continue;

      if (outcome.inject) {
        for (const message of outcome.inject) {
          result.messages.push(
            typeof message === "string" ? { role: "system", content: message } : message,
          );
        }
      }

      if (outcome.data) {
        result.data = { ...result.data, ...outcome.data };
      }

      if (outcome.block) {
        result.blocked = true;
        result.reason = outcome.reason ?? `Blocked by '${event}' hook`;
        result.blockedByIndex = index;
        if (registration.name) result.blockedBy = registration.name;
        return result;
      }
    }

    return result;
  }

  public clear(): void {
    this.handlers.clear();
  }
}
