import type {
  AdapterHealth,
  InferenceRequest,
  InferenceResponse,
  LocalInferenceAdapter,
  ToolArm,
} from "./types.js";

/**
 * What the mock does when its scripted responses run out (M10).
 * - `cycle`: start over (the historical behaviour; the default).
 * - `default`: answer "Mock default response" with no tool calls.
 * - `throw`: throw `MockExhaustedError`, so a test that under-scripts a
 *   conversation fails loudly instead of looping.
 */
export type MockExhaustion = "cycle" | "default" | "throw";

export class MockExhaustedError extends Error {
  constructor(public readonly calls: number) {
    super(`MockInferenceAdapter has no scripted response left (call ${calls})`);
    this.name = "MockExhaustedError";
  }
}

/** A response chosen by what the request contains, not by position. */
export interface MockRule {
  /** Matched against the prompt, the system prompt and every message's text. */
  match: RegExp | string | ((req: InferenceRequest) => boolean);
  response: InferenceResponse | ((req: InferenceRequest) => InferenceResponse);
  /** Uses before the rule retires; unlimited when unset. */
  times?: number;
}

export interface MockAdapterOptions {
  exhaustion?: MockExhaustion;
  rules?: MockRule[];
  health?: Partial<AdapterHealth>;
}

const DEFAULT_RESPONSE: InferenceResponse = {
  text: "Mock default response",
  toolCalls: [],
  usage: { promptTokens: 50, completionTokens: 20, durationMs: 10 },
};

function requestText(req: InferenceRequest): string {
  return [req.systemPrompt ?? "", req.prompt, ...(req.messages ?? []).map((m) => m.content)].join(
    "\n",
  );
}

/**
 * Scripted adapter for tests (M10). Rules are tried first, in order: the
 * first whose pattern matches the request answers (a string matches as a
 * substring). Otherwise the queued responses answer in order, and the
 * exhaustion mode decides what happens after the last one.
 */
export class MockInferenceAdapter implements LocalInferenceAdapter {
  public readonly supportedArms: ToolArm[] = ["arm_a_flat", "arm_b_json", "arm_c_sketch"];
  public callHistory: InferenceRequest[] = [];
  private responseIndex = 0;
  private rules: (MockRule & { used: number })[];
  private exhaustion: MockExhaustion;

  constructor(
    public readonly modelId: string,
    private queuedResponses: InferenceResponse[] = [],
    private options: MockAdapterOptions = {},
  ) {
    this.rules = (options.rules ?? []).map((r) => ({ ...r, used: 0 }));
    this.exhaustion = options.exhaustion ?? "cycle";
  }

  public enqueueResponse(res: InferenceResponse): void {
    this.queuedResponses.push(res);
  }

  public addRule(rule: MockRule): void {
    this.rules.push({ ...rule, used: 0 });
  }

  /** Scripted responses not yet consumed (0 in cycle mode once wrapped). */
  public get remaining(): number {
    return Math.max(0, this.queuedResponses.length - this.responseIndex);
  }

  public async healthCheck(): Promise<AdapterHealth> {
    return {
      ok: true,
      modelId: this.modelId,
      reachable: true,
      loaded: true,
      latencyMs: 0,
      ...this.options.health,
    };
  }

  public async generate(req: InferenceRequest): Promise<InferenceResponse> {
    this.callHistory.push(req);

    const text = requestText(req);
    for (const rule of this.rules) {
      if (rule.times !== undefined && rule.used >= rule.times) continue;
      const hit =
        typeof rule.match === "string"
          ? text.includes(rule.match)
          : rule.match instanceof RegExp
            ? rule.match.test(text)
            : rule.match(req);
      if (!hit) continue;
      rule.used++;
      return typeof rule.response === "function" ? rule.response(req) : rule.response;
    }

    if (this.queuedResponses.length === 0) {
      if (this.exhaustion === "throw") throw new MockExhaustedError(this.callHistory.length);
      return DEFAULT_RESPONSE;
    }

    if (this.responseIndex >= this.queuedResponses.length) {
      if (this.exhaustion === "throw") throw new MockExhaustedError(this.callHistory.length);
      if (this.exhaustion === "default") return DEFAULT_RESPONSE;
    }
    const res = this.queuedResponses[this.responseIndex % this.queuedResponses.length];
    this.responseIndex++;
    return res ?? DEFAULT_RESPONSE;
  }
}
