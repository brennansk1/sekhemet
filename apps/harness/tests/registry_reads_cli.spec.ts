import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ModelRegistry, hostFingerprintHash } from "@sekhemet/models";
import { describe, expect, it } from "vitest";
import { sandboxDirs, sekhemet, sekhemetAsync } from "./cli_fixture.js";

/**
 * Wave 7 A1–A3 (sweep 4): a read or a refusal leaves the model registry
 * unchanged (models.md MD-N12-9, rule 25). Each command runs in a fresh home
 * through the built binary; the home's `models.json` is compared byte for
 * byte before and after — absent before, absent after; seeded before, the
 * same bytes after.
 */

const READS_AND_REFUSALS: string[][] = [
  ["models", "list"],
  ["doctor"],
  ["models", "assign", "planner", "gemma-x"],
  ["models", "assign", "worker", "nail-mtp"],
  ["models", "assign", "researcher", "nosuch"],
  ["qualify", "--models", "ghost-7b", "--role", "planner", "--check"],
  ["qualify", "--models", "nosuch", "--role", "researcher", "--check"],
  ["qualify", "--models", "nail-mtp", "--check"],
  // Free text: the queue's Coding model, not verified here, is refused first.
  ["build a login page"],
];

function registryBytes(home: string): string | undefined {
  const path = join(home, ".sekhemet", "models.json");
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

describe("MD-N4-5b (wave 7 A1–A3): a read or a refusal never writes the registry", () => {
  it("each read or refused command in a fresh home leaves models.json as it was, absent or seeded", async () => {
    const where = sandboxDirs();
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: where.cwd });
    const init = sekhemet(["init"], where);
    expect(init.status, init.stdout + init.stderr).toBe(0);
    // A registry a person already has: a model added and a role assigned.
    const seededPath = join(where.home, "seed", "models.json");
    const reg = new ModelRegistry(seededPath);
    reg.upsert("gemma-r", { engine: "llama.cpp", family: "gemma" });
    reg.recordRoleAssignment("some-host", {
      role: "planner",
      model: "gemma-r",
      scope: "personal",
      by: "person",
      date: "2026-10-11T00:00:00.000Z",
    });
    const seeded = readFileSync(seededPath, "utf8");
    // The same on this machine's host: a Coding model of a known family that is
    // not verified here, and a Planning model of another family, so the Review
    // role resolves to a model and is described (wave 7 review, findings 2–3).
    const hostPath = join(where.home, "seed-host", "models.json");
    const onHost = new ModelRegistry(hostPath);
    for (const [role, model] of [
      ["worker", "qwen3-coder:30b"],
      ["planner", "gemma-x:latest"],
    ] as const) {
      onHost.recordRoleAssignment(hostFingerprintHash(), {
        role,
        model,
        scope: "personal",
        by: "person",
        date: "2026-10-11T00:00:00.000Z",
      });
    }
    const hostSeeded = readFileSync(hostPath, "utf8");
    const changed: string[] = [];
    for (const args of READS_AND_REFUSALS) {
      for (const seed of [undefined, seeded, hostSeeded]) {
        const home = join(where.home, "..", `fresh-${Math.random().toString(36).slice(2)}`);
        mkdirSync(join(home, ".sekhemet"), { recursive: true });
        if (seed !== undefined)
          cpSync(seed === seeded ? seededPath : hostPath, join(home, ".sekhemet", "models.json"));
        const r = await sekhemetAsync(args, { cwd: where.cwd, home });
        expect(r.status, `${args.join(" ")}: ${r.stdout}${r.stderr}`).not.toBeNull();
        const after = registryBytes(home);
        if (after !== seed)
          changed.push(
            `${args.join(" ")} (${seed === undefined ? "fresh" : seed === seeded ? "seeded" : "seeded on this host"}): ${after ?? "removed"}`,
          );
        rmSync(home, { recursive: true, force: true });
      }
    }
    expect(changed).toEqual([]);
  }, 240_000);
});
