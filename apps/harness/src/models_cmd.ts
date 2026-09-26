import type { EventLog } from "@sekhemet/kernel";
import {
  DownloadHashMismatch,
  MODEL_SOURCES,
  ModelRegistry,
  type ModelSource,
  downloadModel,
  lookupPublishedFile,
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
