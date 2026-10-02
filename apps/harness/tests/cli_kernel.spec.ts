import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/index.js";

describe("sekhemet log: projections derive from the ledger (K8), the repo is a project (K14)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    process.exitCode = 0;
    vi.restoreAllMocks();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("verifies, reports drift with exit 1, and rebuilds with --rebuild", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cli-log-"));
    dirs.push(dir);
    execFileSync("git", ["init", "-q"], { cwd: dir });
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      lines.push(a.join(" "));
    });

    await main(["log", "--repo", dir]);
    expect(process.exitCode ?? 0).toBe(0);
    expect(lines.join("\n")).toContain("byte-identical");

    const db = new DatabaseSync(join(dir, ".sekhemet", "events.db"));
    initSchema(db);
    const store = new CardStore(db, new EventLog(db));
    // Startup made the repository a project, and new cards join it.
    const [project] = store.listProjects();
    expect(project?.name).toBe(basename(dir));
    const card = await store.createCard({ id: "card_l", tier: "story", title: "L" });
    expect(card.projectId).toBe(project?.id);
    db.prepare("UPDATE cards SET title = 'drift' WHERE id = 'card_l'").run();
    db.close();

    lines.length = 0;
    await main(["log", "--repo", dir]);
    expect(process.exitCode).toBe(1);
    expect(lines.join("\n")).toContain("Projections differ from the Activity log: cards");

    process.exitCode = 0;
    lines.length = 0;
    await main(["log", "--repo", dir, "--rebuild"]);
    expect(lines.join("\n")).toContain("Projections rebuilt from the Activity log");
    const again = new DatabaseSync(join(dir, ".sekhemet", "events.db"));
    const title = again.prepare("SELECT title FROM cards WHERE id = 'card_l'").get() as {
      title: string;
    };
    expect(title.title).toBe("L");
    again.close();
  });
});
