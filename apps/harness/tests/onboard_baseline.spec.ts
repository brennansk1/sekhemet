import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BASELINE_EVENT, loadGatesConfig } from "@sekhemet/gates";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { afterEach, describe, expect, it } from "vitest";
import { baselineInput, cardGateRunner } from "../src/card_gates.js";
import { loadBaseline, recordBaselineShrink, runOnboard } from "../src/onboard.js";

// NEW-gates-7, GT-BF-2 (gates rule 15a): onboarding records the repository's
// pre-existing diagnostics and failing and flaky tests — the suite run twice,
// confined — as one `project/baseline` event on the ledger, and a card's
// gates then count only what is new. Real git, real SQLite, real processes.

const REPO = join(import.meta.dirname, "..", "..", "..");
const VITEST = join(REPO, "node_modules", "vitest", "vitest.mjs");

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const CHECK = `import { existsSync, readFileSync } from "node:fs";
const lines = existsSync("errors.txt") ? readFileSync("errors.txt", "utf8").split("\\n").filter(Boolean) : [];
for (const l of lines) console.log(l);
process.exit(lines.length ? 2 : 0);
`;
const GATES = `
[[gate]]
id = "typecheck"
rung = "typecheck"
command = "node"
args = ["check.mjs"]
parser = "tsc"

[[gate]]
id = "unit"
rung = "test"
command = "node"
args = [${JSON.stringify(VITEST)}, "run", "--reporter=default"]
parser = "vitest"
timeout_s = 120
`;
const OLD = "src/a.ts(2,10): error TS2304: Cannot find name 'missing'.";

function repo(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "onboard-baseline-")));
  dirs.push(root);
  const files: Record<string, string> = {
    "package.json": '{ "name": "ob", "type": "module", "private": true }\n',
    ".gitignore": ".sekhemet/onboard/\n.sekhemet/state/\nnode_modules/\n",
    ".sekhemet/gates.toml": GATES,
    "check.mjs": CHECK,
    "errors.txt": `${OLD}\n`,
    "src/a.ts": "export function a(): number {\n  return missing;\n}\n",
    "tests/old.spec.ts":
      'import { expect, it } from "vitest";\nit("was broken", () => { expect(1).toBe(2); });\n',
  };
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), text);
  }
  const git = (...a: string[]) => execFileSync("git", a, { cwd: root, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "e@x");
  git("config", "user.name", "E");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  return root;
}

function ledger() {
  const db = new DatabaseSync(":memory:");
  initSchema(db);
  const log = new EventLog(db);
  return { log, cardStore: new CardStore(db, log) };
}

describe("onboarding records the baseline (GT-BF-2, rule 15a)", () => {
  it("runs the gates, the suite twice, and records one project/baseline event", async () => {
    const root = repo();
    const store = ledger();
    const lines: string[] = [];
    const report = await runOnboard(root, {
      trusted: true,
      store,
      say: (l) => lines.push(l),
      lspServers: {},
    });

    const events = await store.log.getEventsByTypes([BASELINE_EVENT]);
    expect(events).toHaveLength(1);
    const payload = events[0]?.payload as {
      kind: string;
      entries: { rule: string; file: string }[];
      runs: { gate: string; run: number; exitCode: number }[];
      gatesSha256: string;
    };
    expect(payload.kind).toBe("recorded");
    expect(payload.entries.map((e) => `${e.file}|${e.rule}`).sort()).toEqual([
      "src/a.ts|TS2304",
      "tests/old.spec.ts|was broken",
    ]);
    expect(payload.runs.filter((r) => r.gate === "unit").map((r) => r.run)).toEqual([1, 2]);
    expect(payload.gatesSha256).toBe(loadGatesConfig(root).sha256);
    expect(report.baseline).toMatchObject({ entries: 2, flaky: 0 });
    expect(
      JSON.parse(readFileSync(join(root, ".sekhemet/onboard/baseline.json"), "utf8")).entries,
    ).toHaveLength(2);
    expect(lines.some((l) => /^8\. Baseline: 2 pre-existing/.test(l))).toBe(true);
  });

  it("a card's gates count only what the card added, and a disappearance shrinks the baseline once accepted", async () => {
    const root = repo();
    const store = ledger();
    await runOnboard(root, { trusted: true, store, say: () => undefined, lspServers: {} });
    const baseline = await loadBaseline(store.log);
    expect(baseline?.entries).toHaveLength(2);

    const runner = cardGateRunner({
      repoPath: root,
      gatesConfig: loadGatesConfig(root),
      restricted: false,
      card: {},
      baseline: baseline?.entries ?? [],
      onBaselineShrink: (gone) => recordBaselineShrink(store.log, gone, "c1"),
    });
    const same = await runner.runGates(["typecheck", "test"], root);
    expect(same.failures.filter((f) => f.rung === "typecheck" || f.rung === "test")).toEqual([]);

    // The card fixes the old error: the baseline shrinks, but only once c1 is accepted.
    writeFileSync(join(root, "errors.txt"), "");
    await runner.runGates(["typecheck"], root);
    expect((await loadBaseline(store.log))?.entries).toHaveLength(2);
    await store.log.append({ actor: "human", type: "card/accepted", payload: { id: "c1" } });
    expect((await loadBaseline(store.log))?.entries.map((e) => e.rule)).toEqual(["was broken"]);
  });

  // Review M4: the shrink is the card's last judged run's, recorded even when
  // empty, so a diagnostic an early run lacked but a later run found again
  // stays after the card is accepted.
  it("keeps a diagnostic a later run found again, once the card is accepted", async () => {
    const root = repo();
    const store = ledger();
    await runOnboard(root, { trusted: true, store, say: () => undefined, lspServers: {} });
    const runner = cardGateRunner({
      repoPath: root,
      gatesConfig: loadGatesConfig(root),
      restricted: false,
      card: {},
      ...baselineInput(await loadBaseline(store.log)),
      onBaselineShrink: (gone, gates) => recordBaselineShrink(store.log, gone, "c1", gates),
    });
    writeFileSync(join(root, "errors.txt"), "");
    await runner.runGates(["typecheck"], root);
    writeFileSync(join(root, "errors.txt"), `${OLD}\n`);
    await runner.runGates(["typecheck"], root);
    await store.log.append({ actor: "human", type: "card/accepted", payload: { id: "c1" } });
    expect((await loadBaseline(store.log))?.entries.map((e) => e.rule).sort()).toEqual([
      "TS2304",
      "was broken",
    ]);
  });

  // Review M2: a file only partly readable at onboarding is recorded with the
  // baseline; a card's reachability verdict partial on it is forgiven and listed.
  it("records files the source index reads only in part, and forgives a partial verdict on one", async () => {
    const root = repo();
    writeFileSync(join(root, "src/legacy.ts"), "export const x = (;\n");
    execFileSync("git", ["add", "-A"], { cwd: root });
    execFileSync("git", ["commit", "-qm", "legacy"], { cwd: root });
    const store = ledger();
    await runOnboard(root, { trusted: true, store, say: () => undefined, lspServers: {} });
    const loaded = await loadBaseline(store.log);
    expect(loaded?.partial.map((p) => p.file)).toEqual(["src/legacy.ts"]);
    const runner = cardGateRunner({
      repoPath: root,
      gatesConfig: loadGatesConfig(root),
      restricted: false,
      card: { spec: "Add b." },
      ...baselineInput(loaded),
    });
    // The card adds an export, so the gate reads the project's files for its users.
    writeFileSync(
      join(root, "src/a.ts"),
      "export function a(): number {\n  return missing;\n}\nexport const b = 1;\n",
    );
    const r = await runner.runGates(["typecheck"], root);
    const reach = r.rungResults?.find((o) => o.gate === "reachability");
    expect(reach?.passed).toBe(true);
    expect(reach?.partial).toEqual([
      expect.objectContaining({ file: "src/legacy.ts", baselined: true }),
    ]);
    expect(r.failures.filter((f) => f.gate === "reachability")).toEqual([]);
  });

  // Minor 4: after gates.toml changed, the baseline is not applied.
  it("does not apply a baseline taken with another gates.toml, and says re-baseline needed", async () => {
    const root = repo();
    const store = ledger();
    await runOnboard(root, { trusted: true, store, say: () => undefined, lspServers: {} });
    writeFileSync(join(root, ".sekhemet/gates.toml"), `${GATES}\n# changed\n`);
    const runner = cardGateRunner({
      repoPath: root,
      gatesConfig: loadGatesConfig(root),
      restricted: false,
      card: {},
      ...baselineInput(await loadBaseline(store.log)),
    });
    const r = await runner.runGates(["typecheck"], root);
    expect(r.failures.filter((f) => f.rung === "typecheck")).toHaveLength(1);
    expect(r.rungResults?.find((o) => o.gate === "typecheck")?.note).toMatch(/re-baseline needed/);
  });

  it("without a ledger the baseline is still written for the person to read", async () => {
    const root = repo();
    const report = await runOnboard(root, { trusted: true, say: () => undefined, lspServers: {} });
    expect(report.baseline?.entries).toBe(2);
  });
});
