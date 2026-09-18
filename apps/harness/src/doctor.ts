import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { freemem, platform, totalmem } from "node:os";
import { join } from "node:path";
import { classifyMemoryPressure } from "@sekhemet/models";
import { ProcessSandbox } from "@sekhemet/sandbox";

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
async function probeInference(endpoints: string[]): Promise<DiagnosticCheck> {
  for (const base of endpoints) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1500);
      const res = await fetch(`${base}/api/tags`, { signal: controller.signal }).catch(() =>
        fetch(`${base}/v1/models`, { signal: controller.signal }),
      );
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
    const out = execFileSync(name, args, {
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
    check(
      "Unified memory",
      pressure.level === "normal" ? "pass" : pressure.level === "warning" ? "warn" : "fail",
      `${gb(free)} GB free of ${gb(total)} GB (${(pressure.usedRatio * 100).toFixed(0)}% used, ${pressure.level})`,
    ),
    await probeInference(["http://127.0.0.1:11434", "http://127.0.0.1:8099"]),
    probeWorktrees(repoPath),
    await probeConfinement(repoPath),
    probeBinary("node", ["--version"], "Node runtime"),
    probeBinary("git", ["--version"], "Git"),
    probeBinary("pnpm", ["--version"], "pnpm"),
    probeSkills(repoPath),
  ];

  return { ok: checks.every((c) => c.status !== "fail"), checks };
}
