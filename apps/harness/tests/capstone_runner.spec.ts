import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error: plain ESM scripts, run by hand and checked here.
import * as grid from "../../../scripts/capstone/grid.mjs";
// @ts-expect-error: plain ESM scripts, run by hand and checked here.
import * as person from "../../../scripts/capstone/person.mjs";
// @ts-expect-error: plain ESM scripts, run by hand and checked here.
import * as reply from "../../../scripts/capstone/reply.mjs";
// @ts-expect-error: plain ESM scripts, run by hand and checked here.
import * as runner from "../../../scripts/capstone/runner.mjs";

/**
 * The capstone's arms runner (W2 G5, CAPSTONE_SELECTION "Protocol"): every
 * arm's first input is `prompt.md` byte for byte and its change request
 * `change_request.md`, both hash-checked; a one-shot cell is one request per
 * phase with no tools and no retries; nothing from the hidden suite's
 * directory reaches a contestant's directory. Real git, real processes, a
 * fake model server on its own port.
 */

const ROOT = resolve(import.meta.dirname, "..", "..", "..");
const FIXTURE = join(ROOT, "fixtures", "capstone", "timesheet");
const manifest = JSON.parse(readFileSync(join(FIXTURE, "manifest.json"), "utf8"));
const PROMPT = readFileSync(join(FIXTURE, "prompt.md"), "utf8");
const CHANGE = readFileSync(join(FIXTURE, "change_request.md"), "utf8");
const sha = (t: string | Buffer) => createHash("sha256").update(t).digest("hex");
const CANARY = `hidden-canary-${Date.now()}-do-not-copy`;

const temps: string[] = [];
const servers: Server[] = [];
/** Sealed (mode 000) directories, opened again before their temp is removed. */
const sealedDirs: string[] = [];
afterEach(async () => {
  for (const d of sealedDirs.splice(0)) chmodSync(d, 0o700);
  for (const s of servers.splice(0)) await new Promise((r) => s.close(() => r(undefined)));
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});
function temp(prefix = "capstone-runner-"): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  temps.push(d);
  return d;
}

type Env = NodeJS.ProcessEnv & {
  SEKHEMET_CAPSTONE_RUNS: string;
  SEKHEMET_CAPSTONE_HIDDEN: string;
  SEKHEMET_WEBBENCH_SRC: string;
  TMPDIR: string;
};

/**
 * A runs root, a stand-in hidden directory holding a canary, a stand-in
 * Web-Bench checkout and a temp directory of its own, all under the
 * temporary directory. Both sealed directories are readable: a one-shot arm
 * needs no isolation, an agentic arm is refused.
 */
function env(): Env {
  const base = temp();
  const hidden = join(base, "capstone-hidden");
  mkdirSync(join(hidden, "tests"), { recursive: true });
  writeFileSync(join(hidden, "tests", "canary.test.mjs"), `// ${CANARY}\n`);
  writeFileSync(join(hidden, "run.mjs"), `// ${CANARY}\n`);
  const webbench = join(base, "webbench-src");
  mkdirSync(webbench);
  mkdirSync(join(base, "tmp"));
  return {
    ...process.env,
    SEKHEMET_CAPSTONE_RUNS: join(base, "runs"),
    SEKHEMET_CAPSTONE_HIDDEN: hidden,
    SEKHEMET_WEBBENCH_SRC: webbench,
    TMPDIR: join(base, "tmp"),
  };
}

/**
 * The same, with both sealed directories unreadable to this user (mode 000,
 * as another user's mode-700 directory looks): what an agentic arm needs.
 */
function sealedEnv(): Env {
  const e = env();
  for (const d of [e.SEKHEMET_CAPSTONE_HIDDEN, e.SEKHEMET_WEBBENCH_SRC]) {
    chmodSync(d, 0o000);
    sealedDirs.push(d);
  }
  return e;
}

function git(dir: string, ...args: string[]): string {
  const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

/** Every file under `dir` (with `.git`), for the canary search. */
function allFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(p);
    }
  };
  walk(dir);
  return out;
}

const REPLY_1 = [
  "Here is the app.",
  "",
  "### src/main.ts",
  "",
  "```ts",
  'console.log("timesheet");',
  "```",
  "",
  "### src/notes.md",
  "",
  "````md",
  "A fence inside: ```",
  "````",
  "",
  "### ../escape.txt",
  "",
  "```",
  "nope",
  "```",
  "",
  "### src/unclosed.ts",
  "",
  "```ts",
  "export const x = 1;",
].join("\n");
const REPLY_2 = [
  "### src/main.ts",
  "",
  "```ts",
  'console.log("timesheet 2");',
  "```",
  "",
  "### src/notes.md",
  "",
  "(deleted)",
  "",
].join("\n");

interface Seen {
  body: Record<string, unknown>;
}
/** A fake OpenAI-compatible model server: `answers` in order, or a status code to fail with. */
async function fakeModel(
  answers: (string | number)[],
  nCtx = 131072,
): Promise<{ url: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    if (req.method === "GET" && req.url === "/props") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ default_generation_settings: { n_ctx: nCtx } }));
      return;
    }
    if (req.method !== "POST" || !req.url?.startsWith("/v1/chat/completions")) {
      res.writeHead(404).end();
      return;
    }
    seen.push({ body: JSON.parse(raw) });
    const next = answers[seen.length - 1];
    if (typeof next === "number") {
      res.writeHead(next, { "Content-Type": "application/json" }).end('{"error":"down"}');
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        choices: [{ message: { role: "assistant", content: next ?? "" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      }),
    );
  });
  servers.push(server);
  await new Promise((r) => server.listen(0, "127.0.0.1", () => r(undefined)));
  const addr = server.address() as { port: number };
  return { url: `http://127.0.0.1:${addr.port}`, seen };
}

function registry(dir: string): string {
  const file = join(dir, "models.json");
  writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      models: [
        {
          id: "nail-mtp",
          family: "qwen",
          sampling: { temperature: 0.6, topP: 0.95, topK: 20, minP: 0 },
        },
      ],
    }),
  );
  return file;
}

describe("the one-shot reply format", () => {
  it("writes whole files, deletes on (deleted), and counts what it cannot read without repairing it", () => {
    const parsed = reply.parseReply(REPLY_1);
    const kinds = parsed.sections.map((s: { path: string; kind: string }) => `${s.kind}:${s.path}`);
    expect(kinds).toEqual([
      "file:src/main.ts",
      "file:src/notes.md",
      "unparsed:../escape.txt",
      "unparsed:src/unclosed.ts",
    ]);
    expect(parsed.sections[1].content).toBe("A fence inside: ```\n");
    expect(parsed.ignoredLines).toBe(1);
    const repo = temp();
    const applied = reply.applyReply(repo, parsed);
    expect(applied.written).toEqual(["src/main.ts", "src/notes.md"]);
    expect(applied.unparsedCount).toBe(2);
    expect(existsSync(join(repo, "..", "escape.txt"))).toBe(false);
    expect(existsSync(join(repo, "src", "unclosed.ts"))).toBe(false);
    reply.applyReply(repo, reply.parseReply(REPLY_2));
    expect(readFileSync(join(repo, "src", "main.ts"), "utf8")).toBe(
      'console.log("timesheet 2");\n',
    );
    expect(existsSync(join(repo, "src", "notes.md"))).toBe(false);
  });

  it("refuses absolute paths and paths into .git", () => {
    for (const p of ["/etc/passwd", ".git/config", "a/../b", "C:/x", "a\\b"])
      expect(reply.pathRefusal(p), p).not.toBeNull();
    expect(reply.pathRefusal("src/pay.ts")).toBeNull();
  });
});

describe("the frozen input", () => {
  it("each one-shot message begins with the frozen text byte for byte, and its hash is the manifest's", () => {
    const first = runner.oneShotMessage("release-1");
    expect(first.message.startsWith(PROMPT)).toBe(true);
    expect(sha(first.message.slice(0, PROMPT.length))).toBe(manifest.files["prompt.md"].sha256);
    expect(first.frozenSha256).toBe(manifest.files["prompt.md"].sha256);
    const seedRecord = JSON.parse(readFileSync(join(FIXTURE, "seed.json"), "utf8"));
    expect(first.listingSha256).toBe(seedRecord.listingSha256);
    const tree = temp();
    writeFileSync(join(tree, "a.txt"), "x\n");
    expect(() => runner.oneShotMessage("change-request", { tree })).toThrow(/first request/);
    const second = runner.oneShotMessage("change-request", {
      tree,
      first: { message: first.message, reply: REPLY_1 },
    });
    // The whole conversation so far, the same for every model: the first
    // request, its reply unchanged, then change_request.md byte for byte.
    expect(second.message.startsWith(first.message)).toBe(true);
    expect(second.message).toContain(`${runner.CONVERSATION_HEADINGS.firstReply}${REPLY_1}`);
    const at = second.frozenAt;
    expect(at).toBeGreaterThan(first.message.length + REPLY_1.length);
    expect(second.message.slice(at, at + CHANGE.length)).toBe(CHANGE);
    expect(sha(second.message.slice(at, at + CHANGE.length))).toBe(
      manifest.files["change_request.md"].sha256,
    );
    expect(second.carried).toEqual({
      firstMessageSha256: sha(first.message),
      firstReplySha256: sha(REPLY_1),
    });
    expect(second.message).toContain("### a.txt");
    expect(() =>
      runner.oneShotMessage("change-request", {
        tree,
        first: { message: "not the prompt", reply: REPLY_1 },
      }),
    ).toThrow(/prompt\.md/);
  });

  it("measures every cell's window by the product's own characters-per-token rule", async () => {
    const models = await import(join(ROOT, "packages", "models", "dist", "index.js"));
    expect(runner.CHARS_PER_TOKEN).toBe(models.PROMPT_CHARS_PER_TOKEN);
    expect(runner.windowRefusal("x".repeat(1000))).toBeNull();
    const big = "x".repeat(Math.ceil(runner.ONE_SHOT.contextTokens * runner.CHARS_PER_TOKEN));
    expect(runner.windowRefusal(big)).toMatch(/does not fit the common window/);
  });

  it("refuses a frozen text whose hash is not the manifest's", () => {
    const copy = temp();
    cpSync(FIXTURE, copy, { recursive: true });
    writeFileSync(join(copy, "prompt.md"), `${PROMPT} `);
    expect(() => runner.oneShotMessage("release-1", { fixture: copy })).toThrow(/not the frozen/);
  });
});

describe("a one-shot cell with a local model", () => {
  it("is one request per phase through the product's adapter, with no tools, and lands each reply", async () => {
    const e = env();
    const model = await fakeModel([REPLY_1, REPLY_2]);
    const made = await runner.askerFor(grid.arm("one-shot-nail-mtp"), {
      baseUrl: model.url,
      registryPath: registry(temp()),
      env: e,
    });
    const { paths } = await runner.runOneShot("one-shot-nail-mtp", 1, made.ask, { env: e });
    expect(model.seen).toHaveLength(2);
    const [r1, r2] = model.seen.map(
      (s) =>
        s.body as {
          messages: { role: string; content: string }[];
          tools?: unknown;
          temperature?: number;
        },
    );
    expect(r1?.messages).toEqual([
      { role: "system", content: runner.ONE_SHOT.system },
      { role: "user", content: runner.oneShotMessage("release-1").message },
    ]);
    expect(r1?.tools).toBeUndefined();
    expect(r1?.temperature).toBe(0.6);
    const second = r2?.messages[1]?.content ?? "";
    expect(second.startsWith(PROMPT)).toBe(true);
    expect(second).toContain(`${runner.CONVERSATION_HEADINGS.firstReply}${REPLY_1}`);
    expect(second).toContain(`${runner.CONVERSATION_HEADINGS.next}${CHANGE}`);
    expect(second).toContain('console.log("timesheet");');
    expect(git(paths.repo, "rev-parse", "release-1")).not.toBe(
      git(paths.repo, "rev-parse", "seed"),
    );
    expect(git(paths.repo, "show", "release-1:src/main.ts")).toBe('console.log("timesheet");');
    expect(readFileSync(join(paths.repo, "src", "main.ts"), "utf8")).toBe(
      'console.log("timesheet 2");\n',
    );
    const log = grid.readLog(paths);
    const given = log.filter((l: { kind: string }) => l.kind === "given");
    expect(given.map((g: { frozenSha256: string }) => g.frozenSha256)).toEqual([
      manifest.files["prompt.md"].sha256,
      manifest.files["change_request.md"].sha256,
    ]);
    const replies = log.filter((l: { kind: string }) => l.kind === "reply");
    expect(replies.map((r: { calls: number }) => r.calls)).toEqual([1, 1]);
    expect(replies[0].unparsedCount).toBe(2);
    expect(log.filter((l: { kind: string }) => l.kind === "usage")).toHaveLength(2);
    expect(log.some((l: { kind: string }) => l.kind === "change_given")).toBe(true);
  });

  it("refuses a server that gives less context than the common window, and records the one it gives", async () => {
    const small = await fakeModel([], 65536);
    await expect(
      runner.askerFor(grid.arm("one-shot-nail-mtp"), {
        baseUrl: small.url,
        registryPath: registry(temp()),
      }),
    ).rejects.toThrow(/below the common window/);
    const ok = await fakeModel([REPLY_1, REPLY_2], 262144);
    const made = await runner.askerFor(grid.arm("one-shot-nail-mtp"), {
      baseUrl: ok.url,
      registryPath: registry(temp()),
    });
    expect(made.describe.serverContextTokens).toBe(262144);
    const e = env();
    const { paths } = await runner.runOneShot("one-shot-nail-mtp", 1, made.ask, {
      env: e,
      describe: made.describe,
    });
    const asker = grid.readLog(paths).find((l: { kind: string }) => l.kind === "asker");
    expect(asker).toMatchObject({ serverContextTokens: 262144, reasoning: "off" });
  });

  it("does not send a request that does not fit the common window, for any model", async () => {
    const e = env();
    const big = `### big.txt\n\n\`\`\`\n${"y".repeat(Math.ceil(runner.ONE_SHOT.contextTokens * runner.CHARS_PER_TOKEN))}\n\`\`\`\n`;
    let asked = 0;
    const { paths } = await runner.runOneShot(
      "one-shot-sonnet",
      1,
      async () => {
        asked += 1;
        return { text: asked === 1 ? big : REPLY_2 };
      },
      { env: e },
    );
    expect(asked).toBe(1);
    const replies = grid.readLog(paths).filter((l: { kind: string }) => l.kind === "reply");
    expect(replies[1]).toMatchObject({ calls: 0 });
    expect(replies[1].error).toMatch(/does not fit the common window/);
  });

  it("never retries: a failed request is logged, and the change request is still given over the tree", async () => {
    const e = env();
    const model = await fakeModel([503, 503, 503, 503, 503, 503]);
    const made = await runner.askerFor(grid.arm("one-shot-nail-mtp"), {
      baseUrl: model.url,
      registryPath: registry(temp()),
      env: e,
    });
    const { paths } = await runner.runOneShot("one-shot-nail-mtp", 1, made.ask, { env: e });
    expect(model.seen).toHaveLength(2);
    const replies = grid.readLog(paths).filter((l: { kind: string }) => l.kind === "reply");
    expect(replies).toHaveLength(2);
    expect(replies[0].error).toMatch(/503/);
    expect(git(paths.repo, "rev-parse", "release-1")).toBe(git(paths.repo, "rev-parse", "seed"));
  });

  it("refuses a model with no sampling recorded and no family default", async () => {
    const dir = temp();
    const file = join(dir, "models.json");
    writeFileSync(file, JSON.stringify({ models: [{ id: "nail-mtp" }] }));
    await expect(
      runner.localAdapter({ model: "nail-mtp", baseUrl: "http://127.0.0.1:9", registryPath: file }),
    ).rejects.toThrow(/no sampling/);
  });
});

describe("a one-shot cell with a Claude model", () => {
  it("runs claude -p once per phase with every tool disabled and the message on standard input", async () => {
    const e = env();
    const dir = temp();
    const calls = join(dir, "calls");
    mkdirSync(calls);
    const bin = join(dir, "claude");
    writeFileSync(
      bin,
      `#!${process.execPath}\nconst fs=require("node:fs");const input=fs.readFileSync(0,"utf8");const n=fs.readdirSync(${JSON.stringify(calls)}).length;fs.writeFileSync(${JSON.stringify(calls)}+"/"+n+".json",JSON.stringify({argv:process.argv.slice(2),input,cwd:process.cwd(),max:process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS,thinking:process.env.MAX_THINKING_TOKENS}));const replies=${JSON.stringify([REPLY_1, REPLY_2])};process.stdout.write(JSON.stringify({type:"result",is_error:false,num_turns:1,result:replies[n],usage:{input_tokens:10,output_tokens:20},total_cost_usd:0.5}));\n`,
    );
    chmodSync(bin, 0o755);
    const made = await runner.askerFor(grid.arm("one-shot-haiku"), {
      env: { ...e, SEKHEMET_CLAUDE_BIN: bin },
    });
    const { paths } = await runner.runOneShot("one-shot-haiku", 1, made.ask, { env: e });
    const recorded = readdirSync(calls)
      .sort()
      .map((f) => JSON.parse(readFileSync(join(calls, f), "utf8")));
    expect(recorded).toHaveLength(2);
    expect(recorded[0].input).toBe(runner.oneShotMessage("release-1").message);
    expect(recorded[1].input.startsWith(recorded[0].input)).toBe(true);
    expect(recorded[1].input).toContain(`${runner.CONVERSATION_HEADINGS.next}${CHANGE}`);
    expect(recorded[0].thinking).toBe("0");
    const argv = recorded[0].argv as string[];
    expect(argv[argv.indexOf("--tools") + 1]).toBe("");
    expect(argv).toContain("-p");
    expect(argv[argv.indexOf("--model") + 1]).toBe("claude-haiku-4-5");
    expect(argv[argv.indexOf("--system-prompt") + 1]).toBe(runner.ONE_SHOT.system);
    expect(recorded[0].max).toBe(String(runner.ONE_SHOT.maxOutputTokens));
    expect(recorded[0].cwd.endsWith("claude-cwd")).toBe(true);
    const usage = grid.readLog(paths).filter((l: { kind: string }) => l.kind === "usage");
    expect(usage.map((u: { costUsd: number }) => u.costUsd)).toEqual([0.5, 0.5]);
  });

  it("a person can give the message by hand: the runner writes it exactly and lands the reply", () => {
    const e = env();
    const first = runner.oneShotByHand("one-shot-opus", 1, { env: e });
    expect(readFileSync(first.requestFile, "utf8")).toBe(
      runner.oneShotMessage("release-1").message,
    );
    runner.oneShotByHand("one-shot-opus", 1, {
      env: e,
      reply: REPLY_1,
      usage: { inputTokens: 5, outputTokens: 6 },
    });
    const second = runner.oneShotByHand("one-shot-opus", 1, { env: e });
    expect(second.phase).toBe("change-request");
    const text = readFileSync(second.requestFile, "utf8");
    expect(text.startsWith(readFileSync(first.requestFile, "utf8"))).toBe(true);
    expect(text).toContain(`${runner.CONVERSATION_HEADINGS.firstReply}${REPLY_1}`);
    expect(text).toContain(`${runner.CONVERSATION_HEADINGS.next}${CHANGE}`);
  });
});

/**
 * A stand-in `claude` for the agentic arm: it records each call and writes a
 * stream-json turn whose result is the next of `results`; a result of
 * `"sleep"` hangs, for the budget.
 */
function fakeClaudeCode(results: string[]): { bin: string; calls: string } {
  const dir = temp();
  const calls = join(dir, "calls");
  mkdirSync(calls);
  const bin = join(dir, "claude");
  writeFileSync(
    bin,
    `#!${process.execPath}
const fs=require("node:fs");const input=fs.readFileSync(0,"utf8");
const n=fs.readdirSync(${JSON.stringify(calls)}).length;
fs.writeFileSync(${JSON.stringify(calls)}+"/"+String(n).padStart(3,"0")+".json",JSON.stringify({argv:process.argv.slice(2),input,cwd:process.cwd()}));
const results=${JSON.stringify(results)};const r=results[n]??"Done.";
if(r==="sleep"){setTimeout(()=>{},60000);}else{
if(n===0)fs.writeFileSync("work.txt","release 1\\n");
const out=[{type:"system",subtype:"init"},{type:"assistant",message:{id:"m"+n,usage:{input_tokens:5,output_tokens:2}}},{type:"result",subtype:"success",is_error:false,num_turns:3,result:r,total_cost_usd:0.25,modelUsage:{"claude-haiku-4-5":{inputTokens:10,cacheReadInputTokens:90,cacheCreationInputTokens:0,outputTokens:7},"claude-opus-5-5":{inputTokens:1,cacheReadInputTokens:0,cacheCreationInputTokens:4,outputTokens:3}}}];
process.stdout.write(out.map((l)=>JSON.stringify(l)).join("\\n")+"\\n");}
`,
  );
  chmodSync(bin, 0o755);
  return { bin, calls };
}

function recordedCalls(calls: string): { argv: string[]; input: string; cwd: string }[] {
  return readdirSync(calls)
    .sort()
    .map((f) => JSON.parse(readFileSync(join(calls, f), "utf8")));
}

describe("a Claude Code arm, driven by the runner", () => {
  it("gives prompt.md, answers a question it ends on from the FAQ, tags release-1, then gives change_request.md in the same session", () => {
    const e = sealedEnv();
    const script = JSON.parse(readFileSync(join(FIXTURE, "stakeholder_script.json"), "utf8"));
    const topic = script.phases[0].topics[0];
    const fake = fakeClaudeCode([
      `Release 1 is nearly there. ${topic.question}`,
      "Release 1 is done.",
      "The California rules are in.",
    ]);
    const r = runner.runClaudeCode("claude-code-sonnet", 1, {
      env: { ...e, SEKHEMET_CLAUDE_BIN: fake.bin },
    });
    expect(r.releaseOne).toBe("the session ended without a question");
    expect(r.change).toBe("the session ended without a question");
    const calls = recordedCalls(fake.calls);
    expect(calls).toHaveLength(3);
    expect(calls[0]?.input).toBe(PROMPT);
    expect(calls[1]?.input).toContain(topic.answer);
    expect(calls[2]?.input).toBe(CHANGE);
    for (const c of calls) expect(c.cwd).toBe(realpathSync(r.paths.repo));
    const argv = calls[0]?.argv ?? [];
    for (const flag of ["--safe-mode", "--strict-mcp-config", "--no-chrome", "--verbose"])
      expect(argv).toContain(flag);
    const flagValue = (flag: string) => argv[argv.indexOf(flag) + 1];
    expect(flagValue("--model")).toBe("claude-sonnet-5");
    expect(flagValue("--setting-sources")).toBe("project");
    expect(flagValue("--permission-prompts")).toBe("none");
    expect(flagValue("--permission-mode")).toBe(runner.AGENTIC.claudeCode.permissionMode);
    expect(flagValue("--effort")).toBe(runner.AGENTIC.claudeCode.effort);
    expect(flagValue("--output-format")).toBe("stream-json");
    expect(
      argv.slice(argv.indexOf("--disallowedTools") + 1, argv.indexOf("--disallowedTools") + 3),
    ).toEqual(["WebSearch", "WebFetch"]);
    const session = flagValue("--session-id");
    expect(session).toMatch(/^[0-9a-f-]{36}$/);
    for (const c of calls.slice(1)) {
      expect(c.argv).not.toContain("--session-id");
      expect(c.argv[c.argv.indexOf("--resume") + 1]).toBe(session);
    }
    expect(git(r.paths.repo, "show", "release-1:work.txt")).toBe("release 1");
    const log = grid.readLog(r.paths);
    const kinds = log.map((l: { kind: string }) => l.kind);
    expect(kinds.indexOf("release_1_finished")).toBeLessThan(kinds.indexOf("change_given"));
    const given = log.find((l: { kind: string }) => l.kind === "given");
    expect(given.frozenSha256).toBe(manifest.files["prompt.md"].sha256);
    expect(log.find((l: { kind: string }) => l.kind === "change_given").frozenSha256).toBe(
      manifest.files["change_request.md"].sha256,
    );
    const decisions = log.filter((l: { kind: string }) => l.kind === "person");
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ simulated: true, minutes: 0 });
    // Every model the turn called, subagents included; cached prompt tokens given apart.
    const usage = log.filter((l: { kind: string }) => l.kind === "usage");
    expect(usage).toHaveLength(3);
    expect(usage[0]).toMatchObject({ inputTokens: 105, cacheReadTokens: 90, outputTokens: 10 });
    expect(kinds[kinds.length - 1]).toBe("end");
  });

  it("gives the change request when release 1's budget is spent, and ends the run at the change phase's", () => {
    const e = sealedEnv();
    const fake = fakeClaudeCode(["sleep", "sleep"]);
    const budget = {
      ...runner.AGENTIC,
      budgetMinutes: { "release-1": 0.02, "change-request": 0.02 },
    };
    const r = runner.runClaudeCode("claude-code-haiku", 1, {
      env: { ...e, SEKHEMET_CLAUDE_BIN: fake.bin },
      budget,
    });
    expect(r.releaseOne).toBe("the phase's time budget was spent");
    expect(r.change).toBe("the phase's time budget was spent");
    const calls = recordedCalls(fake.calls);
    expect(calls.map((c) => c.input)).toEqual([PROMPT, CHANGE]);
  }, 30_000);

  it("stops answering at the reply cap", () => {
    const e = sealedEnv();
    const fake = fakeClaudeCode(["Shall I go on?", "Shall I go on?", "Shall I go on?", "Done."]);
    const r = runner.runClaudeCode("claude-code-opus", 1, {
      env: { ...e, SEKHEMET_CLAUDE_BIN: fake.bin },
      budget: { ...runner.AGENTIC, maxReplies: 1 },
    });
    expect(r.releaseOne).toBe("the reply cap was reached");
  });

  it("writes rules that deny the sealed directories by absolute path, and never the run's own tree", () => {
    const e = env();
    const rules = runner.claudeCodeSettings(e).permissions.deny as string[];
    expect(rules).toContain(`Read(/${e.SEKHEMET_CAPSTONE_HIDDEN}/**)`);
    expect(rules).toContain(`Read(/${e.SEKHEMET_WEBBENCH_SRC}/**)`);
    expect(rules).toContain(`Read(/${ROOT}/**)`);
    for (const r of rules.filter((x) => x.startsWith("Read(")))
      expect(r.startsWith("Read(//")).toBe(true);
    expect(rules.some((r) => r.includes(e.SEKHEMET_CAPSTONE_RUNS))).toBe(false);
    expect(rules).toEqual(expect.arrayContaining(["WebSearch", "WebFetch"]));
  });
});

describe("an agentic run's isolation", () => {
  it("is refused while the hidden suite or Web-Bench's checkout is readable by this user", () => {
    const e = env();
    expect(() => runner.prepareRun("sekhemet-local", 1, { env: e })).toThrow(
      /not isolated[\s\S]*hidden suite[\s\S]*Web-Bench/,
    );
    expect(() => runner.prepareRun("claude-code-opus", 1, { env: e })).toThrow(/not isolated/);
    // A one-shot arm has no tools and needs none.
    expect(() => runner.prepareRun("one-shot-opus", 1, { env: e })).not.toThrow();
  });

  it("is refused while another run is readable under the runs root", () => {
    const e = sealedEnv();
    runner.prepareRun("sekhemet-local", 1, { env: e });
    expect(() => runner.prepareRun("claude-code-opus", 1, { env: e })).toThrow(
      /another run, sekhemet-local\/1/,
    );
  });

  it("is refused while a copy left by an interrupted move into or out of the vault is readable", () => {
    for (const suffix of [".moving-to-vault", ".restoring"]) {
      const e = sealedEnv();
      const left = `${e.SEKHEMET_CAPSTONE_HIDDEN}${suffix}`;
      mkdirSync(join(left, "tests"), { recursive: true });
      writeFileSync(join(left, "tests", "canary.test.mjs"), `// ${CANARY}\n`);
      expect(() => runner.prepareRun("sekhemet-local", 1, { env: e })).toThrow(
        new RegExp(`${left.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} is readable`),
      );
      rmSync(left, { recursive: true, force: true });
      expect(() => runner.prepareRun("sekhemet-local", 1, { env: e })).not.toThrow();
    }
  });

  it("is refused while a scorer scratch copy sits in the shared temp directory", () => {
    const e = sealedEnv();
    mkdirSync(join(e.TMPDIR, "capstone-score-left"));
    expect(() => runner.prepareRun("sekhemet-local", 1, { env: e })).toThrow(/scratch copy/);
  });

  it("refuses a runs root inside ~/.sekhemet, beside the sealed suite", () => {
    const e = env();
    const home = temp();
    expect(() =>
      runner.prepareRun("one-shot-opus", 1, {
        env: { ...e, HOME: home, SEKHEMET_CAPSTONE_RUNS: join(home, ".sekhemet", "capstone-runs") },
      }),
    ).toThrow(/inside .*\.sekhemet/);
    expect(grid.runsRoot({})).toBe(join(homedir(), "capstone-runs"));
  });
});

describe("the hidden suite's directory", () => {
  it("nothing from it reaches a run's directory", async () => {
    const e = env();
    const model = await fakeModel([REPLY_1, REPLY_2]);
    const made = await runner.askerFor(grid.arm("one-shot-nail-mtp"), {
      baseUrl: model.url,
      registryPath: registry(temp()),
      env: e,
    });
    await runner.runOneShot("one-shot-nail-mtp", 1, made.ask, { env: e });
    // The agentic run, once the finished one-shot run is moved away and both sealed directories are shut.
    const done = join(temp(), "moved");
    cpSync(e.SEKHEMET_CAPSTONE_RUNS, done, { recursive: true });
    rmSync(e.SEKHEMET_CAPSTONE_RUNS, { recursive: true, force: true });
    for (const d of [e.SEKHEMET_CAPSTONE_HIDDEN, e.SEKHEMET_WEBBENCH_SRC]) {
      chmodSync(d, 0o000);
      sealedDirs.push(d);
    }
    const fake = fakeClaudeCode(["Done.", "Done."]);
    runner.runClaudeCode("claude-code-opus", 1, { env: { ...e, SEKHEMET_CLAUDE_BIN: fake.bin } });
    for (const d of [e.SEKHEMET_CAPSTONE_HIDDEN, e.SEKHEMET_WEBBENCH_SRC]) chmodSync(d, 0o700);
    cpSync(done, e.SEKHEMET_CAPSTONE_RUNS, { recursive: true });
    const files = allFiles(e.SEKHEMET_CAPSTONE_RUNS);
    expect(files.length).toBeGreaterThan(10);
    const hiddenHashes = new Set(
      allFiles(e.SEKHEMET_CAPSTONE_HIDDEN).map((f) => sha(readFileSync(f))),
    );
    for (const f of files) {
      const buf = readFileSync(f);
      expect(buf.includes(CANARY), f).toBe(false);
      expect(hiddenHashes.has(sha(buf)), f).toBe(false);
    }
    for (const body of model.seen) expect(JSON.stringify(body)).not.toContain(CANARY);
  });

  it("a runs root inside it is refused", () => {
    const e = env();
    expect(() =>
      runner.prepareRun("one-shot-opus", 1, {
        env: { ...e, SEKHEMET_CAPSTONE_RUNS: join(e.SEKHEMET_CAPSTONE_HIDDEN, "runs") },
      }),
    ).toThrow(/hidden suite/);
  });

  it("a run is never repeated in place", () => {
    const e = env();
    runner.prepareRun("one-shot-opus", 1, { env: e });
    expect(() => runner.prepareRun("one-shot-opus", 1, { env: e })).toThrow(/already exists/);
  });
});

describe("the Sekhemet arm's person-simulator", () => {
  const script = JSON.parse(readFileSync(join(FIXTURE, "stakeholder_script.json"), "utf8"));

  it("answers Seshat only with the frozen FAQ's words", () => {
    const topic = script.phases[0].topics[0];
    const r = person.replyTo(`Thanks. ${topic.question} Anything else?`);
    expect(r.text).toContain(topic.answer);
    const faqAnswers = new Set([
      script.defaultAnswer,
      ...script.phases[0].topics.map((t: { answer: string }) => t.answer),
    ]);
    for (const part of r.text.split("\n\n")) expect(faqAnswers.has(part), part).toBe(true);
    expect(person.replyTo("Here is the plan.")).toBeNull();
    expect(person.replyTo("What colour should the logo be?").text).toBe(script.defaultAnswer);
  });

  it("accepts on the checks alone when no AI reviewer is configured, and says no review ran", () => {
    const none = person.acceptDecision({
      checks: [{ id: "unit", passed: true }],
      review: null,
      reviewerConfigured: false,
    });
    expect(none).toMatchObject({ decision: "accept" });
    expect(none.why).toMatch(/no AI reviewer is configured/);
    expect(
      person.acceptDecision({
        checks: [{ id: "unit", passed: false }],
        review: null,
        reviewerConfigured: false,
      }).decision,
    ).toBe("send back");
    expect(
      person.acceptDecision({
        checks: [{ id: "unit", passed: true }],
        review: { passed: false },
        reviewerConfigured: false,
      }).decision,
    ).toBe("send back");
  });

  it("accepts exactly what all checks and the AI review pass", () => {
    expect(
      person.acceptDecision({ checks: [{ id: "unit", passed: true }], review: { passed: true } })
        .decision,
    ).toBe("accept");
    expect(
      person.acceptDecision({ checks: [{ id: "unit", passed: false }], review: { passed: true } })
        .decision,
    ).toBe("send back");
    expect(
      person.acceptDecision({ checks: [{ id: "unit", passed: true }], review: null }).decision,
    ).toBe("send back");
    expect(person.acceptDecision({ checks: [], review: { passed: true } }).decision).toBe(
      "send back",
    );
  });

  async function fakeDashboard(limit: number): Promise<string> {
    const thread: { role: string; text: string; state: string }[] = [];
    const server = createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/api/session") return res.end(JSON.stringify({ csrf: "tok" }));
      if (req.url === "/api/pm/thread") return res.end(JSON.stringify({ messages: thread }));
      if (req.url === "/api/pm/messages" && req.method === "POST") {
        if (req.headers["x-sekhemet-csrf"] !== "tok") return res.writeHead(403).end("{}");
        thread.push({
          role: "user",
          text: JSON.parse(raw).text.trim().slice(0, limit),
          state: "done",
        });
        return res.end("{}");
      }
      res.writeHead(404).end("{}");
    });
    servers.push(server);
    await new Promise((r) => server.listen(0, "127.0.0.1", () => r(undefined)));
    return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  }

  it("stops the arm when the product does not hold prompt.md whole, and logs why", async () => {
    const e = sealedEnv();
    const paths = runner.prepareRun("sekhemet-local", 1, { env: e });
    const r = await person.driveSekhemet({ run: 1, url: await fakeDashboard(8000), env: e });
    expect(r.ok).toBe(false);
    expect(r.why).toMatch(/8000 characters of the \d+ in prompt\.md/);
    expect(grid.readLog(paths).some((l: { kind: string }) => l.kind === "stopped")).toBe(true);
  });

  it("goes on when the product holds prompt.md whole", async () => {
    const e = sealedEnv();
    runner.prepareRun("sekhemet-local", 1, { env: e });
    // No time for either phase: it goes on past the brief to release 1, the change and the end.
    const r = await person.driveSekhemet({
      run: 1,
      url: await fakeDashboard(1_000_000),
      env: e,
      pollMs: 10,
      budget: { ...runner.AGENTIC, budgetMinutes: { "release-1": 0, "change-request": 0 } },
    });
    expect(r).toMatchObject({ ok: true });
    const kinds = grid
      .readLog(grid.runPaths("sekhemet-local", 1, e))
      .map((l: { kind: string }) => l.kind);
    expect(kinds).toEqual(
      expect.arrayContaining(["received", "release_1_finished", "change_given", "end"]),
    );
  });
});
