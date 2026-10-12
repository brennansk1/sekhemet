import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initLocalKernel, main } from "../src/index.js";

/**
 * S1B-B16: `sekhemet plan` with no model leaves every issue held in Planning
 * under an epic stored In progress; Status said the epic was In progress,
 * *Being built*, with nothing running. A parent is shown where its issues are.
 */
describe("S1B-B16: an epic is shown where its issues are", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    process.exitCode = undefined;
  });

  async function heldPlan(): Promise<string> {
    const repo = mkdtempSync(join(tmpdir(), "epic-held-"));
    dirs.push(repo);
    const { db, cardStore } = initLocalKernel(repo);
    await cardStore.createCard({ id: "epic_e", tier: "epic", title: "E", status: "in_progress" });
    for (const id of ["s_a", "s_b"])
      await cardStore.createCard({
        id,
        tier: "story",
        title: id,
        parentId: "epic_e",
        scopeFiles: [`${id}.ts`],
        status: "planning",
      });
    db.close();
    return repo;
  }

  async function stdoutOf(argv: string[]): Promise<string> {
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      lines.push(a.map(String).join(" "));
    });
    try {
      await main(argv);
    } finally {
      spy.mockRestore();
    }
    return lines.join("\n");
  }

  it("status lists the epic under To do, as Planning, and In progress empty", async () => {
    const repo = await heldPlan();
    const text = await stdoutOf(["status", "--repo", repo]);
    const section = (name: string) =>
      text.split("\n\n").find((block) => block.startsWith(name)) ?? "";
    expect(section("To do")).toMatch(/epic_e {2}E {2}Planning/);
    // The Planning limit counts the two issues, not the epic over them.
    expect(section("To do")).toMatch(/^To do {2}3 {2}\(Planning 2\/3\)/);
    expect(section("In progress")).not.toMatch(/epic_e/);
    expect(section("In progress")).toMatch(/^In progress {2}0/);
  });

  it("status --json's columns put the epic in To do and never call it Being built", async () => {
    const repo = await heldPlan();
    // `--json` writes the columns this computation gives (`status.ts`).
    const { statusColumns } = await import("../src/commands/status.js");
    const { db, boardService } = initLocalKernel(repo);
    const columns = statusColumns((await boardService.getBoardState()).cards);
    db.close();
    const epic = columns.find((c) => c.name === "To do")?.issues.find((i) => i.id === "epic_e");
    expect(epic?.state).toBe("Being planned");
    expect(columns.find((c) => c.name === "In progress")?.issues).toEqual([]);
  });
});
