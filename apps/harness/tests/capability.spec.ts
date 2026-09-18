import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CardRecord } from "@sekhemet/kernel";
import { afterEach, describe, expect, it } from "vitest";
import { capabilityReport, capabilitySummary, wilson } from "../src/pm/capability.js";

describe("worker capability from evidence", () => {
  const repos: string[] = [];
  afterEach(() => {
    for (const r of repos.splice(0)) rmSync(r, { recursive: true, force: true });
  });

  it("computes a Wilson interval that is wide for small samples", () => {
    expect(wilson(2, 4)).toEqual({ low: 0.15, high: 0.85 });
    expect(wilson(0, 0)).toEqual({ low: 0, high: 1 });
  });

  it("groups first attempts by card kind and finds the 80% size horizon", () => {
    const repo = mkdtempSync(join(tmpdir(), "cap-"));
    repos.push(repo);
    const dir = join(repo, ".sekhemet", "evidence");
    mkdirSync(dir, { recursive: true });
    const ev = (n: number, cardId: string, attempt: number, passed: boolean, linesAdded: number) =>
      writeFileSync(
        join(dir, `ev_${n}.json`),
        JSON.stringify({ cardId, attempt, passed, linesAdded }),
      );
    ev(1, "a", 1, true, 20);
    ev(2, "b", 1, true, 40);
    ev(3, "c", 1, true, 45);
    ev(4, "d", 1, true, 30);
    ev(5, "e", 1, false, 150);
    ev(6, "f", 1, false, 180);
    ev(7, "e", 2, true, 150); // retries do not count toward first-attempt rates
    writeFileSync(join(dir, "latest-a.json"), "{}");

    const card = (id: string, kind: string) =>
      ({ id, title: `T (SPIDR: ${kind})`, labels: [] }) as unknown as CardRecord;
    const r = capabilityReport(repo, [
      card("a", "Interface"),
      card("b", "Rule"),
      card("c", "Rule"),
      card("d", "Data"),
      card("e", "Rule & Path"),
      card("f", "Rule"),
    ]);
    expect(r.sampleSize).toBe(6);
    expect(r.types.find((t) => t.type === "Rule")).toMatchObject({ attempts: 4, passes: 2 });
    expect(r.horizon80Lines).toBe(50);
    expect(r.note).toMatch(/range/);
    expect(capabilitySummary(r)).toContain("Rules 2/4 (95% CI 15-85%)");
  });
});
