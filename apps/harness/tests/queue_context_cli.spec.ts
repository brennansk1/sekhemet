import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EventLog } from "@sekhemet/kernel";
import { describe, expect, it } from "vitest";
import { installZod } from "./research_notes_fixture.js";
import { cli, g2Dirs, ledgerRows } from "./support/g2_cli.js";
import {
  type Recorded,
  SCRIPTED_MODEL,
  type Turn,
  recorded,
  scriptEnv,
} from "./support/g2_model.js";
import { type G2Project, g2Project } from "./support/g2_project.js";

/**
 * The Worker's prompt as every card meets it (context §2 rules 10a, 24b–24f,
 * C5; CX-M8-2, CX-N3-4, CX-N3-5, CX-N4-1, CX-N4-2, CX-N4-3, CX-N4-6, CX-N5-1,
 * CX-N5-2; FINISH_LINE_PLAN C2d): `sekhemet queue` spawned as the built
 * binary over a real repository and ledger, its Worker a scripted model at the
 * HTTP boundary that records every request it is sent. The prompts asserted on
 * are the bytes the binary sent; nothing is assembled in this process.
 *
 * The binary under test is `apps/harness/dist/index.js`, spawned by
 * `support/g2_cli.ts`.
 */

const TS2554 = "src/ledger.ts(3,1): error TS2554: Expected 2 arguments, but got 1.";
/** A gate that always fails with a typed TypeScript error. */
const FAILING_GATE = ["-e", `console.log(${JSON.stringify(TS2554)}); process.exit(1)`];
const FINISH: Turn = [{ name: "finish_card" }];

/** One approved Worker rule as the learning store folds it from the ledger. */
function rule(
  id: string,
  text: string,
  scope: Record<string, string>,
  opts: { value?: number; at?: string } = {},
) {
  const at = opts.at ?? "2026-01-01T00:00:00.000Z";
  return {
    actor: "human" as const,
    type: "learn/rule",
    payload: {
      id,
      role: "worker",
      text,
      scope,
      reach: "project",
      status: "active",
      helpful: 0,
      harmful: 0,
      value: opts.value ?? 0,
      source: "seed",
      evidence: [{ note: "written by a person", verified: "person", at }],
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  };
}

const user = (r: Recorded) => r.body.messages.find((m) => m.role === "user")?.content ?? "";
const system = (r: Recorded) => r.body.messages.find((m) => m.role === "system")?.content ?? "";
const cardOf = (r: Recorded) => /Card ID: (\S+)/.exec(user(r))?.[1];
const markers = (text: string) => (text.match(/RULE-[A-Z0-9]+/g) ?? []).sort();
const section = (text: string, title: string) => {
  const at = text.indexOf(`=== ${title} ===`);
  if (at < 0) return undefined;
  const next = text.indexOf("\n=== ", at + 4);
  return text.slice(at, next < 0 ? undefined : next);
};

function queue(p: G2Project, worker: Turn[], extra: Record<string, string> = {}) {
  return cli(["queue", "--worker", SCRIPTED_MODEL], {
    cwd: p.repo,
    preload: p.preload,
    env: { ...p.env, ...scriptEnv(p.record, { worker }), ...extra },
    timeoutMs: 120_000,
  });
}

describe("one attempt's steps: the cache prefix, the repair rung and the rules' scope", () => {
  it("CX-M8-2, CX-N3-4, CX-N4-2, CX-N4-6: byte-identical prefix across steps, the rung's directive in the tail, rules applied by kind, path, error and gate, rotated across comparable cards", async () => {
    const where = g2Dirs();
    const p = await g2Project(where, {
      files: {
        "src/ledger.ts": "export const rows = [];\n",
        "src/other.ts": "export const o = 1;\n",
      },
      gateArgs: FAILING_GATE,
      cards: [
        {
          id: "c1",
          tier: "story",
          title: "Store ledger rows",
          kind: "implement",
          scopeFiles: ["src/ledger.ts"],
          stepBudget: 3,
          spec: "Append rows",
        },
        {
          id: "c2",
          tier: "story",
          title: "Count ledger rows",
          kind: "implement",
          scopeFiles: ["src/ledger.ts"],
          stepBudget: 3,
          spec: "Count rows",
        },
      ],
      seed: async (_s, log: EventLog) => {
        await log.append(
          rule("r_path", "RULE-PATH validate every ledger row.", { pathPattern: "ledger" }),
        );
        await log.append(
          rule("r_other", "RULE-OTHER keep helpers pure.", { pathPattern: "other" }),
        );
        await log.append(
          rule("r_kind", "RULE-KIND write a spike report first.", {
            kind: "spike",
            pathPattern: "ledger",
          }),
        );
        await log.append(
          rule("r_gate", "RULE-GATE run the linter again.", {
            pathPattern: "ledger",
            errorPattern: "TS2554",
            triggerGate: "lint",
          }),
        );
        await log.append(
          rule("r_err", "RULE-ERR pass both arguments to append.", {
            pathPattern: "ledger",
            errorPattern: "TS2554",
            triggerGate: "test",
          }),
        );
      },
    });
    const r = await queue(p, [FINISH, FINISH, FINISH, FINISH, FINISH, FINISH]);
    expect(r.stdout, r.stderr).toMatch(/=== c1 \(attempt 1\)/);
    expect(r.stdout).toMatch(/=== c2 \(attempt 1\)/);
    const sent = recorded(p.record).filter((x) => x.role === "worker");
    const c1 = sent.filter((x) => cardOf(x) === "c1");
    const c2 = sent.filter((x) => cardOf(x) === "c2");
    expect(c1).toHaveLength(3);
    expect(c2).toHaveLength(3);
    const [s1, s2, s3] = c1 as [Recorded, Recorded, Recorded];

    // CX-M8-2: every step of one attempt sends the same system prompt and
    // tools array, byte for byte.
    for (const s of [s2, s3]) {
      expect(system(s)).toBe(system(s1));
      expect(JSON.stringify(s.body.tools)).toBe(JSON.stringify(s1.body.tools));
    }
    expect((s1.body.tools ?? []).length).toBeGreaterThan(0);

    // CX-N3-4: two failed verifications move the ladder to its second rung;
    // its directive is in the volatile tail, after the scope file, and the
    // system prompt and the rules zone are the previous step's bytes.
    expect(user(s2)).not.toContain("=== REPAIR MODE ===");
    const tail = user(s3);
    expect(tail).toContain("=== REPAIR MODE ===");
    expect(tail.indexOf("=== REPAIR MODE ===")).toBeGreaterThan(
      tail.indexOf("=== SCOPE FILE: src/ledger.ts"),
    );
    expect(system(s3)).toBe(system(s2));
    expect(section(user(s3), "RULES FOR THE CURRENT ERROR")).toBe(
      section(user(s2), "RULES FOR THE CURRENT ERROR"),
    );
    expect(tail).toMatch(/rung 2\/4 \(fresh_context\)/);

    // CX-N4-2: kind and path at the card boundary, error and trigger gate per step.
    expect(markers(system(s1))).toEqual(["RULE-PATH"]);
    expect(markers(user(s1))).toEqual([]);
    expect(section(user(s2), "RULES FOR THE CURRENT ERROR")).toContain("RULE-ERR");
    for (const s of c1) {
      const all = `${system(s)}\n${user(s)}`;
      expect(all).not.toContain("RULE-OTHER");
      expect(all).not.toContain("RULE-KIND");
      expect(all).not.toContain("RULE-GATE");
    }

    // CX-N4-6: rotated across the two comparable cards in start order — in
    // c1's prompts, withheld from c2's — and recorded on each first attempt.
    for (const s of c2) expect(markers(`${system(s)}\n${user(s)}`)).toEqual([]);
    const rows = ledgerRows(p.repo);
    const rotations = rows.filter((x) => x.type === "learn/rotation").map((x) => x.payload);
    expect(rotations).toEqual([
      // r_gate matches at the boundary (kind and path) and is rotated with
      // the others; its trigger gate never stood, so no prompt carried it.
      expect.objectContaining({ cardId: "c1", with: ["r_err", "r_gate", "r_path"], withheld: [] }),
      expect.objectContaining({
        cardId: "c2",
        with: [],
        withheld: ["r_err", "r_gate", "r_path"],
      }),
    ]);
    expect(rotations[0]?.cardClass).toBe(rotations[1]?.cardClass);
    const finished = rows
      .filter((x) => x.type === "attempt/finished")
      .map((x) => x.payload as { cardId: string; attemptNumber: number; ruleIds?: string[] });
    expect(finished.find((f) => f.cardId === "c1")?.ruleIds?.sort()).toEqual(["r_err", "r_path"]);
    expect(finished.find((f) => f.cardId === "c2")?.ruleIds ?? []).toEqual([]);
  }, 180_000);

  it("CX-N4-6: at its 20th pair a rule the exact test finds harmful is retired automatically, with the pairs and the test as evidence", async () => {
    const where = g2Dirs();
    const RULE = "r_harm";
    const p = await g2Project(where, {
      files: { "src/a.ts": "" },
      cards: [
        {
          id: "c_new",
          tier: "story",
          title: "Write a",
          kind: "implement",
          scopeFiles: ["src/a.ts"],
          stepBudget: 2,
          spec: "Export a constant named a from src/a.ts",
        },
      ],
      seed: async (store, log) => {
        await log.append(
          rule(RULE, "RULE-HARM always rewrite the whole file.", { pathPattern: "src/a" }),
        );
        // Nineteen earlier pairs of comparable first attempts, each harmful —
        // with the rule failed, without it passed — and one with-rule failure
        // still waiting for its partner.
        const seeded: { id: string; withRule: boolean }[] = [];
        for (let i = 1; i <= 19; i++)
          seeded.push({ id: `w${i}`, withRule: true }, { id: `o${i}`, withRule: false });
        seeded.push({ id: "w20", withRule: true });
        for (const s of seeded) {
          await store.createCard({
            id: s.id,
            tier: "story",
            title: `Write ${s.id}`,
            kind: "implement",
            scopeFiles: ["src/a.ts"],
            status: "backlog",
          });
          await log.append({
            actor: "harness",
            type: "learn/rotation",
            cardId: s.id,
            payload: {
              cardId: s.id,
              projectId: "cwd",
              cardClass: "implement:ts",
              with: s.withRule ? [RULE] : [],
              withheld: s.withRule ? [] : [RULE],
            },
          });
          const a = await store.runs.startAttempt({
            cardId: s.id,
            attemptNumber: 1,
            modelId: SCRIPTED_MODEL,
          });
          await store.runs.finishAttempt({
            attemptId: a.id,
            status: s.withRule ? "failed" : "passed",
            stopReason: s.withRule ? "budget_exhausted" : "gate_passed",
            tokensUsed: 0,
            secondsUsed: 0,
            cardClass: "implement:ts",
            projectId: "cwd",
            ruleIds: s.withRule ? [RULE] : [],
            withheldRuleIds: s.withRule ? [] : [RULE],
          });
        }
      },
    });
    const before = await cli(["measure", "rule-credit", RULE], { cwd: p.repo, env: p.env });
    expect(before.stdout, before.stderr).toMatch(
      /r_harm: credit -19 over 19 pairs \(0 helpful, 19 harmful\) — insufficient data/,
    );
    const write: Turn = [
      { name: "write_file", arguments: { path: "src/a.ts", content: "export const a = 1;\n" } },
      { name: "finish_card" },
    ];
    const r = await queue(p, [write]);
    expect(r.stdout, r.stderr).toMatch(/PASSED/);
    const prompt = recorded(p.record).find((x) => x.role === "worker");
    if (!prompt) throw new Error("the Worker was never asked");
    // The rotation withholds it from this card (its 40th comparable start)…
    expect(`${system(prompt)}\n${user(prompt)}`).not.toContain("RULE-HARM");
    // …which passes: the 20th pair is harmful too, and the look at 20 retires it.
    const last = ledgerRows(p.repo)
      .filter((x) => x.type === "learn/rule" && x.payload.id === RULE)
      .at(-1)?.payload as { status: string; evidence: { note: string; source?: string }[] };
    expect(last.status).toBe("retired");
    expect(last.evidence.at(-1)?.note).toMatch(
      /^retired automatically at the look after 20 pairs: 0 helpful, 20 harmful, P = [0-9.e-]+ \(one-sided exact test, alpha 0\.05\/3\)$/,
    );
    // MS-T8-14 (C2d finding): the attempt record names the rule withheld from
    // this card, so `measure rule-credit` counts the 20th pair the queue did.
    const attempt = ledgerRows(p.repo).find(
      (x) => x.type === "attempt/finished" && x.payload.cardId === "c_new",
    )?.payload as { withheldRuleIds?: string[] } | undefined;
    expect(attempt?.withheldRuleIds).toEqual([RULE]);
    const after = await cli(["measure", "rule-credit", RULE], { cwd: p.repo, env: p.env });
    expect(after.stdout, after.stderr).toMatch(
      /r_harm: credit -20 over 20 pairs \(0 helpful, 20 harmful\)/,
    );
  }, 180_000);
});

describe("CX-N4-3: more than eight rules — error first, then value, recency, id", () => {
  /** Ten rules matching the card, appended in `order`. */
  const TEN: [string, string, Record<string, string>, { value?: number; at?: string }][] = [
    [
      "r_e0",
      "RULE-E0 pass both arguments.",
      { pathPattern: "ledger", errorPattern: "TS2554" },
      { value: -5 },
    ],
    ["r_v9", "RULE-V9 name the table.", { pathPattern: "ledger" }, { value: 9 }],
    ["r_v8", "RULE-V8 keep rows immutable.", { pathPattern: "ledger" }, { value: 8 }],
    ["r_v7", "RULE-V7 index by date.", { pathPattern: "ledger" }, { value: 7 }],
    ["r_v6", "RULE-V6 log every insert.", { pathPattern: "ledger" }, { value: 6 }],
    ["r_v5", "RULE-V5 batch the writes.", { pathPattern: "ledger" }, { value: 5 }],
    [
      "r_t3",
      "RULE-TA prefer prepared statements.",
      { pathPattern: "ledger" },
      { value: 2, at: "2026-05-01T00:00:00.000Z" },
    ],
    [
      "r_t1",
      "RULE-TB close every cursor.",
      { pathPattern: "ledger" },
      { value: 2, at: "2026-04-01T00:00:00.000Z" },
    ],
    [
      "r_t2",
      "RULE-TC check foreign keys.",
      { pathPattern: "ledger" },
      { value: 2, at: "2026-04-01T00:00:00.000Z" },
    ],
    ["r_low", "RULE-LOW comment the schema.", { pathPattern: "ledger" }, { value: 0 }],
  ];

  async function project(order: "forward" | "reverse") {
    const where = g2Dirs();
    return g2Project(where, {
      files: { "src/ledger.ts": "export const rows = [];\n" },
      gateArgs: FAILING_GATE,
      cards: [
        {
          id: "c1",
          tier: "story",
          title: "Store ledger rows",
          kind: "implement",
          scopeFiles: ["src/ledger.ts"],
          stepBudget: 2,
          spec: "Append rows",
        },
      ],
      seed: async (store, log) => {
        const rules = order === "forward" ? TEN : [...TEN].reverse();
        for (const [id, text, scope, o] of rules) await log.append(rule(id, text, scope, o));
        // The card's first attempt failed on TS2554: that code stands at its boundary.
        const a = await store.runs.startAttempt({
          cardId: "c1",
          attemptNumber: 1,
          modelId: SCRIPTED_MODEL,
        });
        await store.runs.recordGateResult({
          attemptId: a.id,
          cardId: "c1",
          gate: "unit",
          layer: "functional",
          passed: false,
          exitCode: 1,
          durationMs: 1,
          failures: [{ rung: "test", gate: "unit", exitCode: 1, errorExcerpt: TS2554 }],
          source: "local",
        });
        await store.runs.finishAttempt({
          attemptId: a.id,
          status: "failed",
          stopReason: "budget_exhausted",
          tokensUsed: 0,
          secondsUsed: 0,
        });
      },
    });
  }

  it("CX-N4-3, CX-M1-10, CX-9: takes the rule for the standing error first, then by value, then the most recent evidence, then id — the same eight whatever the ledger order", async () => {
    const seen: { inSystem: string[]; onError: string[]; ruleIds: string[] }[] = [];
    const repos: string[] = [];
    for (const order of ["forward", "reverse"] as const) {
      const p = await project(order);
      repos.push(p.repo);
      const r = await queue(p, [FINISH, FINISH]);
      expect(r.stdout, r.stderr).toMatch(/=== c1 \(attempt 2\)/);
      const sent = recorded(p.record).filter((x) => x.role === "worker");
      expect(sent.length).toBeGreaterThanOrEqual(2);
      const [first, second] = sent as [Recorded, Recorded];
      const finished = ledgerRows(p.repo)
        .filter((x) => x.type === "attempt/finished" && x.payload.attemptNumber === 2)
        .map((x) => (x.payload.ruleIds as string[]) ?? []);
      seen.push({
        inSystem: markers(system(first)),
        onError: markers(section(user(second), "RULES FOR THE CURRENT ERROR") ?? ""),
        ruleIds: [...(finished[0] ?? [])].sort(),
      });
    }
    const [a, b] = seen as [(typeof seen)[0], (typeof seen)[0]];
    // The eight: the error's rule despite the lowest value, the five by value,
    // and of the three tied at value 2 the newest evidence, then the lower id.
    expect(a.inSystem).toEqual([
      "RULE-TA",
      "RULE-TB",
      "RULE-V5",
      "RULE-V6",
      "RULE-V7",
      "RULE-V8",
      "RULE-V9",
    ]);
    expect(a.onError).toEqual(["RULE-E0"]);
    expect(a.ruleIds).toEqual(
      ["r_e0", "r_t1", "r_t3", "r_v5", "r_v6", "r_v7", "r_v8", "r_v9"].sort(),
    );
    // Same inputs, the other ledger order: the same eight.
    expect(b).toEqual(a);
    // CX-M1-10: at most eight rules reach the prompt, each scoped to the card's path or error.
    expect(a.ruleIds).toHaveLength(8);
    // CX-9: applying learned rules writes no playbook file.
    for (const repo of repos)
      expect(existsSync(join(repo, ".sekhemet", "playbook.toml"))).toBe(false);
  }, 240_000);
});

describe("CX-N4-1: a rule that would reach every prompt is refused when written", () => {
  it("CX-N4-1: the run's candidate rule with a match-all or empty pattern is refused, naming the pattern; a scoped one is in force", async () => {
    const cases = [
      { scope: { pathPattern: "src/" }, refused: { code: "match_all", pattern: "src/" } },
      { scope: { pathPattern: "" }, refused: { code: "empty_field", pattern: "" } },
      { scope: {}, refused: { code: "empty_scope" } },
      { scope: { pathPattern: "ledger" }, refused: undefined },
    ];
    for (const c of cases) {
      const where = g2Dirs();
      const p = await g2Project(where, {
        files: { "src/ledger.ts": "export const rows = [];\n" },
        cards: [
          {
            id: "c1",
            tier: "story",
            title: "Store ledger rows",
            scopeFiles: ["src/ledger.ts"],
            stepBudget: 1,
            spec: "Append rows",
          },
        ],
      });
      const r = await queue(p, [FINISH], {
        SEKHEMET_CANDIDATE_RULE: "RULE-CANDIDATE keep each row immutable.",
        SEKHEMET_CANDIDATE_SCOPE: JSON.stringify(c.scope),
      });
      expect(r.stdout, r.stderr).toMatch(/=== c1 \(attempt 1\)/);
      const rows = ledgerRows(p.repo);
      const refusals = rows.filter((x) => x.type === "learn/rule_refused").map((x) => x.payload);
      const prompt = recorded(p.record).find((x) => x.role === "worker");
      if (!prompt) throw new Error("the Worker was never asked");
      const carried = `${system(prompt)}\n${user(prompt)}`.includes("RULE-CANDIDATE");
      if (c.refused) {
        expect(refusals).toEqual([expect.objectContaining({ role: "worker", ...c.refused })]);
        expect(rows.some((x) => x.type === "learn/rule")).toBe(false);
        expect(carried).toBe(false);
      } else {
        expect(refusals).toEqual([]);
        expect(rows.filter((x) => x.type === "learn/rule")).toHaveLength(1);
        expect(carried).toBe(true);
      }
    }
  }, 240_000);
});

describe("CX-N3-5: what the card's own history says comes before the scope files", () => {
  it("CX-N3-5: a reviewer's send-back (the dossier) and the team note sit before the scope file in the next attempt's prompt", async () => {
    const where = g2Dirs();
    const p = await g2Project(where, {
      files: { "src/a.ts": "" },
      cards: [
        {
          id: "c1",
          tier: "story",
          title: "Write a",
          scopeFiles: ["src/a.ts"],
          stepBudget: 3,
          spec: "Export a constant named a from src/a.ts",
        },
      ],
    });
    const write: Turn = [
      { name: "write_file", arguments: { path: "src/a.ts", content: "export const a = 1;\n" } },
      { name: "finish_card" },
    ];
    const first = await queue(p, [write]);
    expect(first.stdout, first.stderr).toMatch(/PASSED/);
    const back = await cli(["request-changes", "c1", "Use the existing constants table for a."], {
      cwd: p.repo,
      env: p.env,
    });
    expect(back.status, back.stdout + back.stderr).toBe(0);
    writeFileSync(p.record, "");
    const again = await queue(p, [write]);
    expect(again.stdout, again.stderr).toMatch(/=== c1 \(attempt 2\)/);
    const prompt = recorded(p.record).find((x) => x.role === "worker");
    if (!prompt) throw new Error("the Worker was never asked");
    const text = user(prompt);
    const scope = text.indexOf("=== SCOPE FILE: src/a.ts");
    expect(scope).toBeGreaterThan(0);
    const sentBack = text.indexOf("Use the existing constants table for a.");
    const team = text.indexOf("=== YOUR TEAM ===");
    expect(sentBack).toBeGreaterThanOrEqual(0);
    expect(team).toBeGreaterThanOrEqual(0);
    expect(sentBack).toBeLessThan(scope);
    expect(team).toBeLessThan(scope);
    expect(text).toMatch(/Sent back by the reviewer: Use the existing constants table for a\./);
  }, 240_000);
});

describe("the ranked repo map every card's prompt carries", () => {
  const files = {
    "src/main.ts": "export const main = 0;\n",
    "src/alpha.ts": "export function alphaThing(): number {\n  return 1;\n}\n",
    "src/beta.ts": "export function betaThing(): number {\n  return 2;\n}\n",
  };
  const mapOf = (r: Recorded) => section(user(r), "ARCHITECTURAL REPO MAP") ?? "";

  it("CX-N5-1: a file defining an identifier the card's spec names ranks above an otherwise equal file", async () => {
    const where = g2Dirs();
    const p = await g2Project(where, {
      files,
      cards: [
        {
          id: "c1",
          tier: "story",
          title: "Wire main",
          scopeFiles: ["src/main.ts"],
          stepBudget: 1,
          spec: "Make main call `betaThing` and print its value.",
        },
        {
          id: "c2",
          tier: "story",
          title: "Tidy main",
          scopeFiles: ["src/main.ts"],
          stepBudget: 1,
          spec: "Rename the export of main.",
        },
      ],
    });
    const r = await queue(p, [FINISH, FINISH]);
    expect(r.stdout, r.stderr).toMatch(/=== c2 \(attempt 1\)/);
    const sent = recorded(p.record).filter((x) => x.role === "worker");
    const named = sent.find((x) => cardOf(x) === "c1");
    const plain = sent.find((x) => cardOf(x) === "c2");
    if (!named || !plain) throw new Error("both cards reach the Worker");
    const order = (m: string) => [m.indexOf("src/alpha.ts:"), m.indexOf("src/beta.ts:")];
    const [alphaNamed, betaNamed] = order(mapOf(named));
    const [alphaPlain, betaPlain] = order(mapOf(plain));
    expect(Math.min(alphaNamed ?? -1, betaNamed ?? -1)).toBeGreaterThan(0);
    // Otherwise equal, they tie by path; the spec's identifier lifts beta.
    expect(alphaPlain).toBeLessThan(betaPlain ?? 0);
    expect(betaNamed).toBeLessThan(alphaNamed ?? 0);
    // The scope file stays first.
    expect(mapOf(named).indexOf("src/main.ts:")).toBeLessThan(betaNamed ?? 0);
  }, 180_000);

  it("CX-N5-2: a file whose content changed with the same size and mtime is rebuilt into the map, not served from the cache", async () => {
    const where = g2Dirs();
    // The gate rewrites src/alpha.ts in the card's worktree — same length, its
    // mtime set back, a different name — and fails, so the card goes on. The
    // second failure moves the ladder to its fresh-context rung, which builds
    // the map again in the same process: a cache keyed by size and mtime
    // would serve the old outline there.
    const gate = [
      "-e",
      [
        "const fs = require('fs');",
        "const f = 'src/alpha.ts';",
        "const st = fs.statSync(f);",
        "fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('alphaThing', 'gammaThing'));",
        "fs.utimesSync(f, st.atime, st.mtime);",
        "const now = fs.statSync(f);",
        "console.log('same size and mtime: ' + (now.size === st.size && now.mtimeMs === st.mtimeMs));",
        "process.exit(1);",
      ].join(" "),
    ];
    const p = await g2Project(where, {
      files,
      gateArgs: gate,
      cards: [
        {
          id: "c1",
          tier: "story",
          title: "Wire main",
          scopeFiles: ["src/main.ts"],
          stepBudget: 3,
          spec: "Make main print a value.",
        },
      ],
    });
    const before = statSync(join(p.repo, "src/alpha.ts"));
    const r = await queue(p, [FINISH, FINISH, FINISH]);
    expect(r.stdout, r.stderr).toContain("same size and mtime: true");
    const sent = recorded(p.record).filter((x) => x.role === "worker");
    expect(sent).toHaveLength(3);
    const [s1, , s3] = sent as [Recorded, Recorded, Recorded];
    expect(mapOf(s1)).toContain("alphaThing");
    expect(user(s3)).toContain("=== REPAIR MODE ===");
    expect(mapOf(s3)).toContain("gammaThing");
    expect(mapOf(s3)).not.toContain("alphaThing");
    // The change was the worktree's: the repository's own file is untouched.
    expect(readFileSync(join(p.repo, "src/alpha.ts"), "utf8")).toContain("alphaThing");
    expect(statSync(join(p.repo, "src/alpha.ts")).size).toBe(before.size);
  }, 180_000);
});

describe("the Worker's dependency tools (DS-N9-5)", () => {
  it("DS-N9-5, DS-7: `dependencies` lists every ecosystem's declared dependencies with the version in use, and `docs` reads an installed dependency's own declarations at that version", async () => {
    const where = g2Dirs();
    const p = await g2Project(where, {
      files: {
        "src/a.ts": "",
        ".gitignore": "node_modules\n.sekhemet/\n",
        "package.json": JSON.stringify({ name: "app", dependencies: { zod: "^3.23.8" } }),
        "pnpm-lock.yaml":
          "lockfileVersion: '9.0'\n\npackages:\n\n  zod@3.23.8:\n    resolution: {integrity: sha512-x}\n",
        "requirements.txt": "requests==2.31.0\n",
        "go.mod":
          "module example.com/app\n\ngo 1.22\n\nrequire github.com/BurntSushi/toml v1.3.2\n",
        "go.sum": "github.com/BurntSushi/toml v1.3.2 h1:a=\n",
      },
      cards: [
        {
          id: "c1",
          tier: "story",
          title: "Validate emails",
          scopeFiles: ["src/a.ts"],
          stepBudget: 3,
          spec: "Validate emails with zod",
        },
      ],
    });
    installZod(p.repo);
    const r = await queue(p, [
      [{ name: "tool_search", arguments: { query: "dependencies docs" } }],
      [
        { name: "dependencies", arguments: {} },
        { name: "docs", arguments: { library: "zod", query: "email" } },
      ],
      FINISH,
    ]);
    expect(r.stdout, r.stderr).toMatch(/turn: dependencies, docs/);
    const third = recorded(p.record).filter((x) => x.role === "worker")[2];
    if (!third) throw new Error("the Worker's third step was never asked");
    const last = section(user(third), "LAST TURN") ?? "";
    // Every ecosystem's declared dependencies, each with the version in use.
    expect(last).toMatch(/zod@\^3\.23\.8 \(dependencies, 3\.23\.8 installed\)/);
    expect(last).toMatch(
      /requests ==2\.31\.0 \(python, requirements\.txt[^\n]*the lockfile pins 2\.31\.0\)/,
    );
    expect(last).toMatch(
      /github\.com\/BurntSushi\/toml v1\.3\.2 \(go, go\.mod[^\n]*the lockfile pins v1\.3\.2\)/,
    );
    // `docs` read zod's own declarations at the installed version.
    // DS-7: the Worker is offered no web search or fetch tool, loaded or not.
    for (const x of recorded(p.record).filter((y) => y.role === "worker")) {
      const names = JSON.stringify(x.body.tools ?? []) + system(x);
      expect(names).not.toMatch(/\bweb_search\b|\bweb_fetch\b|\bsearch_and_read\b/);
    }
    const all = user(third);
    expect(all).toContain("=== zod 3.23.8 (installed) ===");
    expect(all).toContain(
      "zod@3.23.8/lib/types.d.ts:7: email(message?: errorUtil.ErrMessage): ZodString;",
    );
  }, 180_000);
});
