import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { findChrome } from "@sekhemet/sandbox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TOOL_CATALOG, cardClassFor, toolsForClass } from "../src/tool_catalog.js";
import { ToolExecutor } from "../src/tools.js";

describe("loop tools, wave 2b (L12, L18, L19, L20, L23, L24)", () => {
  let root: string;
  let tools: ToolExecutor;
  const run = (name: string, args: Record<string, unknown>) =>
    tools.execute({ id: "t", name, arguments: args });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "tools-w2b-"));
    execFileSync("git", ["init", "-q"], { cwd: root });
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\nexport const TODO_1 = 1;\n");
    writeFileSync(join(root, "src", "b.ts"), "// TODO: b\nexport const b = 2;\n");
    tools = new ToolExecutor({ worktreePath: root, scopeFiles: ["src/**"] });
  });
  afterEach(() => {
    tools.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it("runs a code-mode script over read-only helpers and nothing else (L12)", async () => {
    const obs = await run("run_script", {
      code: 'return find("src/*.ts").map((f) => ({ f, todos: grep("TODO", f).length }));',
    });
    expect(obs.ok).toBe(true);
    expect(JSON.parse(obs.content)).toEqual([
      { f: "src/a.ts", todos: 1 },
      { f: "src/b.ts", todos: 1 },
    ]);
    // The script can read; it cannot write, spawn, or leave the worktree.
    const write = await run("run_script", {
      code: 'require("node:fs").writeFileSync("src/a.ts", "pwned"); return "wrote";',
    });
    expect(write.ok).toBe(false);
    const spawn = await run("run_script", {
      code: 'return require("node:child_process").execSync("id").toString();',
    });
    expect(spawn.ok).toBe(false);
    const outside = await run("run_script", { code: 'return read("../../etc/passwd");' });
    expect(outside.ok).toBe(false);
    const spin = await run("run_script", { code: "for (;;) {}" });
    expect(spin.content).toMatch(/timed out/i);
  }, 60_000);

  it("gives each card class its fixed tool list (L18, L19)", () => {
    // Tool sets are selected by the card's kind, from the kernel's single
    // definition. A SPIDR spike is `spike`, not a second word for it.
    expect(cardClassFor({ title: "Explore the parser (SPIDR: Spike)", tier: "story" })).toBe(
      "spike",
    );
    expect(cardClassFor({ title: "x", tier: "task", labels: ["research"] })).toBe("research");
    expect(cardClassFor({ title: "Add a flag", tier: "task" })).toBe("implement");
    const spike = toolsForClass("spike").map((t) => t.name);
    expect(spike).toContain("read_file");
    expect(spike).not.toContain("write_file");
    expect(spike).not.toContain("run_cmd");
    const research = toolsForClass("research").map((t) => t.name);
    expect(research).toContain("browse");
    expect(research).not.toContain("edit");
    // L19: a card that writes code can start its own app. The progressive arm
    // (the CLI's until B2.5 decides, worker-loop rule 11) keeps the whole
    // catalog; the fixed set of twelve (WL-M2-3) is the other arm.
    expect(
      toolsForClass("implement", TOOL_CATALOG, { arm: "progressive" }).map((t) => t.name),
    ).toContain("start_process");
  });

  it("refuses web pages outside research cards but loads the card's own app (L19, L20)", async () => {
    const outside = await run("browse", { url: "https://example.com/" });
    expect(outside.denied).toBe(true);
    const server = createServer((_q, r) =>
      r.end("<html><body><h1>Chronicle</h1><script>1</script><p>ok</p></body></html>"),
    );
    const port: number = await new Promise((r) =>
      server.listen(0, "127.0.0.1", () => r((server.address() as { port: number }).port)),
    );
    try {
      const page = await run("browse", { url: `http://127.0.0.1:${port}/` });
      expect(page.ok).toBe(true);
      expect(page.content).toContain("Chronicle");
      expect(page.content).not.toContain("<script>");
    } finally {
      await new Promise((r) => server.close(() => r(undefined)));
    }
    expect(typeof findChrome()).toMatch(/string|undefined/);
  }, 60_000);

  it.runIf(platform() === "darwin")(
    "runs a background server on its own port that later commands can reach, with interactive input (L23, L24)",
    async () => {
      const started = await run("start_process", {
        name: "web",
        command:
          "node -e \"require('http').createServer((q,r)=>r.end('pong')).listen(process.env.PORT); process.stdin.on('data', d => console.log('echo:' + d.toString().trim()))\"",
      });
      expect(started.ok).toBe(true);
      const port = /PORT=(\d+)/.exec(started.content)?.[1];
      await new Promise((r) => setTimeout(r, 600));
      const curl = await run("run_cmd", { command: `curl -s http://localhost:${port}/` });
      expect(curl.content).toContain("pong");
      await run("write_process", { name: "web", input: "hello" });
      await new Promise((r) => setTimeout(r, 300));
      const out = await run("read_process", { name: "web" });
      expect(out.content).toContain("echo:hello");
      expect(out.content).toContain(`running on port ${port}`);
      const stopped = await run("stop_process", { name: "web" });
      expect(stopped.ok).toBe(true);
    },
  );
});
