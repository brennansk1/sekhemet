import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { GGUFValueType, serializeGgufMetadata } from "@huggingface/gguf";

/**
 * A GGUF file for the model-library tests (B4.1 part b): a real header, the
 * way llama.cpp writes it, and `padBytes` of zeros standing in for the
 * weights. Nothing here is a model; nothing is ever loaded.
 */
export interface GgufFixture {
  name?: string;
  architecture?: string;
  basename?: string;
  fileType?: number;
  contextLength?: number;
  blockCount?: number;
  headCount?: number;
  headCountKv?: number;
  embeddingLength?: number;
  expertCount?: number;
  expertUsedCount?: number;
  license?: string;
  /** Extra string keys, e.g. `general.base_model.0.name`. */
  strings?: Record<string, string>;
  /** Zero bytes after the header. */
  padBytes?: number;
}

export function ggufBytes(f: GgufFixture = {}): Buffer {
  const arch = f.architecture ?? "llama";
  const meta: Record<string, { value: unknown; type: GGUFValueType }> = {
    "general.architecture": { value: arch, type: GGUFValueType.STRING },
  };
  const str = (k: string, v: string | undefined) => {
    if (v !== undefined) meta[k] = { value: v, type: GGUFValueType.STRING };
  };
  const u32 = (k: string, v: number | undefined) => {
    if (v !== undefined) meta[k] = { value: v, type: GGUFValueType.UINT32 };
  };
  str("general.name", f.name);
  str("general.basename", f.basename);
  str("general.license", f.license);
  u32("general.file_type", f.fileType);
  u32(`${arch}.context_length`, f.contextLength);
  u32(`${arch}.block_count`, f.blockCount);
  u32(`${arch}.attention.head_count`, f.headCount);
  u32(`${arch}.attention.head_count_kv`, f.headCountKv);
  u32(`${arch}.embedding_length`, f.embeddingLength);
  u32(`${arch}.expert_count`, f.expertCount);
  u32(`${arch}.expert_used_count`, f.expertUsedCount);
  for (const [k, v] of Object.entries(f.strings ?? {})) str(k, v);
  const header = serializeGgufMetadata({
    version: { value: 3, type: GGUFValueType.UINT32 },
    tensor_count: { value: 0n, type: GGUFValueType.UINT64 },
    kv_count: { value: BigInt(Object.keys(meta).length), type: GGUFValueType.UINT64 },
    ...meta,
  } as unknown as Parameters<typeof serializeGgufMetadata>[0]);
  return Buffer.concat([Buffer.from(header), Buffer.alloc(f.padBytes ?? 0)]);
}

export function writeGguf(path: string, f: GgufFixture = {}): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, ggufBytes(f));
  return path;
}

/** A typical small model's header: 32 layers, 8 KV heads of 128. */
export const SMALL: GgufFixture = {
  architecture: "llama",
  name: "Tiny Llama 1B",
  basename: "Tiny-Llama",
  fileType: 15,
  contextLength: 32768,
  blockCount: 32,
  headCount: 32,
  headCountKv: 8,
  embeddingLength: 4096,
};
