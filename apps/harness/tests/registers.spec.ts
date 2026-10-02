import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import type { DeterministicGateRunner } from "@sekhemet/gates";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { afterEach, describe, expect, it } from "vitest";
import { runDoctor } from "../src/doctor.js";
import { licenseGate, repoLicenseAudit, withLicenseGate } from "../src/license_gate.js";
import {
  advanceResearchEntry,
  checkRegisters,
  markdownTable,
  readProvenance,
  readResearchRegister,
  validateResearchRegister,
} from "../src/registers.js";
import { runDevCommand } from "../src/wave2.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});
const write = (root: string, rel: string, text: string) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};

function fixtureRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "sek-reg-"));
  dirs.push(root);
  mkdirSync(join(root, "docs/reference"), { recursive: true });
  mkdirSync(join(root, "docs/research"), { recursive: true });
  writeFileSync(
    join(root, "docs/reference/PROVENANCE.md"),
    readFileSync(join(ROOT, "docs/reference/PROVENANCE.md"), "utf8"),
  );
  writeFileSync(
    join(root, "docs/research/RESEARCH_REGISTER.md"),
    readFileSync(join(ROOT, "docs/research/RESEARCH_REGISTER.md"), "utf8"),
  );
  write(root, "package.json", JSON.stringify({ name: "x", dependencies: { "left-pad": "1" } }));
  write(root, "node_modules/left-pad/package.json", JSON.stringify({ license: "SSPL-1.0" }));
  write(root, ".gitignore", "node_modules/\n");
  const git = (...a: string[]) => execFileSync("git", a, { cwd: root, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "e@x");
  git("config", "user.name", "E");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  return root;
}

describe("X17/X18: the registers in this repository are well-formed", () => {
  it("PROVENANCE.md maps techniques to sources and lists licences", () => {
    const p = readProvenance(ROOT);
    expect(p.techniques.length).toBeGreaterThan(10);
    expect(p.techniques.every((t) => t.source && /^\d{4}-\d{2}-\d{2}$/.test(t.verified))).toBe(
      true,
    );
    expect(p.licenses.find((l) => /semgrep/i.test(l.component))?.license).toBe("LGPL-2.1");
  });

  it("reads a register's table as Markdown: an example table in a code block is not the register (DEC-44)", () => {
    const md = [
      "## Techniques",
      "",
      "```",
      "| A | B |",
      "| --- | --- |",
      "| x | y |",
      "```",
      "",
      "| Technique | Public source |",
      "| --- | --- |",
      "| Repo map | `aider` (Apache-2.0) |",
      "",
      "## Licences",
      "",
      "| Component | Licence |",
      "| --- | --- |",
      "| semver | ISC |",
    ].join("\n");
    expect(markdownTable(md, "techniques")).toEqual([
      { technique: "Repo map", "public source": "`aider` (Apache-2.0)" },
    ]);
    expect(markdownTable(md, "Licences")).toEqual([{ component: "semver", licence: "ISC" }]);
    expect(markdownTable(md, "Missing")).toEqual([]);
  });

  it("RESEARCH_REGISTER.md follows the lifecycle rules, and the whole check passes", () => {
    const entries = readResearchRegister(ROOT);
    expect(entries.map((e) => e.state)).toContain("shortlisted");
    expect(validateResearchRegister(entries)).toEqual([]);
    expect(checkRegisters(ROOT)).toEqual([]);
  });

  it("every dependency of this repository has a permissive or registered licence", () => {
    const audit = repoLicenseAudit(ROOT);
    expect(audit.length).toBeGreaterThan(0);
    expect(audit.filter((a) => !a.ok)).toEqual([]);
  });
});

describe("X18: lifecycle rules", () => {
  it("refuses skipped states, a missing threshold and evidence, and a threshold set after the move", () => {
    const base = {
      id: "R1",
      technique: "t",
      source: "s",
      threshold: "",
      thresholdSet: "",
      evidence: "",
      updated: "2026-09-19",
    };
    expect(validateResearchRegister([{ ...base, state: "shortlisted" }])[0]).toMatch(/threshold/);
    expect(
      validateResearchRegister([
        { ...base, state: "benched", threshold: "x", thresholdSet: "2026-09-19" },
      ])[0],
    ).toMatch(/evidence/);
    expect(
      validateResearchRegister([
        {
          ...base,
          state: "benched",
          threshold: "x",
          thresholdSet: "2026-09-20",
          evidence: "run 4",
        },
      ])[0],
    ).toMatch(/after/);
    expect(validateResearchRegister([{ ...base, state: "maybe" }])[0]).toMatch(/state/);

    const root = fixtureRepo();
    expect(() => advanceResearchEntry(root, "R7", "benched", {})).toThrow(/spotted -> benched/);
    advanceResearchEntry(root, "R7", "triaged", { now: "2026-09-20" });
    expect(() => advanceResearchEntry(root, "R7", "shortlisted", { now: "2026-09-20" })).toThrow(
      /threshold/,
    );
    advanceResearchEntry(root, "R7", "shortlisted", {
      threshold: "Beats the incumbent by one card",
      now: "2026-09-20",
    });
    advanceResearchEntry(root, "R7", "benched", {
      evidence: "bake-off 2026-09-21: +2 cards",
      now: "2026-09-21",
    });
    const r7 = readResearchRegister(root).find((e) => e.id === "R7");
    expect(r7).toMatchObject({
      state: "benched",
      thresholdSet: "2026-09-20",
      updated: "2026-09-21",
    });
    expect(checkRegisters(root)).toEqual([]);
  });
});

describe("X20: the licence register is enforced as a gate", () => {
  it("fails a card that adds a copyleft dependency, passes a registered or permissive one", async () => {
    const root = fixtureRepo();
    // left-pad (SSPL-1.0, unregistered) was already there: only additions are judged.
    expect(licenseGate(root, "main")).toEqual({ failures: [], advisories: [] });
    write(
      root,
      "package.json",
      JSON.stringify({
        name: "x",
        dependencies: { "left-pad": "1", "gpl-thing": "1", pixelmatch: "5", "no-licence": "1" },
      }),
    );
    write(root, "node_modules/gpl-thing/package.json", JSON.stringify({ license: "GPL-3.0" }));
    write(root, "node_modules/pixelmatch/package.json", JSON.stringify({ license: "ISC" }));
    const r = licenseGate(root, "main");
    expect(r.failures.map((f) => f.actual)).toEqual(["gpl-thing", "no-licence"]);
    expect(r.failures[0]).toMatchObject({ gate: "licenses", rung: "security" });
    expect(r.failures[0]?.errorExcerpt).toMatch(/GPL-3.0/);
    // Registering the component with its licence admits it.
    const prov = join(root, "docs/reference/PROVENANCE.md");
    writeFileSync(
      prov,
      readFileSync(prov, "utf8").replace(
        "| Node type definitions (@types/node) | MIT | Development dependency |",
        "| Node type definitions (@types/node) | MIT | Development dependency |\n| A GPL helper (gpl-thing) | GPL-3.0 | Build-time tool, never shipped |",
      ),
    );
    expect(licenseGate(root, "main").failures.map((f) => f.actual)).toEqual(["no-licence"]);

    // In the card runner's gate path: the wrapped runner adds the failure.
    const inner = { runGates: async () => ({ passed: true, failures: [], durationMs: 1 }) };
    const wrapped = withLicenseGate(inner as unknown as DeterministicGateRunner, root);
    const res = await wrapped.runGates(["test"], root);
    expect(res.passed).toBe(false);
    expect(res.failures.map((f) => f.gate)).toEqual(["licenses"]);
    expect(res.rungResults?.map((o) => o.gate)).toContain("licenses");
  });
});

describe("X17/X18/X20: production paths", () => {
  it("sekhemet register check/licenses/advance and the doctor read the registers", async () => {
    const root = fixtureRepo();
    const db = new DatabaseSync(":memory:");
    initSchema(db);
    const log = new EventLog(db);
    const k = { repoPath: root, log, cardStore: new CardStore(db, log) };
    const lines: string[] = [];
    const io = { print: (l: string) => lines.push(l) };
    expect(await runDevCommand("register", ["check"], k, io)).toBe(0);
    expect(
      await runDevCommand(
        "register",
        ["advance", "R6", "shortlisted", "--threshold", "Two more cards pass"],
        k,
        io,
      ),
    ).toBe(0);
    expect(readResearchRegister(root).find((e) => e.id === "R6")?.state).toBe("shortlisted");
    // left-pad is SSPL-1.0 (source-available) and unregistered: the audit names it.
    // (WTFPL, the fixture before B4.5, is Public Domain in ScanCode: permissive.)
    expect(await runDevCommand("register", ["licenses"], k, io)).toBe(1);
    expect(lines.some((l) => /FAIL left-pad \(SSPL-1.0\)/.test(l))).toBe(true);
    const report = await runDoctor(root);
    expect(report.checks.find((c) => c.name === "Project records")?.status).toBe("pass");
  }, 30_000);
});
