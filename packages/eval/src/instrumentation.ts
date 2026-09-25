import type {
  InferenceRequest,
  InferenceResponse,
  LocalInferenceAdapter,
  ToolArm,
} from "@sekhemet/models";

export interface SamplingOverrides {
  temperature?: number | undefined;
  maxTokens?: number | undefined;
}

/**
 * Delegating adapter that pins sampling for one attempt and meters what it cost.
 *
 * The session loop reports turns, not tokens, so the meter has to sit on the
 * adapter. Pinning temperature here rather than trusting the caller is what
 * makes a pass@k sweep honest: every attempt is drawn at the temperature the
 * result records, whatever the session or the underlying adapter would default
 * to.
 */
export class InstrumentedAdapter implements LocalInferenceAdapter {
  public readonly modelId: string;
  public readonly supportedArms: ToolArm[];

  public promptTokens = 0;
  /** Of `promptTokens`, those the server served from its prompt cache (MS-M9-2). */
  public cachedPromptTokens = 0;
  public completionTokens = 0;
  public inferenceCalls = 0;
  public inferenceMs = 0;

  constructor(
    private readonly inner: LocalInferenceAdapter,
    private readonly overrides: SamplingOverrides = {},
  ) {
    this.modelId = inner.modelId;
    this.supportedArms = inner.supportedArms;
    // An optional property forwarded live: absent on the inner adapter reads
    // as absent here, never as a made-up `false`.
    Object.defineProperty(this, "nativeTools", {
      get: () => this.inner.nativeTools,
      enumerable: true,
    });
  }

  /** Forwarded from the inner adapter (see the constructor). */
  public declare readonly nativeTools?: boolean;

  // Every property the session reads passes through unchanged (MS-M9-2,
  // measurement rule 9): a wrapper that hid the window, the native-tools
  // flag or the measured arm measured a different Worker from the product's.
  public get contextWindow(): LocalInferenceAdapter["contextWindow"] {
    return this.inner.contextWindow;
  }

  public get preferredToolArm(): ToolArm | undefined {
    return this.inner.preferredToolArm;
  }

  public healthCheck(): ReturnType<NonNullable<LocalInferenceAdapter["healthCheck"]>> {
    return this.inner.healthCheck
      ? this.inner.healthCheck()
      : Promise.resolve({
          ok: true,
          modelId: this.modelId,
          reachable: true,
          loaded: true,
          latencyMs: 0,
        });
  }

  /** Release the inner adapter's weights, when it holds any. */
  public async unload(): Promise<void> {
    await (this.inner as { unload?: () => Promise<void> }).unload?.();
  }

  public get totalTokens(): number {
    return this.promptTokens + this.completionTokens;
  }

  public async generate(req: InferenceRequest): Promise<InferenceResponse> {
    const request: InferenceRequest = {
      ...req,
      ...(this.overrides.temperature !== undefined
        ? { temperature: this.overrides.temperature }
        : {}),
      ...(this.overrides.maxTokens !== undefined ? { maxTokens: this.overrides.maxTokens } : {}),
    };

    const response = await this.inner.generate(request);

    this.inferenceCalls++;
    this.promptTokens += response.usage.promptTokens;
    this.cachedPromptTokens += response.usage.cachedPromptTokens ?? 0;
    this.completionTokens += response.usage.completionTokens;
    this.inferenceMs += response.usage.durationMs;

    return response;
  }
}
