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
  public completionTokens = 0;
  public inferenceCalls = 0;
  public inferenceMs = 0;

  constructor(
    private readonly inner: LocalInferenceAdapter,
    private readonly overrides: SamplingOverrides = {},
  ) {
    this.modelId = inner.modelId;
    this.supportedArms = inner.supportedArms;
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
    this.completionTokens += response.usage.completionTokens;
    this.inferenceMs += response.usage.durationMs;

    return response;
  }
}
