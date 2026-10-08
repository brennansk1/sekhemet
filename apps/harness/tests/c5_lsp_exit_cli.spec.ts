import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { BIN } from "./support/g2_cli.js";
import { startEngine } from "./support/g4_engine.js";
import { queueProject } from "./support/g4_queue.js";
import { guardedImports, killTree, trackChild } from "./support/hygiene.js";

/**
 * A run that started a language server ends, servers and all (worker-loop
 * WL-N7-4; C2d G4 finding routed to C5): `sekhemet queue` spawned as the
 * built binary (`apps/harness/dist/index.js`) over a real repository and
 * ledger, a test `typescript-language-server` on PATH (the context package's
 * fake LSP), the Worker a scripted engine (`support/g4_engine.ts`). No model
 * is loaded.
 */

const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..");
const FAKE_LSP = join(REPO_ROOT, "packages", "context", "tests", "support", "fake_lsp.mjs");

function lspOnPath(home: string): string {
  const bin = join(home, "lsp-bin");
  mkdirSync(bin, { recursive: true });
  const server = join(bin, "typescript-language-server");
  writeFileSync(server, `#!${process.execPath}\n${readFileSync(FAKE_LSP, "utf8")}`);
  chmodSync(server, 0o755);
  return `${bin}:${process.env.PATH ?? ""}`;
}

describe("language servers stop with the run (WL-N7-4)", () => {
  it("WL-N7-4: `queue` exits by itself after its report when a step started a language server", async () => {
    const p = await queueProject({
      files: {
        "src/a.ts": "export function greet() {}\ngreet();\n",
        "src/b.ts": 'import { greet } from "./a.js";\ngreet();\n',
      },
      cards: [
        {
          id: "c1",
          tier: "story",
          title: "Rename greet",
          scopeFiles: ["src/**"],
          stepBudget: 4,
          spec: "Rename greet to welcome",
        },
      ],
    });
    const engine = await startEngine(p.home, [
      {
        calls: [
          {
            name: "rename_symbol",
            arguments: { path: "src/a.ts", symbol: "greet", new_name: "welcome" },
          },
        ],
      },
      { calls: [{ name: "finish_card" }] },
    ]);
    const child = trackChild(
      spawn(
        process.execPath,
        [...guardedImports(engine.preload), BIN, "queue", "--worker", "scripted-worker:latest"],
        {
          cwd: p.repo,
          env: { ...p.env, ...engine.env, PATH: lspOnPath(p.home) },
          stdio: ["ignore", "pipe", "pipe"],
          detached: true,
        },
      ),
    );
    let out = "";
    child.stdout?.on("data", (b) => {
      out += String(b);
    });
    child.stderr?.on("data", (b) => {
      out += String(b);
    });
    const exited = new Promise<number | null>((r) => child.once("close", (code) => r(code)));
    const reported = Date.now();
    const code = await Promise.race([
      exited,
      new Promise<"hung">((r) => setTimeout(() => r("hung"), 90_000)),
    ]);
    if (code === "hung") killTree(child);
    expect(out).toMatch(/Report: \S+queue_report\.json/);
    // The language server really started (rename_symbol goes through it).
    expect(out).toMatch(/rename_symbol/);
    expect(code, out).not.toBe("hung");
    expect(Date.now() - reported).toBeLessThan(90_000);
  }, 150_000);
});
