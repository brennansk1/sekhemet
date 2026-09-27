import { resolve } from "node:path";
import type { EventLog } from "@sekhemet/kernel";
import {
  DownloadHashMismatch,
  MODEL_SOURCES,
  ModelRegistry,
  type ModelSource,
  downloadModel,
  lookupPublishedFile,
  registerModelFile,
  resolveWorkerModelId,
  tableSource,
  volumeOf,
} from "@sekhemet/models";
import { mergeNetworkConfigs, policyFetch, policyRefusal } from "@sekhemet/sandbox";
import { resolveConfig, userConfigPath } from "./config.js";
import { networkConfigs } from "./config_apply.js";
import { egressEvent } from "./egress_event.js";
import { networkHint } from "./github_transport.js";

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

/**
 * `sekhemet models add <path> [--id <id>]` (MD-N12-9, live-test F1/F7): register
 * a GGUF a person already has. Its header is read — the model is never
 * loaded — and its weights, SHA-256, size and header are recorded under the
 * id (default: a slug of the header's name). A managed name's id (the
 * Planner's `qwen3.8-27b`, say) makes that file the managed model's weights
 * (MD-N14-41a); any other id runs under a managed llama-server with the
 * generic profile (MD-N12-10) and is qualified under that id.
 */
export async function modelsAdd(
  path: string,
  opts: { id?: string; registry?: ModelRegistry; print?: (line: string) => void },
): Promise<number> {
  const print = opts.print ?? ((l: string) => console.log(l));
  const registry = opts.registry ?? new ModelRegistry();
  try {
    // A managed name (`cyber-tiel`, `dirk`) is the registry id its server runs as.
    const id = opts.id ? resolveWorkerModelId(opts.id) : undefined;
    const r = await registerModelFile(registry, resolve(path), id ? { id } : {});
    const ctx = r.header.contextLength ? `, trained context ${r.header.contextLength}` : "";
    print(
      `Registered ${r.id}: ${r.path} (${(r.sizeBytes / 1e9).toFixed(1)} GB, sha256 ${r.sha256.slice(0, 12)}…${ctx}).`,
    );
    print(`Qualify it before it runs as the Worker: sekhemet qualify --models ${r.id}`);
    return 0;
  } catch (err) {
    print(`Not registered: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
