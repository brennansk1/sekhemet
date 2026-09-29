import { resolve } from "node:path";
import type { EventLog } from "@sekhemet/kernel";
import {
  DownloadHashMismatch,
  FAMILY_SAMPLING,
  MODEL_SOURCES,
  ModelRegistry,
  type ModelSource,
  downloadModel,
  lookupPublishedFile,
  registerModelFile,
  resolveWorkerModelId,
  samplingSettingsOf,
  tableSource,
  volumeOf,
} from "@sekhemet/models";
import { mergeNetworkConfigs, policyFetch, policyRefusal } from "@sekhemet/sandbox";
import { resolveConfig, userConfigPath } from "./config.js";
import { networkConfigs } from "./config_apply.js";
import { egressEvent } from "./egress_event.js";
import { networkHint } from "./github_transport.js";
import { describeModel } from "./model_access.js";

/**
 * `sekhemet models fetch <model> [--folder <path>]` (models rule 4, NEW-models-7,
 * MD-N12-6): the terminal form of the Configuration page's **Download…**, and
 * the same implementation (`downloadModel`): only from the model's registered
 * source, through the network policy (refused in `offline` with the setting
 * named), into a model folder the person named, verified by the published
 * SHA-256 before the file is used, and recorded as `model/downloaded` with
 * the person's principal. Running the command is the person's explicit ask.
 */
export async function modelsFetch(
  model: string,
  opts: {
    repoPath: string;
    log: EventLog;
    principal: string;
    folder?: string;
    registry?: ModelRegistry;
    userConfigPath?: string;
    hub?: string;
    env?: NodeJS.ProcessEnv;
    print?: (line: string) => void;
  },
): Promise<number> {
  const print = opts.print ?? ((l: string) => console.log(l));
  const registry = opts.registry ?? new ModelRegistry();
  const cfgPath = opts.userConfigPath ?? userConfigPath();
  const n = networkConfigs(opts.repoPath, cfgPath);
  const policy = mergeNetworkConfigs(n.user, n.project);
  const record = (r: Parameters<typeof egressEvent>[0]) =>
    opts.log.append({ actor: "harness", ...egressEvent(r) });
  // A managed name (`cyber-tiel`) is the registry id its server runs as.
  const id = MODEL_SOURCES[model] ? model : resolveWorkerModelId(model);
  let source: ModelSource | undefined = registry.get(model)?.source ?? registry.get(id)?.source;
  if (!source) source = tableSource(id, opts.hub);
  if (source && !registry.get(model)?.source) registry.recordSource(model, source);
  const table = MODEL_SOURCES[id];
  if (!source && table) {
    source = await lookupPublishedFile(table.repo, table.file, {
      fetch: policyFetch(policy, { purpose: "model lookup", research: true, record }),
      ...(opts.hub ? { hub: opts.hub } : {}),
    }).catch(() => undefined);
    if (source) registry.recordSource(model, source);
  }
  const env = opts.env ?? process.env;
  const folder =
    opts.folder ??
    resolveConfig({ repoPath: opts.repoPath, userConfigPath: cfgPath }).config.models.folders[0]
      ?.path ??
    env.SEKHEMET_MODELS_DIR?.trim();
  if (!folder) {
    print("Name a model folder first: --folder <path>, or add one on the Configuration page.");
    return 2;
  }
  try {
    const done = await downloadModel({
      model,
      source,
      destDir: folder,
      fetch: policyFetch(policy, { purpose: "model download", record, stream: true }),
      refusal: (host) => {
        const reason = policyRefusal(policy, host);
        return reason ? `${networkHint(reason, host)} ([network] mode)` : undefined;
      },
      onProgress: (p) => {
        if (p.state === "verifying") print("Verifying…");
      },
    });
    await opts.log.append({
      actor: "human",
      type: "model/downloaded",
      principal: opts.principal,
      payload: {
        model,
        source: (source as ModelSource).host,
        sha256: done.sha256,
        bytes: done.bytes,
        principal: opts.principal,
        verified: true,
      },
    });
    registry.recordWeights(model, {
      path: done.path,
      volume: volumeOf(done.path),
      sha256: done.sha256,
    });
    print(`Verified. ${model} is ready to assign: ${done.path}`);
    return 0;
  } catch (err) {
    if (err instanceof DownloadHashMismatch && source) {
      await opts.log.append({
        actor: "human",
        type: "model/downloaded",
        principal: opts.principal,
        payload: {
          model,
          source: source.host,
          sha256: source.sha256,
          bytes: 0,
          principal: opts.principal,
          verified: false,
        },
      });
    }
    print(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

/** A model card's sampling, as `sekhemet models add --sampling` records it (live-test F16). */
export type CardSampling = { temperature?: number; topP?: number; topK?: number; minP?: number };

const SAMPLING_KEYS: Record<string, { key: keyof CardSampling; ok: (n: number) => boolean }> = {
  temperature: { key: "temperature", ok: (n) => n >= 0 && n <= 2 },
  top_p: { key: "topP", ok: (n) => n > 0 && n <= 1 },
  top_k: { key: "topK", ok: (n) => Number.isInteger(n) && n >= 0 },
  min_p: { key: "minP", ok: (n) => n >= 0 && n <= 1 },
};

/**
 * `temperature=0.6,top_p=0.95,top_k=20,min_p=0` as a sampling record; a
 * string naming why when a key is unknown or a value out of range.
 */
export function parseSamplingFlag(text: string): CardSampling | string {
  const out: CardSampling = {};
  const parts = text.split(",").filter((p) => p.trim() !== "");
  if (parts.length === 0) return "--sampling names no values";
  for (const part of parts) {
    const [k = "", v = ""] = part.split("=").map((x) => x.trim());
    const spec = SAMPLING_KEYS[k];
    if (!spec) return `--sampling: unknown key "${k}" (temperature, top_p, top_k, min_p)`;
    const n = v === "" ? Number.NaN : Number(v);
    if (!Number.isFinite(n) || !spec.ok(n)) return `--sampling: ${k}=${v} is not a valid value`;
    out[spec.key] = n;
  }
  return out;
}

const describeSampling = (s: CardSampling | undefined): string =>
  s
    ? `temperature ${s.temperature ?? "default"}, top_p ${s.topP ?? "default"}, top_k ${s.topK ?? "default"}, min_p ${s.minP ?? "default"}`
    : "the engine's default sampling";

/**
 * `sekhemet models add <path> [--id <id>] [--sampling temperature=,top_p=,top_k=,min_p=]`
 * (MD-N12-9, live-test F1/F7/F16): register a GGUF a person already has.
 * Its header is read — the model is never loaded — and its weights, SHA-256,
 * size and header are recorded under the id (default: a slug of the header's
 * name). A managed name's id (the Planner's `qwen3.8-27b`, say) makes that
 * file the managed model's weights (MD-N14-41a); any other id runs under a
 * managed llama-server with the generic profile (MD-N12-10) and is qualified
 * under that id. `--sampling` records the model card's sampling in the
 * registry, which every launch of the id then uses (MD-N4-2); the output
 * always states the sampling the model will run at and where it came from.
 */
export async function modelsAdd(
  path: string,
  opts: {
    id?: string;
    sampling?: string;
    registry?: ModelRegistry;
    print?: (line: string) => void;
  },
): Promise<number> {
  const print = opts.print ?? ((l: string) => console.log(l));
  const registry = opts.registry ?? new ModelRegistry();
  const given = opts.sampling !== undefined ? parseSamplingFlag(opts.sampling) : undefined;
  if (typeof given === "string") {
    print(`Not registered: ${given}.`);
    return 1;
  }
  try {
    // A managed name (`cyber-tiel`, `dirk`) is the registry id its server runs as.
    const id = opts.id ? resolveWorkerModelId(opts.id) : undefined;
    const r = await registerModelFile(registry, resolve(path), id ? { id } : {});
    if (given) registry.upsert(r.id, { sampling: given });
    const ctx = r.header.contextLength ? `, trained context ${r.header.contextLength}` : "";
    print(
      `Registered ${r.id}: ${r.path} (${(r.sizeBytes / 1e9).toFixed(1)} GB, sha256 ${r.sha256.slice(0, 12)}…${ctx}).`,
    );
    // F16: the sampling it will run at, from the adapter a role would launch.
    const runs = samplingSettingsOf(describeModel(opts.id ?? r.id, "worker", { registry }));
    const entry = registry.get(r.id);
    const family = entry?.family;
    const familyDefaults = family ? FAMILY_SAMPLING[family] : undefined;
    const same = (a: CardSampling | undefined, b: CardSampling | undefined) =>
      JSON.stringify(a ?? {}) ===
      JSON.stringify({
        ...(b?.temperature !== undefined ? { temperature: b.temperature } : {}),
        ...(b?.topP !== undefined ? { topP: b.topP } : {}),
        ...(b?.topK !== undefined ? { topK: b.topK } : {}),
        ...(b?.minP !== undefined ? { minP: b.minP } : {}),
      });
    const source = given
      ? "the values given with --sampling"
      : entry?.sampling
        ? "the model card's values recorded in the registry"
        : familyDefaults && same(runs, familyDefaults)
          ? `the ${family} family's defaults, not this model's card`
          : "its launch profile's defaults, not this model's card";
    print(`${r.id} runs at ${describeSampling(runs)} (${source}).`);
    // F25: a template that cannot turn reasoning off, known from the header.
    if (entry?.reasoning?.cannotDisable)
      print(
        `${r.id} cannot turn its reasoning off (architecture ${r.header.architecture ?? "unknown"}): a request for none thinks at ${entry.reasoning.floor ?? "low"}, and its thinking is budgeted.`,
      );
    if (!given && !entry?.sampling)
      print(
        `Record its model card's sampling with: sekhemet models add ${r.path} --id ${r.id} --sampling temperature=,top_p=,top_k=,min_p=`,
      );
    print(
      `Verify it on this machine before it runs as the Coding model: sekhemet qualify --models ${r.id}`,
    );
    return 0;
  } catch (err) {
    print(`Not registered: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
