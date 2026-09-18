export type ToolArm = "arm_a_flat" | "arm_b_json" | "arm_c_sketch";

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  raw?: string;
}

export interface TextPatch {
  filePath?: string;
  search: string;
  replace: string;
}

export interface InferenceRequest {
  systemPrompt?: string;
  prompt: string;
  tools?: ToolDefinition[];
  toolArm: ToolArm;
  temperature?: number;
  maxTokens?: number;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  durationMs: number;
}

export interface InferenceResponse {
  text: string;
  toolCalls: ToolCall[];
  usage: TokenUsage;
}

export interface LocalInferenceAdapter {
  readonly modelId: string;
  readonly supportedArms: ToolArm[];
  /** Context size and reserved output tokens, when known; used to budget prompts. */
  readonly contextWindow?: { contextTokens: number; maxTokens: number } | undefined;
  generate(req: InferenceRequest): Promise<InferenceResponse>;
}
