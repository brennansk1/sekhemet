import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cli, g2Env, ledgerRows, ledgerText, scratch, track } from "./support/g2_cli.js";
import { FAKE_TOKEN, halfDoneFixture } from "./takeover_fixture.js";

/**
 * The take-over through its door (design-stage §2.10 steps 1–3, DS-TO-1 to
 * DS-TO-8; FINISH_LINE_PLAN C2d): `sekhemet take-over` spawned as the built
 * binary in the half-built fixture repository, first untrusted, then after
 * `sekhemet trust --yes`. Real git, real subprocesses, the real ledger file
 * the binary wrote; no model (SEKHEMET_MODEL_LOADS=off) and no network.
 *
 * The binary under test is `apps/harness/dist/index.js`, spawned by
 * `support/g2_cli.ts`.
 */

type Finding = { id: string; kind: string; path?: string; line?: number; commit?: string };
type Detail = { id: string; reason: string; command?: string };

function inventories(repo: string) {
  return ledgerRows(repo)
    .filter((r) => r.type === "takeover/inventory")
    .map((r) => ({
      seq: r.seq,
      baselineSeq: r.payload.baselineSeq as number,
      findings: r.payload.findings as Finding[],
      details: (r.private?.findingDetails ?? []) as Detail[],
      recon: JSON.parse(String(r.private?.recon ?? "{}")) as Record<string, unknown>,
    }));
}

const at = (f: Finding) => `${f.kind}:${f.path ?? ""}:${f.line ?? ""}`;
const gitStatus = (repo: string) =>
  execFileSync("git", ["status", "--porcelain", "--ignored"], { cwd: repo, encoding: "utf8" })
    .split("\n")
    .filter(Boolean);

describe("sekhemet take-over, untrusted (DS-TO-1 to DS-TO-5, DS-TO-8)", () => {
  it("DS-TO-1, DS-TO-2, DS-TO-3, DS-TO-4, DS-TO-5, DS-TO-8: runs nothing, scans the history, lists submodules and agent config, records recon and every half-done piece", async () => {
    const fx = halfDoneFixture();
    track(fx.root);
    const env = g2Env(join(scratch(), "home"));
    const r = await cli(["take-over"], { cwd: fx.root, env });
    expect(r.status, r.stderr).toBe(0);

    // DS-TO-1: nothing of the repository ran — no lifecycle script, no build,
    // no hook from .claude/, no node_modules; only the harness's own .sekhemet/
    // appeared in the working tree.
    for (const m of Object.values(fx.markers)) expect(existsSync(m)).toBe(false);
    expect(existsSync(join(fx.root, "node_modules"))).toBe(false);
    expect(existsSync(join(fx.root, "pwned"))).toBe(false);
    expect(gitStatus(fx.root)).toEqual(["?? .sekhemet/"]);
    expect(r.stdout).toMatch(/Nothing runs yet: the repository is not trusted/);
    expect(r.stdout).toContain("install: npm install --ignore-scripts --offline");
    expect(r.stdout).not.toMatch(/→ exit/);
    const rows = ledgerRows(fx.root);
    expect(rows.some((x) => x.type === "project/baseline")).toBe(false);

    // DS-TO-3: every commit scanned with the bundled rules (gitleaks is not
    // installed here), the finding's commit, path and rule — never the secret.
    const scanned = rows.filter((x) => x.type === "takeover/secrets_scanned");
    expect(scanned.map((x) => x.payload)).toEqual([
      {
        scanner: "builtin",
        commits: 4,
        findings: [{ commit: fx.leakCommit, path: "src/config.ts", rule: "github-pat" }],
      },
    ]);
    expect(r.stdout).toContain("4 commits scanned for secrets with builtin; 1 to rotate");
    const middle = FAKE_TOKEN().slice(4, 20);
    expect(r.stdout + r.stderr).not.toContain(middle);
    expect(ledgerText(fx.root)).not.toContain(middle);

    const [inv] = inventories(fx.root);
    if (!inv) throw new Error("no takeover/inventory");
    expect(inv.baselineSeq).toBe(0);
    const found = inv.findings.map(at);
    const reason = (kind: string, path: string) =>
      inv.details.find(
        (d) => d.id === inv.findings.find((f) => f.kind === kind && f.path === path)?.id,
      )?.reason;
    // DS-TO-2: another agent's configuration is listed as inert, never run.
    expect(found).toEqual(
      expect.arrayContaining(["agent_config:.claude/settings.json:", "agent_config:AGENTS.md:"]),
    );
    expect(reason("agent_config", "AGENTS.md")).toMatch(/inert: never run.*untrusted/);
    // DS-TO-4: the submodule listed with its path and URL, never cloned.
    expect(found).toContain("submodule:vendor/pdfkit:");
    expect(reason("submodule", "vendor/pdfkit")).toContain("https://example.invalid/pdfkit.git");
    expect(readdirSync(fx.root)).not.toContain("vendor");
    // DS-TO-8: each half-done piece with its file and line.
    expect(found).toEqual(
      expect.arrayContaining([
        "stub:src/export.ts:2",
        "skipped_test:tests/export.spec.ts:2",
        "todo_test:tests/export.spec.ts:3",
        "no_handler:src/server.ts:4",
        "missing_import:src/report.ts:1",
        "no_migration:prisma/schema.prisma:1",
      ]),
    );
    expect(r.stdout).toMatch(
      /Inventory: 1 secret, 2 agent config, 1 submodule, 1 stub, 1 skipped test, 1 todo test, 1 no migration, \d missing import, 1 no handler\./,
    );

    // DS-TO-5: recon with no model — manifests, scripts, the repo map, the
    // commits, the unmerged branch with its last commit, the hotspots, the
    // TODO, the docs; dependency age not checked offline, vulnerabilities not checked.
    expect(rows.some((x) => x.type.startsWith("model/"))).toBe(false);
    const recon = inv.recon as {
      manifests: string[];
      scripts: Record<string, string>;
      repoMap: { files: number; top: string[] };
      commits: { commit: string }[];
      branches: { name: string; commit: string }[];
      hotspots: { path: string }[];
      todos: { path: string; line: number }[];
      docs: string[];
      dependencyAge: string;
      vulnerabilities: string;
    };
    expect(recon.manifests).toContain("package.json");
    expect(Object.keys(recon.scripts)).toEqual(
      expect.arrayContaining(["preinstall", "postinstall", "build", "test"]),
    );
    expect(recon.repoMap.files).toBeGreaterThan(0);
    expect(recon.repoMap.top).toContain("src/export.ts");
    expect(recon.commits).toHaveLength(4);
    expect(recon.branches.map((b) => b.name)).toEqual(["feature/email"]);
    expect(recon.branches[0]?.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(recon.hotspots[0]?.path).toBe("src/config.ts");
    expect(recon.todos).toEqual([{ path: "src/report.ts", line: 2 }]);
    expect(recon.docs).toContain("README.md");
    expect(recon.dependencyAge).toBe("not checked: offline");
    expect(recon.vulnerabilities).toMatch(/^not checked/);
    expect(r.stdout).toMatch(/dependency age not checked: offline; vulnerabilities not checked/);
  }, 60_000);
});

describe("sekhemet trust --yes, then take-over (DS-TO-6, DS-TO-7)", () => {
  it("DS-TO-6, DS-TO-7: installs with scripts off, records each command's exit, a failed build as could-not-build, and the suite twice as the baseline", async () => {
    const fx = halfDoneFixture({ buildFails: true });
    track(fx.root);
    const env = g2Env(join(scratch(), "home"));
    const first = await cli(["take-over"], { cwd: fx.root, env });
    expect(first.status, first.stderr).toBe(0);
    const trust = await cli(["trust", "--yes"], { cwd: fx.root, env });
    expect(trust.status, trust.stderr).toBe(0);
    expect(trust.stdout).toMatch(/Trusted this repository/);
    const r = await cli(["take-over"], { cwd: fx.root, env, timeoutMs: 120_000 });
    expect(r.status, r.stderr).toBe(0);

    // DS-TO-6: lifecycle scripts stayed off; the build ran; each command with its exit code.
    expect(existsSync(fx.markers.preinstall)).toBe(false);
    expect(existsSync(fx.markers.postinstall)).toBe(false);
    expect(existsSync(fx.markers.build)).toBe(true);
    expect(r.stdout).toMatch(
      /install: npm install --ignore-scripts --offline --no-audit --no-fund → exit \d+/,
    );
    expect(r.stdout).toContain("build: npm run build → exit 2");
    // The suite run twice, recorded as the onboarding baseline the inventory points at.
    const rows = ledgerRows(fx.root);
    const baseline = rows.find((x) => x.type === "project/baseline");
    if (!baseline) throw new Error("no project/baseline");
    const runs = baseline.payload.runs as {
      rung: string;
      run: number;
      command: string;
      exitCode: number;
      failing: unknown[];
    }[];
    expect(runs.filter((x) => x.rung === "test").map((x) => x.run)).toEqual([1, 2]);
    expect(runs.every((x) => x.command === "npm run test" && x.exitCode === 0)).toBe(true);
    expect(runs.every((x) => Array.isArray(x.failing))).toBe(true);
    expect(r.stdout).toMatch(/Baseline: .*the suite run twice/);
    const last = inventories(fx.root).at(-1);
    if (!last) throw new Error("no inventory");
    expect(last.baselineSeq).toBe(baseline.seq);

    // DS-TO-7: the failed build is a could-not-build finding with its reason,
    // and the take-over went on to the baseline, the brief and the backlog.
    const cannot = last.findings
      .filter((f) => f.kind === "could_not_build")
      .map((f) => last.details.find((d) => d.id === f.id));
    const build = cannot.find((d) => d?.command === "npm run build");
    expect(build?.reason).toMatch(/^exited 2: Cannot find module \.\/chart\.js/);
    expect(r.stdout).toMatch(/could not build/);
    expect(r.stdout).toMatch(/Backlog proposed as TOP-\d+/);
    // The repository's own history is untouched.
    expect(
      execFileSync("git", ["rev-list", "--count", "--all"], {
        cwd: fx.root,
        encoding: "utf8",
      }).trim(),
    ).toBe("4");
  }, 180_000);
});
