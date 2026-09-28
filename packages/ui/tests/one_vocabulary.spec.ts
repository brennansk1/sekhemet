import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { CARD_KINDS } from "@sekhemet/kernel";
import { describe, expect, it } from "vitest";
import { kindTip } from "../src/learn.js";
import {
  BOARD_COLUMNS,
  boardColumnLabel,
  columnLabel,
  issueTypeOf,
  parseTitle,
} from "../src/vocabulary.js";

/**
 * NEW-dashboard-2's one vocabulary: one status-to-label map (DB-N2-3), no
 * kind enumeration of the dashboard's own (DB-N2-4, under DEC-31 an issue
 * type is what a person reads), and change and split read from their own
 * stored fields, never inferred (DB-N2-5).
 */

const ROOT = join(import.meta.dirname, "..", "..", "..");

function files(dir: string, ext: RegExp): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...files(p, ext));
    else if (ext.test(name)) out.push(p);
  }
  return out;
}

/**
 * An object literal mapping stored states to words a person reads: at least
 * three state keys whose values start with a capital letter.
 */
function statusLabelMaps(src: string): number {
  const states = "backlog|ready|planning|in_progress|verify|review|done|parked|rejected";
  const entry = new RegExp(`^\\s*(${states}):\\s*"[A-Z][^"]*",?\\s*$`);
  let maps = 0;
  let run = 0;
  for (const line of src.split("\n")) {
    if (entry.test(line)) {
      run++;
      if (run === 3) maps++;
    } else if (!/^\s*(\/\/.*)?$/.test(line)) run = 0;
  }
  return maps;
}

describe("one status-to-label map (DB-N2-3)", () => {
  // The Jira export writes Jira's own workflow names (*To Do*, *In Progress*),
  // the file format Jira imports, not words this product shows.
  const EXEMPT = new Set(["apps/harness/src/integrations.ts"]);

  it("finds exactly one, in vocabulary.ts, across the dashboard, the server and the CLI", () => {
    const sources = [
      ...files(join(ROOT, "packages", "ui", "src"), /\.ts$/),
      ...files(join(ROOT, "packages", "ui", "web"), /\.js$/),
      ...files(join(ROOT, "apps", "harness", "src"), /\.ts$/),
    ];
    const found = sources
      .map((p) => ({ file: relative(ROOT, p), maps: statusLabelMaps(readFileSync(p, "utf8")) }))
      .filter((f) => f.maps > 0 && !EXEMPT.has(f.file));
    // COLUMN_LABELS; COLUMN_EMPTY and PLAIN_STATUS are sentences for the same
    // states, in the same module (§2.3: every word a person reads, in one place).
    expect(found.map((f) => f.file)).toEqual(["packages/ui/src/vocabulary.ts"]);
    expect(columnLabel("in_progress")).toBe("In progress");
  });

  it("the scan finds a second map when there is one (a negative case)", () => {
    expect(
      statusLabelMaps(
        'const M = {\n  ready: "Ready",\n  in_progress: "In Progress",\n  done: "Done",\n};',
      ),
    ).toBe(1);
    expect(
      statusLabelMaps(
        'const T = {\n  in_progress: "running",\n  verify: "running",\n  done: "done",\n};',
      ),
    ).toBe(0);
  });

  it("the board's words for a state come from its columns", () => {
    for (const c of BOARD_COLUMNS)
      for (const s of c.states) expect(boardColumnLabel(s)).toBe(c.label);
    expect(boardColumnLabel("rejected")).toBe("Won't do");
  });
});

describe("no kind enumeration of the dashboard's own (DB-N2-4, DEC-31)", () => {
  const vocabulary = readFileSync(join(ROOT, "packages", "ui", "src", "vocabulary.ts"), "utf8");

  it("vocabulary.ts declares no kind type or label map; it reads the kernel's kinds", () => {
    expect(vocabulary).not.toMatch(/export type CardKind\s*=/);
    expect(vocabulary).not.toMatch(/"(Contract|Storage|Flow|Wiring)"/);
    for (const suffix of ["Interface", "Data", "Path", "Rule", "Spike", "Visual", "Integration"]) {
      for (const k of parseTitle(`x (SPIDR: ${suffix})`).kinds)
        expect(CARD_KINDS as readonly string[]).toContain(k);
    }
  });

  it("a person reads an issue type, never a kind label", () => {
    expect(issueTypeOf({ kind: "interface" })).toBe("story");
    expect(issueTypeOf({ kind: "spike" })).toBe("spike");
    expect(issueTypeOf({ kind: "research" })).toBe("spike");
    expect(issueTypeOf({ kind: "review" })).toBe("task");
    expect(issueTypeOf({ kind: "implement", change: "fix" })).toBe("bug");
    expect(issueTypeOf({ tier: "epic" })).toBe("epic");
    // An older card with no stored kind: its title's suffix, read as the kernel reads it.
    expect(issueTypeOf({ title: "Probe the API (SPIDR: Spike)" })).toBe("spike");
  });
});

describe("change and split from their own fields (DB-N2-5)", () => {
  it("names the split from the stored split", () => {
    expect(kindTip({ kind: "implement", split: "path" }).yours).toBe(
      "Split from a larger story along its Path: one way through it, built end to end.",
    );
  });

  it("never infers a split from the kind or the title", () => {
    expect(kindTip({ kind: "rule" }).yours).toBe("This issue was not split from a larger one.");
    expect(kindTip({ kind: "data", title: "Store it (SPIDR: Data)" }).yours).toBe(
      "This issue was not split from a larger one.",
    );
  });

  it("reads the change from its field: a fix is a Bug whatever the kind", () => {
    for (const kind of ["implement", "rule", "data", "interface"])
      expect(issueTypeOf({ kind, change: "fix" })).toBe("bug");
    expect(issueTypeOf({ kind: "implement", title: "Fix the crash" })).toBe("story");
  });
});
