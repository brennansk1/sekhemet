import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  condenseToolOutput,
  maskOlderObservations,
  retrieveMaskedObservation,
} from "../src/condenser.js";
import {
  FileEvidenceStore,
  InMemoryEvidenceStore,
  defaultEvidenceStore,
  useFileEvidenceStore,
} from "../src/evidence.js";

const dirs: string[] = [];
const tempRepo = () => {
  const d = mkdtempSync(join(tmpdir(), "sekhemet-ev-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  defaultEvidenceStore.use(new InMemoryEvidenceStore());
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

/** 400 passing lines with one failing assertion in the middle, like a long vitest run. */
function longTestOutput(): string {
  const lines: string[] = [];
  for (let i = 0; i < 200; i++) lines.push(` ✓ tests/ledger.spec.ts > appends event ${i} 1ms`);
  lines.push(" × tests/ledger.spec.ts > rejects a broken chain");
  lines.push("   AssertionError: expected 'ok' to be 'tampered'");
  for (let i = 200; i < 400; i++) lines.push(` ✓ tests/ledger.spec.ts > appends event ${i} 1ms`);
  lines.push(" Test Files  1 failed (1)");
  return lines.join("\n");
}

describe("C8: condenseToolOutput is the command-output path", () => {
  it("keeps the middle error line that head/tail clamping dropped, and keeps the raw text", () => {
    const store = new InMemoryEvidenceStore();
    const raw = longTestOutput();
    const out = condenseToolOutput(raw, {
      command: "pnpm test",
      exitCode: 1,
      evidenceStore: store,
    });
    expect(out.text).toContain("× tests/ledger.spec.ts > rejects a broken chain");
    expect(out.text).toContain("AssertionError: expected 'ok' to be 'tampered'");
    expect(out.text).toContain(
      "[grouped] 400 test result(s) passed (suites: tests/ledger.spec.ts)",
    );
    expect(out.text).toContain("Test Files  1 failed (1)");
    expect(out.evidenceRef).toMatch(/^ev_[0-9a-f]{8}$/);
    expect(out.text.endsWith(`Full output: recall(ref="${out.evidenceRef}")]`)).toBe(true);
    expect(store.get(out.evidenceRef as string)).toBe(raw);
    expect(store.getRecord(out.evidenceRef as string)?.meta).toEqual({
      producer: "pnpm test",
      exitCode: 1,
    });
    expect(out.protectedLinesCut).toBe(0);
    expect(out.text.length).toBeLessThan(raw.length / 10);
  });

  it("returns short output unchanged, with no ref and no footer", () => {
    const store = new InMemoryEvidenceStore();
    const out = condenseToolOutput("built 3 packages\ndone", { evidenceStore: store });
    expect(out).toMatchObject({ text: "built 3 packages\ndone", protectedLinesCut: 0 });
    expect(out.evidenceRef).toBeUndefined();
    expect(store.refs()).toEqual([]);
  });

  it("under the character ceiling keeps the first errors and the last line, and says how many were cut", () => {
    const store = new InMemoryEvidenceStore();
    const errors = Array.from(
      { length: 300 },
      (_, i) =>
        `src/ledger.ts(${i + 1},5): error TS2322: Type 'string' is not assignable to type 'number' #${i}.`,
    );
    const raw = [...errors, "Found 300 errors."].join("\n");
    const out = condenseToolOutput(raw, { maxChars: 2000, evidenceStore: store });
    expect(out.text).toContain("src/ledger.ts(1,5): error TS2322");
    expect(out.text).toContain("Found 300 errors.");
    expect(out.text).not.toContain("#299.");
    expect(out.protectedLinesCut).toBeGreaterThan(250);
    expect(out.text).toContain(`${out.protectedLinesCut} further error line(s) cut for length`);
    expect(store.get(out.evidenceRef as string)).toBe(raw);
  });
});

describe("C6: masked observations survive a restart", () => {
  it("useFileEvidenceStore makes masking write to .sekhemet/observations, readable by a new process", () => {
    const repo = tempRepo();
    useFileEvidenceStore(repo);
    const big = Array.from({ length: 30 }, (_, i) => `line ${i} of tsc output`).join("\n");
    const masked = maskOlderObservations(
      [
        { turn: 1, action: "run_cmd", result: big },
        { turn: 2, action: "read_file", result: "short" },
        { turn: 3, action: "edit", result: "ok" },
      ],
      2,
      { cardId: "card_1" },
    );
    const ref = /EvidenceRef: (ev_[0-9a-f]{8})/.exec(masked[0]?.result ?? "")?.[1];
    expect(ref).toBeDefined();
    expect(existsSync(join(repo, ".sekhemet", "observations", `${ref}.txt`))).toBe(true);
    // Nothing lands among the per-card evidence bundles.
    expect(existsSync(join(repo, ".sekhemet", "evidence"))).toBe(false);

    // "Restart": the default store is reset to memory, a fresh file store reads the disk.
    defaultEvidenceStore.use(new InMemoryEvidenceStore());
    expect(retrieveMaskedObservation(ref as string)).toBeUndefined();
    const reopened = new FileEvidenceStore(repo);
    expect(retrieveMaskedObservation(ref as string, reopened)).toBe(big);
    expect(reopened.getRecord(ref as string)?.meta).toEqual({
      producer: "run_cmd",
      turn: 1,
      cardId: "card_1",
    });
    // And recall through the default store works again once it points at disk.
    useFileEvidenceStore(repo);
    expect(retrieveMaskedObservation(ref as string)).toBe(big);
  });
});
