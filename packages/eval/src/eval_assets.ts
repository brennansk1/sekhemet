import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { ModelRegistry } from "@sekhemet/models";

/**
 * Evaluation assets (measurement.md rule 29, T11): labelled data some
 * criteria are scored against. Each is versioned, hashed and listed in one
 * manifest, `fixtures/eval_assets.json`; a result records the hash it was
 * scored on and compares only with results on the same hash; an item is
 * never edited to improve a result — a change is a new version. Labels are a
 * person's, an executed check's or a public dataset's publisher's, never a
 * model's. An asset not registered is never scored against.
 */

export interface AssetVersion {
  version: string;
  hash: string;
  items: number;
}

export interface AssetEntry {
  name: string;
  version: string;
  /** `hashAssetDir` of the asset's directory. */
  hash: string;
  items: number;
  /** The principal who labelled it: a person, "frozen tests", or a dataset's publisher. */
  labelledBy: string;
  /** Who or what made the items, when not the labeller (an agent's work verified by tests). */
  provenance?: string;
  /** The criteria scored against it. */
  usedBy: string[];
  /** What is held out, and from which role. */
  heldOut?: string;
  /** The workstream that builds it (rule 29's "Built in" column). */
  builtIn?: string;
  /** Repository-relative directory holding `items.json` and the items. */
  path: string;
  /** Earlier versions, oldest first, so results on them stay identifiable (MS-T11-5). */
  versions: AssetVersion[];
}

export interface AssetManifest {
  about: string;
  assets: AssetEntry[];
}

/** Rule 29's table: each asset's minimum size and the workstream that builds it. */
export const EVAL_ASSET_PLAN: readonly {
  name: string;
  minItems: number;
  builtIn: string;
  usedBy: string[];
}[] = [
  {
    name: "reference-solutions",
    minItems: 30,
    builtIn: "B2.4",
    usedBy: ["MS-T7-2", "MS-T7-3", "CX-P1-5"],
  },
  { name: "golden-briefs", minItems: 10, builtIn: "B2.4", usedBy: ["MS-T7-7", "P14"] },
  // One per golden brief and fixture specification: 10 briefs and 4 fixtures.
  { name: "held-out-acceptance-suite", minItems: 14, builtIn: "B2.4", usedBy: ["MS-T7-8"] },
  { name: "injection-fixtures", minItems: 1, builtIn: "B1", usedBy: ["NEW-security-4"] },
  { name: "labelled-ui-screens", minItems: 60, builtIn: "B2.3", usedBy: ["GT-N4-2"] },
  {
    name: "research-golden-set",
    minItems: 25,
    builtIn: "B4.4",
    usedBy: ["NEW-design-stage-2", "NEW-models-11"],
  },
  { name: "project-starts", minItems: 5, builtIn: "B4.4", usedBy: ["P2"] },
  { name: "labelled-reuse-set", minItems: 40, builtIn: "B4.5", usedBy: ["P7"] },
  { name: "reviewer-seeded-defects", minItems: 20, builtIn: "B4.8", usedBy: ["P8"] },
  { name: "pm-conversations", minItems: 20, builtIn: "B4.8", usedBy: ["P6"] },
];

const REQUIRED: (keyof AssetEntry)[] = [
  "name",
  "version",
  "hash",
  "items",
  "labelledBy",
  "usedBy",
  "path",
];

/** What an entry lacks (MS-T11-1); empty when complete. */
export function validateAssetEntry(entry: AssetEntry): string[] {
  const name = entry.name || "(unnamed asset)";
  return REQUIRED.filter((k) => {
    const v = entry[k];
    return (
      v === undefined ||
      v === null ||
      v === "" ||
      (Array.isArray(v) && v.length === 0) ||
      (k === "items" && typeof v !== "number")
    );
  }).map((k) => `${name}: missing ${k}`);
}

/** Every file under a directory, by relative path and content, order-stable. */
export function hashAssetDir(dir: string): string {
  const h = createHash("sha256");
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else
        h.update(relative(dir, p).replaceAll("\\", "/"))
          .update("\u0000")
          .update(readFileSync(p))
          .update("\u0000");
    }
  };
  walk(dir);
  return h.digest("hex");
}

const manifestPath = (root: string) => join(root, "fixtures", "eval_assets.json");

/** The manifest; refused when any entry is incomplete (MS-T11-1). */
export function loadAssetManifest(root: string): AssetManifest {
  const path = manifestPath(root);
  if (!existsSync(path)) return { about: "", assets: [] };
  const manifest = JSON.parse(readFileSync(path, "utf8")) as AssetManifest;
  const problems = (manifest.assets ?? []).flatMap(validateAssetEntry);
  if (problems.length) throw new Error(`fixtures/eval_assets.json: ${problems.join("; ")}`);
  return { about: manifest.about ?? "", assets: manifest.assets ?? [] };
}

/** The items an asset's `items.json` lists. */
function itemCount(dir: string): number {
  const file = join(dir, "items.json");
  if (!existsSync(file)) return 0;
  const list = JSON.parse(readFileSync(file, "utf8")) as unknown;
  return Array.isArray(list) ? list.length : 0;
}

/**
 * Check an asset before scoring against it (MS-T11-2, MS-T11-7): it must be
 * registered, its hash must match the manifest and it must hold the items
 * the manifest declares. Returns the hash the result records.
 */
export function verifyAsset(
  root: string,
  name: string,
): { hash: string; items: number; version: string } {
  const entry = loadAssetManifest(root).assets.find((a) => a.name === name);
  if (!entry) {
    const plan = EVAL_ASSET_PLAN.find((p) => p.name === name);
    throw new Error(
      `${name} is not registered in fixtures/eval_assets.json; nothing is scored against it${plan ? ` (it is built in ${plan.builtIn})` : ""}`,
    );
  }
  const dir = join(root, entry.path);
  if (!existsSync(dir)) throw new Error(`${name}: its directory ${entry.path} is missing`);
  const hash = hashAssetDir(dir);
  if (hash !== entry.hash) {
    throw new Error(
      `${name}: its content hash ${hash.slice(0, 12)} does not match the manifest's ${entry.hash.slice(0, 12)}; an asset changes only by a new version`,
    );
  }
  const items = itemCount(dir);
  if (items < entry.items) {
    throw new Error(
      `${name} holds ${items} items, the manifest declares ${entry.items}; it is not scored on a partial set`,
    );
  }
  return { hash, items, version: entry.version };
}

/** Two results compare only when scored on the same asset hash (MS-T11-2). */
export function comparableResults(a: { assetHash: string }, b: { assetHash: string }): boolean {
  return a.assetHash === b.assetHash;
}

export interface AssetLabel {
  principal: string;
  kind: "person" | "executed" | "publisher" | "model";
  /** For an executed label (a reference solution): it passed its card's frozen tests. */
  passedFrozenTests?: boolean;
}

/**
 * Labels as rule 29 allows them (MS-T11-4): every item names who labelled
 * it; a model alone never counts; an executed label counts only when the
 * item passed its card's frozen tests.
 */
export function validateAssetLabels(
  items: readonly { id: string; labelledBy?: AssetLabel }[],
  modelIds: readonly string[] = [],
): string[] {
  return items.flatMap((item) => {
    const l = item.labelledBy;
    if (!l?.principal) return [`${item.id}: no labelling principal`];
    if (l.kind === "model") return [`${item.id}: labelled only by a model (${l.principal})`];
    if ((l.kind === "person" || l.kind === "publisher") && namesAModel(l.principal, modelIds))
      return [
        `${item.id}: its label names a model (${l.principal}); labels are a person's or executed`,
      ];
    if (l.kind === "executed" && l.passedFrozenTests !== true)
      return [`${item.id}: an executed label must pass its card's frozen tests`];
    return [];
  });
}

/** A new version of an asset (MS-T11-5): the earlier version's hash is kept. */
export function recordAssetVersion(
  manifest: AssetManifest,
  name: string,
  next: { hash: string; items: number },
): AssetManifest {
  return {
    ...manifest,
    assets: manifest.assets.map((a) =>
      a.name !== name
        ? a
        : {
            ...a,
            version: String(Number(a.version) + 1),
            hash: next.hash,
            items: next.items,
            versions: [...a.versions, { version: a.version, hash: a.hash, items: a.items }],
          },
    ),
  };
}

/**
 * Register an asset, or its new version, in `fixtures/eval_assets.json`
 * (rule 29, MS-T11-1, MS-T11-5): the hash and item count are computed from
 * its directory, the criteria and workstream come from rule 29's plan, the
 * entry is validated, and a changed asset becomes a new version keeping the
 * earlier hash. The manifest's other keys are kept. A label from a model is
 * refused (MS-T11-4).
 */
/** The labelling principals rule 29 allows at the entry level (review M6). */
const LABEL_PRINCIPAL = /^(frozen tests\b|person: \S|the owner\b|publisher: \S)/i;

/**
 * Names that are models, not people or publishers (confirmation check, M6):
 * the families a label is most likely to borrow, and the harness's own
 * roster. A label is a declaration the tool cannot verify beyond this — it
 * is the owner's word, a trust boundary (measurement rule 29).
 */
const MODEL_NAME =
  /^(claude|gpt|o[1-9]\b|gemini|gemma|qwen|llama|mistral|mixtral|codestral|phi-?\d|deepseek|grok|starcoder|command-r|cyber-tiel|apodex|dirk)/i;

/** A principal (after any "person:" or "publisher:") that names a model. */
export function namesAModel(principal: string, modelIds: readonly string[] = []): boolean {
  const name = principal.replace(/^(person|publisher):\s*/i, "").trim();
  const bare = name.replace(/^ollama\//i, "");
  return MODEL_NAME.test(bare) || modelIds.some((id) => id.toLowerCase() === bare.toLowerCase());
}

/** The model ids this machine's registry knows, when it can be read. */
function registryModelIds(): string[] {
  try {
    return new ModelRegistry().list().map((e) => e.id);
  } catch {
    return [];
  }
}

export function registerAsset(
  root: string,
  spec: {
    name: string;
    path: string;
    labelledBy: string;
    provenance?: string;
    heldOut?: string;
  },
  opts: { modelIds?: readonly string[] } = {},
): { entry: AssetEntry; changed: "registered" | "new version" | "unchanged" } {
  const modelIds = opts.modelIds ?? registryModelIds();
  const plan = EVAL_ASSET_PLAN.find((p) => p.name === spec.name);
  if (!plan) throw new Error(`${spec.name} is not in rule 29's plan of evaluation assets`);
  // Review M6: only a principal form rule 29 allows — a person, execution
  // against frozen tests, or a dataset's publisher — never a model's name.
  if (
    spec.labelledBy.trim() &&
    (!LABEL_PRINCIPAL.test(spec.labelledBy.trim()) || namesAModel(spec.labelledBy, modelIds))
  )
    throw new Error(
      namesAModel(spec.labelledBy, modelIds)
        ? `${spec.name}: labelledBy names a model (${spec.labelledBy}); labels are a person's or executed, never a model's`
        : `${spec.name}: labels are a person's or executed, never a model's: labelledBy must be "frozen tests …", "person: <name>", "the owner" or "publisher: <name>", not ${JSON.stringify(spec.labelledBy)}`,
    );
  const dir = join(root, spec.path);
  // Every item names its labelling principal, and none is a model's alone (MS-T11-4).
  const listed = JSON.parse(readFileSync(join(dir, "items.json"), "utf8")) as {
    id: string;
    labelledBy?: AssetLabel;
  }[];
  const labels = validateAssetLabels(listed, modelIds);
  if (labels.length) throw new Error(`${spec.name}: ${labels.join("; ")}`);
  const hash = hashAssetDir(dir);
  const items = itemCount(dir);
  const file = manifestPath(root);
  const raw = existsSync(file)
    ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>)
    : { about: "" };
  let manifest = loadAssetManifest(root);
  const existing = manifest.assets.find((a) => a.name === spec.name);
  let changed: "registered" | "new version" | "unchanged";
  if (!existing) {
    const entry: AssetEntry = {
      name: spec.name,
      version: "1",
      hash,
      items,
      labelledBy: spec.labelledBy,
      ...(spec.provenance ? { provenance: spec.provenance } : {}),
      usedBy: [...plan.usedBy],
      ...(spec.heldOut ? { heldOut: spec.heldOut } : {}),
      builtIn: plan.builtIn,
      path: spec.path,
      versions: [],
    };
    const problems = validateAssetEntry(entry);
    if (problems.length) throw new Error(problems.join("; "));
    manifest = { ...manifest, assets: [...manifest.assets, entry] };
    changed = "registered";
  } else if (existing.hash !== hash || existing.items !== items) {
    manifest = recordAssetVersion(manifest, spec.name, { hash, items });
    changed = "new version";
  } else {
    changed = "unchanged";
  }
  if (changed !== "unchanged") {
    writeFileSync(file, `${JSON.stringify({ ...raw, ...manifest }, null, 2)}\n`);
  }
  const entry = manifest.assets.find((a) => a.name === spec.name) as AssetEntry;
  return { entry, changed };
}

/**
 * Each planned asset of a workstream against rule 29's size (MS-T11-6): the
 * workstream does not close while any is missing or short.
 */
export function assetSizeReport(
  manifest: AssetManifest,
  workstream: string,
): { name: string; required: number; registered: number; status: "missing" | "short" | "ok" }[] {
  return EVAL_ASSET_PLAN.filter((p) => p.builtIn === workstream).map((p) => {
    const e = manifest.assets.find((a) => a.name === p.name);
    const registered = e?.items ?? 0;
    return {
      name: p.name,
      required: p.minItems,
      registered,
      status: !e ? "missing" : registered < p.minItems ? "short" : "ok",
    };
  });
}
