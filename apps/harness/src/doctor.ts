import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { freemem, platform, totalmem } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { EventLog } from "@sekhemet/kernel";
import {
  MODEL_ROLES,
  ModelRegistry,
  type ModelRole,
  ROLE_WORDS,
  type WeightsReport,
  classifyMemoryPressure,
  managedModelWeights,
  probeModelWeights,
  readKernelPressureLevel,
} from "@sekhemet/models";
import { ProcessSandbox } from "@sekhemet/sandbox";
import { userConfigPath } from "./config.js";
import { networkConfigs } from "./config_apply.js";
import { configUpgradeCheck } from "./config_upgrade.js";
import { toolProbeOptions } from "./init.js";
import { pendingM0InRepo } from "./m0_path.js";
import { rolePromptVersions } from "./prompt_versions.js";
import { checkRegisters } from "./registers.js";
import { researchDoctorLines } from "./research_bakeoff.js";
import { awaitingResearchHosts } from "./research_consent.js";
import { secretStoreStatus } from "./secret_store.js";
import { readMoveRecord, userDir } from "./user_dir.js";
import { hookEngineFor } from "./user_hooks.js";
import { playbookDoctorCheck } from "./wave2.js";

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
          "Local inference socket",
          found.length > 0 ? "pass" : "warn",
          found.length > 0
            ? `${base} reachable — ${found.length} model(s): ${found.slice(0, 3).join(", ")}`
            : `${base} reachable but serving no models`,
        );
      }
    } catch {
      // Try the next endpoint.
    }
  }

  return check(
    "Local inference socket",
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
    return check("Git worktree isolation", "pass", `${count} worktree(s) registered`);
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
    return check(
      "Sandbox confinement",
      "warn",
      `no OS confinement available on ${platform()} — commands run unconfined`,
    );
  }

  const escapePath = join("/", "sekhemet_doctor_escape_probe");
  const result = await sandbox.execute(
    process.execPath,
    ["-e", `require('fs').writeFileSync(${JSON.stringify(escapePath)},'x')`],
    { allowedPaths: [repoPath], allowNetwork: false, timeoutMs: 10_000, cwd: repoPath },
  );

  return result.exitCode === 0
    ? check("Sandbox confinement", "fail", "escape probe WROTE OUTSIDE the worktree")
    : check(
        "Sandbox confinement",
        "pass",
        `seatbelt active — escape probe refused (exit ${result.exitCode})`,
      );
}

/** Report on the skills directory the context engine loads from. */
function probeSkills(repoPath: string): DiagnosticCheck {
  const dir = join(repoPath, ".sekhemet", "skills");
  if (!existsSync(dir)) {
    return check("Skills registry", "warn", `${dir} not present — no skills will load`);
  }
  try {
    const entries = execFileSync("ls", ["-1", dir], { encoding: "utf8" }).trim();
    const count = entries ? entries.split("\n").length : 0;
    return check("Skills registry", count > 0 ? "pass" : "warn", `${count} skill(s) discoverable`);
  } catch {
    return check("Skills registry", "warn", "skills directory unreadable");
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
      `${report.present} model file(s) present in ${report.modelsDir}`,
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
    weightsCheck(),
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
    userDirCheck(),
    // SUR-43: each renamed config key an upgrade rewrote, with its backup.
    configUpgradeCheck([join(repoPath, ".sekhemet", "config.toml"), userConfigPath()]),
    hooksCheck(repoPath),
    researchConsentCheck(repoPath),
    await researchPipelineCheck(repoPath),
    secretStoreCheck(),
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
  return check("Hooks", "pass", count ? `${count} hook(s) loaded` : "none declared");
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
    ? `moved ${move.moved.length} item(s) from ${move.from} on ${(move.at ?? "").slice(0, 10)}`
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
      : check("Research pipelines", "pass", "no pipeline found worse on the research golden set");
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
 * MS-M9-6: a Worker adopted or re-qualified owes the M0 protocol; the
 * overnight run does it first, or a person runs `sekhemet m0`.
 */
export function m0PendingCheck(repoPath: string): DiagnosticCheck {
  const pending = pendingM0InRepo(repoPath);
  return pending.length === 0
    ? check("M0", "pass", "no Coding model owes the M0 protocol")
    : check(
        "M0",
        "warn",
        `M0 pending: ${pending.map((p) => `${p.worker} (${p.combination})`).join(", ")}; sekhemet overnight runs it first, or run sekhemet m0 --worker <name>`,
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
  if (!registry) return check("Model verification", "pass", "no model registry on this host");
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

/** X17, X18: the provenance and research registers, when the repository keeps them. */
function registersCheck(repoPath: string): DiagnosticCheck {
  if (!existsSync(join(repoPath, "docs", "reference", "PROVENANCE.md")))
    return { name: "Registers", status: "pass", detail: "no registers kept in this repository" };
  const problems = checkRegisters(repoPath);
  return problems.length === 0
    ? { name: "Registers", status: "pass", detail: "provenance and research registers are valid" }
    : { name: "Registers", status: "warn", detail: problems.slice(0, 3).join("; ") };
}
