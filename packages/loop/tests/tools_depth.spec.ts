import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { retrieveMaskedObservation, workerCopy } from "@sekhemet/context";
import { ProcessSandbox } from "@sekhemet/sandbox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ToolExecutor } from "../src/tools.js";

let root: string;
const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });

function exec(tools: ToolExecutor, name: string, args: Record<string, unknown>) {
  return tools.execute({ id: "t", name, arguments: args });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tools-depth-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(
    join(root, "src", "a.ts"),
    "export const alpha = 1;\nconst beta = 2;\nconst Alpha = 3;\n",
  );
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("grep_search (L6)", () => {
  beforeEach(() => {
    git("init", "-q", "-b", "main");
    writeFileSync(join(root, ".gitignore"), "generated/\n*.log\n");
    mkdirSync(join(root, "generated"), { recursive: true });
    writeFileSync(join(root, "generated", "out.ts"), "export const alpha = 99;\n");
    writeFileSync(join(root, "debug.log"), "alpha in a log\n");
    writeFileSync(join(root, "src", "b.md"), "alpha docs\n");
  });

  it("skips gitignored files but finds untracked ones", async () => {
    const obs = await exec(new ToolExecutor({ worktreePath: root }), "grep_search", {
      query: "alpha",
    });
    expect(obs.ok).toBe(true);
    expect(obs.content).toBe(
      '2 match(es) for "alpha":\nsrc/a.ts:1: export const alpha = 1;\nsrc/b.md:1: alpha docs',
    );
  });

  it("reports file names only, or counts per file", async () => {
    const tools = new ToolExecutor({ worktreePath: root });
    const files = await exec(tools, "grep_search", {
      query: "alpha",
      output_mode: "files_with_matches",
      case_insensitive: true,
    });
    expect(files.content).toBe('2 file(s) match "alpha":\nsrc/a.ts\nsrc/b.md');
    const counts = await exec(tools, "grep_search", {
      query: "alpha",
      output_mode: "count",
      case_insensitive: true,
    });
    expect(counts.content).toBe('3 match(es) for "alpha" in 2 file(s):\nsrc/a.ts:2\nsrc/b.md:1');
  });

  it("prints context lines rg-style and filters by glob", async () => {
    writeFileSync(
      join(root, "src", "c.ts"),
      ["l1", "hit one", "l3", "l4", "l5", "l6", "hit two", "l8"].join("\n"),
    );
    const obs = await exec(new ToolExecutor({ worktreePath: root }), "grep_search", {
      query: "hit",
      context: 1,
      glob: "*.ts",
    });
    expect(obs.content).toBe(
      [
        '2 match(es) for "hit":',
        "src/c.ts-1- l1",
        "src/c.ts:2: hit one",
        "src/c.ts-3- l3",
        "--",
        "src/c.ts-6- l6",
        "src/c.ts:7: hit two",
        "src/c.ts-8- l8",
      ].join("\n"),
    );
  });

  it("refuses an unknown output mode, a negative context and a missing path", async () => {
    const tools = new ToolExecutor({ worktreePath: root });
    const bad = await exec(tools, "grep_search", { query: "a", output_mode: "json" });
    expect(bad.ok).toBe(false);
    expect(bad.summary).toBe('unknown output_mode "json"');
    const neg = await exec(tools, "grep_search", { query: "a", context: -2 });
    expect(neg.ok).toBe(false);
    expect(neg.summary).toContain("non-negative");
    const missing = await exec(tools, "grep_search", { query: "a", path: "nope" });
    expect(missing.summary).toBe("path not found: nope");
  });

  it("falls back to a walk outside git, still skipping build directories", async () => {
    rmSync(join(root, ".git"), { recursive: true, force: true });
    mkdirSync(join(root, "node_modules", "x"), { recursive: true });
    writeFileSync(join(root, "node_modules", "x", "i.js"), "alpha\n");
    const obs = await exec(new ToolExecutor({ worktreePath: root }), "grep_search", {
      query: "alpha",
      output_mode: "files_with_matches",
    });
    // Without git there is no .gitignore evaluation, but node_modules is never searched.
    expect(obs.content).not.toContain("node_modules");
    expect(obs.content).toContain("src/a.ts");
  });
});

describe("run_cmd (L8)", () => {
  it("redirects raw cat, grep and sed to the dedicated tools", async () => {
    const tools = new ToolExecutor({ worktreePath: root });
    const cat = await exec(tools, "run_cmd", { command: "cat src/a.ts" });
    expect(cat.ok).toBe(false);
    expect(cat.summary).toBe("run_cmd refused: use read_file instead of cat");
    expect(cat.content).toContain('read_file(path="...")');
    const grep = await exec(tools, "run_cmd", { command: "ls src && grep -rn alpha src" });
    expect(grep.summary).toBe("run_cmd refused: use grep_search instead of grep");
    const sed = await exec(tools, "run_cmd", {
      command: "/usr/bin/sed",
      args: ["-i", "", "s/a/b/", "src/a.ts"],
    });
    expect(sed.summary).toBe("run_cmd refused: use edit instead of sed");
    expect(readFileSync(join(root, "src", "a.ts"), "utf8")).toContain("alpha");
  });

  it("still allows a filter later in a pipeline, and shows the description", async () => {
    const obs = await exec(new ToolExecutor({ worktreePath: root }), "run_cmd", {
      command: "sort src/a.ts | grep beta",
      description: "find beta",
    });
    expect(obs.ok).toBe(true);
    expect(obs.content).toBe(
      "# find beta\n$ sort src/a.ts | grep beta\nexit code 0\nconst beta = 2;",
    );
  });

  it("condenses long output without losing an error line in the middle, and keeps it recallable", async () => {
    const script = [
      'for i in $(seq 1 400); do echo "progress line $i"; done',
      "echo 'src/a.ts(2,7): error TS2322: Type string is not assignable to type number.'",
      'for i in $(seq 1 400); do echo "trailing noise $i"; done',
      "exit 1",
    ].join("; ");
    const obs = await exec(new ToolExecutor({ worktreePath: root }), "run_cmd", {
      command: script,
    });
    expect(obs.ok).toBe(false);
    expect(obs.summary).toContain("exited 1");
    expect(obs.content).toContain("error TS2322: Type string is not assignable to type number.");
    expect(obs.content.split("\n").length).toBeLessThan(120);
    const ref = /recall\(ref="([^"]+)"\)/.exec(obs.content)?.[1];
    expect(ref).toBeDefined();
    const full = retrieveMaskedObservation(ref as string) ?? "";
    expect(full).toContain("progress line 200");
    expect(full).toContain("trailing noise 400");
  });

  it("writes no recall pointer when recall is not offered (CX-M1-1)", async () => {
    const obs = await exec(
      new ToolExecutor({ worktreePath: root, recallOffered: false }),
      "run_cmd",
      {
        command: 'for i in $(seq 1 400); do echo "progress line $i"; done; exit 1',
      },
    );
    expect(obs.content).toMatch(/lines condensed to/);
    expect(obs.content).not.toMatch(/recall|EvidenceRef/);
  });
});

describe("edit's remedy when the search text is missing (CX-M1-1)", () => {
  it("points at the file's current content, not at a re-read", async () => {
    const tools = new ToolExecutor({ worktreePath: root });
    await exec(tools, "read_file", { path: "src/a.ts" });
    const obs = await exec(tools, "edit", { path: "src/a.ts", search: "gamma", replace: "delta" });
    expect(obs.ok).toBe(false);
    expect(obs.content).toBe(workerCopy.editNotFound("src/a.ts"));
    expect(obs.content).not.toMatch(/re-?read/i);
  });
});

describe("restricted mode and project protection (defects 3 and 5)", () => {
  const unconfinedButRequired = () =>
    new ToolExecutor({
      worktreePath: root,
      requireConfinement: true,
      sandbox: new ProcessSandbox({ disableConfinement: true }),
    });

  it("refuses run_cmd, shell lines and raw commands when nothing can confine them", async () => {
    const tools = unconfinedButRequired();
    const plain = await exec(tools, "run_cmd", { command: "touch", args: ["made-plain"] });
    expect(plain.denied).toBe(true);
    expect(plain.summary).toContain("restricted mode");
    const shell = await exec(tools, "run_cmd", { command: "touch made-shell && echo done" });
    expect(shell.denied).toBe(true);
    const raw = await tools.runCommandRaw("touch", ["made-raw"]);
    expect(raw.exitCode).toBe(126);
    expect(raw.stderr).toContain("restricted mode");
    for (const f of ["made-plain", "made-shell", "made-raw"])
      expect(existsSync(join(root, f))).toBe(false);
  });

  it("honours a strict sandbox handed in without the executor flag", async () => {
    const tools = new ToolExecutor({
      worktreePath: root,
      sandbox: new ProcessSandbox({ disableConfinement: true, requireConfinement: true }),
    });
    const obs = await exec(tools, "run_cmd", { command: "touch", args: ["x"] });
    expect(obs.denied).toBe(true);
    expect(existsSync(join(root, "x"))).toBe(false);
  });

  it("runs normally when restriction is off (control)", async () => {
    const tools = new ToolExecutor({
      worktreePath: root,
      sandbox: new ProcessSandbox({ disableConfinement: true }),
    });
    const obs = await exec(tools, "run_cmd", { command: "touch", args: ["ok-file"] });
    expect(obs.ok).toBe(true);
    expect(existsSync(join(root, "ok-file"))).toBe(true);
  });

  it("denies writes to the project's protected globs and counts the rule", async () => {
    mkdirSync(join(root, "db"), { recursive: true });
    const tools = new ToolExecutor({
      worktreePath: root,
      agentRole: "implementer",
      protectedGlobs: ["db/**"],
    });
    const obs = await exec(tools, "write_file", { path: "db/0001.sql", content: "drop table x;" });
    expect(obs.denied).toBe(true);
    expect(obs.deniedRule).toBe("protected_file");
    expect(existsSync(join(root, "db", "0001.sql"))).toBe(false);
    expect(tools.getDenialCounts()).toEqual({ protected_file: 1 });
  });
});

describe("read-before-edit (L17)", () => {
  it("refuses an edit to an unread file and leaves it unchanged", async () => {
    const tools = new ToolExecutor({ worktreePath: root });
    const before = readFileSync(join(root, "src", "a.ts"), "utf8");
    const obs = await exec(tools, "edit", { path: "src/a.ts", search: "beta", replace: "gamma" });
    expect(obs.ok).toBe(false);
    expect(obs.summary).toBe("edit refused: src/a.ts has not been read this card");
    expect(readFileSync(join(root, "src", "a.ts"), "utf8")).toBe(before);
    for (const [name, args] of [
      ["replace_lines", { path: "src/a.ts", start: 1, end: 1, replacement: "x" }],
      ["write_file", { path: "src/a.ts", content: "x" }],
      ["insert_after_symbol", { path: "src/a.ts", symbol: "alpha", content: "x" }],
    ] as const) {
      expect((await exec(tools, name, args)).summary).toBe(
        `${name} refused: src/a.ts has not been read this card`,
      );
    }
  });

  it("allows the edit after read_file, whatever path spelling was used", async () => {
    const tools = new ToolExecutor({ worktreePath: root });
    await exec(tools, "read_file", { path: "./src/a.ts", start: 1, end: 1 });
    const obs = await exec(tools, "edit", { path: "src/a.ts", search: "beta", replace: "gamma" });
    expect(obs.ok).toBe(true);
    expect(readFileSync(join(root, "src", "a.ts"), "utf8")).toContain("gamma");
  });

  it("allows creating a new file without a read, then editing what it wrote", async () => {
    const tools = new ToolExecutor({ worktreePath: root });
    const created = await exec(tools, "write_file", {
      path: "src/new.ts",
      content: "export const n = 1;\n",
    });
    expect(created.ok).toBe(true);
    const edited = await exec(tools, "edit", { path: "src/new.ts", search: "1", replace: "2" });
    expect(edited.ok).toBe(true);
    expect(readFileSync(join(root, "src", "new.ts"), "utf8")).toBe("export const n = 2;\n");
  });

  it("counts read_symbol and pinned files as read, and can be switched off", async () => {
    const viaSymbol = new ToolExecutor({ worktreePath: root });
    await exec(viaSymbol, "read_symbol", { path: "src/a.ts", symbol: "alpha" });
    expect(viaSymbol.hasSeen("src/a.ts")).toBe(true);
    const pinned = new ToolExecutor({ worktreePath: root });
    pinned.markSeen("src/a.ts");
    expect(
      (await exec(pinned, "edit", { path: "src/a.ts", search: "beta", replace: "b2" })).ok,
    ).toBe(true);
    const off = new ToolExecutor({ worktreePath: root, requireReadBeforeEdit: false });
    expect((await exec(off, "edit", { path: "src/a.ts", search: "b2", replace: "b3" })).ok).toBe(
      true,
    );
    expect(pinned.hasSeen("../outside.ts")).toBe(false);
  });
});
