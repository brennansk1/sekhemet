import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { findUnreachable, reachabilityGate } from "../src/reachability_gate.js";

/**
 * GT-T2-4: the reachability gate over Sekhemet's own repository, every
 * export treated as added. It must finish within a gate's timeout, report
 * each unreachable export with its file, name and a one-edit remedy, and
 * never report an export a checked-in list records as reachable only through
 * a barrel, a namespace import or an entry point.
 */
const REPO = resolve(import.meta.dirname, "..", "..", "..");
/** The built-in gates' default timeout: the reachability gate must finish well inside it. */
const GATE_TIMEOUT_MS = 120_000;

interface Recorded {
  file: string;
  name: string;
  through: "barrel" | "namespace" | "entry";
}

describe("the reachability gate over this repository (GT-T2-4)", () => {
  it("judges every export in time, with file, name and remedy, and spares the indirectly reachable", () => {
    const started = Date.now();
    const failures = reachabilityGate(REPO, "main", {}, "every");
    expect(Date.now() - started).toBeLessThan(GATE_TIMEOUT_MS);

    for (const f of failures) {
      expect(f.location?.file).toMatch(/\.[cm]?tsx?$/);
      expect(f.errorExcerpt).toMatch(/: export \S+ is used by nothing/);
      expect(f.suggestedAction).toMatch(/wire it into/);
    }

    const recorded = (
      JSON.parse(
        readFileSync(join(import.meta.dirname, "__golden__", "reachable_indirectly.json"), "utf8"),
      ) as { exports: Recorded[] }
    ).exports;
    expect(recorded.length).toBeGreaterThan(0);
    const reported = new Set(
      findUnreachable(REPO, "main", {}, "every").map((d) => `${d.file}#${d.name}`),
    );
    expect(recorded.filter((r) => reported.has(`${r.file}#${r.name}`))).toEqual([]);
  });

  it("still reports an export only a file's own tests use", () => {
    // The control: the harness's own CLI modules export helpers for their
    // tests; with every export judged, some of those are reported, so the
    // list above is spared for a reason, not because nothing is reported.
    const reported = findUnreachable(REPO, "main", {}, "every");
    expect(reported.some((d) => d.file.startsWith("apps/harness/src/"))).toBe(true);
  });
});
