import { join, resolve } from "node:path";
import {
  type ManagedLlamaServerAdapter,
  SHIPPED_MODELS,
  type ShippedModel,
  type ShippedRole,
  formatBytes,
  shippedAdapter,
} from "@sekhemet/models";

/**
 * The Team server's engines, one per filled role (models rule 26a,
 * NEW-models-15; FINDINGS INS-01; DESIGN_GAPS_C1 b1). The compose file
 * (`packaging/server/compose.yaml`) defines one llama.cpp service per filled
 * shipped role's weights, each started with exactly the shipped profile's
 * `launchArgs()` as computed here (a static test holds the two equal,
 * MD-N15-2); at start `checkTeamEngines` reads each engine's `/health` and
 * `/props` — never a load, an unload or a completion — and names a role
 * with no engine, a refused engine, or footprints that exceed the measured
 * headroom (MD-N15-3, MD-N15-5).
 */

/** Where the models folder is mounted in every Team container. */
export const TEAM_MODELS_DIR = "/models";

/**
 * Where the engines save their slots, a volume shared with the harness
 * (`SEKHEMET_SLOT_CACHE`), which sweeps erased slots (MD-N14-37).
 */
export const TEAM_SLOTS_DIR = "/slots";

/**
 * The host the compose file's host-sized values are computed for (the
 * prompt-cache flags and the Research window): 64 GB, the top of the L
 * tier, since one service per role keeps every filled role resident.
 */
export const TEAM_HOST_BYTES = 64 * 1024 ** 3;

/**
 * llama.cpp's server images, pinned by digest (MD-N15-4): build b10818, the
 * first published container build at or above the shipped set's floor
 * (b10809, which has no image). CUDA is the compose file's default; INSTALL
 * names the others.
 */
export const LLAMA_CPP_TEAM_IMAGES = {
  cuda: "ghcr.io/ggml-org/llama.cpp:server-cuda-b10818@sha256:e61f29b37c471f956a772f91f4e9952d29f237e5d1a1a748e14421aae090305f",
  vulkan:
    "ghcr.io/ggml-org/llama.cpp:server-vulkan-b10818@sha256:d14e49d20a4baf070cedcafbf32388ab1ff809f52fb7ec950371fba01a13c0bd",
  cpu: "ghcr.io/ggml-org/llama.cpp:server-b10818@sha256:1394ab6c8e418859b282ff5a38a218ab318b2b4de8848c611b92e92017d6d8e4",
} as const;

/** One engine service: the roles it serves, its weights and its launch. */
export interface TeamEngine {
  service: string;
  roles: ShippedRole[];
  model: ShippedModel;
  port: number;
  args: string[];
  adapter: ManagedLlamaServerAdapter;
}

const ROLE_WORD: Readonly<Record<ShippedRole, string>> = {
  coding: "Coding",
  planning: "Planning",
  research: "Research",
  review: "Review",
};

/**
 * The engine services for the filled shipped roles, one per weights (roles
 * served by the same weights share one, MD-N9-1), each with its profile's
 * launch at `<modelsDir>/<file>`.
 */
export function teamEngines(opts: { modelsDir?: string; totalBytes?: number } = {}): TeamEngine[] {
  const dir = opts.modelsDir ?? TEAM_MODELS_DIR;
  const out: TeamEngine[] = [];
  for (const m of SHIPPED_MODELS) {
    if (!m.id || !m.source) continue;
    const same = out.find((e) => e.model.id === m.id);
    if (same) {
      same.roles.push(m.role);
      continue;
    }
    const adapter = shippedAdapter(m, {
      modelPath: join(dir, m.source.file),
      totalBytes: opts.totalBytes ?? TEAM_HOST_BYTES,
      slotCacheDir: TEAM_SLOTS_DIR,
    });
    out.push({
      service: `engine-${m.role}`,
      roles: [m.role],
      model: m,
      port: adapter.launchProfile.port ?? 8098,
      args: adapter.launchArgs(),
      adapter,
    });
  }
  return out;
}

export interface TeamEngineState {
  service: string;
  roles: ShippedRole[];
  modelId: string;
  port: number;
  state: "ok" | "no-engine" | "refused";
  reason?: string;
  footprintBytes?: number;
}

export interface TeamEnginesReport {
  engines: TeamEngineState[];
  unfilled: { role: ShippedRole; reason: string }[];
  footprint: { totalBytes: number; headroomBytes?: number; fits?: boolean };
  /** The words `doctor` and Configuration › Models show. */
  lines: string[];
}

/** Why the engine on this port is not the profile's (MD-M4-1), or undefined when it is. */
async function identityRefusal(e: TeamEngine): Promise<string | undefined> {
  const props = await e.adapter.serverProps();
  const want = e.adapter.launchProfile.modelPath;
  if (props?.modelPath === undefined)
    return `the engine on port ${e.port} does not report its model (/props)`;
  if (resolve(props.modelPath) !== resolve(want))
    return `port ${e.port} is serving ${props.modelPath}, not ${want}`;
  const total = e.adapter.totalContextTokens();
  const perSlot = total / e.adapter.slotCount();
  if (
    props.contextTokens !== undefined &&
    props.contextTokens !== total &&
    props.contextTokens !== perSlot
  )
    return `port ${e.port} is serving context ${props.contextTokens}, not ${total}`;
  if (props.mtp !== undefined && props.mtp !== e.adapter.mtpEnabled())
    return `port ${e.port} is serving with MTP ${props.mtp ? "on" : "off"}, but the profile has it ${e.adapter.mtpEnabled() ? "on" : "off"}`;
  return undefined;
}

async function answers(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(3000),
    });
    await res.body?.cancel();
    return res.ok;
  } catch {
    return false;
  }
}

const roleWords = (roles: readonly ShippedRole[]) => roles.map((r) => ROLE_WORD[r]).join(" and ");

/**
 * Check the Team server's engine services at start (MD-N15-3, MD-N15-5):
 * each answers and matches its profile, and their summed footprint fits the
 * measured headroom (rule 20g). Only `/health` and `/props` are read: an
 * engine is adopted as it is, never loaded, unloaded or asked for a reply.
 */
export async function checkTeamEngines(
  opts: { engines?: TeamEngine[]; headroomBytes?: number } = {},
): Promise<TeamEnginesReport> {
  const engines = opts.engines ?? teamEngines();
  const states: TeamEngineState[] = [];
  for (const e of engines) {
    const base = {
      service: e.service,
      roles: e.roles,
      modelId: e.model.id as string,
      port: e.port,
    };
    const footprint = await e.adapter.footprintBytes();
    const withFootprint = footprint !== undefined ? { footprintBytes: footprint } : {};
    if (!(await answers(e.port))) {
      states.push({
        ...base,
        ...withFootprint,
        state: "no-engine",
        reason: `no engine answers on port ${e.port}`,
      });
      continue;
    }
    const refused = await identityRefusal(e);
    states.push(
      refused
        ? { ...base, ...withFootprint, state: "refused", reason: refused }
        : { ...base, ...withFootprint, state: "ok" },
    );
  }
  const unfilled = SHIPPED_MODELS.filter((m) => !m.id).map((m) => ({
    role: m.role,
    reason: m.note,
  }));
  const totalBytes = states.reduce((n, s) => n + (s.footprintBytes ?? 0), 0);
  const fits = opts.headroomBytes === undefined ? undefined : totalBytes <= opts.headroomBytes;
  const lines: string[] = [];
  for (const s of states) {
    const who = `${roleWords(s.roles)} (${s.service}, ${s.modelId})`;
    if (s.state === "ok") lines.push(`${who}: answering on port ${s.port}, matches its profile.`);
    else if (s.state === "no-engine") lines.push(`${who}: ${s.reason}.`);
    else lines.push(`${who}: refused — ${s.reason}; start it with its profile's arguments.`);
  }
  for (const u of unfilled) lines.push(`${ROLE_WORD[u.role]}: unfilled — ${u.reason}`);
  const each = states.map((s) => `${s.service} ${formatBytes(s.footprintBytes ?? 0)}`).join(", ");
  if (fits === undefined)
    lines.push(
      `Engines' footprint ${formatBytes(totalBytes)} (${each}); the headroom was not measured on this host, so whether they fit together is not known.`,
    );
  else if (!fits)
    lines.push(
      `Engines' footprint ${formatBytes(totalBytes)} exceeds the measured headroom of ${formatBytes(opts.headroomBytes as number)}: ${each}. Every service keeps its role resident, so this host needs more memory or fewer services.`,
    );
  else
    lines.push(
      `Engines' footprint ${formatBytes(totalBytes)} fits the measured headroom of ${formatBytes(opts.headroomBytes as number)} (${each}).`,
    );
  return {
    engines: states,
    unfilled,
    footprint: {
      totalBytes,
      ...(opts.headroomBytes !== undefined ? { headroomBytes: opts.headroomBytes } : {}),
      ...(fits !== undefined ? { fits } : {}),
    },
    lines,
  };
}
