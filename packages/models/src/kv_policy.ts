/**
 * KV-cache precision policy (M16, design §572 and "Inference settings").
 *
 * 8-bit (`q8_0`) or better is the default. 4-bit KV is prohibited for
 * tool-calling models: it degrades long-range attention exactly where a tool
 * loop needs it (finding the schema and the last observation in a long
 * prompt). Between 4 and 8 bits (`q5_0`, `q5_1`, `iq4_nl` counts as 4) is
 * permitted only for a model that passed the qualification suite with it.
 */
export class KvPolicyError extends Error {
  constructor(
    message: string,
    public readonly kvType: string,
  ) {
    super(message);
    this.name = "KvPolicyError";
  }
}

export type KvPrecisionClass = "full" | "8bit" | "sub8bit" | "4bit" | "unknown";

/** Classify a llama.cpp / Ollama KV cache type name. */
export function kvPrecision(type: string): KvPrecisionClass {
  const t = type.trim().toLowerCase();
  if (t === "f32" || t === "f16" || t === "bf16") return "full";
  if (t === "q8_0" || t === "fp8" || t === "f8") return "8bit";
  if (t === "q5_0" || t === "q5_1" || t === "q6_k") return "sub8bit";
  if (/^(q4|iq4|q3|q2|iq3|iq2)/.test(t)) return "4bit";
  return "unknown";
}

export interface KvPolicyOptions {
  /** The model calls tools (default true). */
  toolCalling?: boolean;
  /** The model passed qualification with a KV type below 8 bits. */
  qualifiedBelow8Bit?: boolean;
}

/** Check one KV type; throws `KvPolicyError` when the policy forbids it. */
export function assertKvType(type: string, options: KvPolicyOptions = {}): void {
  const toolCalling = options.toolCalling !== false;
  const cls = kvPrecision(type);
  if (!toolCalling) return;
  if (cls === "4bit") {
    throw new KvPolicyError(
      `KV cache type '${type}' is 4-bit, which is prohibited for tool-calling models (use q8_0).`,
      type,
    );
  }
  if (cls === "sub8bit" && !options.qualifiedBelow8Bit) {
    throw new KvPolicyError(
      `KV cache type '${type}' is below 8 bits; it is allowed only after the model passes qualification with it.`,
      type,
    );
  }
}

const KV_FLAGS = new Set(["-ctk", "-ctv", "--cache-type-k", "--cache-type-v"]);

/**
 * Check every KV type in a llama-server argv. The last occurrence of a flag
 * wins in llama.cpp, but every value is checked: `extraArgs` must not be a
 * way around the policy.
 */
export function assertKvPolicy(argv: readonly string[], options: KvPolicyOptions = {}): void {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    const eq = arg.indexOf("=");
    const flag = eq > 0 ? arg.slice(0, eq) : arg;
    if (!KV_FLAGS.has(flag)) continue;
    const value = eq > 0 ? arg.slice(eq + 1) : argv[i + 1];
    if (value !== undefined) assertKvType(value, options);
  }
}
