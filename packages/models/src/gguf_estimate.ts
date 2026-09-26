import { gguf } from "@huggingface/gguf";
import type { Graded, ModelMetadata, ModelShape } from "./library_types.js";
import { type MemoryBreakdown, memoryBreakdown } from "./model_fit.js";
import { familyOfArchitecture } from "./model_scan.js";
import { DEFAULT_SWAP_POLICY, type SwapPolicyParams } from "./swap_policy.js";

/**
 * Speed and memory before a measurement (models MD-N13-3, rule 20d;
 * dashboard DB-NM14-3, DB-NM14-5; DEC-44/45). Decode is predicted by the
 * roofline — the engine's efficiency × the memory bandwidth ÷ the bytes read
 * per token (the active parameters × bits per weight ÷ 8) — and is always
 * *Estimated*, with its spread, until llama-bench measures it. A remote model
 * is estimated from its GGUF metadata alone, through our own estimator over
 * `@huggingface/gguf`, which reads the header's byte ranges and never the
 * weights; gguf-parser-go is used for a local file only (`estimateLocal`),
 * never with its `--url`, which would fetch outside the `[network]` policy.
 */

/** The roofline's spread until calibrated (D): ±25%. */
export const ROOFLINE_SPREAD = 0.25;

/** Bytes read per decoded token: the active parameters for a mixture of experts. */
export function bytesPerToken(
  meta: Pick<ModelMetadata, "parametersActive" | "parametersTotal" | "bitsPerWeight">,
  sizeBytes: number,
): number {
  const bpw =
    meta.bitsPerWeight ??
    (meta.parametersTotal ? (sizeBytes * 8) / meta.parametersTotal : undefined);
  if (meta.parametersActive && bpw) return (meta.parametersActive * bpw) / 8;
  if (meta.parametersTotal && bpw) return (meta.parametersTotal * bpw) / 8;
  return sizeBytes;
}

/** The predicted decode speed (MD-N13-3), graded estimated with its spread; undefined without a bandwidth. */
export function predictDecode(
  meta: Pick<ModelMetadata, "parametersActive" | "parametersTotal" | "bitsPerWeight">,
  sizeBytes: number,
  bandwidth: Graded | undefined,
  engine: string,
  params: Pick<SwapPolicyParams, "engineEfficiency"> = DEFAULT_SWAP_POLICY,
): Graded | undefined {
  const efficiency = params.engineEfficiency[engine];
  const bytes = bytesPerToken(meta, sizeBytes);
  if (!bandwidth || efficiency === undefined || bytes <= 0) return undefined;
  const value = (efficiency * bandwidth.value) / bytes;
  return {
    value,
    grade: "estimated",
    low: value * (1 - ROOFLINE_SPREAD),
    high: value * (1 + ROOFLINE_SPREAD),
  };
}

/** gguf-parser-go, when installed: `run(args)` returns its stdout. */
export interface GgufParserGo {
  run(args: string[]): Promise<string>;
}

export interface RemoteEstimate {
  source: "gguf-parser-go" | "estimator";
  url: string;
  sizeBytes?: number;
  metadata: ModelMetadata;
  memory: MemoryBreakdown;
  decode?: Graded;
}

/** gguf-parser-go's `--json` output: its metadata and its first estimate item. */
export function parseGgufParserJson(
  text: string,
): { sizeBytes?: number; metadata: ModelMetadata; totalBytes: number } | undefined {
  let j: {
    metadata?: {
      size?: number;
      parameters?: number;
      bitsPerWeight?: number;
      architecture?: string;
      name?: string;
    };
    estimate?: { items?: { vrams?: { uma?: number }[]; ram?: { uma?: number } }[] };
  };
  try {
    j = JSON.parse(text);
  } catch {
    return undefined;
  }
  const item = j.estimate?.items?.[0];
  const vram = (item?.vrams ?? []).reduce((n, v) => n + (v.uma ?? 0), 0);
  const total = vram + (item?.ram?.uma ?? 0);
  if (!(total > 0)) return undefined;
  const m = j.metadata ?? {};
  const family = familyOfArchitecture(m.architecture);
  return {
    ...(m.size ? { sizeBytes: m.size } : {}),
    totalBytes: total,
    metadata: {
      ...(m.architecture ? { architecture: m.architecture } : {}),
      ...(family ? { family } : {}),
      ...(m.parameters ? { parametersTotal: m.parameters } : {}),
      ...(m.bitsPerWeight ? { bitsPerWeight: m.bitsPerWeight } : {}),
    },
  };
}

const num = (v: unknown): number | undefined =>
  typeof v === "number" ? v : typeof v === "bigint" ? Number(v) : undefined;

/** The most a remote header read may take (DB-NM14-5): far above any header, far below any weights. */
export const REMOTE_HEADER_CAP_BYTES = 64 * 1024 * 1024;

const parserArgs = (contextTokens: number, kvType: string) => [
  "--ctx-size",
  String(contextTokens),
  "--cache-type-k",
  kvType,
  "--cache-type-v",
  kvType,
  "--skip-tokenizer",
  "--json",
];

/**
 * A local GGUF's estimate through gguf-parser-go (DB-NM14-5), by `--path`
 * only: its `--url` would fetch outside the `[network]` policy, so a remote
 * model is never given to it (`estimateRemote` reads remote headers itself).
 * Undefined when its output cannot be read.
 */
export async function estimateLocal(
  path: string,
  options: {
    parser: GgufParserGo;
    contextTokens: number;
    kvType: string;
    engine: string;
    bandwidth?: Graded;
  },
): Promise<RemoteEstimate | undefined> {
  if (/^[a-z][a-z0-9+.-]*:/i.test(path))
    throw new Error(
      "gguf-parser-go reads a local file only; a remote model is estimated by our own reader.",
    );
  const out = await options.parser.run([
    "--path",
    path,
    ...parserArgs(options.contextTokens, options.kvType),
  ]);
  const p = parseGgufParserJson(out);
  if (!p) return undefined;
  const size = p.sizeBytes ?? 0;
  const breakdown = memoryBreakdown(
    { sizeBytes: size, metadata: p.metadata },
    { contextTokens: options.contextTokens, kvType: options.kvType },
  );
  const decode = predictDecode(p.metadata, size, options.bandwidth, options.engine);
  return {
    source: "gguf-parser-go",
    url: path,
    ...(p.sizeBytes ? { sizeBytes: p.sizeBytes } : {}),
    metadata: p.metadata,
    memory: {
      ...breakdown,
      weightsBytes: { value: size, grade: "estimated" },
      totalBytes: { value: p.totalBytes, grade: "estimated" },
    },
    ...(decode ? { decode } : {}),
  };
}

/**
 * The pre-download estimate (DB-NM14-5): memory at the role's context and KV
 * type and the predicted decode, from a remote GGUF's metadata alone.
 * `fetch` is the research network policy's; only range requests are made,
 * each must be answered with a 206 (a host that ignores Range would send the
 * weights, so its body is cancelled and the estimate refused), and at most
 * `maxBytes` are read in all.
 */
export async function estimateRemote(
  url: string,
  options: {
    fetch: (input: string, init?: RequestInit) => Promise<Response>;
    contextTokens: number;
    kvType: string;
    engine: string;
    bandwidth?: Graded;
    maxBytes?: number;
  },
): Promise<RemoteEstimate> {
  const cap = options.maxBytes ?? REMOTE_HEADER_CAP_BYTES;
  let read = 0;
  let sizeBytes: number | undefined;
  const ranged = (async (input: string | URL | Request, init?: RequestInit) => {
    const res = await options.fetch(String(input instanceof Request ? input.url : input), init);
    if (res.status !== 206) {
      await res.body?.cancel().catch(() => undefined);
      throw new Error(
        `The host ignored the range request (it answered ${res.status}), so no estimate is made: only the header is ever read.`,
      );
    }
    const total = /\/\s*(\d+)\s*$/.exec(res.headers.get("content-range") ?? "")?.[1];
    if (total) sizeBytes = Number(total);
    if (!res.body) return res;
    const reader = res.body.getReader();
    const counted = new ReadableStream<Uint8Array>({
      async pull(ctrl) {
        const { value, done } = await reader.read();
        if (done) return ctrl.close();
        read += value.byteLength;
        if (read > cap) {
          await reader.cancel().catch(() => undefined);
          ctrl.error(
            new Error(`The header read stopped: more than ${cap} bytes, so it is not a header.`),
          );
          return;
        }
        ctrl.enqueue(value);
      },
      cancel: (reason) => reader.cancel(reason),
    });
    return new Response(counted, { status: res.status, headers: res.headers });
  }) as typeof fetch;
  const parsed = await gguf(url, { fetch: ranged, computeParametersCount: true });
  const raw = parsed.metadata as Record<string, unknown>;
  const arch =
    typeof raw["general.architecture"] === "string"
      ? String(raw["general.architecture"])
      : undefined;
  const a = (k: string) => (arch ? num(raw[`${arch}.${k}`]) : undefined);
  const heads = a("attention.head_count");
  const kvHeads = a("attention.head_count_kv") ?? heads;
  const emb = a("embedding_length");
  const layers = a("block_count");
  const headDim = emb && heads ? emb / heads : undefined;
  const keyLength = a("attention.key_length") ?? headDim;
  const valueLength = a("attention.value_length") ?? headDim;
  const shape: ModelShape | undefined =
    layers && kvHeads && keyLength && valueLength
      ? { layers, kvHeads, keyLength, valueLength }
      : undefined;
  const family = familyOfArchitecture(arch);
  const params = parsed.parameterCount > 0 ? parsed.parameterCount : undefined;
  const size = sizeBytes ?? 0;
  const metadata: ModelMetadata = {
    ...(arch ? { architecture: arch } : {}),
    ...(family ? { family } : {}),
    ...(params ? { parametersTotal: params } : {}),
    ...(params && size ? { bitsPerWeight: (size * 8) / params } : {}),
    ...(a("context_length") ? { contextLength: a("context_length") as number } : {}),
    ...(shape ? { shape } : {}),
  };
  const breakdown = memoryBreakdown(
    { sizeBytes: size, metadata },
    { contextTokens: options.contextTokens, kvType: options.kvType },
  );
  const decode = predictDecode(metadata, size, options.bandwidth, options.engine);
  return {
    source: "estimator",
    url,
    ...(sizeBytes !== undefined ? { sizeBytes } : {}),
    metadata,
    memory: {
      ...breakdown,
      // The size comes from the server's Content-Range, not this disk.
      weightsBytes: { value: size, grade: "estimated" },
      totalBytes: { value: breakdown.totalBytes.value, grade: "estimated" },
    },
    ...(decode ? { decode } : {}),
  };
}
