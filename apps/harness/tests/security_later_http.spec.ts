import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { WORKER, scriptedTurnsProject } from "./support/g6_models.js";
import { BIN, type G6Repo, g6Repo } from "./support/g6_review.js";

/**
 * security item 32a (NEW-security-12) at the door (C2d, FINDINGS_C1 TST-01):
 * a spawned `sekhemet queue` whose scripted Worker writes files that another
 * tool runs later, outside the sandbox — or files that only look like them —
 * then the card's evidence as `sekhemet serve` serves it to the Review view
 * (`GET /api/evidence/<card>`, which `packages/ui/web/evidence.js` renders as
 * "Runs outside the sandbox later").
 *
 * The binary under test is `apps/harness/dist/index.js`, spawned through
 * `support/g6_review.ts` (`BIN`).
 */

const children: ChildProcess[] = [];
afterEach(() => {
  for (const c of children.splice(0)) if (c.exitCode === null) c.kill("SIGKILL");
});

const writeFile = (path: string) => ({
  name: "write_file",
  arguments: { path, content: "x = 1\n" },
});

async function buildAndServe(
  paths: string[],
): Promise<{ r: G6Repo; evidence: Record<string, unknown>; out: string }> {
  const r = g6Repo();
  const project = await scriptedTurnsProject(
    r,
    [
      {
        calls: [
          ...paths.map(writeFile),
          { name: "write_file", arguments: { path: "src/a.ts", content: "export const a = 2;\n" } },
          { name: "finish_card", arguments: {} },
        ],
      },
    ],
    { stepBudget: 3, scope: ["src/a.ts", ...paths], maxFiles: paths.length + 2 },
  );
  const run = spawnSync(process.execPath, [...project.nodeArgs, BIN, "queue", "--worker", WORKER], {
    cwd: r.repo,
    encoding: "utf8",
    timeout: 120_000,
    env: r.env({ env: project.env }),
  });
  const child = spawn(process.execPath, [BIN, "serve", "--port", "0"], {
    cwd: r.repo,
    env: r.env(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let out = "";
  child.stderr?.on("data", (d) => {
    out += String(d);
  });
  const address = await new Promise<string>((ok, bad) => {
    const timer = setTimeout(() => bad(new Error(`no address: ${out}`)), 30_000);
    child.stdout?.on("data", (d) => {
      out += String(d);
      const m = /running at:\s+(http:\/\/127\.0\.0\.1:\d+)/.exec(out);
      if (m) {
        clearTimeout(timer);
        ok(m[1] as string);
      }
    });
    child.once("exit", (code) => bad(new Error(`serve exited ${code}: ${out}`)));
  });
  try {
    const res = await fetch(`${address}/api/evidence/c1`);
    expect(res.status, run.stdout + run.stderr).toBe(200);
    return {
      r,
      evidence: (await res.json()) as Record<string, unknown>,
      out: run.stdout + run.stderr,
    };
  } finally {
    child.kill("SIGTERM");
  }
}

describe("SEC-N12-1, SEC-N12-2: files that run outside the sandbox later are marked on the card", () => {
  it("SEC-N12-1: a diff adding agent and editor configuration, at any depth and in any letter case, is marked in the evidence the Review view shows", async () => {
    // (The Worker's own tools may not write a top-level .claude/, .codex/ or
    // .mcp.json at all; these are the ones a diff can carry.)
    const later = [
      "pkg/.Cursor/rules.mdc",
      ".github/copilot-instructions.md",
      "docs/AGENTS.md",
      "Claude.md",
      "mise.toml",
    ];
    const { evidence, out } = await buildAndServe(later);
    const bundle = (evidence.evidence ?? evidence) as {
      executesLater?: string[];
      filesTouched?: string[];
    };
    expect(bundle.filesTouched, out).toEqual(expect.arrayContaining(later));
    expect([...(bundle.executesLater ?? [])].sort()).toEqual([...later].sort());
  }, 150_000);

  it("SEC-N12-2: files that only resemble those names are not marked", async () => {
    const lookalikes = ["src/claude.ts", "docs/agents.md.bak", "cursor/index.ts"];
    const { evidence, out } = await buildAndServe(lookalikes);
    const bundle = (evidence.evidence ?? evidence) as {
      executesLater?: string[];
      filesTouched?: string[];
    };
    expect(bundle.filesTouched, out).toEqual(expect.arrayContaining(lookalikes));
    expect(bundle.executesLater ?? []).toEqual([]);
  }, 150_000);
});
