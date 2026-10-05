import { execFileSync } from "node:child_process";
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
import { dirname, join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { EventLog } from "@sekhemet/kernel";
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
  ollamaCloudRefusal,
  probeModelWeights,
  readKernelPressureLevel,
  sekhemetConfigDir,
  sha256File,
  supportedTierFor,
} from "@sekhemet/models";
import { ProcessSandbox } from "@sekhemet/sandbox";
import { plural } from "@sekhemet/ui";
import { userConfigPath } from "./config.js";
import {
  defaultWorkerName,
  effectiveConfig,
  networkConfigs,
  queueDefaults,
} from "./config_apply.js";
import { configUpgradeCheck } from "./config_upgrade.js";
import { toolProbeOptions } from "./init.js";
import { pendingM0InRepo } from "./m0_path.js";
import { describeModel, roleModelName } from "./model_access.js";
import { setupFor } from "./planner_live.js";
import { rolePromptVersions } from "./prompt_versions.js";
import { type CombinationDeps, qualificationCombination } from "./qualify.js";
import { checkRegisters } from "./registers.js";
import { researchDoctorLines } from "./research_bakeoff.js";
import { awaitingResearchHosts } from "./research_consent.js";
import { secretStoreStatus } from "./secret_store.js";
import { type TeamEnginesReport, checkTeamEngines } from "./team_engines.js";
import { readMoveRecord, userDir } from "./user_dir.js";
import { hookEngineFor } from "./user_hooks.js";
import { playbookDoctorCheck } from "./wave2.js";
import { holdsLedger, ledgerFacts, rewriteLocators } from "./workspace_locator.js";

export type CheckStatus = "pass" | "warn" | "fail";

export interface DiagnosticCheck {
  name: string;
  status: CheckStatus;
  detail: string;
}

export interface DoctorReport {
  ok: boolean;
  checks: DiagnosticCheck[];
}

function check(name: string, status: CheckStatus, detail: string): DiagnosticCheck {
  return { name, status, detail };
}

/** Probe a local inference server's model list over HTTP. */
export async function probeInference(endpoints: string[]): Promise<DiagnosticCheck> {
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

  return check(
    "Model server",
    "fail",
    `no inference server reachable at ${endpoints.join(" or ")} — start Ollama or llama-server`,
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
    return check(label, "fail", `not runnable: ${message.split("\n")[0] ?? message}`);
  }
}

/** Confirm git worktree support by listing the repo's actual worktrees. */
function probeWorktrees(repoPath: string): DiagnosticCheck {
  try {
    const out = execFileSync("git", ["worktree", "list", "--porcelain"], {
      cwd: repoPath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const count = out.split("\n").filter((l) => l.startsWith("worktree ")).length;
    return check("Git worktree isolation", "pass", `${plural(count, "worktree")} registered`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return check("Git worktree isolation", "fail", message.split("\n")[0] ?? message);
  }
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
export async function runDoctor(repoPath: string = process.cwd()): Promise<DoctorReport> {
  const total = totalmem();
  const free = freemem();
  const pressure = classifyMemoryPressure(total - free, total);
  const gb = (n: number): string => (n / 1024 ** 3).toFixed(1);

  const checks: DiagnosticCheck[] = [
    memoryCheck(pressure, free, total, gb),
    // Rule 6c, MD-N16-3: the memory floor v1 supports.
    memoryFloorCheck(total),
    // Rules 6a and 6b: which engine, where it came from, its build against the floor.
    engineDoctorCheck(),
    weightsCheck(),
    // Rule 5, MD-N7-2: each weights file's hash against the registered one.
    await weightsHashCheck(),
    // MD-N8-1: each assigned role verified for its combination on this machine.
    roleQualificationCheck(hostRegistry(), { repoPath }),
    // Rule 6d, MD-N16-4: which roles Ollama serves, in the README's words.
    ollamaRolesCheck(roleEngines(repoPath)),
    // MD-N15-3: on the Team server, each filled role's engine answers and matches.
    ...(setupFor(repoPath) === "team" ? [teamEnginesCheck(await checkTeamEngines())] : []),
    // Ollama, the managed Worker server (cyber-tiel, 8098) and the legacy 8099.
    await probeInference([
      "http://127.0.0.1:11434",
      "http://127.0.0.1:8098",
      "http://127.0.0.1:8099",
    ]),
    probeWorktrees(repoPath),
    await probeConfinement(repoPath),
    probeBinary("node", ["--version"], "Node runtime"),
    probeBinary("git", ["--version"], "Git"),
    probeBinary("pnpm", ["--version"], "pnpm"),
    probeSkills(repoPath),
    // E19, C12: rule net gain, context bloat, pruning recommendations.
    playbookDoctorCheck(repoPath),
    registersCheck(repoPath),
    pluginsCheck(repoPath),
    m0PendingCheck(repoPath),
    modelVerificationCheck(),
    ollamaCloudCheck(repoPath),
    userDirCheck(),
    // SUR-43: each renamed config key an upgrade rewrote, with its backup.
    configUpgradeCheck([join(repoPath, ".sekhemet", "config.toml"), userConfigPath()]),
    hooksCheck(repoPath),
    researchConsentCheck(repoPath),
    await researchPipelineCheck(repoPath),
    secretStoreCheck(),
    // SUR-78: every project's locator, rewritten from the ledger.
    projectLocatorsCheck(repoPath),
  ];

  return { ok: checks.every((c) => c.status !== "fail"), checks };
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

/** A detail that is not a pass, ending with its next step (SUR-62, NEW-surface-8). */
function withDo(detail: string, step: string): string {
  const end = (t: string) => (/[.!?]$/.test(t) ? t : `${t}.`);
  return `${end(detail)} Do: ${end(step)}`;
}

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
    withDo(s.line, s.fixes[0] ?? "install llama.cpp's llama-server"),
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
      withDo(
        `${gb} GB installed; v1 supports 24 GB of memory and above, and the shipped models do not fit in this much`,
        "use a machine with 24 GB or more; you may continue here at your own risk",
      ),
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
    withDo(
      `${README_ENGINE}; Ollama serves ${which}, outside that statement`,
      "assign a GGUF model to each on Configuration › Models, or run `sekhemet models assign <role> <model>`",
    ),
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
      lines.push(
        withDo(
          `${ROLE_WORDS[role]} ${name}: not verified (${state})`,
          `Verify it on Configuration › Models, or run \`sekhemet qualify --models ${name}${role === "worker" ? "" : ` --role ${role}`}\``,
        ),
      );
      status = role === "worker" ? "fail" : status === "fail" ? "fail" : "warn";
    }
  }
  return check("Role verification", status, lines.join("; "));
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
        withDo(
          detail,
          "start each engine service with its profile's arguments: `docker compose -f packaging/server/compose.yaml up` (docs/reference/INSTALL.md, For a team)",
        ),
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
  } = {},
): Promise<DiagnosticCheck> {
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
  for (const [path, { modelId, expected }] of todo) {
    let key: string;
    try {
      const st = statSync(path);
      key = `${path}\0${st.size}\0${Math.round(st.mtimeMs)}`;
    } catch {
      continue;
    }
    let sha = cache[key];
    if (!sha || !/^[0-9a-f]{64}$/.test(sha)) {
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
    if (sha !== expected)
      bad.push(
        withDo(
          `${modelId}: the file's hash differs from the registered one (${path})`,
          `download it again on Configuration › Models, or run \`sekhemet models fetch ${modelId}\``,
        ),
      );
  }
  if (wrote)
    try {
      mkdirSync(dirname(cachePath), { recursive: true });
      writeFileSync(cachePath, JSON.stringify(cache));
    } catch {
      // The cache is a convenience; a failed write only means hashing again.
    }
  if (bad.length) return check("Weights' hashes", "fail", bad.join("; "));
  return check(
    "Weights' hashes",
    "pass",
    `${plural(todo.size, "model file")} ${todo.size === 1 ? "matches its" : "match their"} registered SHA-256`,
  );
}
