import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { cpus, totalmem } from "node:os";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { EventLog, initSchema } from "@sekhemet/kernel";
import {
  type ConfigRole,
  type FoundModel,
  MANAGED_MODEL_FILES,
  resolveModelPath,
} from "@sekhemet/models";
import { HARDENED_GIT_CONFIG, HARDENED_GIT_PINS, withGitConfig } from "@sekhemet/sync";
import {
  type Check,
  type DerivedGates,
  NODE_FLOOR,
  type Roster,
  START_BY_CONVERSATION,
  configToml,
  deriveGates,
  gatesDiff,
  installGates,
  isEmptyProject,
  nodeMeetsFloor,
  recommendRoster,
  toolchainChecks,
  writeGitignoreBlock,
} from "./init.js";
import { PmStore } from "./pm/store.js";

/**
 * One first run for all three audiences (surface items 5–8, 5a, 5b; P10).
 * The bare `sekhemet` in a repository with no `.sekhemet/config.toml`:
 *
 * 1. checks the machine and the toolchain — Node.js older than 22.13 stops
 *    it here, naming both versions, before anything is written (SUR-46);
 * 2. resolves the roster for this machine's tier and says, per role, whether
 *    its weights are in a model folder the harness knows — read through part
 *    (b)'s `findRoleWeights`; nothing is downloaded (SUR-49);
 * 3. derives the gates with the one deriver (`init.ts`);
 * 4. prints one paragraph and asks one confirmation — `--yes` confirms,
 *    and with no terminal and no `--yes` it writes nothing and exits 2;
 * 5. on confirmation writes `config.toml`, `gates.toml` (an existing,
 *    different one is shown as a diff and kept unless confirmed, with a
 *    backup) and the `.gitignore` block, each exactly once;
 * 6. then the board opens — the Configuration page instead while no role's
 *    weights are found — never in a browser under `--yes`.
 *
 * It makes no network request (SUR-6): nothing here fetches, and the model
 * folders are only read.
 */

/**
 * Part (b)'s `findRoleWeights` (models NEW-models-12, the Configuration
 * page's scan): for each role, the model whose weights a known model folder
 * holds, or nothing. The first run needs only the name and size; any
 * `FoundModel` satisfies it.
 */
export type RoleWeightsFinder = () => Promise<
  Partial<Record<ConfigRole, Pick<FoundModel, "name" | "sizeBytes"> | undefined>>
>;

/**
 * The finder the first run uses until part (b)'s `findRoleWeights` is
 * exported by `@sekhemet/models`: the registry's managed weight files,
 * resolved against the models directory (`--models-dir`,
 * `SEKHEMET_MODELS_DIR`) — the same files `doctor` probes. Only reads.
 */
export function managedRoleWeights(modelsDir?: string): RoleWeightsFinder {
  return async () => {
    const out: Partial<Record<ConfigRole, Pick<FoundModel, "name" | "sizeBytes">>> = {};
    for (const [role, file] of Object.entries(MANAGED_MODEL_FILES)) {
      const path = resolveModelPath(file, modelsDir ? { modelsDir } : {});
      try {
        const st = statSync(path);
        if (st.isFile()) {
          out[role as ConfigRole] = { name: basename(file, ".gguf"), sizeBytes: st.size };
        }
      } catch {
        // Not there: the role has no weights yet.
      }
    }
    return out;
  };
}

/**
 * The model-folder finder: part (b)'s `findRoleWeights` when the models
 * package exports it, else the managed files above.
 */
export async function roleWeightsFinder(modelsDir?: string): Promise<RoleWeightsFinder> {
  const models = (await import("@sekhemet/models")) as Record<string, unknown>;
  const find = models.findRoleWeights;
  return typeof find === "function"
    ? (find as (o?: { modelsDir?: string }) => ReturnType<RoleWeightsFinder>).bind(undefined, {
        ...(modelsDir ? { modelsDir } : {}),
      })
    : managedRoleWeights(modelsDir);
}

/** The four roles the paragraph names, in order, with the roster's model for each. */
const ROLES: readonly { role: ConfigRole; label: string; model: (r: Roster) => string }[] = [
  // DEC-31: the roles as teams name them (NAMING), never Worker or Planner.
  { role: "worker", label: "Coding model", model: (r) => r.worker },
  { role: "planner", label: "Planning model", model: (r) => r.manager },
  { role: "reviewer", label: "Review model", model: (r) => r.reviewer },
  { role: "researcher", label: "Research model", model: (r) => r.researcher },
];

export type HomePage = "board" | "configuration";

export interface FirstRunPlan {
  repo: string;
  memoryGb: number;
  chip: string;
  nodeVersion: string;
  nodeOk: boolean;
  checks: Check[];
  roster: Roster;
  /** Per role: the model whose weights were found, if any. */
  weights: {
    role: ConfigRole;
    label: string;
    model: string;
    present: boolean;
    sizeBytes?: number;
  }[];
  gates: DerivedGates;
  /** The diff against a `gates.toml` already in the repository; empty when none or equal. */
  gatesDiff: string;
  /** A repository with history: onboarding (items 9–12) and take-over are offered. */
  history: boolean;
  /** Nothing here yet: a start by conversation is offered (design-stage DS-P2-4). */
  empty: boolean;
  opens: HomePage;
  paragraph: string[];
}

export interface FirstRunOptions {
  findRoleWeights: RoleWeightsFinder;
  run?: (cmd: string, args: string[]) => string | undefined;
  totalBytes?: number;
  nodeVersion?: string;
}

function chipName(): string {
  const model = cpus()[0]?.model ?? "";
  return /Apple (M\d[^,]*)/.exec(model)?.[1]?.trim() ?? (model.trim() || process.arch);
}

function hasHistory(repo: string): boolean {
  try {
    const n = execFileSync("git", ["rev-list", "--count", "--all"], {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      // Item 19's keys on the command level, writing nothing (the first run
      // writes nothing until confirmed, SUR-2).
      // The search stops at the repository: a folder inside another one
      // does not report the parent's history as its own.
      env: withGitConfig(
        {
          ...process.env,
          ...HARDENED_GIT_PINS,
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CEILING_DIRECTORIES: dirname(realpathSync(repo)),
        },
        HARDENED_GIT_CONFIG,
      ),
    });
    return Number.parseInt(n.trim(), 10) > 1;
  } catch {
    return false;
  }
}

const gb = (bytes: number) => `${Math.round(bytes / 1024 ** 3)} GB`;

/** Where `sekhemet` opens: the Configuration page while no role's weights are found (item 5b). */
export async function homeDestination(findRoleWeights: RoleWeightsFinder): Promise<HomePage> {
  const found = await findRoleWeights().catch(() => ({}));
  return Object.values(found).some(Boolean) ? "board" : "configuration";
}

/** Everything the first run would do, computed without writing anything. */
export async function planFirstRun(repo: string, options: FirstRunOptions): Promise<FirstRunPlan> {
  const nodeVersion = (options.nodeVersion ?? process.versions.node).replace(/^v/, "");
  const totalBytes = options.totalBytes ?? totalmem();
  const roster = recommendRoster(totalBytes);
  const checks = toolchainChecks(options.run, nodeVersion);
  const found = await options.findRoleWeights().catch(() => ({}) as Record<string, undefined>);
  const weights = ROLES.map(({ role, label, model }) => {
    const hit = (found as Partial<Record<ConfigRole, Pick<FoundModel, "name" | "sizeBytes">>>)[
      role
    ];
    return hit
      ? { role, label, model: hit.name, present: true, sizeBytes: hit.sizeBytes }
      : { role, label, model: model(roster), present: false };
  });
  const gates = deriveGates(repo);
  const live = join(repo, ".sekhemet", "gates.toml");
  const diff = existsSync(live) ? gatesDiff(readFileSync(live, "utf8"), gates.toml) : "";
  const opens: HomePage = weights.some((w) => w.present) ? "board" : "configuration";
  const plan: FirstRunPlan = {
    repo,
    memoryGb: Math.round(totalBytes / 1024 ** 3),
    chip: chipName(),
    nodeVersion,
    nodeOk: nodeMeetsFloor(nodeVersion),
    checks,
    roster,
    weights,
    gates,
    gatesDiff: diff,
    history: hasHistory(repo),
    empty: isEmptyProject(repo),
    opens,
    paragraph: [],
  };
  plan.paragraph = paragraph(plan);
  return plan;
}

function paragraph(plan: FirstRunPlan): string[] {
  const lines: string[] = [];
  const present = plan.weights.filter((w) => w.present);
  // Rule 6c, MD-N16-3: below 24 GB the shipped set is never presented as
  // fitting; the person may continue at their own risk.
  const supported = plan.roster.supported;
  if (!supported) {
    lines.push(`${plan.chip}, ${plan.memoryGb} GB. ${plan.roster.note}`);
  } else if (present.length === 0) {
    const worker = plan.weights[0];
    const planner = plan.weights[1];
    lines.push(
      `${plan.chip}, ${plan.memoryGb} GB. No models found yet — recommended: ${worker?.label} ${worker?.model}, ${planner?.label} ${planner?.model}.`,
    );
  } else {
    lines.push(`${plan.chip}, ${plan.memoryGb} GB, class ${plan.roster.tier}.`);
  }
  for (const w of plan.weights) {
    if (w.present)
      lines.push(
        `  ${w.label} ${w.model} — weights present${w.sizeBytes ? ` (${gb(w.sizeBytes)})` : ""}`,
      );
    else if (!w.model)
      // Rule 3: a role the shipped set leaves unfilled says so (the Review role).
      lines.push(`  ${w.label} — unfilled until a model is admitted for it`);
    else
      lines.push(
        supported
          ? `  ${w.label} ${w.model} — no weights found`
          : `  ${w.label} — no weights found`,
      );
  }
  if (present.length === 0 && supported) {
    lines.push(
      "  The Configuration page finds the models you already have, or downloads these when you choose.",
    );
  }
  for (const c of plan.checks.filter((x) => !x.ok && x.required)) {
    lines.push(`  ✗ ${c.name}: ${c.detail} → ${c.fix}`);
  }
  const ids = plan.gates.defs.map((g) => g.id);
  lines.push(
    ids.length
      ? `Checks from ${plan.gates.sources.join(", ")}: ${ids.join(", ")}.`
      : plan.empty
        ? START_BY_CONVERSATION
        : "No checks found yet: add typecheck, lint and test scripts, and run `sekhemet` again.",
  );
  if (plan.gates.teamTools.length) {
    lines.push(`  Your team's tools and settings: ${plan.gates.teamTools.join(", ")}.`);
  }
  const skipped = plan.gates.ci.filter(
    (s) => s.reason && s.reason !== "action" && s.reason !== "setup",
  );
  if (skipped.length) {
    lines.push(
      `  CI steps not run as checks: ${skipped.map((s) => `${s.command} (${s.reason?.replace(/_/g, " ")})`).join("; ")}.`,
    );
  }
  if (plan.gatesDiff) {
    lines.push("Your .sekhemet/gates.toml differs from what the project suggests:");
    for (const l of plan.gatesDiff.split("\n")) lines.push(`  ${l}`);
    lines.push("  It is kept unless you confirm; the old file is kept as gates.toml.bak.");
  }
  if (plan.history) {
    lines.push(
      "This repository has history: `sekhemet dev onboard` reads its conventions, and `sekhemet dev take-over` finds out what runs — nothing of it runs before you trust it.",
    );
  }
  return lines;
}

export interface FirstRunOutcome {
  /** 0 set up; 1 the machine cannot run it (Node.js); 2 not confirmed (item 18). */
  code: 0 | 1 | 2;
  /** Repository-relative files written. */
  wrote: string[];
  opens?: HomePage;
  /** False under `--yes` (item 7): the address is printed instead. */
  openBrowser: boolean;
}

export interface RunFirstRunOptions extends FirstRunOptions {
  yes?: boolean;
  /** A terminal on stdin and stdout. */
  interactive: boolean;
  ask?: (question: string) => Promise<boolean>;
  /**
   * A line of text from the person at the terminal: in an empty directory,
   * what they want built (DS-P2-4). Enter skips.
   */
  askText?: (question: string) => Promise<string>;
  say?: (line: string) => void;
}

/** What the first run asks in an empty directory (DS-P2-4). */
export const WHAT_TO_BUILD = "What would you like to build? One sentence, or Enter to skip: ";

/**
 * The person's sentence to Seshat, as their own message (planner-pm §2.9):
 * queued on the ledger, answered when the board opens with a `start_project`
 * proposal. Nothing is planned or created here.
 */
export async function queueStartProject(repo: string, sentence: string): Promise<void> {
  mkdirSync(join(repo, ".sekhemet"), { recursive: true });
  const db = new DatabaseSync(join(repo, ".sekhemet", "events.db"));
  try {
    initSchema(db);
    await new PmStore(new EventLog(db)).appendUserMessage(`start a new project: ${sentence}`);
  } finally {
    db.close();
  }
}

/** The first run (P10): plan, one confirmation, the writes, and where to open. */
export async function runFirstRun(
  repo: string,
  options: RunFirstRunOptions,
): Promise<FirstRunOutcome> {
  const say = options.say ?? ((l: string) => console.log(l));
  const plan = await planFirstRun(repo, options);
  if (!plan.nodeOk) {
    // SUR-46: named with the version required, before anything is written.
    say(
      `This is Node.js ${plan.nodeVersion}; Sekhemet needs Node.js ${NODE_FLOOR} or newer (its Activity log needs the built-in SQLite). Nothing was written.`,
    );
    return { code: 1, wrote: [], openBrowser: false };
  }
  for (const l of plan.paragraph) say(l);
  let confirmed = options.yes === true;
  if (!confirmed) {
    if (!options.interactive || !options.ask) {
      say("No terminal to confirm in: nothing was written. Run `sekhemet --yes` to set up here.");
      return { code: 2, wrote: [], openBrowser: false };
    }
    confirmed = await options.ask("Set up here? [Y/n] ");
  }
  if (!confirmed) {
    say("Nothing was written.");
    return { code: 2, wrote: [], openBrowser: false };
  }
  const wrote: string[] = [];
  const dir = join(repo, ".sekhemet");
  const config = join(dir, "config.toml");
  if (!existsSync(config)) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(config, configToml(plan.roster));
    wrote.push(".sekhemet/config.toml");
  }
  // A different gates.toml is replaced only when the person confirmed with
  // its diff on screen (the paragraph showed it); --yes never replaces one.
  const gates = installGates(repo, plan.gates.toml, options.yes !== true && plan.gatesDiff !== "");
  if (gates.state === "written" || gates.state === "replaced") wrote.push(".sekhemet/gates.toml");
  if (gates.state === "replaced") say(`Kept your previous checks file as ${gates.backup}.`);
  if (gates.state === "needs_confirmation") {
    say(
      "Kept your .sekhemet/gates.toml; `sekhemet dev onboard --apply` replaces it after showing the diff.",
    );
  }
  if (writeGitignoreBlock(repo)) wrote.push(".gitignore");
  // DS-P2-4: in an empty directory, the person may say what to build now;
  // Seshat has it when the board opens.
  if (plan.empty && options.interactive && options.askText) {
    const sentence = (await options.askText(WHAT_TO_BUILD)).trim();
    if (sentence) await queueStartProject(repo, sentence);
  }
  say(
    plan.opens === "configuration"
      ? "Ready. Opening Configuration to find your models or download these."
      : 'Ready. Ask for work with: sekhemet "add rate limiting to the API"',
  );
  return { code: 0, wrote, opens: plan.opens, openBrowser: options.yes !== true };
}
