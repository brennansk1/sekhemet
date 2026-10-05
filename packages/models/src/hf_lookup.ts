import type { MetadataSource, ModelMetadata } from "./library_types.js";
import type { ModelSource } from "./registry.js";
import { MEASUREMENT_BASELINE, SHIPPED_MODELS } from "./shipped_models.js";

// The shipped set (rule 8a) is exported from here, so the package index is unchanged.
export * from "./shipped_models.js";

/**
 * The model sources table and the Hugging Face lookups (models rule 4,
 * MD-N12-6, MD-N13-2; security SEC-N10-3). Every request goes through the
 * `fetch` the caller passes — the one network policy's `policyFetch`, with
 * the research policy for a metadata lookup — and sends only a model's name
 * or its repository, never a path or a file name from this machine.
 */

export const HF_HUB = "https://huggingface.co";

/** One row of the model sources table: the repository and file, and what is recorded of it. */
export interface ModelSourceRow {
  repo: string;
  file: string;
  /** The file's SHA-256, when recorded: a download is verified against it. */
  sha256?: string;
  sizeBytes?: number;
}

/**
 * The official location of each registry model's weights, by registry id:
 * a Hugging Face repository and file. A row with its SHA-256 and size lets
 * a download be confirmed (source, size, hash) before any request
 * (dashboard DB-N6-16); a row without them is looked up
 * (`lookupPublishedFile`) and recorded in the registry
 * (`ModelRegistry.recordSource`), never assumed. A registry model absent
 * here, with no source recorded in the registry either, offers no download
 * (MD-N12-6).
 *
 * Derived from the shipped set and the measurement baseline
 * (`shipped_models.ts`, rule 8a), whose rows are filled only from a verified
 * lookup; a role with no verified source (Review, while unfilled) has none.
 */
export const MODEL_SOURCES: Readonly<Record<string, ModelSourceRow>> = Object.fromEntries(
  [...SHIPPED_MODELS, ...MEASUREMENT_BASELINE].flatMap((m) =>
    m.id && m.source
      ? [
          [
            m.id,
            {
              repo: m.source.repo,
              file: m.source.file,
              sha256: m.source.sha256,
              sizeBytes: m.source.sizeBytes,
            },
          ],
        ]
      : [],
  ),
);

/** A file's download URL on the hub. */
export function hubFileUrl(repo: string, file: string, hub: string = HF_HUB): string {
  return `${hub.replace(/\/$/, "")}/${repo}/resolve/main/${file.split("/").map(encodeURIComponent).join("/")}`;
}

/**
 * A registry model's source from the table alone, making no request: only
 * for a row that records its SHA-256 (what the download is verified by).
 */
export function tableSource(model: string, hub: string = HF_HUB): ModelSource | undefined {
  const row = MODEL_SOURCES[model];
  if (!row?.sha256) return undefined;
  const url = hubFileUrl(row.repo, row.file, hub);
  return {
    url,
    host: new URL(url).hostname,
    sha256: row.sha256,
    ...(row.sizeBytes !== undefined ? { sizeBytes: row.sizeBytes } : {}),
    repo: row.repo,
    file: row.file,
  };
}

/** A `fetch` for one URL: the network policy's `policyFetch`. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface HubOptions {
  fetch: FetchLike;
  /** The hub's base URL (tests point it at a local server). */
  hub?: string;
}

interface TreeEntry {
  type?: string;
  path?: string;
  size?: number;
  lfs?: { oid?: string; sha256?: string; size?: number };
}

const SHA = /^[0-9a-f]{64}$/;

/** A repository's file: its download URL, published SHA-256 and size (the model sources table). */
export async function lookupPublishedFile(
  repo: string,
  file: string,
  options: HubOptions,
): Promise<ModelSource | undefined> {
  const hub = (options.hub ?? HF_HUB).replace(/\/$/, "");
  const dir = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "";
  const res = await options.fetch(
    `${hub}/api/models/${repo}/tree/main${dir ? `/${encodeURI(dir)}` : ""}`,
  );
  if (!res.ok) return undefined;
  const entries = (await res.json()) as TreeEntry[];
  const e = Array.isArray(entries) ? entries.find((x) => x.path === file) : undefined;
  const sha = e?.lfs?.sha256 ?? e?.lfs?.oid;
  if (!e || !sha || !SHA.test(sha)) return undefined;
  const url = hubFileUrl(repo, file, hub);
  return {
    url,
    host: new URL(url).hostname,
    sha256: sha,
    sizeBytes: e.lfs?.size ?? e.size ?? 0,
    repo,
    file,
  };
}

export interface HubMatch {
  lookedUp: boolean;
  /** Why no lookup was made, in words. */
  note?: string;
  repo?: string;
  /** The found model's metadata with the hub's values filled where the header had none. */
  metadata?: ModelMetadata;
}

interface HubModel {
  id?: string;
  gguf?: { total?: number; architecture?: string; context_length?: number };
  safetensors?: { total?: number };
  cardData?: { license?: string; base_model?: string | string[] };
}

/**
 * Match a found model on the hub by its header's name (MD-N13-2) and fill
 * the specs its header lacks — total parameters, licence, base model,
 * context length — marking each filled value's source `huggingface`. Only
 * the name is sent (SEC-N10-3). When research is not allowed no request is
 * made and the result says so.
 */
export async function matchOnHub(
  found: { name?: string; metadata: ModelMetadata },
  options: HubOptions & { research: boolean },
): Promise<HubMatch> {
  if (!options.research) {
    return {
      lookedUp: false,
      note: "No lookup was made: research is off ([network] research), so only the header's metadata is shown.",
    };
  }
  if (!found.name) {
    return { lookedUp: false, note: "No lookup was made: the header names no model." };
  }
  const hub = (options.hub ?? HF_HUB).replace(/\/$/, "");
  const q = new URLSearchParams({ search: found.name, limit: "5" });
  const list = await options.fetch(`${hub}/api/models?${q}`);
  if (!list.ok) return { lookedUp: true, note: `The hub answered ${list.status}.` };
  const hits = (await list.json()) as HubModel[];
  const id = Array.isArray(hits) ? hits[0]?.id : undefined;
  if (!id) return { lookedUp: true, note: "No model on the hub matched this name." };
  const detail = await options.fetch(
    `${hub}/api/models/${id}?expand[]=gguf&expand[]=cardData&expand[]=safetensors`,
  );
  if (!detail.ok) return { lookedUp: true, repo: id, note: `The hub answered ${detail.status}.` };
  const m = (await detail.json()) as HubModel;
  const hubValues: Partial<ModelMetadata> = {};
  const total = m.gguf?.total ?? m.safetensors?.total;
  if (total) hubValues.parametersTotal = total;
  if (m.gguf?.architecture) hubValues.architecture = m.gguf.architecture;
  if (m.gguf?.context_length) hubValues.contextLength = m.gguf.context_length;
  if (m.cardData?.license) hubValues.license = m.cardData.license;
  const base = Array.isArray(m.cardData?.base_model)
    ? m.cardData?.base_model[0]
    : m.cardData?.base_model;
  if (base) hubValues.baseModel = base;
  return {
    lookedUp: true,
    repo: id,
    metadata: fillMetadata(found.metadata, hubValues, "huggingface"),
  };
}

/** Fill only the keys the header lacks, marking each filled key's source (MD-N13-2). */
export function fillMetadata(
  header: ModelMetadata,
  extra: Partial<ModelMetadata>,
  source: MetadataSource,
): ModelMetadata {
  const out: ModelMetadata = { ...header };
  const sources = { ...(header.sources ?? {}) };
  for (const [k, v] of Object.entries(extra) as [keyof ModelMetadata, unknown][]) {
    if (k === "sources" || k === "shape" || v === undefined) continue;
    if (out[k] !== undefined) continue;
    (out as Record<string, unknown>)[k] = v;
    sources[k] = source;
  }
  if (Object.keys(sources).length > 0) out.sources = sources;
  return out;
}
