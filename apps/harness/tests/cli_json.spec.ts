import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { CardStore } from "@sekhemet/kernel";
import { describe, expect, it } from "vitest";
import { openLocalLedger } from "../src/ledger_cmds.js";
import {
  BIN,
  SCRIPTED_WORKER,
  cardInReview,
  sandboxDirs,
  scriptedWorkerProject,
  sekhemet,
} from "./cli_fixture.js";

/**
 * NEW-surface-10 (DEC-53 c11; surface item 20c): `run`, `status`, `accept`
 * and `doctor` take `--json`, printing exactly one object of the one result
 * type on stdout, each checked against its published JSON Schema
 * (`apps/harness/data/schemas/cli/<command>.schema.json`) by running the
 * built binary (SUR-70, SUR-71, SUR-72).
 */

const SCHEMAS = resolve(import.meta.dirname, "../data/schemas/cli");
const validator = new AjvJsonSchemaValidator();

function schemaOf(command: string) {
  return JSON.parse(readFileSync(join(SCHEMAS, `${command}.schema.json`), "utf8"));
}

/** The one object on stdout, checked against the command's schema. */
function oneObject(command: string, r: { stdout: string; stderr: string; status: number | null }) {
  const lines = r.stdout.split("\n").filter((l) => l.trim() !== "");
  expect(lines, `stdout: ${r.stdout}\nstderr: ${r.stderr}`).toHaveLength(1);
  const value = JSON.parse(lines[0] as string) as Record<string, unknown>;
  const check = validator.getValidator(schemaOf(command))(value);
  expect(check.errorMessage, JSON.stringify(value)).toBeUndefined();
  expect(check.valid).toBe(true);
  expect(value.command).toBe(command);
  expect(value.exitCode).toBe(r.status);
  expect(value.ok).toBe(r.status === 0);
  return value;
}

describe("SUR-70, SUR-72: one JSON object on stdout, matching the command's schema", () => {
  it("status: each column's issues, what the queue runs next, and what waits on a person", async () => {
    const where = sandboxDirs();
    await cardInReview(where, "c1");
    {
      const { db, log } = openLocalLedger(where.cwd);
      const store = new CardStore(db, log);
      await store.createCard({
        id: "c2",
        tier: "story",
        title: "Next one",
        scopeFiles: ["src/**"],
      });
      await store.updateCardStatus("c2", "ready", "planned", "harness", { override: true });
      db.close();
    }
    const prose = sekhemet(["status"], where);
    expect(prose.status, prose.stderr).toBe(0);
    expect(prose.stdout).toMatch(/In review\s+1/);
    expect(prose.stdout).toMatch(/Next: c2/);
    const r = sekhemet(["status", "--json"], where);
    expect(r.status, r.stderr).toBe(prose.status);
    const v = oneObject("status", r) as {
      columns: { name: string; issues: { id: string; state: string }[] }[];
      next: { id: string }[];
      waiting: { id: string; why: string }[];
    };
    const review = v.columns.find((c) => c.name === "In review");
    expect(review?.issues.map((i) => i.id)).toEqual(["c1"]);
    expect(v.next.map((i) => i.id)).toEqual(["c2"]);
    expect(v.waiting).toEqual([expect.objectContaining({ id: "c1", why: "review" })]);
  });

  it("accept: the accepted issue and its commit, with the exit code it gives without the flag", async () => {
    const where = sandboxDirs();
    await cardInReview(where, "c1");
    const r = sekhemet(["accept", "c1", "--json"], where);
    expect(r.status, r.stderr).toBe(0);
    const v = oneObject("accept", r) as {
      accepted: boolean;
      commit?: string;
      issue?: { id: string; status: string };
    };
    expect(v.accepted).toBe(true);
    expect(v.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(v.issue).toMatchObject({ id: "c1", status: "done" });
    // A missing issue: exit 1 with and without the flag.
    const prose = sekhemet(["accept", "nope"], where);
    const json = sekhemet(["accept", "nope", "--json"], where);
    expect(prose.status).toBe(1);
    expect(json.status).toBe(1);
    expect(oneObject("accept", json).message).toMatch(/no issue nope/);
  });

  it("doctor: every check with its status, and the exit code it gives without the flag", () => {
    const where = sandboxDirs();
    const prose = sekhemet(["doctor"], where);
    const r = sekhemet(["doctor", "--json"], where);
    expect(r.status).toBe(prose.status);
    const v = oneObject("doctor", r) as { checks: { name: string; status: string }[] };
    expect(v.checks.length).toBeGreaterThan(5);
    expect(v.checks.map((c) => c.name)).toContain("Git");
  }, 60_000);

  it("run: the issue's outcome on stdout, the progress on stderr", async () => {
    const where = sandboxDirs();
    const env = await scriptedWorkerProject(where);
    const r = spawnSync(
      process.execPath,
      ["--import", env.preload, BIN, "run", "c1", "--worker", SCRIPTED_WORKER, "--json"],
      {
        cwd: where.cwd,
        encoding: "utf8",
        timeout: 120_000,
        env: { ...env.vars, SCRIPTED_WORKER_MODE: "finish" },
      },
    );
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const v = oneObject("run", r) as {
      passed: boolean;
      issue: { id: string; status: string };
      checks: { name: string; passed: boolean; skipped?: boolean }[];
    };
    expect(v.passed).toBe(true);
    expect(v.issue).toMatchObject({ id: "c1", status: "review" });
    // The project's own check, and a skipped built-in one is said as skipped.
    expect(v.checks).toContainEqual({ name: "unit", passed: true });
    for (const c of v.checks.filter((c) => !c.passed)) expect(c).toHaveProperty("skipped", true);
    expect(r.stderr).toMatch(/turn: write_file, finish_card/);
  }, 300_000);
});

describe("SUR-71: a command under --json asks nothing", () => {
  it("accept with an AI review finding unacknowledged prints the object with the findings and exits 2", async () => {
    const where = sandboxDirs();
    await cardInReview(where, "c1");
    {
      const { db, log } = openLocalLedger(where.cwd);
      await new CardStore(db, log).recordDossierEntry({
        cardId: "c1",
        kind: "review",
        actor: "reviewer",
        verdict: "unmet",
        text: "criterion 2 is not exercised",
      } as Parameters<CardStore["recordDossierEntry"]>[0]);
      db.close();
    }
    const r = sekhemet(["accept", "c1", "--json"], where);
    expect(r.status).toBe(2);
    const v = oneObject("accept", r) as {
      accepted: boolean;
      refusal: string;
      findings: { number: number; verdict: string; text: string; acknowledged: boolean }[];
    };
    expect(v.accepted).toBe(false);
    expect(v.refusal).toBe("unacknowledged");
    expect(v.findings).toEqual([
      { number: 1, verdict: "unmet", text: "criterion 2 is not exercised", acknowledged: false },
    ]);
  });
});

describe("surface item 20c: `run` with no issue is the queue, which prints no JSON", () => {
  it("is refused before anything runs: exit 2 and the object saying so", () => {
    const where = sandboxDirs();
    for (const args of [
      ["run", "--json"],
      ["add a CSV export of a week", "--json"],
    ]) {
      const r = sekhemet(args, where);
      expect(r.status, r.stderr).toBe(2);
      expect(oneObject("run", r).message).toMatch(/--json needs an issue/);
      expect(readdirSync(where.cwd)).toEqual([]);
    }
  });
});

describe("SUR-70: a usage error the front door catches is an object too", () => {
  it("an unknown flag or a valued --json: exit 2 with the command's object on stdout", async () => {
    const where = sandboxDirs();
    await cardInReview(where, "c1");
    for (const args of [
      ["status", "--json", "--frob"],
      ["status", "--json=1"],
      ["dev", "status", "--frob", "--json"],
    ]) {
      const r = sekhemet(args, where);
      expect(r.status, `${args.join(" ")}: ${r.stderr}`).toBe(2);
      const v = oneObject("status", r);
      expect(v.message).toMatch(/--frob|--json/);
    }
  });

  it("doctor --airgap has no object yet: --json there is refused, exit 2 with the object, and no self-test runs", () => {
    const where = sandboxDirs();
    const r = sekhemet(["doctor", "--airgap", "--json"], where);
    expect(r.status, r.stderr).toBe(2);
    expect(oneObject("doctor", r).message).toMatch(/--airgap/);
    expect(r.stderr).not.toMatch(/outbound/);
  });
});

describe("surface item 20c: an error nothing handled, under --json", () => {
  it("prints the one line on stderr and {ok: false, error} on stdout, exit 1", () => {
    const where = sandboxDirs();
    const preload = join(where.home, "fault.mjs");
    writeFileSync(
      preload,
      `const t = setInterval(() => {
  if (process.listenerCount("unhandledRejection") === 0) return;
  clearInterval(t);
  Promise.reject(new Error("an injected fault"));
}, 1);
`,
    );
    const r = spawnSync(process.execPath, ["--import", preload, BIN, "doctor", "--json"], {
      cwd: where.cwd,
      encoding: "utf8",
      timeout: 60_000,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: where.home,
        SEKHEMET_CONFIG_DIR: join(where.home, ".sekhemet"),
        SEKHEMET_USER_CONFIG: "/nonexistent/sekhemet-test-user-config.toml",
        BROWSER: "false",
      },
    });
    expect(r.status, r.stderr).toBe(1);
    const line = r.stderr.split("\n").find((l) => l.startsWith("sekhemet stopped: "));
    expect(line, r.stderr).toBeDefined();
    const out = r.stdout.split("\n").filter((l) => l.trim() !== "");
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0] as string)).toEqual({ ok: false, error: line });
  }, 60_000);
});
