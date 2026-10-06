import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error: a plain ESM script, shared with the entry-point report.
import { analyze } from "../../../scripts/entry_points.mjs";

/**
 * The unhappy-path matrix (FINDINGS_C1 TST-03; FINISH_LINE_PLAN C2d): every
 * feature of a spec (a `### ` heading of its §5, or a `**NEW-… — ` item where
 * the spec heads its §5 items that way, and its §6 acceptance list)
 * against the twelve unhappy paths a person meets. C1's generator
 * (c1-backup/c1/unhappy_work/gen.mjs) is this test now. Each cell is one of:
 *
 * - covered: a criterion of the feature names that path, and the entry-point
 *   report (scripts/entry_points.mjs) finds a test citing it, in or right
 *   above the test or in its describe, that reaches the product through a
 *   door (the built CLI, a started server, a browser, MCP): entry-strict or
 *   entry-lenient. A file that merely mentions the id in its header is the
 *   report's weak link, and covers nothing here either;
 * - n/a: the checked-in table says why the path does not apply to the feature;
 * - gap: a criterion names the path but no entry test cites it yet; the table
 *   names the criteria, and the count may never rise above `_ceiling`.
 *
 * A cell that is none of these fails, so a new feature or a new criterion
 * comes with its tests or its reasons. A table entry for a cell that is now
 * covered fails too, so the table only shrinks as tests arrive. The tables
 * are `unhappy_matrix/<spec>.json`, one for every spec with a feature that has
 * a SHALL criterion; a spec with none and no table fails.
 */

const REPO = resolve(import.meta.dirname, "..", "..", "..");
const TABLES = join(import.meta.dirname, "unhappy_matrix");

/** The twelve columns, as C1's generator read a criterion's text (dims.tsv). */
const COLUMNS: [string, RegExp][] = [
  [
    "empty",
    /\b(empty|no (issues|cards|projects|rows|results|items|data|comments|threads|messages|runs)|nothing (to|yet|here)|first run|zero (issues|cards))\b/i,
  ],
  ["loading", /\b(loading|skeleton|spinner|in flight|pending state|progress)\b/i],
  ["error", /\b(error state|fails?|failure|error|500|refus|rejects?|invalid|malformed)\b/i],
  [
    "slow",
    /\b(slow|timeout|timed? out|deadline|latency|stall|hang|takes longer|over 10 s|waits?)\b/i,
  ],
  [
    "model_down",
    /\b(model (is )?(down|unreachable|unavailable|not (loaded|running))|server (is )?(down|unreachable|not running)|ECONNREFUSED|no model|inference server|endpoint (down|unreachable)|model_unavailable|cannot reach)\b/i,
  ],
  [
    "offline",
    /\b(offline|air-?gap|no network|network (is )?(down|unavailable)|disconnect|reconnect|websocket (clos|drop))\b/i,
  ],
  [
    "permission",
    /\b(permission|forbidden|403|401|viewer|stakeholder|access level|not allowed|unauthori[sz]ed|lacks|level it needs|sign(ed)? ?in|csrf)\b/i,
  ],
  [
    "large_data",
    /\b(500 issues|10,?000|large|many (issues|cards)|paginat|virtuali[sz]|thousands?|limit|truncat|cap(ped)?)\b/i,
  ],
  [
    "concurrent",
    /\b(concurren|conflict|409|stale|version mismatch|race|two (people|tabs|sessions|writers)|simultaneous|optimistic|etag|if-match|lease)\b/i,
  ],
  ["undo", /\b(undo|revert|reopen|restore|roll ?back)\b/i],
  [
    "retry",
    /\b(retry|retries|idempoten|twice|duplicate|replay(ed)?|same request|once only|at most once)\b/i,
  ],
  [
    "restart",
    /\b(restart|crash|resume|killed|SIGKILL|SIGTERM|recover|mid-operation|interrupted|after a reboot|daemon (stops|dies))\b/i,
  ],
];

const ID = /^\s*- \*\*([A-Z]{1,5}-[A-Za-z0-9-]*?[0-9]+[a-z]?)\*\*\s*(.*)$/;

interface Feature {
  key: string;
  criteria: { id: string; text: string }[];
}

/** A spec's features: §5's `### ` headings and §6, each with its SHALL criteria. */
function features(spec: string): Feature[] {
  const lines = readFileSync(join(REPO, "docs", "design", "specs", spec), "utf8").split("\n");
  const out: Feature[] = [];
  let cur: Feature | undefined;
  let inChanges = false;
  for (const l of lines) {
    if (/^## 5\./.test(l)) inChanges = true;
    else if (/^## [6-9]\./.test(l)) {
      inChanges = false;
      cur = undefined;
    }
    if (/^## 6\./.test(l)) {
      cur = { key: "§6 v1 acceptance", criteria: [] };
      out.push(cur);
    }
    // teams.md heads its §5 items `**NEW-teams-1 — …**` instead of `### `.
    const item = inChanges ? l.match(/^\*\*(NEW-[A-Za-z0-9-]+) — /) : null;
    if (item) {
      cur = { key: item[1] as string, criteria: [] };
      out.push(cur);
    }
    if (inChanges && /^### /.test(l)) {
      cur = { key: (l.replace(/^### /, "").split(" — ")[0] ?? "").trim(), criteria: [] };
      out.push(cur);
    }
    const m = l.match(ID);
    if (cur && m && /SHALL/.test(l))
      cur.criteria.push({ id: m[1] as string, text: m[2] as string });
  }
  return out.filter((f) => f.criteria.length > 0);
}

/** The criteria a test reaches through a door (entry-strict or entry-lenient). */
function entryCited(): Set<string> {
  const { tested } = analyze(REPO) as { tested: Record<string, string> };
  return new Set(
    Object.entries(tested)
      .filter(([, cls]) => cls === "entry-strict" || cls === "entry-lenient")
      .map(([id]) => id),
  );
}

type Table = Record<string, { na?: Record<string, string>; gap?: Record<string, string> }> & {
  _ceiling?: { gaps: number };
};

/** A table's reasons per column: `"a,b,c": "why"` names three columns. */
function columnsOf(group: Record<string, string> | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const [cols, why] of Object.entries(group ?? {}))
    for (const c of cols.split(",").map((x) => x.trim())) out.set(c, why);
  return out;
}

const tables = existsSync(TABLES)
  ? readdirSync(TABLES)
      .filter((f) => f.endsWith(".json"))
      .map((f) => ({ spec: f.replace(/\.json$/, ".md"), file: f }))
  : [];

describe("the unhappy-path matrix: every cell a test, a reasoned n/a or a counted gap (TST-03)", () => {
  const cited = entryCited();

  it("has a table for every spec with a feature that has a SHALL criterion", () => {
    const specs = readdirSync(join(REPO, "docs", "design", "specs"))
      .filter((f) => f.endsWith(".md") && f !== "README.md")
      .filter((f) => features(f).length > 0)
      .sort();
    expect(specs.length).toBeGreaterThanOrEqual(16);
    expect(tables.map((t) => t.spec).sort()).toEqual(specs);
  });

  for (const { spec, file } of tables) {
    it(`${spec}: every feature × column is covered, n/a with a reason, or a named gap`, () => {
      const table = JSON.parse(readFileSync(join(TABLES, file), "utf8")) as Table;
      const feats = features(spec);
      const keys = new Set(feats.map((f) => f.key));
      // A table names only features the spec has.
      const unknown = Object.keys(table).filter((k) => k !== "_ceiling" && !keys.has(k));
      expect(unknown, `${file} names features ${spec} does not have`).toEqual([]);
      const problems: string[] = [];
      let gaps = 0;
      let covered = 0;
      for (const f of feats) {
        const row = table[f.key];
        const na = columnsOf(row?.na);
        const gap = columnsOf(row?.gap);
        for (const c of [...na.keys(), ...gap.keys()])
          if (!COLUMNS.some(([k]) => k === c)) problems.push(`${f.key}: no column "${c}"`);
        for (const [col, re] of COLUMNS) {
          const named = f.criteria.filter((c) => re.test(c.text));
          const tested = named.some((c) => cited.has(c.id));
          const where = `${f.key} × ${col}`;
          if (tested) {
            covered++;
            if (na.has(col) || gap.has(col))
              problems.push(`${where}: covered by a test now; remove its table entry`);
            continue;
          }
          if (named.length > 0) {
            // A criterion names the path but no door's test cites it: a gap naming them, or n/a.
            const why = gap.get(col) ?? na.get(col);
            if (!why)
              problems.push(
                `${where}: ${named.map((c) => c.id).join(", ")} untested, and no gap or n/a`,
              );
            else if (gap.has(col)) {
              gaps++;
              const missing = named.filter((c) => !why.includes(c.id));
              if (missing.length)
                problems.push(
                  `${where}: the gap does not name ${missing.map((c) => c.id).join(", ")}`,
                );
            }
            continue;
          }
          const why = na.get(col);
          if (gap.has(col))
            problems.push(`${where}: a gap with no criterion naming it; make it n/a`);
          else if (!why) problems.push(`${where}: no criterion, no test and no reason`);
          else if (why.trim().length < 30)
            problems.push(`${where}: a reason of a few words is no reason`);
        }
      }
      expect(problems, problems.join("\n")).toEqual([]);
      // Gaps only fall: the ceiling is the count when the table was written.
      const ceiling = table._ceiling?.gaps ?? 0;
      expect(gaps, `${spec}: ${gaps} gaps, over the ceiling of ${ceiling}`).toBeLessThanOrEqual(
        ceiling,
      );
      expect(covered).toBeGreaterThan(0);
    });
  }
});
