import type {
  InferenceRequest,
  InferenceResponse,
  LocalInferenceAdapter,
  ToolArm,
} from "./types.js";

export class MockInferenceAdapter implements LocalInferenceAdapter {
  public readonly supportedArms: ToolArm[] = ["arm_a_flat", "arm_b_json", "arm_c_sketch"];
  public callHistory: InferenceRequest[] = [];
  private responseIndex = 0;

  constructor(
    public readonly modelId: string,
    private queuedResponses: InferenceResponse[] = [],
  ) {}

  public enqueueResponse(res: InferenceResponse): void {
    this.queuedResponses.push(res);
  }

  public async generate(req: InferenceRequest): Promise<InferenceResponse> {
    this.callHistory.push(req);

    if (this.queuedResponses.length === 0) {
      return {
        text: "Mock default response",
        toolCalls: [],
        usage: { promptTokens: 50, completionTokens: 20, durationMs: 10 },
      };
    }

    const res = this.queuedResponses[this.responseIndex % this.queuedResponses.length];
    this.responseIndex++;
    if (!res) {
      return {
        text: "Mock default response",
        toolCalls: [],
        usage: { promptTokens: 50, completionTokens: 20, durationMs: 10 },
      };
    }
    return res;
  }
}
