import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { freemem, homedir, platform, tmpdir, totalmem } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { loadGatesConfig } from "@sekhemet/gates";
import { EventLog, SCHEMA_VERSION } from "@sekhemet/kernel";
import {
  type EngineStatus,
  HttpInferenceAdapter,
  type LocalInferenceAdapter,
  MEASUREMENT_BASELINE,
  MODEL_ROLES,
  ManagedLlamaServerAdapter,
  ModelRegistry,
  type ModelRole,
  ROLE_WORDS,
  SHIPPED_MODELS,
  type WeightsReport,
  classifyMemoryPressure,
  currentAssignment,
  engineStatus,
  hostFingerprintHash,
  isOllamaCloudTag,
  managedModelWeights,
  modelLeaseHolderWords,
  modelLeaseLive,
  modelLeasePath,
  ollamaCloudRefusal,
  probeModelWeights,
  readKernelPressureLevel,
  readModelLease,
  resolveModelsDir,
  sekhemetConfigDir,
  sha256File,
  supportedTierFor,
} from "@sekhemet/models";
import { ProcessSandbox, allowlistWarnings, sameProcess, socatAvailable } from "@sekhemet/sandbox";
import { plural } from "@sekhemet/ui";
import { newestVerifiedBackup } from "./backup_sets.js";
import { resolveConfig, userConfigPath } from "./config.js";
import {
  defaultWorkerName,
  effectiveConfig,
  networkConfigs,
  queueDefaults,
} from "./config_apply.js";
import { configUpgradeCheck } from "./config_upgrade.js";
import { checkFreeSpace, formatBytes } from "./disk_space.js";
import { packageManagerOf, toolProbeOptions } from "./init.js";
import { countLostRecords, lostRecordsPath } from "./lost_records.js";
import { pendingM0InRepo } from "./m0_path.js";
import { describeModel, roleModelName } from "./model_access.js";
import { setupFor } from "./planner_live.js";
import { rolePromptVersions } from "./prompt_versions.js";
import { type CombinationDeps, qualificationCombination } from "./qualify.js";
import { checkRegisters } from "./registers.js";
import { researchDoctorLines } from "./research_bakeoff.js";
import { awaitingResearchHosts } from "./research_consent.js";
import { isLive, leasePath, readLeaseFile, runnerLease } from "./runner_lease.js";
import { secretStoreStatus } from "./secret_store.js";
import { findOnPath, sleepAssertionCommand, sleepAssertionProbe } from "./sleep_assertion.js";
import {
  CREDENTIALS_FILE,
  type IdentityMove,
  identityDir,
  identityRoot,
  readIdentityMove,
} from "./team/credential_store.js";
import { type TeamEnginesReport, checkTeamEngines } from "./team_engines.js";
import { readMoveRecord, userDir } from "./user_dir.js";
import { hookEngineFor } from "./user_hooks.js";
import { playbookDoctorCheck } from "./wave2.js";
import {
  holdsLedger,
  ledgerFacts,
  ledgerPathOf,
  rewriteLocators,
  workspaceFolderOf,
} from "./workspace_locator.js";

export type CheckStatus = "pass" | "warn" | "fail";

export interface DiagnosticCheck {
  name: string;
  status: CheckStatus;
  detail: string;
  /**
   * SUR-62: the next step, printed on its own line as `Do: …` when the check
   * is not a pass — the check's own where it has one, else the catalogue's
   * (`DOCTOR_CHECKS`, filled in by `runDoctor`).
   */
  do?: string;
}

export interface DoctorReport {
  /** No check failed: *Ready to run an issue* (SUR-61). */
  ok: boolean;
  checks: DiagnosticCheck[];
  /** The closing line: *Ready to run an issue*, or *Not ready* naming the first missing step. */
  verdict: string;
}

/** A sentence ends with its stop. */
const sentence = (t: string): string => (/[.!?]$/.test(t.trim()) ? t.trim() : `${t.trim()}.`);

function check(name: string, status: CheckStatus, detail: string, step?: string): DiagnosticCheck {
  return { name, status, detail, ...(step ? { do: sentence(step) } : {}) };
}

/**
 * One entry of `doctor`'s catalogue (surface item 20b, NEW-surface-8): the
 * check's id, its title as `doctor` prints it, and its generic next step,
 * which the user guide's troubleshooting page is generated from (SUR-65).
 */
export interface DoctorCheckSpec {
  id: string;
  title: string;
  do: string;
}

/**
 * The catalogue, in the order `doctor` runs and prints the checks: what a
 * run needs first (the engine, the weights, the roles' models), then the
 * repository, the sandbox and the toolchain, then the rest. The verdict
 * names the first check here that fails (SUR-61).
 */
export const DOCTOR_CHECKS: readonly DoctorCheckSpec[] = [
  {
    id: "memory",
    title: "Unified memory",
    do: "close programs you are not using, or wait until the system's memory pressure is normal",
  },
  {
    id: "memory-floor",
    title: "Memory floor",
    do: "use a machine with 24 GB of memory or more; you may continue here at your own risk",
  },
  {
    id: "engine",
    title: "Inference engine",
    do: "get the inference engine on Configuration › Models, or run `sekhemet engine get`",
  },
  {
    id: "weights",
    title: "Model weights",
    do: "point SEKHEMET_MODELS_DIR (or `--models-dir`) at the folder holding your weights, or download them on Configuration › Models",
  },
  {
    id: "weights-hashes",
    title: "Weights' hashes",
    do: "run `sekhemet doctor --verify-weights`; download a file whose hash differs again on Configuration › Models",
  },
  {
    id: "role-verification",
    title: "Role verification",
    do: "verify each role's model on Configuration › Models, or run `sekhemet qualify --models <model>`",
  },
  {
    id: "ollama-roles",
    title: "Ollama's roles",
    do: "assign a GGUF model to each role on Configuration › Models, or run `sekhemet models assign <role> <model>`",
  },
  {
    id: "team-engines",
    title: "Team engines",
    do: "start each engine service with its profile's arguments: `docker compose -f packaging/server/compose.yaml up` (docs/reference/INSTALL.md, For a team)",
  },
  {
    id: "model-server",
    title: "Model server",
    do: "start Ollama for the roles it serves; a role on llama.cpp needs nothing running, since each run starts its own llama-server",
  },
  {
    id: "git-repository",
    title: "Git repository",
    do: "run `git init` in the project's folder, or run `sekhemet doctor` in a folder that is a git repository",
  },
  {
    id: "sandbox",
    title: "Sandbox confinement",
    do: "on Linux install bubblewrap (`sudo apt install bubblewrap`); on macOS the sandbox is built in (docs/reference/INSTALL.md)",
  },
  {
    id: "port-relays",
    title: "Port relays",
    do: "install socat (`sudo apt install socat`, or your distribution's package)",
  },
  { id: "node", title: "Node runtime", do: "install Node.js 22.13 or newer (https://nodejs.org)" },
  { id: "git", title: "Git", do: "install git (https://git-scm.com/downloads)" },
  {
    id: "package-manager",
    title: "Package manager",
    do: "install the package manager the project uses (the `packageManager` field in package.json, or its lockfile)",
  },
  {
    id: "skills",
    title: "Skills",
    do: "add skills under .sekhemet/skills/, or leave it: a project runs without skills",
  },
  {
    id: "playbook",
    title: "Playbook and skills",
    do: "prune the rules and skills it names on Configuration › Project, or run `sekhemet skills`",
  },
  {
    id: "project-records",
    title: "Project records",
    do: "fix the entries it names in docs/reference/PROVENANCE.md or the research register",
  },
  {
    id: "plugins",
    title: "Plugins",
    do: "move what the plugins did to hooks (.sekhemet/hooks.toml) or MCP servers (.sekhemet/mcp.json), then remove .sekhemet/plugins/",
  },
  {
    id: "first-run-benchmark",
    title: "First-run benchmark",
    do: "run `sekhemet m0 --worker <name>`, or let `sekhemet overnight` run it first",
  },
  {
    id: "model-verification",
    title: "Model verification",
    do: "verify each model it names again: `sekhemet qualify --models <model>`",
  },
  {
    id: "local-models-only",
    title: "Local models only",
    do: "assign a local model to each role it names on Configuration › Models",
  },
  {
    id: "user-directory",
    title: "User directory",
    do: "merge or delete by hand the files it names as left behind",
  },
  {
    id: "configuration",
    title: "Configuration",
    do: "fix the config.toml line it names, then run `sekhemet doctor` again",
  },
  {
    id: "config-upgrades",
    title: "Config upgrades",
    do: "read the renamed keys it lists; each file's backup sits beside it",
  },
  { id: "hooks", title: "Hooks", do: "fix .sekhemet/hooks.toml where it says" },
  {
    id: "research",
    title: "Research",
    do: "set `[network] research` in your own config.toml (only you can allow research)",
  },
  {
    id: "network-allowlist",
    title: "Network allowlist",
    do: "remove the wildcard or upload-capable entry from `[project] network_allow` in .sekhemet/gates.toml unless the project's checks truly need it; every issue that runs under it records the warning",
  },
  {
    id: "research-pipelines",
    title: "Research pipelines",
    do: "run `sekhemet research-bakeoff` to compare the pipelines again",
  },
  {
    id: "secret-store",
    title: "Secret store",
    do: "install the system's secret store (macOS Keychain, or the Secret Service on Linux), or choose a private file in Integrations",
  },
  {
    id: "activity-log",
    title: "Activity log",
    do: "run `sekhemet log` to see the entry named; restore the newest backup that verifies with `sekhemet restore --latest`",
  },
  {
    id: "locks",
    title: "Locks",
    do: "nothing is needed: the next run takes over a lock whose holder is gone; or remove the file it names",
  },
  {
    id: "crashed-attempts",
    title: "Crashed attempts",
    do: "run `sekhemet run`: its start-up pass returns each to Ready from its last checkpoint",
  },
  {
    id: "git-clean",
    title: "Workspace in a git repository",
    do: "run `sekhemet backup` before any `git clean -xdf` there",
  },
  {
    id: "project-locators",
    title: "Project locators",
    do: "move the project back, or record its new folder with `sekhemet project move <id> <path>`",
  },
  {
    id: "team-address",
    title: "Team address",
    do: 'serve the Team server behind TLS — your reverse proxy (the `builtin` profile) or the identity proxy with your certificate (the `proxy` profile), docs/reference/INSTALL.md › For a team — and set `[identity] public_url = "https://…"`',
  },
  { id: "backup", title: "Backup", do: "run `sekhemet backup`" },
  {
    id: "staying-awake",
    title: "Staying awake",
    do: "install the tool that keeps the machine awake (`caffeinate` on macOS, `systemd-inhibit` on Linux), or keep the machine from sleeping while a run works",
  },
  { id: "power", title: "Power", do: "plug the machine in for the night" },
  { id: "free-space", title: "Free space", do: "free space on the volume it names" },
  {
    id: "credential-store",
    title: "Credential store",
    do: 'set `[team] mode = "team"` in your config.toml and run `sekhemet serve` in the workspace\'s folder: a Team server moves the store into its workspace',
  },
  {
    id: "model-lease",
    title: "Model lease",
    do: "wait for the run that holds it to finish, or stop that process",
  },
  {
    id: "lost-records",
    title: "Lost records",
    do: "read the file it names; each line is a record that could not be written",
  },
];

/** The catalogue's entry for a check's title. */
export function doctorCheckSpec(title: string): DoctorCheckSpec | undefined {
  return DOCTOR_CHECKS.find((c) => c.title === title);
}

/**
 * SUR-61: the verdict — *Ready to run an issue* while no check fails, else
 * *Not ready* naming the first failing check in the catalogue's order and
 * its next step.
 */
export function doctorVerdict(checks: readonly DiagnosticCheck[]): string {
  const order = (c: DiagnosticCheck) => {
    const i = DOCTOR_CHECKS.findIndex((s) => s.title === c.name);
    return i === -1 ? DOCTOR_CHECKS.length : i;
  };
  const first = checks.filter((c) => c.status === "fail").sort((a, b) => order(a) - order(b))[0];
  if (!first) return "Ready to run an issue.";
  const step = first.do ?? doctorCheckSpec(first.name)?.do;
  return `Not ready: ${first.name}.${step ? ` Do: ${sentence(step)}` : ""}`;
}

/** Every check that is not a pass carries a next step: its own, else the catalogue's (SUR-62). */
function withNextSteps(checks: readonly DiagnosticCheck[]): DiagnosticCheck[] {
  return checks.map((c) => {
    if (c.status === "pass") {
      const { do: _unused, ...rest } = c;
      return rest;
    }
    const step = c.do ?? doctorCheckSpec(c.name)?.do;
    return step ? { ...c, do: sentence(step) } : c;
  });
}

/** Probe a local inference server's model list over HTTP. */
export async function probeInference(
  endpoints: string[],
  /**
   * A role is served by a server that must already run (Ollama). Otherwise
   * no server answering is a warning, not a failure: each run starts its own
   * llama-server (surface item 20b).
   */
  needed = true,
): Promise<DiagnosticCheck> {
  for (const base of endpoints) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1500);
      // Ollama answers /api/tags; a llama-server answers it with 404, which
      // does not throw — so a failed status, not only an error, falls back to
      // the OpenAI-compatible listing.
      const tags = await fetch(`${base}/api/tags`, { signal: controller.signal }).catch(
        () => undefined,
      );
      const res = tags?.ok
        ? tags
        : await fetch(`${base}/v1/models`, { signal: controller.signal }).catch(() => undefined);
      clearTimeout(timer);

      if (res?.ok) {
        const body = (await res.json()) as {
          models?: { name?: string }[];
          data?: { id?: string }[];
        };
        const names = (body.models ?? []).map((m) => m.name).filter(Boolean);
        const ids = (body.data ?? []).map((m) => m.id).filter(Boolean);
        const found = [...names, ...ids];
        return check(
          "Model server",
          found.length > 0 ? "pass" : "warn",
          found.length > 0
            ? `${base} reachable — ${plural(found.length, "model")}: ${found.slice(0, 3).join(", ")}`
            : `${base} reachable but serving no models`,
        );
      }
    } catch {
      // Try the next endpoint.
    }
  }

  return needed
    ? check(
        "Model server",
        "fail",
        `no inference server reachable at ${endpoints.join(" or ")}, and a role's model is served by Ollama`,
        "start Ollama (`ollama serve`), or assign a GGUF model to that role on Configuration › Models",
      )
    : check(
        "Model server",
        "warn",
        `no inference server reachable at ${endpoints.join(" or ")}; a role on llama.cpp needs none, since each run starts its own llama-server`,
      );
}

/** Verify a tool is on PATH and report the version it actually returns. */
function probeBinary(name: string, args: string[], label = name): DiagnosticCheck {
  try {
    // Review M1: from a neutral directory with Corepack's downloads off, so a
    // repository's `packageManager` field chooses no program here.
    const out = execFileSync(name, args, {
      ...toolProbeOptions(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 15_000,
    }).trim();
    return check(label, "pass", `${out.split("\n")[0]}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return check(
      label,
      "fail",
      (err as NodeJS.ErrnoException).code === "ENOENT"
        ? `not installed (${name} is not on the PATH)`
        : `not runnable: ${message.split("\n")[0] ?? message}`,
    );
  }
}

/**
 * The folder is a git repository, where each issue runs in a worktree of its
 * own (SUR-64): outside one it says so in words and names `git init`, never
 * a raw git error.
 */
export function probeWorktrees(repoPath: string): DiagnosticCheck {
  const git = (args: string[]) =>
    execFileSync("git", args, {
      cwd: repoPath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 15_000,
    });
  try {
    if (git(["rev-parse", "--is-inside-work-tree"]).trim() !== "true") throw new Error("bare");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT")
      return check("Git repository", "fail", "git is not installed, so no issue can run");
    return check(
      "Git repository",
      "fail",
      `${repoPath} is not inside a git repository; each issue runs in a git worktree of the project's repository`,
      `run \`git init\` in ${repoPath}, or run \`sekhemet doctor\` in your project's folder`,
    );
  }
  try {
    const count = git(["worktree", "list", "--porcelain"])
      .split("\n")
      .filter((l) => l.startsWith("worktree ")).length;
    return check(
      "Git repository",
      "pass",
      `a git repository; ${plural(count, "worktree")} registered`,
    );
  } catch (err) {
    const said = (err as { stderr?: string }).stderr?.toString().trim().split("\n")[0];
    return check(
      "Git repository",
      "fail",
      `git could not list this repository's worktrees${said ? ` (${said})` : ""}`,
      "update git to 2.20 or newer, then run `sekhemet doctor` again",
    );
  }
}

/**
 * The project's package manager (SUR-64, item 5.3): the one its
 * `packageManager` field or lockfile names, never pnpm by default; a folder
 * with no `package.json` needs none.
 */
export function packageManagerCheck(repoPath: string): DiagnosticCheck {
  const manifest = join(repoPath, "package.json");
  if (!existsSync(manifest))
    return check(
      "Package manager",
      "pass",
      "no package.json here, so no JavaScript package manager is needed",
    );
  let pkg: { packageManager?: string } = {};
  try {
    pkg = JSON.parse(readFileSync(manifest, "utf8")) as typeof pkg;
  } catch {
    // An unreadable package.json names no manager: its lockfile, else npm.
  }
  const pm = packageManagerOf(repoPath, pkg);
  const probed = probeBinary(pm, ["--version"], "Package manager");
  return probed.status === "pass"
    ? check("Package manager", "pass", `${pm} ${probed.detail}, the project's package manager`)
    : check(
        "Package manager",
        "fail",
        `${pm}, the project's package manager, is ${probed.detail}`,
        `install ${pm}${pm === "pnpm" || pm === "yarn" ? ` (\`npm install -g ${pm}\`)` : pm === "npm" ? " with Node.js (https://nodejs.org)" : " (https://bun.sh)"}`,
      );
}

/**
 * Port relays (SUR-93, security item 14b): on Linux a card's command runs in
 * an empty network namespace, and its named ports and egress proxy cross it
 * through socat. Without socat on the PATH they have no route. Elsewhere
 * there is no row: macOS needs no relay.
 */
export function portRelaysCheck(
  os: NodeJS.Platform = process.platform,
  available: () => boolean = socatAvailable,
): DiagnosticCheck | undefined {
  if (os !== "linux") return undefined;
  return available()
    ? check(
        "Port relays",
        "pass",
        "socat found: an issue's named ports and its egress proxy cross the sandbox's network namespace",
      )
    : check(
        "Port relays",
        "fail",
        "socat is not on the PATH, so an issue's named ports (a dev server, the browser's) and its egress proxy get no route out of the sandbox's empty network namespace",
        "install socat (`sudo apt install socat`, or your distribution's package)",
      );
}

/**
 * Prove sandbox containment by actually attempting an escape.
 *
 * Asserting that a profile string looks right proves nothing; the only honest
 * check is to run a subprocess that tries to write outside its allowed paths
 * and confirm the kernel refuses.
 */
async function probeConfinement(repoPath: string): Promise<DiagnosticCheck> {
  const sandbox = new ProcessSandbox();
  if (sandbox.confinement === "none") {
    return judgeConfinement("none", undefined, undefined, sandbox.unavailableReason);
  }
  const options = {
    allowedPaths: [repoPath],
    allowNetwork: false,
    timeoutMs: 10_000,
    cwd: repoPath,
  };
  // A refusal counts only once a harmless command is shown to run (R9: a
  // bubblewrap that cannot start fails every command, the probe included).
  const control = await sandbox.execute(process.execPath, ["-e", "0"], options);
  // The escape targets a directory the person can write outside the grant,
  // so only the sandbox can refuse it (R9 review: `/` refuses any non-root
  // user, confined or not). Not /tmp, which is private inside bubblewrap.
  const home = homedir();
  const inGrant = !relative(repoPath, home).startsWith("..");
  const base = inGrant ? (platform() === "linux" ? "/var/tmp" : tmpdir()) : home;
  let dir: string;
  try {
    dir = mkdtempSync(join(base, ".sekhemet-doctor-probe-"));
  } catch (err) {
    return check(
      "Sandbox confinement",
      "warn",
      `${sandbox.confinement} in force, sandbox test not run: ${base} is not writable (${(err as Error).message})`,
    );
  }
  const target = join(dir, "escaped");
  try {
    const attempt = await sandbox.execute(
      process.execPath,
      ["-e", `require('fs').writeFileSync(${JSON.stringify(target)},'x')`],
      options,
    );
    return judgeConfinement(sandbox.confinement, control, {
      exitCode: attempt.exitCode,
      wrote: existsSync(target),
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The confinement check's verdict. It names the mechanism actually in force,
 * and passes only when a harmless command ran, the escape failed, and the
 * file it tried to write is absent.
 */
export function judgeConfinement(
  mode: string,
  control: { exitCode: number; stderr: string } | undefined,
  attempt: { exitCode: number; wrote: boolean } | undefined,
  unavailable?: string,
): DiagnosticCheck {
  if (mode === "none" || !control || !attempt) {
    return check(
      "Sandbox confinement",
      "warn",
      unavailable
        ? `no OS confinement in force on ${platform()}: ${unavailable}`
        : `no OS confinement available on ${platform()} — commands run unconfined`,
    );
  }
  if (control.exitCode !== 0) {
    const said = control.stderr.trim().split("\n")[0] || `exit ${control.exitCode}`;
    return check("Sandbox confinement", "fail", `${mode} cannot run a harmless command (${said})`);
  }
  return attempt.wrote || attempt.exitCode === 0
    ? check("Sandbox confinement", "fail", "the sandbox test wrote outside the worktree")
    : check(
        "Sandbox confinement",
        "pass",
        `${mode} active — the sandbox test was refused (exit ${attempt.exitCode})`,
      );
}

/** Report on the skills directory the context engine loads from. */
function probeSkills(repoPath: string): DiagnosticCheck {
  // SUR-64: a folder not set up yet is not warned about skills.
  if (!existsSync(join(repoPath, ".sekhemet")))
    return check("Skills", "pass", "not set up here yet: skills load once the project is");
  const dir = join(repoPath, ".sekhemet", "skills");
  if (!existsSync(dir)) {
    return check("Skills", "warn", `${dir} not present — no skills will load`);
  }
  try {
    const entries = execFileSync("ls", ["-1", dir], { encoding: "utf8" }).trim();
    const count = entries ? entries.split("\n").length : 0;
    return check("Skills", count > 0 ? "pass" : "warn", `${plural(count, "skill")} discoverable`);
  } catch {
    return check("Skills", "warn", "skills directory unreadable");
  }
}

/**
 * Memory health, judged by the signal the run guard acts on.
 *
 * On macOS used/total counts reclaimable file cache, so it read "97% used,
 * critical" on a machine at normal pressure while the Machine view beside it
 * said Normal. Where the kernel reports its pressure level (1 normal,
 * 2 warning, 4 critical) that decides the status; the ratio remains as detail.
 */
export function memoryCheck(
  pressure: ReturnType<typeof classifyMemoryPressure>,
  free: number,
  total: number,
  gb: (n: number) => string,
  // null: this platform reports no level (an explicit undefined would re-run the default).
  kernelLevel: number | null = readKernelPressureLevel() ?? null,
): DiagnosticCheck {
  const used = `${gb(free)} GB free of ${gb(total)} GB (${(pressure.usedRatio * 100).toFixed(0)}% used`;
  if (kernelLevel !== null) {
    const level = kernelLevel >= 4 ? "critical" : kernelLevel >= 2 ? "warning" : "normal";
    return check(
      "Unified memory",
      level === "normal" ? "pass" : level === "warning" ? "warn" : "fail",
      `${used}, including reclaimable cache); system pressure ${level}`,
    );
  }
  return check(
    "Unified memory",
    pressure.level === "normal" ? "pass" : pressure.level === "warning" ? "warn" : "fail",
    `${used}, ${pressure.level})`,
  );
}

/** This host's model registry, or none when it cannot be read (doctor still reports). */
function hostRegistry(): ModelRegistry | undefined {
  try {
    return new ModelRegistry();
  } catch {
    return undefined;
  }
}

/**
 * Are the weights the resolved profiles name actually on this disk?
 *
 * Design "Getting the weights": a diagnostic that reports all-clear and is
 * followed by a file-not-found on the first card is worse than no diagnostic.
 * No models directory at all is a warning, because an Ollama-only install is
 * a legitimate setup; a directory with some of the weights missing is not.
 */
export function weightsCheck(
  report: WeightsReport = probeModelWeights(managedModelWeights({ registry: hostRegistry() })),
): DiagnosticCheck {
  if (!report.modelsDirExists) {
    return check(
      "Model weights",
      "warn",
      `no models directory at ${report.modelsDir} — point --models-dir (or SEKHEMET_MODELS_DIR) at your weights, or run a model over Ollama`,
    );
  }
  if (report.missing.length === 0) {
    return check(
      "Model weights",
      "pass",
      `${plural(report.present, "model file")} present in ${report.modelsDir}`,
    );
  }
  const detail = report.probes
    .filter((p) => !p.ok)
    .map((p) => `${p.modelId} ${p.detail} (${p.path})`)
    .join("; ");
  return check("Model weights", report.present === 0 ? "fail" : "warn", detail);
}

/**
 * Run the real diagnostic suite.
 *
 * Every check probes something. A diagnostic that cannot fail is worse than no
 * diagnostic, because it is trusted and wrong.
 */
export interface DoctorOptions {
  /** SUR-89: hash every weights file the cache does not hold (`doctor --verify-weights`). */
  verifyWeights?: boolean;
}

export async function runDoctor(
  repoPath: string = process.cwd(),
  options: DoctorOptions = {},
): Promise<DoctorReport> {
  const total = totalmem();
  const free = freemem();
  const pressure = classifyMemoryPressure(total - free, total);
  const gb = (n: number): string => (n / 1024 ** 3).toFixed(1);
  const workspaceFolder = workspaceFolderOf(repoPath);
  const roles = roleEngines(repoPath);

  const checks: (DiagnosticCheck | undefined)[] = [
    memoryCheck(pressure, free, total, gb),
    // Rule 6c, MD-N16-3: the memory floor v1 supports.
    memoryFloorCheck(total),
    // Rules 6a and 6b: which engine, where it came from, its build against the floor.
    engineDoctorCheck(),
    weightsCheck(),
    // Rule 5, MD-N7-2: each weights file's hash against the registered one;
    // a file the cache does not hold is read only on request (SUR-89).
    await weightsHashCheck({ verify: options.verifyWeights === true }),
    // MD-N8-1: each assigned role verified for its combination on this machine.
    roleQualificationCheck(hostRegistry(), { repoPath }),
    // Rule 6d, MD-N16-4: which roles Ollama serves, in the README's words.
    ollamaRolesCheck(roles),
    // MD-N15-3: on the Team server, each filled role's engine answers and matches.
    ...(setupFor(repoPath) === "team" ? [teamEnginesCheck(await checkTeamEngines())] : []),
    // Ollama, the managed Worker server (cyber-tiel, 8098) and the legacy 8099:
    // needed only where a role's model is served by Ollama (item 20b).
    await probeInference(
      ["http://127.0.0.1:11434", "http://127.0.0.1:8098", "http://127.0.0.1:8099"],
      roles.some((r) => r.engine === "ollama"),
    ),
    probeWorktrees(repoPath),
    await probeConfinement(repoPath),
    // SUR-93: socat on Linux, for a card's port relays.
    portRelaysCheck(),
    probeBinary("node", ["--version"], "Node runtime"),
    probeBinary("git", ["--version"], "Git"),
    // SUR-64: the project's own package manager, or none.
    packageManagerCheck(repoPath),
    probeSkills(repoPath),
    // E19, C12: rule net gain, context bloat, pruning recommendations.
    playbookDoctorCheck(repoPath),
    registersCheck(repoPath),
    pluginsCheck(repoPath),
    m0PendingCheck(repoPath),
    modelVerificationCheck(),
    ollamaCloudCheck(repoPath),
    userDirCheck(),
    // Surface item 21, SUR-92: a config.toml that does not parse fails, by file, line and column.
    configurationCheck(repoPath),
    // SUR-43: each renamed config key an upgrade rewrote, with its backup.
    configUpgradeCheck([join(repoPath, ".sekhemet", "config.toml"), userConfigPath()]),
    hooksCheck(repoPath),
    researchConsentCheck(repoPath),
    // SEC-15b: a wildcard or upload-capable allowlist entry, warned where a person meets it.
    networkAllowlistCheck(repoPath),
    await researchPipelineCheck(repoPath),
    secretStoreCheck(),
    // SUR-63: the ledger's chain and schema, locks, crashed attempts (item 20b).
    activityLogCheck(workspaceFolder),
    locksCheck(repoPath),
    crashedAttemptsCheck(workspaceFolder, repoPath),
    // SUR-82: a workspace inside a git repository, and `git clean -xdf`.
    gitCleanCheck(workspaceFolder),
    // SUR-78: every project's locator, rewritten from the ledger.
    projectLocatorsCheck(repoPath),
    // TEAM-47: the Team server's public address is https.
    teamAddressCheck(repoPath),
    // Surface item 20e (C4): backups, staying awake, power, free space, the
    // credential store, the model lease and lost records (SUR-83 to SUR-88).
    ...reliabilityChecks(repoPath),
  ];
  // In the catalogue's order, each not-pass with its next step (SUR-61, SUR-62).
  const at = (c: DiagnosticCheck) => {
    const i = DOCTOR_CHECKS.findIndex((s) => s.title === c.name);
    return i === -1 ? DOCTOR_CHECKS.length : i;
  };
  const ordered = withNextSteps(
    checks.filter((c): c is DiagnosticCheck => c !== undefined).sort((a, b) => at(a) - at(b)),
  );
  return {
    ok: ordered.every((c) => c.status !== "fail"),
    checks: ordered,
    verdict: doctorVerdict(ordered),
  };
}

// ── the catalogue's ledger, lock, sweep, git and Team rows (SUR-63, SUR-82, TEAM-47) ──

/**
 * Activity log (SUR-63): the ledger's schema version is one this build
 * reads, and its whole hash chain verifies — read-only; an erased entry is a
 * named gap, never a failure.
 */
export function activityLogCheck(workspaceFolder: string): DiagnosticCheck {
  if (!holdsLedger(workspaceFolder))
    return check("Activity log", "pass", "no Activity log here yet");
  const path = ledgerPathOf(workspaceFolder);
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(path, { readOnly: true });
  } catch (err) {
    return check(
      "Activity log",
      "fail",
      `${path} could not be opened: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  try {
    const stored = (db.prepare("PRAGMA user_version").get() as { user_version: number })
      .user_version;
    if (stored > SCHEMA_VERSION)
      return check(
        "Activity log",
        "fail",
        `${path} is at schema version ${stored}, newer than this build's ${SCHEMA_VERSION}, so this build cannot open it`,
        "upgrade Sekhemet to the version that wrote it, or restore the backup taken before the migration (`sekhemet restore --latest`)",
      );
    const v = new EventLog(db).verifyHashChainSync({ full: true });
    if (!v.valid)
      return check(
        "Activity log",
        "fail",
        `the hash chain of ${path} does not verify${v.corruptedSeq !== undefined ? ` at entry ${v.corruptedSeq}` : ""}${v.reason ? ` (${v.reason})` : ""}: an entry was changed outside Sekhemet`,
        "run `sekhemet log` to see the entry; with the server stopped, restore the newest backup that verifies (`sekhemet restore --latest`)",
      );
    const gaps = v.erased?.length ?? 0;
    return check(
      "Activity log",
      "pass",
      `${plural(v.totalEvents, "entry", "entries")}, the hash chain verifies${gaps ? ` (${plural(gaps, "erased entry", "erased entries")} named as gaps)` : ""}; schema version ${stored}${stored < SCHEMA_VERSION ? `, migrated to ${SCHEMA_VERSION} after a backup the next time a command opens it` : ""}`,
    );
  } finally {
    db.close();
  }
}

/** A lock file's holder: its pid and start time, or nothing readable. */
function lockFileHolder(path: string): { pid: number; processStart?: string } | undefined {
  try {
    const { pid, processStart } = JSON.parse(readFileSync(path, "utf8")) as {
      pid?: unknown;
      processStart?: unknown;
    };
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return undefined;
    return { pid, ...(typeof processStart === "string" ? { processStart } : {}) };
  } catch {
    return undefined;
  }
}

/** The repository's accept lock (review-git RG-S5-5), in its shared git directory. */
function acceptLockPath(repoPath: string): string | undefined {
  try {
    const dir = execFileSync("git", ["rev-parse", "--git-common-dir"], {
      cwd: repoPath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 15_000,
    }).trim();
    return join(isAbsolute(dir) ? dir : join(repoPath, dir), "sekhemet-accept.lock");
  } catch {
    return undefined;
  }
}

/**
 * Locks (SUR-63): the runner lease (runtime item 3) and the accept lock
 * (review-git RG-S5-5) — free, held by a live process, or left by one that
 * is gone, which the next run takes over (a warning naming the file).
 */
export function locksCheck(repoPath: string): DiagnosticCheck {
  const held: string[] = [];
  const stale: string[] = [];
  const runnerPath = leasePath(repoPath);
  if (existsSync(runnerPath)) {
    const lease = readLeaseFile(runnerPath);
    if (lease && isLive(lease))
      held.push(
        `the runner lease is held by pid ${lease.pid}${lease.kind ? ` (${lease.kind})` : ""}`,
      );
    else
      stale.push(
        `a runner lease ${lease ? `from pid ${lease.pid}, whose process is gone` : "that cannot be read"} (${runnerPath})`,
      );
  }
  const acceptPath = acceptLockPath(repoPath);
  if (acceptPath && existsSync(acceptPath)) {
    const holder = lockFileHolder(acceptPath);
    if (holder && sameProcess(holder.pid, holder.processStart))
      held.push(`an accept is in progress (pid ${holder.pid})`);
    else
      stale.push(
        `an accept lock ${holder ? `from pid ${holder.pid}, whose process is gone` : "that cannot be read"} (${acceptPath})`,
      );
  }
  if (stale.length)
    return check(
      "Locks",
      "warn",
      [...held, `${stale.join(" and ")} was left behind`].join("; "),
      `nothing is needed: the next run takes ${stale.length === 1 ? "it" : "them"} over; or remove ${stale.length === 1 ? "that file" : "those files"} while no Sekhemet command runs`,
    );
  return check("Locks", "pass", held.length ? held.join("; ") : "no runner or accept lock is held");
}

/**
 * Crashed attempts (SUR-63, runtime RUN-9): issues In progress whose latest
 * attempt is still marked running while no runner holds the lease — stopped
 * by a crash or a kill, waiting for the next start-up sweep to return them
 * to Ready. Read-only: the sweep is the runner's.
 */
export function crashedAttemptsCheck(workspaceFolder: string, repoPath: string): DiagnosticCheck {
  if (!holdsLedger(workspaceFolder))
    return check("Crashed attempts", "pass", "no Activity log here yet");
  const runner = runnerLease(repoPath);
  if (runner)
    return check(
      "Crashed attempts",
      "pass",
      `a runner is working (pid ${runner.pid}), so the attempts in progress are live`,
    );
  let ids: string[];
  try {
    const db = new DatabaseSync(ledgerPathOf(workspaceFolder), { readOnly: true });
    try {
      ids = (
        db
          .prepare(
            `SELECT c.id AS id FROM cards c JOIN attempts a ON a.card_id = c.id
             WHERE c.status = 'in_progress' AND a.status = 'running'
               AND a.attempt_number = (SELECT MAX(attempt_number) FROM attempts WHERE card_id = c.id)
             ORDER BY c.id`,
          )
          .all() as { id: string }[]
      ).map((r) => r.id);
    } finally {
      db.close();
    }
  } catch (err) {
    // An unreadable ledger is the Activity log row's to report.
    return check(
      "Crashed attempts",
      "pass",
      `not read: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (ids.length === 0)
    return check("Crashed attempts", "pass", "no attempt was left running by a stopped run");
  return check(
    "Crashed attempts",
    "warn",
    `${plural(ids.length, "issue")} stopped mid-attempt with no end recorded (a crash or a kill): ${ids.join(", ")}; the next start-up sweep returns ${ids.length === 1 ? "it" : "each"} to Ready from ${ids.length === 1 ? "its" : "their"} last checkpoint`,
  );
}

/**
 * SUR-82 (DEC-57, runtime item 35a): a workspace whose folder lies inside a
 * git repository — every install from before DEC-57 — loses its ledger to
 * one `git clean -xdf` there, and every project's history since the newest
 * backup with it.
 */
export function gitCleanCheck(workspaceFolder: string, now: Date = new Date()): DiagnosticCheck {
  const name = "Workspace in a git repository";
  if (!holdsLedger(workspaceFolder)) return check(name, "pass", "no Activity log here yet");
  let top: string;
  try {
    top = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: workspaceFolder,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 15_000,
    }).trim();
  } catch {
    return check(
      name,
      "pass",
      "the workspace folder is not inside a git repository, so `git clean` cannot reach its Activity log",
    );
  }
  let since = "there is no backup of it yet";
  try {
    const id = ledgerFacts(workspaceFolder).workspaceId;
    const set = id ? newestVerifiedBackup(id, now) : undefined;
    if (set) since = `the newest backup is ${hoursWords(set.ageHours)}`;
  } catch {
    // An unreadable ledger is the Activity log row's to report.
  }
  return check(
    name,
    "warn",
    `the workspace folder ${workspaceFolder} lies inside the git repository ${top}: \`git clean -xdf\` there deletes the Activity log, which git does not track, and loses every project's history since the newest backup (up to a day at the defaults); ${since}`,
    "run `sekhemet backup` before any `git clean -xdf` there",
  );
}

/**
 * TEAM-47: the Team server's public address (`[identity] public_url`) is
 * https; one that is not, or none, fails naming the documented TLS front.
 * Solo has no row.
 */
export function teamAddressCheck(
  repoPath: string,
  userPath: string = userConfigPath(),
): DiagnosticCheck | undefined {
  let config: ReturnType<typeof resolveConfig>["config"];
  try {
    config = resolveConfig({ repoPath, userConfigPath: userPath }).config;
  } catch {
    return undefined; // the configuration check reports it
  }
  if (config.team.mode !== "team") return undefined;
  const url = config.identity.publicUrl.trim();
  let https = false;
  try {
    https = new URL(url).protocol === "https:";
  } catch {
    // Not a URL: not https.
  }
  return https
    ? check("Team address", "pass", `people open ${url}, over TLS`)
    : check(
        "Team address",
        "fail",
        url
          ? `[identity] public_url is ${url}, which is not https: passwords and session cookies would cross the network in the clear`
          : "[identity] public_url is not set, so the Team server has no https address for people to open",
      );
}

/**
 * Surface item 21, SUR-92 (FINDINGS_C1 REL-06): each `config.toml` that does
 * not parse fails, named by file, line and column, since `run`, `queue` and
 * `overnight` refuse to start on it; a value refused (item 23's checks) is a
 * warning naming its key; otherwise the layers that were read.
 */
export function configurationCheck(
  repoPath: string,
  userPath: string = userConfigPath(),
): DiagnosticCheck {
  const resolved = resolveConfig({ repoPath, userConfigPath: userPath });
  if (resolved.parseErrors.length > 0)
    return check(
      "Configuration",
      "fail",
      `${resolved.parseErrors.map((e) => e.text).join("; ")}; this file is skipped, and run, queue and overnight refuse to start until it parses`,
      `fix ${resolved.parseErrors.length === 1 ? "that line" : "those lines"}, then run \`sekhemet doctor\` again`,
    );
  if (resolved.problems.length > 0)
    return check("Configuration", "warn", resolved.problems.join("; "));
  const files = resolved.layers.filter((l) => l === "user" || l === "project");
  return check(
    "Configuration",
    "pass",
    files.length
      ? `read ${files.map((l) => `the ${l} config.toml`).join(" and ")}`
      : "built-in defaults; no config.toml",
  );
}

/** Surface item 20e's rows for the workspace `repoPath` belongs to (SUR-83 to SUR-88). */
export function reliabilityChecks(repoPath: string): DiagnosticCheck[] {
  const workspaceFolder = workspaceFolderOf(repoPath);
  let workspaceId: string | undefined;
  try {
    workspaceId = holdsLedger(workspaceFolder)
      ? ledgerFacts(workspaceFolder).workspaceId
      : undefined;
  } catch {
    // An unreadable ledger is the Backup row's to report.
  }
  return [
    backupCheck(workspaceFolder),
    stayAwakeCheck(),
    powerCheck(repoPath),
    freeSpaceCheck(repoPath, workspaceFolder, resolveModelsDir()),
    credentialStoreCheck(workspaceId, workspaceFolder),
    modelLeaseCheck(),
    lostRecordsCheck(workspaceId),
  ];
}

/**
 * SEC-27c (B-12): where integration secrets are kept on this host. The OS
 * store passes; no store is a warning that says why and what happens — a
 * secret is not saved until one is installed or the person chooses a private
 * file in Integrations — and, once chosen, that it is their choice.
 */
export function secretStoreCheck(): DiagnosticCheck {
  const s = secretStoreStatus();
  return check("Secret store", s.store ? "pass" : "warn", s.message);
}

/**
 * EXT-10: a hooks.toml that does not load — invalid TOML, an unknown event, an
 * entry with no command — is named with its file and error, not discarded.
 */
export function hooksCheck(repoPath: string): DiagnosticCheck {
  const { errors, count } = hookEngineFor(repoPath);
  if (errors.length) return check("Hooks", "warn", errors.join("; "));
  return check("Hooks", "pass", count ? `${plural(count, "hook")} loaded` : "none declared");
}

/**
 * NEW-surface-1 (SUR-26): the one user directory, and what the one-time move
 * from `~/.config/sekhemet` did — a file left behind because its name was
 * taken is a warning naming it, never silently dropped.
 */
export function userDirCheck(): DiagnosticCheck {
  const dir = userDir();
  const move = readMoveRecord();
  if (!move) return check("User directory", "pass", dir);
  const moved = move.moved.length
    ? `moved ${plural(move.moved.length, "item")} from ${move.from} on ${(move.at ?? "").slice(0, 10)}`
    : `nothing moved from ${move.from}`;
  if (move.kept.length) {
    return check(
      "User directory",
      "warn",
      `${dir}: ${moved}; left in ${move.from} because ${dir} already has them: ${move.kept.join(", ")} — merge or delete them by hand`,
    );
  }
  return check("User directory", "pass", `${dir}: ${moved}`);
}

/**
 * EXT-28: plugins were cut (DEC-29 O4). A repository that still carries
 * `.sekhemet/plugins/` gets nothing loaded from it, and is told where the
 * same needs are met now.
 */
export function pluginsCheck(repoPath: string): DiagnosticCheck {
  const dir = join(repoPath, ".sekhemet", "plugins");
  if (!existsSync(dir)) return check("Plugins", "pass", "no plugins directory");
  const found = readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
  return check(
    "Plugins",
    "warn",
    `plugins are not supported and are not loaded${found.length ? ` (${found.join(", ")})` : ""}; use hooks (.sekhemet/hooks.toml) or MCP servers (.sekhemet/mcp.json) instead`,
  );
}

/**
 * SEC-15b (security item 31a): an entry of the project's `[project]
 * network_allow` that is a wildcard or an upload-capable host is warned
 * about here, where a person checks what they configured, as well as on
 * every card that runs under it (`card/egress_warning`).
 */
export function networkAllowlistCheck(repoPath: string): DiagnosticCheck {
  let hosts: readonly string[] = [];
  try {
    hosts = loadGatesConfig(repoPath).project.networkAllow ?? [];
  } catch {
    // A gates.toml that does not load is the configuration check's to name.
  }
  const warned = allowlistWarnings(hosts);
  if (warned.length === 0)
    return check(
      "Network allowlist",
      "pass",
      hosts.length
        ? `${hosts.length} host${hosts.length === 1 ? "" : "s"}; no wildcard or upload-capable entry`
        : "no hosts allowed to the project's checks",
    );
  return check(
    "Network allowlist",
    "warn",
    warned.map((w) => `${w.host} (${w.reason})`).join("; "),
  );
}

/**
 * SEC-52b (security item 29a): a project may turn research off for itself,
 * never on — its `research = "yes"` under the person's no (or no answer) is
 * ignored, and said here.
 */
export function researchConsentCheck(repoPath: string): DiagnosticCheck {
  const n = networkConfigs(repoPath);
  if (n.project.research === "yes" && n.user.research !== "yes") {
    return check(
      "Research",
      "warn",
      `this project's config.toml research = "yes" is ignored: your config.toml says ${n.user.research ? `research = "${n.user.research}"` : "nothing yet (research stays offline until you answer)"}, and only you can allow research`,
    );
  }
  const effective = n.user.research === "yes" && n.project.research !== "no" ? "yes" : "no";
  // DS-S8-8: a yes covers exactly the hosts its question named.
  const awaiting = awaitingResearchHosts(n.user);
  return check(
    "Research",
    "pass",
    effective === "yes"
      ? `research may use the network, through the network policy${awaiting.length ? `; ${awaiting.join(", ")} ${awaiting.length === 1 ? "awaits" : "await"} a yes (not named by the question you answered; not reached)` : ""}`
      : "research stays offline",
  );
}

/**
 * DS-N2-9: the research pipelines the latest golden-set run found worse for
 * a model, "not recommended", with its numbers; research routes each model
 * to the recommended one. Read-only; no ledger or no run passes.
 */
export async function researchPipelineCheck(repoPath: string): Promise<DiagnosticCheck> {
  const path = join(repoPath, ".sekhemet", "events.db");
  if (!existsSync(path)) return check("Research pipelines", "pass", "no golden-set run recorded");
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const lines = await researchDoctorLines(new EventLog(db));
    return lines.length
      ? check("Research pipelines", "warn", lines.join("; "))
      : check("Research pipelines", "pass", "no pipeline found worse on the Research quality set");
  } catch (err) {
    // A ledger older than the events table has no run to read.
    if (/no such table/i.test(String(err))) {
      return check("Research pipelines", "pass", "no golden-set run recorded");
    }
    throw err;
  } finally {
    db.close();
  }
}

/**
 * SUR-78 (kernel rule 38a): run in the workspace folder, rewrite every
 * project's missing or disagreeing locator from the ledger and report each
 * one; a project whose folder is gone is named with its fix.
 */
export function projectLocatorsCheck(repoPath: string): DiagnosticCheck {
  if (!holdsLedger(repoPath)) {
    return check(
      "Project locators",
      "pass",
      "not a workspace folder: its Activity log is elsewhere",
    );
  }
  let facts: ReturnType<typeof ledgerFacts>;
  try {
    facts = ledgerFacts(repoPath);
  } catch (err) {
    return check("Project locators", "warn", `the Activity log could not be read: ${String(err)}`);
  }
  const lines = rewriteLocators(repoPath, facts.projects, facts.workspaceId);
  const missing = lines.some((l) => l.includes("is missing"));
  return lines.length === 0
    ? check(
        "Project locators",
        "pass",
        `${facts.projects.length} project${facts.projects.length === 1 ? "" : "s"}, every locator agrees with the Activity log`,
      )
    : check("Project locators", missing ? "warn" : "pass", lines.join(" "));
}

/**
 * MS-M9-6: a Worker adopted or re-qualified owes the M0 protocol; the
 * overnight run does it first, or a person runs `sekhemet m0`.
 */
export function m0PendingCheck(repoPath: string): DiagnosticCheck {
  const pending = pendingM0InRepo(repoPath);
  return pending.length === 0
    ? check("First-run benchmark", "pass", "no Coding model owes its first-run benchmark")
    : check(
        "First-run benchmark",
        "warn",
        `First-run benchmark pending: ${pending.map((p) => `${p.worker} (${p.combination})`).join(", ")}; sekhemet overnight runs it first, or run sekhemet m0 --worker <name>`,
      );
}

/**
 * CX-N6-1, CX-N6-4: the models this build owes a re-verification, per role —
 * each qualified for the role under another prompt version and not yet under
 * this build's. Read without writing; the registry is shared by every build,
 * and what another build owes under its own version is not listed (F23).
 */
export function modelVerificationCheck(
  registry: ModelRegistry | undefined = hostRegistry(),
  versions: Readonly<Record<ModelRole, string>> = rolePromptVersions(),
): DiagnosticCheck {
  if (!registry) return check("Model verification", "pass", "no model list on this host");
  const owed = MODEL_ROLES.flatMap((role) =>
    registry.requalificationsOwed(versions[role], role).map((o) => ({ ...o, role })),
  );
  if (owed.length === 0)
    return check(
      "Model verification",
      "pass",
      "every verified model is verified for this build's prompts",
    );
  return check(
    "Model verification",
    "warn",
    `verify again on this machine, the prompts changed since: ${owed
      .map(
        (o) =>
          `${ROLE_WORDS[o.role]} ${o.modelId} (${o.reason}): sekhemet qualify --models ${o.modelId}${o.role === "worker" ? "" : ` --role ${o.role}`}`,
      )
      .join("; ")}`,
  );
}

/**
 * Models rule 14c, MD-N20-2 (NEW-models-20): a role whose configuration names
 * an Ollama cloud model — the person's assignment on this host, or the
 * project's `[models]` — fails, in the words the run refuses it with.
 */
export function ollamaCloudCheck(
  repoPath: string,
  registry: ModelRegistry | undefined = hostRegistry(),
  host: string = hostFingerprintHash(),
): DiagnosticCheck {
  const named: { role: ModelRole; model: string }[] = [];
  for (const role of MODEL_ROLES) {
    for (const scope of ["personal", "baseline", "default"] as const) {
      const model = registry ? currentAssignment(registry, host, role, scope)?.model : undefined;
      if (model) named.push({ role, model });
    }
  }
  try {
    const q = queueDefaults(effectiveConfig(repoPath).config, []);
    if (q.worker) named.push({ role: "worker", model: q.worker });
    if (q.manager) named.push({ role: "planner", model: q.manager });
  } catch {
    // An unreadable configuration is the configuration check's to report.
  }
  const refused = [
    ...new Map(
      named.filter((n) => isOllamaCloudTag(n.model)).map((n) => [`${n.role}|${n.model}`, n]),
    ).values(),
  ];
  return refused.length === 0
    ? check("Local models only", "pass", "no role names one of Ollama's cloud models")
    : check(
        "Local models only",
        "fail",
        refused.map((n) => ollamaCloudRefusal(n.model, n.role)).join(" "),
      );
}

/** X17, X18: the provenance and research registers, when the repository keeps them. */
function registersCheck(repoPath: string): DiagnosticCheck {
  if (!existsSync(join(repoPath, "docs", "reference", "PROVENANCE.md")))
    return {
      name: "Project records",
      status: "pass",
      detail: "no project records kept in this repository",
    };
  const problems = checkRegisters(repoPath);
  return problems.length === 0
    ? {
        name: "Project records",
        status: "pass",
        detail: "the provenance and research records are valid",
      }
    : { name: "Project records", status: "warn", detail: problems.slice(0, 3).join("; ") };
}

// ── the first hour's rows (models rules 5, 6a–6d; MD-N7-2, MD-N8-1, MD-N15-3) ──

/**
 * The inference engine (rules 6a, 6b; MD-N16-1, MD-N16-2, MD-N19-5): which
 * llama-server is used, where it came from and its build against the floor;
 * missing or below it, a fail naming this platform's first fix.
 */
export function engineDoctorCheck(s: EngineStatus = engineStatus()): DiagnosticCheck {
  if (s.engine && s.meetsFloor) return check("Inference engine", "pass", s.line);
  return check(
    "Inference engine",
    "fail",
    s.line,
    s.fixes[0] ?? "install llama.cpp's llama-server",
  );
}

/**
 * The memory floor (rule 6c, MD-N16-3; DEC-47 O-5): v1 supports 24 GB of
 * memory and above, read from `SUPPORTED_HARDWARE`; below it a warning, since
 * the person may continue at their own risk.
 */
export function memoryFloorCheck(totalBytes: number = totalmem()): DiagnosticCheck {
  const t = supportedTierFor(totalBytes);
  const gb = Math.round(totalBytes / 1024 ** 3);
  if (!t.supported)
    return check(
      "Memory floor",
      "warn",
      `${gb} GB installed; v1 supports 24 GB of memory and above, and the shipped models do not fit in this much`,
      "use a machine with 24 GB or more; you may continue here at your own risk",
    );
  return check(
    "Memory floor",
    "pass",
    `${gb} GB installed; v1 supports 24 GB and above (tier ${t.tier}: ${t.residency})`,
  );
}

/** The README's words for v1's engine (a test holds the two equal). */
export const README_ENGINE =
  "Local models only in v1, served by llama.cpp's `llama-server` (README)";

export interface RoleEngine {
  role: ModelRole;
  model: string;
  engine: "ollama" | "llama.cpp" | "other";
}

const engineOf = (a: LocalInferenceAdapter): RoleEngine["engine"] =>
  a instanceof ManagedLlamaServerAdapter
    ? "llama.cpp"
    : a instanceof HttpInferenceAdapter && a.api === "ollama"
      ? "ollama"
      : "other";

/** The model each role resolves to on this machine, and the engine that serves it. */
export function roleEngines(
  repoPath: string,
  registry: ModelRegistry | undefined = hostRegistry(),
): RoleEngine[] {
  if (!registry) return [];
  let configured: ReturnType<typeof queueDefaults> = {};
  try {
    configured = queueDefaults(effectiveConfig(repoPath).config, []);
  } catch {
    // An unreadable configuration is the configuration check's to report.
  }
  const out: RoleEngine[] = [];
  for (const role of MODEL_ROLES) {
    const name =
      roleModelName(role, undefined, { registry }) ??
      (role === "worker"
        ? (configured.worker ?? defaultWorkerName())
        : role === "planner"
          ? configured.manager
          : undefined);
    if (!name) continue;
    try {
      out.push({ role, model: name, engine: engineOf(describeModel(name, role, { registry })) });
    } catch {
      // A name the roster cannot resolve is the run's to refuse.
    }
  }
  return out;
}

/**
 * Ollama's role in v1 (rule 6d, MD-N16-4): the README names llama.cpp's
 * llama-server as v1's engine, so a role an Ollama model serves is named as
 * running outside that statement, in the README's words.
 */
export function ollamaRolesCheck(roles: readonly RoleEngine[]): DiagnosticCheck {
  const on = roles.filter((r) => r.engine === "ollama");
  if (on.length === 0)
    return check("Ollama's roles", "pass", `${README_ENGINE}; no role runs on Ollama.`);
  const which = on.map((r) => `the ${ROLE_WORDS[r.role]} (${r.model})`).join(" and ");
  return check(
    "Ollama's roles",
    "warn",
    `${README_ENGINE}; Ollama serves ${which}, outside that statement`,
    "assign a GGUF model to each on Configuration › Models, or run `sekhemet models assign <role> <model>`",
  );
}

/**
 * Each role's verification for its combination on this machine (MD-N8-1):
 * the Coding model as `run` and the queue resolve it, and every other role a
 * person assigned. Read without writing: no re-verification is scheduled.
 */
export function roleQualificationCheck(
  registry: ModelRegistry | undefined,
  opts: {
    repoPath?: string;
    describe?: (name: string, role: ModelRole) => LocalInferenceAdapter;
    deps?: CombinationDeps;
    host?: string;
    worker?: string;
  } = {},
): DiagnosticCheck {
  if (!registry) return check("Role verification", "warn", "no model list on this host");
  const host = opts.host ?? hostFingerprintHash();
  const describe =
    opts.describe ?? ((n: string, r: ModelRole) => describeModel(n, r, { registry }));
  let configured: ReturnType<typeof queueDefaults> = {};
  if (opts.repoPath)
    try {
      configured = queueDefaults(effectiveConfig(opts.repoPath).config, []);
    } catch {
      // The configuration check reports an unreadable file.
    }
  const lines: string[] = [];
  const unverified: string[] = [];
  let status: CheckStatus = "pass";
  for (const role of MODEL_ROLES) {
    const name =
      role === "worker"
        ? (opts.worker ??
          roleModelName("worker", undefined, { registry, host }) ??
          configured.worker ??
          defaultWorkerName())
        : roleModelName(role, undefined, { registry, host });
    if (!name) continue;
    let look: ReturnType<ModelRegistry["lookupQualification"]>;
    try {
      const adapter = describe(name, role);
      const combination = qualificationCombination(adapter, {
        ...opts.deps,
        ...(opts.deps?.host ? {} : { host: () => host }),
        registry,
        role,
      });
      look = registry.lookupQualification(adapter.modelId, combination);
    } catch (err) {
      lines.push(
        `${ROLE_WORDS[role]} ${name}: ${err instanceof Error ? err.message : String(err)}`,
      );
      status = role === "worker" ? "fail" : status === "fail" ? "fail" : "warn";
      continue;
    }
    if (look.status === "qualified") lines.push(`${ROLE_WORDS[role]} ${name}: verified`);
    else if (look.status === "overridden")
      lines.push(`${ROLE_WORDS[role]} ${name}: runs under an override (${look.reason})`);
    else {
      const state = look.status === "missing" ? "missing" : `${look.status}: ${look.reason}`;
      lines.push(`${ROLE_WORDS[role]} ${name}: not verified (${state})`);
      unverified.push(
        `sekhemet qualify --models ${name}${role === "worker" ? "" : ` --role ${role}`}`,
      );
      status = role === "worker" ? "fail" : status === "fail" ? "fail" : "warn";
    }
  }
  // SUR-62: one next step for every model not verified.
  const step =
    unverified.length === 0
      ? undefined
      : `Verify ${unverified.length === 1 ? "it" : "them"} on Configuration › Models, or run ${unverified.map((c) => `\`${c}\``).join(" and ")}`;
  return check("Role verification", status, lines.join("; "), step);
}

/**
 * The Team server's engines (MD-N15-3): each filled role's engine answers and
 * matches its profile, the unfilled Review role named, the footprint against
 * the headroom; any role with no engine or a refused one fails, with its step.
 */
export function teamEnginesCheck(report: TeamEnginesReport): DiagnosticCheck {
  const bad = report.engines.some((e) => e.state !== "ok") || report.footprint.fits === false;
  const detail = report.lines.join(" ");
  return bad
    ? check(
        "Team engines",
        "fail",
        detail,
        "start each engine service with its profile's arguments: `docker compose -f packaging/server/compose.yaml up` (docs/reference/INSTALL.md, For a team)",
      )
    : check("Team engines", "pass", detail);
}

/** The shipped or baseline source hash of a registry id, for a file the registry has not hashed. */
const shippedHash = (id: string): string | undefined =>
  [...SHIPPED_MODELS, ...MEASUREMENT_BASELINE].find((m) => m.id === id)?.source?.sha256;

/**
 * Rule 5, MD-N7-2 (FINDINGS CFG-05): each weights file the registry records,
 * and each managed file present, hashed and compared with its registered
 * SHA-256 (the registry's, else its source's, else the shipped table's).
 * A file's hash is kept by its path, size and modification time in the
 * same cache the Configuration page keeps (`model-hashes.json`), so a 13 GB
 * file is read once.
 */
export async function weightsHashCheck(
  opts: {
    registry?: ModelRegistry | undefined;
    files?: readonly { modelId: string; path: string }[];
    cachePath?: string;
    hash?: (path: string) => Promise<string>;
    /** SUR-89: read the files the cache does not hold (`--verify-weights`); otherwise only name them. */
    verify?: boolean;
    now?: () => number;
  } = {},
): Promise<DiagnosticCheck> {
  const now = opts.now ?? (() => Date.now());
  const registry = "registry" in opts ? opts.registry : hostRegistry();
  const files =
    opts.files ??
    (() => {
      try {
        return managedModelWeights({ registry });
      } catch {
        return [];
      }
    })();
  const cachePath = opts.cachePath ?? join(sekhemetConfigDir(), "model-hashes.json");
  const hash = opts.hash ?? ((p: string) => sha256File(p));
  const todo = new Map<string, { modelId: string; expected: string }>();
  for (const e of registry?.list() ?? []) {
    const path = registry?.preferredWeights(e.id, existsSync);
    const expected = e.sha256 ?? e.source?.sha256;
    if (path && expected) todo.set(path, { modelId: e.id, expected });
  }
  for (const f of files) {
    if (todo.has(f.path) || !existsSync(f.path)) continue;
    const e = registry?.get(f.modelId);
    const expected = e?.sha256 ?? e?.source?.sha256 ?? shippedHash(f.modelId);
    if (expected) todo.set(f.path, { modelId: f.modelId, expected });
  }
  if (todo.size === 0)
    return check("Weights' hashes", "pass", "no registered model file on this machine to check");
  let cache: Record<string, string> = {};
  try {
    cache = JSON.parse(readFileSync(cachePath, "utf8")) as Record<string, string>;
  } catch {
    // No cache yet.
  }
  let wrote = false;
  const bad: string[] = [];
  /** The models whose file differs, each downloaded again (SUR-62's one step). */
  const refetch = new Set<string>();
  const unread: { path: string; bytes: number }[] = [];
  /** Verified here before, at this size, and written since: not read again without the flag. */
  const changed: string[] = [];
  let compared = 0;
  const started = now();
  for (const [path, { modelId, expected }] of todo) {
    let key: string;
    let bytes: number;
    try {
      const st = statSync(path);
      key = `${path}\0${st.size}\0${Math.round(st.mtimeMs)}`;
      bytes = st.size;
    } catch {
      continue;
    }
    let sha = cache[key];
    if (!sha || !/^[0-9a-f]{64}$/.test(sha)) {
      // SUR-89: about 42 GB on the reference machine; read only when asked.
      if (!opts.verify) {
        // The cheap signals, read without reading the file (C4 review): a
        // size other than the registered one, or than the file verified
        // here before, cannot have the registered hash.
        const entry = registry?.get(modelId);
        const registered = entry?.sizeBytes ?? entry?.source?.sizeBytes;
        const verified = Object.entries(cache)
          .filter(([k, v]) => k.startsWith(`${path}\0`) && v === expected)
          .map(([k]) => Number(k.split("\0")[1]));
        const was =
          registered !== undefined && registered !== bytes
            ? `the registered ${formatBytes(registered)}`
            : verified.length > 0 && !verified.includes(bytes)
              ? `the ${formatBytes(verified[0] as number)} verified before`
              : undefined;
        if (was) {
          bad.push(
            `${modelId}: the file is ${formatBytes(bytes)}, not ${was}, so its hash differs from the registered one (${path})`,
          );
          refetch.add(modelId);
        } else if (verified.length > 0) changed.push(path);
        else unread.push({ path, bytes });
        continue;
      }
      try {
        sha = await hash(path);
      } catch (err) {
        bad.push(
          `${modelId}: could not be read (${err instanceof Error ? err.message : String(err)})`,
        );
        continue;
      }
      cache[key] = sha;
      wrote = true;
    }
    compared++;
    if (sha !== expected) {
      bad.push(`${modelId}: the file's hash differs from the registered one (${path})`);
      refetch.add(modelId);
    }
  }
  if (wrote)
    try {
      mkdirSync(dirname(cachePath), { recursive: true });
      writeFileSync(cachePath, JSON.stringify(cache));
    } catch {
      // The cache is a convenience; a failed write only means hashing again.
    }
  const tookMs = now() - started;
  const unverified = [
    changed.length
      ? `${plural(changed.length, "model file")} changed since ${changed.length === 1 ? "it was" : "they were"} verified (${changed.join(", ")}): run \`sekhemet doctor --verify-weights\` to check ${changed.length === 1 ? "it" : "them"}`
      : "",
    unreadWords(unread),
  ].filter(Boolean);
  if (bad.length)
    return check(
      "Weights' hashes",
      "fail",
      [...bad, ...unverified].join("; "),
      refetch.size
        ? `download ${refetch.size === 1 ? "it" : "them"} again on Configuration › Models, or run ${[...refetch].map((m) => `\`sekhemet models fetch ${m}\``).join(" and ")}`
        : "check that the models folder is readable, then run `sekhemet doctor --verify-weights` again",
    );
  const matched = compared
    ? `${plural(compared, "model file")} ${compared === 1 ? "matches its" : "match their"} registered SHA-256${opts.verify ? ` (read in ${durationWords(tookMs)})` : ""}`
    : "";
  // SUR-89: a file not read was not checked, so it is never a pass.
  return check(
    "Weights' hashes",
    unverified.length ? "warn" : "pass",
    [matched, ...unverified].filter(Boolean).join("; "),
  );
}

/** The policy rate for the time-to-verify estimate (SUR-89): 1 GB/s. */
export const HASH_BYTES_PER_SECOND = 1024 ** 3;

function durationWords(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  return s < 90 ? `${s} s` : `${Math.round(s / 60)} min`;
}

/** The files `doctor` did not read, their size, and how long reading them takes (SUR-89). */
function unreadWords(unread: readonly { path: string; bytes: number }[]): string {
  if (unread.length === 0) return "";
  const bytes = unread.reduce((n, f) => n + f.bytes, 0);
  return `${plural(unread.length, "model file")} (${formatBytes(bytes)}) not verified yet: reading ${unread.length === 1 ? "it" : "them"} takes about ${durationWords((bytes / HASH_BYTES_PER_SECOND) * 1000)}; run \`sekhemet doctor --verify-weights\` to check ${unread.length === 1 ? "it" : "them"}`;
}

// ── C4's reliability rows (surface item 20e, NEW-surface-12: SUR-83 to SUR-88) ──

/**
 * Events recorded after `seq`, read without writing; a backup's own
 * `ledger/backed_up` record is not counted, since it changes nothing a
 * backup holds.
 */
function eventsAfter(workspaceFolder: string, seq: number): number {
  const db = new DatabaseSync(ledgerPathOf(workspaceFolder), { readOnly: true });
  try {
    return (
      db
        .prepare("SELECT COUNT(*) AS n FROM events WHERE seq > ? AND type <> 'ledger/backed_up'")
        .get(seq) as { n: number }
    ).n;
  } finally {
    db.close();
  }
}

const hoursWords = (h: number): string => {
  const n = Math.floor(h);
  return n < 1 ? "less than an hour old" : `${n} hour${n === 1 ? "" : "s"} old`;
};

/**
 * Backup (SUR-83, runtime RUN-63): the age and path of the workspace's
 * newest verified set; a warning when it is over 48 hours old while events
 * were recorded since, or when the ledger has events and there is no set.
 */
export function backupCheck(workspaceFolder: string, now: Date = new Date()): DiagnosticCheck {
  if (!holdsLedger(workspaceFolder)) return check("Backup", "pass", "no Activity log here");
  let workspaceId: string | undefined;
  let head: number;
  try {
    workspaceId = ledgerFacts(workspaceFolder).workspaceId;
    head = eventsAfter(workspaceFolder, 0);
  } catch (err) {
    return check("Backup", "warn", `the Activity log could not be read: ${String(err)}`);
  }
  if (!workspaceId || head === 0) return check("Backup", "pass", "nothing recorded yet to back up");
  const set = newestVerifiedBackup(workspaceId, now);
  if (!set)
    return check(
      "Backup",
      "warn",
      `no backup of this workspace yet, and ${plural(head, "event")} recorded only in ${ledgerPathOf(workspaceFolder)}`,
      "run `sekhemet backup`",
    );
  const since = eventsAfter(workspaceFolder, set.manifest.seq);
  const age = `the newest backup, ${set.path}, is ${hoursWords(set.ageHours)}`;
  if (set.ageHours > 48 && since > 0)
    return check(
      "Backup",
      "warn",
      `${age} and ${plural(since, "event")} were recorded since`,
      "run `sekhemet backup`",
    );
  return check(
    "Backup",
    "pass",
    `${age}${since > 0 ? `; ${plural(since, "event")} recorded since` : ""}`,
  );
}

/** Staying awake (SUR-84, RUN-66): the tool that keeps the machine awake, or a warning. */
export function stayAwakeCheck(
  os: NodeJS.Platform = process.platform,
  path: string = process.env.PATH ?? "",
): DiagnosticCheck {
  const cmd = sleepAssertionCommand(os, process.pid);
  if (!cmd)
    return check(
      "Staying awake",
      "warn",
      `no tool keeps the machine awake on ${os}: an unattended run may stop when the machine sleeps`,
    );
  const found = findOnPath(cmd.tool, path);
  if (!found)
    return check(
      "Staying awake",
      "warn",
      `${cmd.tool} is not on PATH: an unattended run may stop when the machine sleeps`,
    );
  // RUN-66 (C4 review, proved in the Lima VM): a tool on PATH can still be
  // refused — polkit denies `systemd-inhibit` in a headless session — so the
  // assertion is taken and given back, the way a run takes it.
  const probe = spawnSync(found, sleepAssertionProbe(cmd.tool), {
    encoding: "utf8",
    timeout: 5_000,
    env: { ...process.env, PATH: path },
  });
  if (probe.status !== 0) {
    const said =
      `${probe.stderr ?? ""}`.trim().split("\n")[0] ||
      probe.error?.message ||
      `exit ${probe.status}`;
    return check(
      "Staying awake",
      "warn",
      `${found} refused to keep the machine awake (${said}): an unattended run may stop when the machine sleeps`,
    );
  }
  return check("Staying awake", "pass", `${found} keeps the machine awake while a runner works`);
}

/** Where the machine draws its power from, as far as it says. */
export type PowerSource = "battery" | "ac" | "none" | "unknown";

/** `pmset -g batt` (macOS): on battery, on mains with a battery, or no battery. */
export function parsePmsetBatt(out: string): PowerSource {
  if (/drawing from 'Battery Power'/.test(out)) return "battery";
  if (/InternalBattery/.test(out)) return "ac";
  if (/drawing from 'AC Power'/.test(out)) return "none";
  return "unknown";
}

/** Linux's `/sys/class/power_supply`: a mains supply online, a battery discharging, or none. */
export function linuxPowerSource(dir = "/sys/class/power_supply"): PowerSource {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return "unknown";
  }
  const read = (n: string, f: string): string => {
    try {
      return readFileSync(join(dir, n, f), "utf8").trim();
    } catch {
      return "";
    }
  };
  const batteries = names.filter((n) => read(n, "type") === "Battery");
  if (batteries.length === 0) return "none";
  if (names.some((n) => read(n, "type") !== "Battery" && read(n, "online") === "1")) return "ac";
  return batteries.some((n) => read(n, "status") === "Discharging") ? "battery" : "ac";
}

/** This machine's power source, read from the operating system. */
export function powerSource(os: NodeJS.Platform = platform()): PowerSource {
  if (os === "linux") return linuxPowerSource();
  if (os !== "darwin") return "unknown";
  try {
    return parsePmsetBatt(
      execFileSync("pmset", ["-g", "batt"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 5_000,
      }),
    );
  } catch {
    return "unknown";
  }
}

const WINDOW_KEYS = ["machine.reserved_hours", "machine.hours", "machine.overnight_hours"];

/**
 * Power (SUR-84, RUN-68): on battery while an overnight window is set in a
 * `config.toml`, a warning that a closed lid or a battery sleep stops the night.
 */
export function powerCheck(
  repoPath: string,
  source: PowerSource = powerSource(),
  userPath: string = userConfigPath(),
): DiagnosticCheck {
  if (source === "unknown")
    return check("Power", "pass", "the power source could not be read on this machine");
  if (source === "none")
    return check("Power", "pass", "no battery: the machine runs on mains power");
  if (source === "ac") return check("Power", "pass", "on mains power");
  const sources = resolveConfig({ repoPath, userConfigPath: userPath }).sources;
  const window = WINDOW_KEYS.some((k) => sources[k] === "user" || sources[k] === "project");
  if (!window) return check("Power", "pass", "on battery power; no overnight window is set");
  return check(
    "Power",
    "warn",
    "on battery power with an overnight window set: Sekhemet keeps the machine from idle sleep only, so a closed lid or a sleep the battery forces stops the night",
    "plug the machine in for the night",
  );
}

/**
 * Free space (SUR-85, RUN-71): the repository's volume (and the ledger's,
 * when another) and the models folder's, against the floor; below it on the
 * first a failure, since no issue starts, and on the models' a warning.
 */
export function freeSpaceCheck(
  repoPath: string,
  workspaceFolder: string,
  modelsDir: string,
  opts: { floorBytes?: number; modelsFloorBytes?: number } = {},
): DiagnosticCheck {
  const work = checkFreeSpace(
    [repoPath, workspaceFolder],
    opts.floorBytes !== undefined ? { floorBytes: opts.floorBytes } : {},
  );
  const line = (v: { mount: string; freeBytes: number }, floor: number, what: string) =>
    `${what} (${v.mount}): ${formatBytes(v.freeBytes)} free of a ${formatBytes(floor)} floor`;
  const lines = work.volumes.map((v, i) =>
    line(v, work.floorBytes, i === 0 ? "the repository" : "the Activity log"),
  );
  let modelsShort = false;
  if (!existsSync(modelsDir)) lines.push(`the models folder ${modelsDir} does not exist`);
  else {
    const models = checkFreeSpace([modelsDir], {
      floorBytes: opts.modelsFloorBytes ?? work.floorBytes,
    });
    const v = models.volumes[0];
    if (v) lines.push(line(v, models.floorBytes, "the models"));
    modelsShort = !models.ok;
  }
  if (!work.ok) {
    const consumers = work.consumers.map((c) => `${c.path} (${formatBytes(c.bytes)})`);
    return check(
      "Free space",
      "fail",
      `${lines.join("; ")}; below the floor no issue starts${consumers.length ? `; the largest under .sekhemet/: ${consumers.join(", ")}` : ""}`,
      `free space on ${work.short.mount}`,
    );
  }
  if (modelsShort)
    return check(
      "Free space",
      "warn",
      `${lines.join("; ")}; the models' volume is below it`,
      "free space for the models",
    );
  return check("Free space", "pass", lines.join("; "));
}

/** The store's one-time move as the workspace's ledger records it (SEC-N14-2), read-only. */
function recordedIdentityMove(workspaceFolder: string): IdentityMove | undefined {
  const path = join(workspaceFolder, ".sekhemet", "events.db");
  if (!existsSync(path)) return undefined;
  try {
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      return readIdentityMove(db);
    } finally {
      db.close();
    }
  } catch {
    return undefined; // an unreadable ledger is the Backup row's to report
  }
}

/**
 * Credential store (SUR-86, security SEC-N14-2): this workspace's store, the
 * one-time move from the old place, and a store still left there.
 */
export function credentialStoreCheck(
  workspaceId: string | undefined,
  workspaceFolder?: string,
): DiagnosticCheck {
  const root = identityRoot();
  const parts: string[] = [];
  if (workspaceId) {
    const dir = identityDir(workspaceId);
    parts.push(`this workspace's store is ${dir}${existsSync(dir) ? "" : " (nothing kept yet)"}`);
  }
  const move = workspaceFolder ? recordedIdentityMove(workspaceFolder) : undefined;
  if (move)
    parts.push(
      `moved ${move.moved.join(" and ")} from ${move.from} to ${move.to} on ${move.at.slice(0, 10)}`,
    );
  const left = [CREDENTIALS_FILE, "setup-token"]
    .map((f) => join(root, f))
    .filter((f) => existsSync(f));
  if (left.length)
    return check(
      "Credential store",
      "warn",
      `${[...parts, `a store is still at the old place, ${left.join(" and ")}, and no workspace has claimed it`].join("; ")}`,
      `set [team] mode = "team" in ${userConfigPath()} and run \`sekhemet serve\` in the folder of the workspace it belongs to: a Team server moves the store into its workspace (a Solo server refuses to start beside a store)`,
    );
  return check(
    "Credential store",
    "pass",
    parts.length ? parts.join("; ") : "no workspace here, and nothing at the old place",
  );
}

/**
 * Model lease (SUR-87, models MD-N17-1): free, held by a live process (a
 * warning: a load here waits for it), or left by a process that is gone.
 */
export function modelLeaseCheck(path: string = modelLeasePath()): DiagnosticCheck {
  const lease = readModelLease(path);
  if (!lease) return check("Model lease", "pass", "free: no process holds this machine's models");
  if (!modelLeaseLive(lease))
    return check(
      "Model lease",
      "pass",
      `a stale lease from pid ${lease.pid}, whose process is gone; the next load takes it over`,
    );
  return check(
    "Model lease",
    "warn",
    `another process holds this machine's model lease: ${modelLeaseHolderWords(lease)}; a load here waits for it`,
    `wait for that run to finish, or stop it (pid ${lease.pid})`,
  );
}

/** Lost records (SUR-88, runtime RUN-89): the lost-record log's count, and its path. */
export function lostRecordsCheck(workspaceId: string | undefined): DiagnosticCheck {
  const n = countLostRecords(workspaceId);
  const path = lostRecordsPath(workspaceId);
  return n === 0
    ? check("Lost records", "pass", "every record was written")
    : check(
        "Lost records",
        "warn",
        `${plural(n, "record")} could not be written; each is listed in ${path}`,
      );
}
