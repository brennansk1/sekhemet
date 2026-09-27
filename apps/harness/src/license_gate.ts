import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  type GateFailure,
  type GateResult,
  type GateRung,
  type GateRunner,
  RERUN_GATES,
  type RunGatesOptions,
  type RungOutcome,
  gateCopy,
} from "@sekhemet/gates";
import { judgeLicence } from "./pm/libraries.js";
import { readProvenance } from "./registers.js";

/**
 * The licence register as a gate (X20). A card that adds a dependency whose
 * licence is not permissive (the one classifier, `classifyLicence`, that
 * Seshat's library search and the reuse survey also use; design-stage P7)
 * fails verification unless the component is listed
 * with that licence in docs/reference/PROVENANCE.md. A licence that cannot
 * be read locally fails too: install the package, or register it.
 *
 * Only additions are judged, against the base branch, so an existing
 * dependency never blocks an unrelated card. Everything is read offline:
 * installed package.json files, `pip show`, and the cargo registry cache.
 */

type Ecosystem = "npm" | "pypi" | "crates";

interface Manifest {
  file: string;
  ecosystem: Ecosystem;
  deps: (text: string) => string[];
}

const npm = (text: string): string[] => {
  try {
    const p = JSON.parse(text) as Record<string, Record<string, string> | undefined>;
    return Object.entries({
      ...(p.dependencies ?? {}),
      ...(p.devDependencies ?? {}),
      ...(p.optionalDependencies ?? {}),
      ...(p.peerDependencies ?? {}),
    })
      .filter(([, v]) => !String(v).startsWith("workspace:"))
      .map(([k]) => k);
  } catch {
    return [];
  }
};
const pypi = (text: string): string[] =>
  text
    .split("\n")
    .map((l) => l.replace(/#.*/, "").trim())
    .filter((l) => l && !l.startsWith("-"))
    .map((l) => l.split(/[<>=!~[; ]/)[0] as string)
    .filter(Boolean);
const crates = (text: string): string[] => {
  const out: string[] = [];
  let inDeps = false;
  for (const line of text.split("\n")) {
    const section = /^\s*\[([^\]]+)\]/.exec(line)?.[1];
    if (section) {
      inDeps = /(^|\.)(dev-|build-)?dependencies$/.test(section);
      continue;
    }
    const m = inDeps ? /^\s*([A-Za-z0-9_-]+)\s*=/.exec(line) : null;
    if (m) out.push(m[1] as string);
  }
  return out;
};

function manifests(root: string): Manifest[] {
  const out: Manifest[] = [];
  const dirs = [""];
  for (const group of ["packages", "apps", "crates"]) {
    if (!existsSync(join(root, group))) continue;
    for (const d of readdirSync(join(root, group), { withFileTypes: true }))
      if (d.isDirectory()) dirs.push(join(group, d.name));
  }
  for (const d of dirs) {
    if (existsSync(join(root, d, "package.json")))
      out.push({ file: join(d, "package.json"), ecosystem: "npm", deps: npm });
    if (existsSync(join(root, d, "requirements.txt")))
      out.push({ file: join(d, "requirements.txt"), ecosystem: "pypi", deps: pypi });
    if (existsSync(join(root, d, "Cargo.toml")))
      out.push({ file: join(d, "Cargo.toml"), ecosystem: "crates", deps: crates });
  }
  return out;
}

function atBase(root: string, base: string, file: string): string | undefined {
  try {
    return execFileSync("git", ["show", `${base}:${file}`], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return undefined;
  }
}

/** The installed licence of a dependency, read locally. */
export function localLicense(
  root: string,
  manifestFile: string,
  ecosystem: Ecosystem,
  dep: string,
): string | undefined {
  if (ecosystem === "npm") {
    for (let dir = join(root, dirname(manifestFile)); ; dir = dirname(dir)) {
      const pkg = join(dir, "node_modules", dep, "package.json");
      if (existsSync(pkg)) {
        const j = JSON.parse(readFileSync(pkg, "utf8")) as {
          license?: string | { type?: string };
          licenses?: { type?: string }[];
        };
        const l = j.license ?? j.licenses?.map((x) => x.type).join(" OR ");
        return typeof l === "string" ? l : l?.type;
      }
      // Up past the root too: a card worktree sits inside the repository.
      if (dirname(dir) === dir) return undefined;
    }
  }
  if (ecosystem === "pypi") {
    // -I (SEC-36): a repository's PYTHONPATH or ./pip cannot stand in for pip.
    const r = spawnSync("python3", ["-I", "-m", "pip", "show", dep], {
      encoding: "utf8",
      timeout: 15_000,
    });
    const license = /^License(?:-Expression)?: (.+)$/m.exec(r.stdout ?? "")?.[1]?.trim();
    return license && license !== "UNKNOWN" ? license : undefined;
  }
  const registry = join(homedir(), ".cargo", "registry", "src");
  if (!existsSync(registry)) return undefined;
  for (const index of readdirSync(registry)) {
    const hit = readdirSync(join(registry, index))
      .filter((d) => d.startsWith(`${dep}-`) && /^\d/.test(d.slice(dep.length + 1)))
      .sort()
      .at(-1);
    if (hit) {
      const toml = readFileSync(join(registry, index, hit, "Cargo.toml"), "utf8");
      return /^license\s*=\s*"([^"]+)"/m.exec(toml)?.[1];
    }
  }
  return undefined;
}

function registered(root: string, dep: string, license: string | undefined): boolean {
  const esc = dep.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  const named = new RegExp(`(^|[^\\w@/.-])${esc}($|[^\\w@/.-])`, "i");
  return readProvenance(root).licenses.some(
    (l) =>
      named.test(l.component) &&
      (!license || l.license.toLowerCase().includes(license.toLowerCase())),
  );
}

export interface LicenseFinding {
  manifest: string;
  dep: string;
  license?: string;
  ok: boolean;
  why: string;
}

function judge(root: string, m: Manifest, dep: string): LicenseFinding {
  const license = localLicense(root, m.file, m.ecosystem, dep);
  const verdict = judgeLicence(license);
  if (license && verdict.usable)
    return { manifest: m.file, dep, license, ok: true, why: "permissive" };
  if (registered(root, dep, license))
    return {
      manifest: m.file,
      dep,
      ...(license ? { license } : {}),
      ok: true,
      why: "listed in the licence register",
    };
  return {
    manifest: m.file,
    dep,
    ...(license ? { license } : {}),
    ok: false,
    why: license
      ? (verdict.note ?? `${license} is not permissive`)
      : "no licence could be read locally",
  };
}

/** Every direct dependency of the repository, judged (`sekhemet register licenses`). */
export function repoLicenseAudit(root: string): LicenseFinding[] {
  const out: LicenseFinding[] = [];
  for (const m of manifests(root))
    for (const dep of m.deps(readFileSync(join(root, m.file), "utf8")))
      out.push(judge(root, m, dep));
  return out;
}

/** The gate: dependencies added since `base`, judged. */
export function licenseGate(
  root: string,
  base = "main",
): { failures: GateFailure[]; advisories: string[]; skipped?: string } {
  const failures: GateFailure[] = [];
  const advisories: string[] = [];
  try {
    execFileSync("git", ["rev-parse", "--verify", "-q", `${base}^{commit}`], {
      cwd: root,
      stdio: "ignore",
    });
  } catch {
    // No base to compare against: every dependency would look new.
    return {
      failures,
      advisories: [`licences: no ${base} branch to compare against; skipped`],
      skipped: `no ${base} branch to compare against`,
    };
  }
  for (const m of manifests(root)) {
    const before = new Set(m.deps(atBase(root, base, m.file) ?? ""));
    const added = m.deps(readFileSync(join(root, m.file), "utf8")).filter((d) => !before.has(d));
    for (const dep of added) {
      const f = judge(root, m, dep);
      if (f.ok) {
        if (f.why !== "permissive") advisories.push(`licence: ${dep} (${f.license}) ${f.why}`);
        continue;
      }
      failures.push({
        rung: "security",
        gate: "licenses",
        layer: "security",
        exitCode: 1,
        errorExcerpt: `${m.file} adds "${dep}"${f.license ? ` (${f.license})` : ""}: ${f.why}`,
        suggestedFixFiles: [m.file],
        location: { file: m.file },
        actual: dep,
        expected: "a permissive licence, or an entry in docs/reference/PROVENANCE.md (Licences)",
        minimalRepro: RERUN_GATES,
        suggestedAction: f.license
          ? gateCopy.licenseNotPermissive(dep, f.license)
          : gateCopy.licenseUnknown(dep),
      });
    }
  }
  return { failures, advisories };
}

/**
 * Wrap a gate runner so every verification also runs the licence gate
 * (execute.ts wraps the card runner's gates with it).
 */
export function withLicenseGate(inner: GateRunner, repoRoot: string, base = "main"): GateRunner {
  return {
    // GT-M6-5: the gate this wrapper adds, for `note`'s enum.
    gateIds: [...(inner.gateIds ?? []), "licenses"],
    runGates: async (
      rungs: GateRung[],
      cwd: string,
      runOptions?: RunGatesOptions,
    ): Promise<GateResult> => {
      const res = await inner.runGates(rungs, cwd, runOptions);
      const started = Date.now();
      let lic: { failures: GateFailure[]; skipped?: string };
      try {
        lic = licenseGate(cwd || repoRoot, base);
      } catch (err) {
        // Fail closed (gates rule 9): a licence gate that could not run is
        // reported as not run, never passed and never absent.
        const reason = (err instanceof Error ? err.message : String(err)).split("\n")[0] ?? "";
        lic = {
          failures: [
            {
              rung: "security",
              gate: "licenses",
              layer: "security",
              exitCode: -1,
              errorExcerpt: `licenses not run: ${reason}`,
              suggestedFixFiles: [],
              location: { file: "." },
              expected: "every new dependency's licence read",
              actual: reason || "the licence gate could not run",
              minimalRepro: RERUN_GATES,
              suggestedAction: gateCopy.gateNotRun("licenses"),
              notRun: true,
            },
          ],
        };
      }
      const outcome = {
        gate: "licenses",
        rung: "security",
        layer: "security",
        passed: lic.failures.length === 0,
        exitCode: lic.failures.length === 0 ? 0 : 1,
        durationMs: Date.now() - started,
        ...(lic.skipped ? { skipped: true, reason: lic.skipped } : {}),
      } satisfies RungOutcome;
      return {
        ...res,
        passed: res.passed && lic.failures.length === 0,
        failures: [...res.failures, ...lic.failures],
        rungResults: [...(res.rungResults ?? []), outcome],
      };
    },
  };
}
