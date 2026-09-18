import { performance } from "node:perf_hooks";
import { parseToolCallsFromText } from "./parser.js";
import type {
  InferenceRequest,
  InferenceResponse,
  LocalInferenceAdapter,
  ToolArm,
} from "./types.js";

export interface SamplingOptions {
  temperature?: number;
  topP?: number;
  topK?: number;
  minP?: number;
  presencePenalty?: number;
}

export interface HttpAdapterOptions {
  modelId: string;
  baseUrl?: string;
  apiFormat?: "ollama" | "openai";
  sampling?: SamplingOptions;
}

export class HttpInferenceAdapter implements LocalInferenceAdapter {
  public readonly modelId: string;
  public readonly supportedArms: ToolArm[] = ["arm_a_flat", "arm_b_json", "arm_c_sketch"];
  private baseUrl: string;
  private apiFormat: "ollama" | "openai";
  private sampling: SamplingOptions;

  constructor(options: HttpAdapterOptions) {
    this.modelId = options.modelId;
    this.baseUrl = options.baseUrl ?? "http://127.0.0.1:11434";
    this.apiFormat = options.apiFormat ?? "ollama";
    this.sampling = options.sampling ?? {};
  }

  public async generate(req: InferenceRequest): Promise<InferenceResponse> {
    const start = performance.now();

    if (this.apiFormat === "ollama") {
      const messages = [];
      if (req.systemPrompt) {
        messages.push({ role: "system", content: req.systemPrompt });
      }
      messages.push({ role: "user", content: req.prompt });

      const res = await fetch(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.modelId,
          messages,
          stream: false,
          options: {
            temperature: req.temperature ?? 0.2,
            num_predict: req.maxTokens ?? 2048,
          },
        }),
      });

      if (!res.ok) {
        throw new Error(`Inference HTTP error: ${res.status} ${res.statusText}`);
      }

      const data = (await res.json()) as {
        message?: { content?: string };
        prompt_eval_count?: number;
        eval_count?: number;
      };

      const text = data.message?.content ?? "";
      const toolCalls = parseToolCallsFromText(text, req.toolArm);
      const durationMs = Math.round(performance.now() - start);

      return {
        text,
        toolCalls,
        usage: {
          promptTokens: data.prompt_eval_count ?? Math.round(req.prompt.length / 4),
          completionTokens: data.eval_count ?? Math.round(text.length / 4),
          durationMs,
        },
      };
    }

    // Default: OpenAI-compatible (llama.cpp / MLX)
    const messages = [];
    if (req.systemPrompt) {
      messages.push({ role: "system", content: req.systemPrompt });
    }
    messages.push({ role: "user", content: req.prompt });

    const body: Record<string, unknown> = {
      model: this.modelId,
      messages,
      temperature: req.temperature ?? this.sampling.temperature ?? 0.2,
      max_tokens: req.maxTokens ?? 2048,
    };
    if (this.sampling.topP !== undefined) body.top_p = this.sampling.topP;
    if (this.sampling.topK !== undefined) body.top_k = this.sampling.topK;
    if (this.sampling.minP !== undefined) body.min_p = this.sampling.minP;
    if (this.sampling.presencePenalty !== undefined) {
      body.presence_penalty = this.sampling.presencePenalty;
    }

    const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      throw new Error(`Inference HTTP error: ${res.status} ${res.statusText}`);
    }

    const data = (await res.json()) as {
      choices?: [{ message?: { content?: string } }];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };

    const text = data.choices?.[0]?.message?.content ?? "";
    const toolCalls = parseToolCallsFromText(text, req.toolArm);
    const durationMs = Math.round(performance.now() - start);

    return {
      text,
      toolCalls,
      usage: {
        promptTokens: data.usage?.prompt_tokens ?? Math.round(req.prompt.length / 4),
        completionTokens: data.usage?.completion_tokens ?? Math.round(text.length / 4),
        durationMs,
      },
    };
  }
}

export function createQwen38_27BAdapter(baseUrl = "http://127.0.0.1:8099"): HttpInferenceAdapter {
  return new HttpInferenceAdapter({
    modelId: "qwen3.8-27b",
    baseUrl,
    apiFormat: "openai",
    sampling: {
      temperature: 0.2,
      topP: 0.9,
      topK: 20,
      minP: 0.0,
      presencePenalty: 1.5,
    },
  });
}
