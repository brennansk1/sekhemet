import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { countLostRecords, lostRecordsPath, reportLostRecord } from "../src/lost_records.js";

// Runtime item 29a, NEW-runtime-19 (RUN-89, RUN-91; FINDINGS_C1 REL-03): a
// record that cannot be written is reported — one warn line and one line in
// the workspace's lost-record log, which doctor counts — never swallowed.

let home: string;
const saved = process.env.SEKHEMET_CONFIG_DIR;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "sek-lost-"));
  process.env.SEKHEMET_CONFIG_DIR = home;
});
afterEach(() => {
  if (saved === undefined) Reflect.deleteProperty(process.env, "SEKHEMET_CONFIG_DIR");
  else process.env.SEKHEMET_CONFIG_DIR = saved;
  rmSync(home, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("reportLostRecord (RUN-89)", () => {
  it("writes one warn line and appends {at, kind, error, cardId} to <user dir>/logs/<ws>/lost-records.ndjson", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    reportLostRecord("card/egress", new Error("database or disk is full"), {
      workspaceId: "ws_abc",
      cardId: "card_1",
    });
    reportLostRecord("governance/tripped", "SQLITE_BUSY", { workspaceId: "ws_abc" });
    expect(warn).toHaveBeenCalledTimes(2);
    expect(String(warn.mock.calls[0]?.[0])).toMatch(
      /card\/egress not recorded: database or disk is full/,
    );
    const path = lostRecordsPath("ws_abc");
    expect(path).toBe(join(home, "logs", "ws_abc", "lost-records.ndjson"));
    const lines = readFileSync(path, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      kind: "card/egress",
      error: "database or disk is full",
      cardId: "card_1",
    });
    expect(Date.parse(lines[0].at)).not.toBeNaN();
    expect(lines[1]).toMatchObject({ kind: "governance/tripped", error: "SQLITE_BUSY" });
    expect(countLostRecords("ws_abc")).toBe(2);
    expect(countLostRecords("ws_none")).toBe(0);
  });

  it("never throws, even when the log itself cannot be written (it is a diagnostic)", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.SEKHEMET_CONFIG_DIR = "/dev/null/not-a-folder";
    expect(() => reportLostRecord("x", new Error("y"), { workspaceId: "w" })).not.toThrow();
  });
});

describe("RUN-91: no swallowed ledger or dossier write at the sites REL-03 cites", () => {
  const root = resolve(import.meta.dirname, "../../..");
  const read = (p: string) => readFileSync(join(root, p), "utf8");
  /** Each `.catch(() => undefined)` whose call chain, within the statement, writes a record. */
  function swallowedWrites(source: string): string[] {
    const found: string[] = [];
    const re = /\.catch\(\(\) => (?:undefined|\[\]|\{\})\)/g;
    for (const m of source.matchAll(re)) {
      const before = source.slice(Math.max(0, (m.index ?? 0) - 400), m.index);
      const stmt = before.slice(Math.max(before.lastIndexOf(";"), before.lastIndexOf("{\n")));
      if (
        /\b(append|appendNow|recordEvent|recordDossierEntry|recordNotReviewed|recordLedgerEvent|recordAnswer|recordQuestion|onNote|postDecision|onAnswerDelivered)\b/.test(
          stmt,
        )
      )
        found.push(stmt.trim().slice(-160));
    }
    return found;
  }
  for (const file of [
    "packages/loop/src/card_runner.ts",
    "apps/harness/src/review_flow.ts",
    "apps/harness/src/governance.ts",
    "apps/harness/src/triage.ts",
    "apps/harness/src/airgap.ts",
    "packages/loop/src/session.ts",
  ]) {
    it(`${file}`, () => {
      expect(swallowedWrites(read(file))).toEqual([]);
    });
  }
});
