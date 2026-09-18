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

export type HookHandler = (context: LifecycleHookContext) => Promise<void> | void;

export class LifecycleHookEngine {
  private handlers: Map<LifecycleHookEvent, HookHandler[]> = new Map();

  public register(event: LifecycleHookEvent, handler: HookHandler): () => void {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);

    return () => {
      const current = this.handlers.get(event) ?? [];
      this.handlers.set(
        event,
        current.filter((h) => h !== handler),
      );
    };
  }

  public async emit(event: LifecycleHookEvent, context: LifecycleHookContext): Promise<void> {
    const list = this.handlers.get(event) ?? [];
    for (const handler of list) {
      await handler(context);
    }
  }

  public clear(): void {
    this.handlers.clear();
  }
}
