import { statSync } from "node:fs";
import { basename } from "node:path";
import { readGgufHeader, sha256File } from "./model_scan.js";
import { type ModelEntry, type ModelRegistry, reasoningFromArchitecture } from "./registry.js";
import { volumeOf } from "./swap_cost.js";

/**
 * Plug-and-play GGUF weights (live-test F1/F7; MD-N12-9, MD-N12-10): any
 * GGUF a person registers runs as a role under a harness-managed
 * llama-server, not only the shipped managed defaults. The launch profile
 * is `createGenericManaged` beside the other managed profiles.
 */

/** The recorded GGUF this id should load, when the registry holds one that `usable` accepts. */
export function recordedGguf(
  registry: ModelRegistry | undefined,
  id: string,
  usable?: (path: string) => boolean,
): string | undefined {
  const path = registry?.preferredWeights(id, usable);
  return path && /\.gguf$/i.test(path) ? path : undefined;
}

/** A registry id from a name: lower case, runs of other characters as one hyphen. */
export function slugModelId(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export interface RegisteredModel {
  id: string;
  path: string;
  sha256: string;
  sizeBytes: number;
  header: NonNullable<ModelEntry["header"]>;
}

/**
 * Register a GGUF file as a model's weights (MD-N12-9; `sekhemet models add`
 * and the Configuration page's assignment): its header is read (never the
 * model loaded), its SHA-256 computed, and the weights, hash, size, family,
 * quantisation and header recorded under `id` (default: a slug of the
 * header's name, else the file name). A file whose hash differs from the
 * id's recorded weights is refused and the registry left unchanged. An
 * architecture whose template cannot turn reasoning off records that and
 * its lowest level (live-test F25), under any reasoning entry already there:
 * an owner's `supported: false` or floor is kept.
 */
export async function registerModelFile(
  registry: ModelRegistry,
  path: string,
  opts: {
    id?: string;
    /** Already computed (the page's background hash). */
    sha256?: string;
    volume?: (path: string) => "internal" | "external";
  } = {},
): Promise<RegisteredModel> {
  const read = await readGgufHeader(path);
  const id = opts.id ?? slugModelId(read.name ?? basename(path).replace(/\.gguf$/i, ""));
  if (!id) throw new Error(`${path}: no model id could be made from its name; pass --id`);
  const sha256 = opts.sha256 ?? (await sha256File(path));
  const sizeBytes = statSync(path).size;
  const mtpHead = Object.entries(read.raw).some(
    ([k, v]) => k.endsWith(".nextn_predict_layers") && typeof v === "number" && v > 0,
  );
  const header: NonNullable<ModelEntry["header"]> = {
    ...(read.metadata.architecture ? { architecture: read.metadata.architecture } : {}),
    ...(read.metadata.contextLength ? { contextLength: read.metadata.contextLength } : {}),
    ...(mtpHead ? { mtpHead } : {}),
  };
  // First the weights: a hash that differs throws before anything is written.
  registry.recordWeights(id, {
    path,
    volume: (opts.volume ?? ((p: string) => volumeOf(p)))(path),
    sha256,
  });
  const entry = registry.get(id);
  // F25: a template that cannot turn reasoning off is known from its architecture.
  const implied = reasoningFromArchitecture(header.architecture);
  registry.upsert(id, {
    sizeBytes,
    header,
    // An entry of the owner's own (`supported: false`, a floor) is kept over it.
    ...(implied && entry?.reasoning?.supported !== false
      ? { reasoning: { ...implied, ...entry?.reasoning } }
      : {}),
    ...(!entry?.family && read.metadata.family ? { family: read.metadata.family } : {}),
    ...(!entry?.quant && read.metadata.quantisation ? { quant: read.metadata.quantisation } : {}),
  });
  return { id, path, sha256, sizeBytes, header };
}
