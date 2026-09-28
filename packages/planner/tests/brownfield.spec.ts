import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { type InferenceResponse, MockInferenceAdapter } from "@sekhemet/models";
import { afterEach, describe, expect, it } from "vitest";
import {
  type PlannerLedger,
  SpidrFeaturePlanner,
  changeOf,
  changelogBetween,
  codebaseMapFromRepo,
  persistPlan,
  planUpgrade,
  planUpgradeFixes,
  repoHasHistory,
  supersededTests,
  untestedScopeFiles,
} from "../src/index.js";

/**
 * Planning on existing codebases (planner-pm §2.16, NEW-planner-pm-6,
 * PM-N6-1…4), against real git repositories: one `change` per card, apart
 * from its `kind`; a characterize card before a change to untested code; a
 * base test whose expectation the card changes listed as superseded, its new
 * version staged by the test-author step; an upgrade as a tool step plus
 * child fix cards from the failing gates, citing the changelog.
 */
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

function diskLedger(): PlannerLedger {
  const db = new DatabaseSync(join(tmp("sek-brown-db-"), "events.db"));
  initSchema(db);
  const log = new EventLog(db);
  return { log, store: new CardStore(db, log) };
}

const git = (root: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
  });

/** A billing repository with history: refund is tested, report is not. */
function billing(): string {
  const root = tmp("sek-brown-repo-");
  const w = (rel: string, text: string) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  };
  w("package.json", JSON.stringify({ name: "billing", devDependencies: { vitest: "^3.0.0" } }));
  w(
    "src/refund.ts",
    "export function refundInvoice(paid: number, refund: number): number {\n  return paid - refund;\n}\n",
  );
  w("src/money.ts", 'export { refundInvoice } from "./refund.js";\n');
  w(
    "src/report.ts",
    "export function reportTotal(rows: number[]): number {\n  return rows.reduce((a, b) => a + b, 0);\n}\n",
  );
  w(
    "tests/refund.spec.ts",
    [
      'import { describe, expect, it } from "vitest";',
      'import { refundInvoice } from "../src/money.js";',
      "",
      'describe("refunds", () => {',
      '  it("refunds part", () => {',
      "    expect(refundInvoice(1000, 400)).toBe(600);",
      "  });",
      '  it("refunds all", () => {',
      "    expect(refundInvoice(500, 500)).toBe(0);",
      "  });",
      "});",
      "",
    ].join("\n"),
  );
  git(root, "init", "-q");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base");
  return root;
}

const reply = (text: string): InferenceResponse => ({
  text,
  toolCalls: [],
  usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 },
});

async function plan(
  root: string,
  spec: string,
  slice: {
    title: string;
    keywords: string[];
    criteria: { text: string; examples?: unknown[] }[];
    interface: { symbol: string; file: string; signature: string }[];
  },
) {
  const l = diskLedger();
  await l.store.createCard({ id: "epic_b", tier: "epic", title: spec, status: "in_progress" });
  const adapter = new MockInferenceAdapter(
    "planner",
    [reply(JSON.stringify({ slices: [{ kind: "path", rationale: "r", ...slice }] }))],
    { exhaustion: "throw" },
  );
  const p = await new SpidrFeaturePlanner({
    adapter,
    codebaseMap: codebaseMapFromRepo(root),
  }).decomposeSpec({ parentId: "epic_b", parentTier: "epic", spec });
  const result = await persistPlan(l, p, { epicId: "epic_b", repoRoot: root });
  return { l, result, story: p.stories[0] };
}

describe("PM-N6-1: one change per card in a repository with history, apart from its kind", () => {
  it("knows a repository with history from a new one", () => {
    expect(repoHasHistory(billing())).toBe(true);
    const fresh = tmp("sek-brown-new-");
    git(fresh, "init", "-q");
    expect(repoHasHistory(fresh)).toBe(false);
    expect(repoHasHistory(tmp("sek-brown-none-"))).toBe(false);
  });

  it("chooses among the five from what the card is asked to do; a new project's are all features", () => {
    expect(changeOf("Fix the refund rounding bug", true)).toBe("fix");
    expect(changeOf("Refactor the report module into smaller functions", true)).toBe("refactor");
    expect(changeOf("Upgrade vitest to 3.2.0", true)).toBe("upgrade");
    expect(changeOf("Characterize the report totals before changing them", true)).toBe(
      "characterize",
    );
    expect(changeOf("Add a CSV export of refunds", true)).toBe("feature");
    expect(changeOf("Fix the refund rounding bug", false)).toBe("feature");
  });

  it("persists a fix as change fix and kind implement", async () => {
    const root = billing();
    const { l, result } = await plan(
      root,
      "Fix the refund: a refund of a paid invoice keeps a 10 cent fee.",
      {
        title: "Refund keeps a fee",
        keywords: ["refund", "invoice"],
        criteria: [
          {
            text: "Given a paid invoice of 1000 cents, refunding 400 leaves 590",
            examples: [{ args: [1000, 400], expected: 590 }],
          },
        ],
        interface: [{ symbol: "refundInvoice", file: "src/refund.ts", signature: "" }],
      },
    );
    const card = await l.store.getCard(
      result.created.find((c) => !c.id.endsWith("_char"))?.id as string,
    );
    expect(card?.change).toBe("fix");
    expect(card?.kind).toBe("implement");
  });
});

describe("PM-N6-2: a characterize card before a change to code no test executes", () => {
  it("finds the scope files no test reaches on the base, through re-exports", () => {
    const root = billing();
    expect(untestedScopeFiles(root, ["src/refund.ts", "src/report.ts", "src/new.ts"])).toEqual([
      "src/report.ts",
    ]);
  });

  it("plans the characterize card first and makes the feature wait on it", async () => {
    const root = billing();
    const { l, result } = await plan(root, "Add a grand total line to the report totals.", {
      title: "Report grand total",
      keywords: ["report", "total"],
      criteria: [
        {
          text: "Given rows 1, 2 and 3, the report total is 6",
          examples: [{ args: [[1, 2, 3]], expected: 6 }],
        },
      ],
      interface: [{ symbol: "reportTotal", file: "src/report.ts", signature: "" }],
    });
    const feature = await l.store.getCard(
      result.created.find((c) => !c.id.endsWith("_char"))?.id as string,
    );
    const char = await l.store.getCard(`${feature?.id}_char`);
    expect(char?.change).toBe("characterize");
    expect(char?.scopeFiles).toContain("src/report.ts");
    expect(char?.criterionIds?.length).toBe(1);
    expect(feature?.dependsOn).toContain(char?.id);
    expect(result.created.map((c) => c.id).indexOf(char?.id as string)).toBeLessThan(
      result.created.map((c) => c.id).indexOf(feature?.id as string),
    );
    // It traces where the feature traces.
    const req = (id: string) =>
      l.store.requirements.linksFrom("card", id).map((x) => x.requirementId);
    expect(req(char?.id as string)).toEqual(req(feature?.id as string));
  });

  it("plans none when a base test already executes the scope", async () => {
    const root = billing();
    const { l, result } = await plan(root, "Fix the refund: a refund keeps a 10 cent fee.", {
      title: "Refund keeps a fee",
      keywords: ["refund", "invoice"],
      criteria: [
        {
          text: "Given a paid invoice of 1000 cents, refunding 400 leaves 590",
          examples: [{ args: [1000, 400], expected: 590 }],
        },
      ],
      interface: [{ symbol: "refundInvoice", file: "src/refund.ts", signature: "" }],
    });
    expect(result.created.some((c) => c.id.endsWith("_char"))).toBe(false);
    expect(await l.store.listCards({ parentId: "epic_b" })).toHaveLength(result.created.length);
  });
});

describe("PM-N6-3: a base test whose expectation the card changes is superseded", () => {
  it("finds the base test asserting a different value for the same call", () => {
    const root = billing();
    const found = supersededTests(root, { symbol: "refundInvoice", file: "src/refund.ts" }, [
      { args: [1000, 400], expected: 590 },
      { args: [500, 500], expected: 0 },
    ]);
    expect(found.map((f) => f.test)).toEqual(["tests/refund.spec.ts > refunds part"]);
    expect(found[0]).toMatchObject({ was: 600, now: 590 });
  });

  it("lists it on the card and stages its new version through the test-author step", async () => {
    const root = billing();
    const { l, result } = await plan(root, "Fix the refund: a refund keeps a 10 cent fee.", {
      title: "Refund keeps a fee",
      keywords: ["refund", "invoice"],
      criteria: [
        {
          text: "Given a paid invoice of 1000 cents, refunding 400 leaves 590",
          examples: [{ args: [1000, 400], expected: 590 }],
        },
      ],
      interface: [{ symbol: "refundInvoice", file: "src/refund.ts", signature: "" }],
    });
    const id = result.created[0]?.id as string;
    const card = await l.store.getCard(id);
    expect(card?.supersedes).toEqual(["tests/refund.spec.ts > refunds part"]);
    const next = l.store.stagedTests.staged(id).find((t) => t.author === "test-author");
    expect(next).toBeDefined();
    expect(card?.acceptanceTests).toContain(next?.path);
    expect(next?.cases).toEqual([{ name: "refunds part", criterionId: `${id}.c1` }]);
    const source = readFileSync(join(root, next?.path as string), "utf8");
    // The regression gate finds the new version by the base test's own title.
    expect(source).toMatch(/it\("refunds part"/);
    expect(source).toContain("toEqual(590)");
    // The base test itself is untouched: the old expectation is the gate's to accept.
    expect(readFileSync(join(root, "tests/refund.spec.ts"), "utf8")).toContain("toBe(600)");
  });
});

describe("PM-N6-4: an upgrade is a tool step, then child fix cards from the failing gates", () => {
  const CHANGELOG = [
    "# Changelog",
    "## [1.4.0]",
    "- Drops Node 18.",
    "## [1.3.0] - 2026-01-02",
    "- `pad` throws on a negative length.",
    "## 1.2.0",
    "- Adds `padEnd`.",
    "## [1.1.0]",
    "- `pad` returns a string for numbers.",
    "## [1.0.0]",
    "- First release.",
    "",
  ].join("\n");

  it("reads the changelog entries between the installed and the proposed version", () => {
    const entries = changelogBetween(CHANGELOG, "1.0.0", "1.3.0");
    expect(entries.map((e) => e.version)).toEqual(["1.3.0", "1.2.0", "1.1.0"]);
    expect(entries[0]?.lines).toEqual(["- `pad` throws on a negative length."]);
  });

  it("orders prereleases by SemVer precedence (DEC-44: the semver library)", () => {
    const text = [
      "# Changelog",
      "## [2.0.0]",
      "- Stable.",
      "## [2.0.0-rc.10]",
      "- Tenth candidate.",
      "## [2.0.0-rc.2]",
      "- Second candidate.",
      "## [1.10.0]",
      "- Ten.",
      "## [1.9.0]",
      "- Nine.",
      "",
    ].join("\n");
    expect(changelogBetween(text, "2.0.0-rc.1", "2.0.0").map((e) => e.version)).toEqual([
      "2.0.0",
      "2.0.0-rc.10",
      "2.0.0-rc.2",
    ]);
    expect(changelogBetween(text, "1.9.0", "2.0.0-rc.2").map((e) => e.version)).toEqual([
      "2.0.0-rc.2",
      "1.10.0",
    ]);
  });

  it("plans the version change as a tool step and turns each failing file into a fix card citing the changelog", async () => {
    const root = billing();
    writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    const l = diskLedger();
    const { cardId } = await planUpgrade(l, {
      root,
      pkg: "left-pad",
      from: "1.0.0",
      to: "1.3.0",
      changelog: CHANGELOG,
    });
    const card = await l.store.getCard(cardId);
    expect(card?.change).toBe("upgrade");
    expect(card?.scopeFiles).toEqual(["package.json", "pnpm-lock.yaml"]);
    const [planned] = await l.log.getEventsByTypes(["upgrade/planned"]);
    expect(planned?.payload).toMatchObject({
      cardId,
      package: "left-pad",
      from: "1.0.0",
      to: "1.3.0",
      command: ["pnpm", "add", "left-pad@1.3.0"],
      entries: ["1.3.0", "1.2.0", "1.1.0"],
    });

    // The gates after the tool step fail in two files.
    const a = await l.store.runs.startAttempt({ cardId, attemptNumber: 1, modelId: "tool" });
    for (const file of ["src/refund.ts", "src/report.ts"]) {
      await l.store.runs.recordGateResult({
        attemptId: a.id,
        cardId,
        gate: "unit",
        layer: "functional",
        passed: false,
        exitCode: 1,
        durationMs: 1,
        source: "local",
        failures: [{ gate: "unit", location: { file }, errorExcerpt: "TypeError" }],
      });
    }
    const fixes = await planUpgradeFixes(l, cardId);
    expect(fixes.created).toHaveLength(2);
    for (const id of fixes.created) {
      const child = await l.store.getCard(id);
      expect(child?.parentId).toBe(cardId);
      expect(child?.change).toBe("fix");
      expect(child?.scopeFiles).toHaveLength(1);
      expect(child?.spec).toContain("1.3.0: - `pad` throws on a negative length.");
      expect(child?.spec).toContain("1.1.0");
      expect(child?.spec).not.toContain("Drops Node 18");
      expect(child?.status).toBe("planning");
    }
    // Once per failing file: asking again creates nothing new.
    expect((await planUpgradeFixes(l, cardId)).created).toEqual([]);
    expect(existsSync(join(root, "package.json"))).toBe(true);
  });
});
