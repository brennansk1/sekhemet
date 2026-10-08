import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CardStore } from "@sekhemet/kernel";
import { openLocalLedger } from "../../src/ledger_cmds.js";
import { type G6Repo, write } from "./g6_review.js";

/**
 * A scripted Worker and a scripted Reviewer at the HTTP boundary, for the
 * Reviewer's entry-point tests (C2d; review-git P8): loaded with
 * `node --import` into the spawned command, the preload answers every
 * request to the Ollama address itself — the machine's real Ollama is never
 * reached, and a socket to any of the owner's model servers is refused — and
 * writes each Reviewer request's body to a file, so a test
 * reads what the product sent. The two models are of different families
 * (qwen, gemma), each recorded as qualified for its exact combination on
 * this host (MD-N8-1), so the Review role is filled (RG-P8-10).
 *
 * The Reviewer's reply is chosen by `G6_REVIEW_MODE`: `json` (a reply in
 * the schema, citing `src/a.ts:1`), `prose` (no readable JSON) or `cut`
 * (ended at its length cap).
 */
const ROOT = resolve(import.meta.dirname, "../../../..");
const DIST = {
  models: join(ROOT, "packages/models/dist/index.js"),
  qualify: join(ROOT, "apps/harness/dist/qualify.js"),
};

export const WORKER = "qwen-scripted-worker:latest";
export const REVIEWER = "gemma-scripted-reviewer:latest";
/** The same family as the Worker: never fills the Review role (RG-P8-10). */
export const SAME_FAMILY_REVIEWER = "qwen-scripted-reviewer:latest";

/** The owner's real model servers on loopback are refused at the socket, whatever a probe tries. */
const NET_GUARD = `import net from "node:net";
const DENY = new Set([11434, 8098, 8099, 8080]);
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  // net.connect and http pass their options normalized, as an array.
  const a = Array.isArray(args[0]) ? args[0][0] : args[0];
  const o = typeof a === "object" && a !== null ? a : { port: a, host: args[1] };
  const host = String(o.host ?? "localhost");
  if (!o.path && DENY.has(Number(o.port)) && /^(127\\.0\\.0\\.1|localhost|::1|\\[::1\\])$/.test(host)) {
    const err = Object.assign(new Error("connect ECONNREFUSED " + host + ":" + o.port + " (test guard)"), { code: "ECONNREFUSED" });
    process.nextTick(() => this.destroy(err));
    return this;
  }
  return connect.apply(this, args);
};
`;

const PRELOAD = `
import { appendFileSync } from "node:fs";
${NET_GUARD}
const real = globalThis.fetch;
const WORKER = ${JSON.stringify(WORKER)};
const MODELS = [WORKER, ${JSON.stringify(REVIEWER)}, ${JSON.stringify(SAME_FAMILY_REVIEWER)}];
let finished = false;
const json = (b) => new Response(JSON.stringify(b), { headers: { "content-type": "application/json" } });
const REPLY = {
  criteria: [
    { n: 1, verdict: "met", at: "src/a.ts:1", note: "" },
    { n: 2, verdict: "unmet", at: "src/a.ts:1", note: "nothing exports b" },
  ],
  assumptions: [],
  preferences: [],
  outside: [],
};
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!url.startsWith("http://127.0.0.1:11434")) return real(input, init);
  const path = new URL(url).pathname;
  if (path === "/api/tags") return json({ models: MODELS.map((m) => ({ name: m, model: m, size: 1 })) });
  // Nothing stays loaded: a swap's unload is confirmed at once.
  if (path === "/api/ps") return json({ models: [] });
  if (path !== "/api/chat") return json({});
  const body = JSON.parse(String(init?.body ?? "{}"));
  let message = { role: "assistant", content: "" };
  let doneReason = "stop";
  if (body.model === WORKER) {
    const act = !finished && (body.tools ?? []).length > 0;
    if (act) {
      finished = true;
      message = { role: "assistant", content: "", tool_calls: [
        { function: { name: "write_file", arguments: { path: "src/a.ts", content: "export const a = 1;\\n" } } },
        { function: { name: "finish_card", arguments: {} } } ] };
    }
  } else {
    if (process.env.G6_REQUEST_LOG) appendFileSync(process.env.G6_REQUEST_LOG, JSON.stringify(body) + "\\n");
    const mode = process.env.G6_REVIEW_MODE ?? "json";
    if (mode === "json") message = { role: "assistant", content: JSON.stringify(REPLY) };
    else if (mode === "prose") message = { role: "assistant", content: "The change looks fine to me overall." };
    else { message = { role: "assistant", content: '{"criteria":[{"n":1,"verdict":"met","at":"src/a.ts:1","no' }; doneReason = "length"; }
  }
  const final = { model: body.model, message, done: true, done_reason: doneReason, prompt_eval_count: 10, eval_count: 5 };
  return body.stream ? new Response(JSON.stringify(final) + "\\n") : json(final);
};
`;

/** The card's acceptance criteria, as the Reviewer is asked to judge them. */
export const CRITERIA = ["src/a.ts exports a constant named a", "src/a.ts exports a constant b"];

/**
 * In `r`: a project with one passing gate and Ready card `c1` (two
 * acceptance criteria), the scripted models recorded as qualified, and the
 * preload written. Returns the arguments to put before the binary.
 */
export async function scriptedReviewProject(
  r: G6Repo,
  opts: { reviewers?: string[]; env?: Record<string, string> } = {},
): Promise<{ nodeArgs: string[]; env: Record<string, string> }> {
  write(
    r.repo,
    ".sekhemet/gates.toml",
    `[project]\nmax_files = 3\nmax_diff_lines = 200\n\n[[gate]]\nid = "unit"\nrung = "test"\nlayer = "functional"\ncommand = "node"\nargs = ["-e", "process.exit(0)"]\ntimeout_s = 60\nparser = "generic"\n`,
  );
  write(r.repo, "src/a.ts", "");
  r.git("add", "-A");
  r.git("commit", "-q", "-m", "seed");
  const { db, log } = openLocalLedger(r.repo);
  try {
    await new CardStore(db, log).createCard({
      id: "c1",
      tier: "story",
      title: "Write a",
      scopeFiles: ["src/a.ts"],
      stepBudget: 3,
      spec: "Export a constant named a from src/a.ts",
      acceptanceCriteria: CRITERIA,
    });
  } finally {
    db.close();
  }
  recordQualified(
    r,
    [
      [WORKER, "worker"],
      ...(opts.reviewers ?? [REVIEWER]).map((n): [string, string] => [n, "reviewer"]),
    ],
    opts.env ?? {},
  );
  const preload = join(r.home, "scripted_roles.mjs");
  writeFileSync(preload, PRELOAD);
  // The preload answers every model request itself, so the load guard is not needed here.
  return { nodeArgs: ["--import", preload], env: { SEKHEMET_MODEL_LOADS: "" } };
}

/**
 * Record `models` as qualified for their exact combinations on this host, by
 * the built modules in a process of their own with the command's environment,
 * so the combination is keyed exactly as the spawned command keys it.
 */
export function recordQualified(
  r: G6Repo,
  models: [name: string, role: string][],
  env: Record<string, string> = {},
): void {
  mkdirSync(join(r.home, ".sekhemet"), { recursive: true });
  const script = `
    const { ModelRegistry, ModelRoster, QUALIFICATION_SUITE_VERSION } = await import(${JSON.stringify(DIST.models)});
    const { qualificationCombination } = await import(${JSON.stringify(DIST.qualify)});
    const registry = new ModelRegistry(process.env.SEKHEMET_MODEL_REGISTRY);
    const roster = new ModelRoster({ registry });
    for (const [name, role] of ${JSON.stringify(models)}) {
      const adapter = roster.resolve(name, role);
      registry.recordCombinationQualification(adapter.modelId, qualificationCombination(adapter, { registry, role }), {
        suiteVersion: QUALIFICATION_SUITE_VERSION, passRate: 1, status: "qualified", toolCallChecks: true,
      });
    }
  `;
  const done = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: r.repo,
    encoding: "utf8",
    env: r.env({ env }),
  });
  if (done.status !== 0) throw new Error(`recording the qualifications failed: ${done.stderr}`);
}

/** One Worker turn of a script: what moves under the card first, then the tool calls. */
export interface Turn {
  /** Another accepted card lands on main: `file` committed with `content`, `Card: card_other`. */
  main?: { file: string; content: string };
  /** A side effect in the card's worktree (a command's write outside the tool's path). */
  worktree?: { file: string; content: string };
  /**
   * A shell line run in the card's worktree before the calls (`$REPO` is the
   * repository): something on the machine tampering with the worktree mid-run.
   */
  sh?: string;
  calls: { name: string; arguments: Record<string, unknown> }[];
}

const TURNS_PRELOAD = `
import { appendFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
${NET_GUARD}
const real = globalThis.fetch;
const WORKER = ${JSON.stringify(WORKER)};
const TURNS = JSON.parse(process.env.G6_TURNS ?? "[]");
const CARD = process.env.G6_CARD ?? "c1";
let n = 0;
const json = (b) => new Response(JSON.stringify(b), { headers: { "content-type": "application/json" } });
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!url.startsWith("http://127.0.0.1:11434")) return real(input, init);
  const path = new URL(url).pathname;
  if (path === "/api/tags") return json({ models: [{ name: WORKER, model: WORKER, size: 1 }] });
  if (path === "/api/ps") return json({ models: [] });
  if (path !== "/api/chat") return json({});
  const body = JSON.parse(String(init?.body ?? "{}"));
  let message = { role: "assistant", content: "" };
  if ((body.tools ?? []).length > 0) {
    if (process.env.G6_REQUEST_LOG) appendFileSync(process.env.G6_REQUEST_LOG, JSON.stringify(body) + "\\n");
    const turn = TURNS[Math.min(n, TURNS.length - 1)] ?? { calls: [] };
    n++;
    const repo = process.env.G6_REPO ?? process.cwd();
    if (turn.main) {
      writeFileSync(join(repo, turn.main.file), turn.main.content);
      execFileSync("git", ["commit", "-qam", "feat(card_other): other\\n\\nCard: card_other"], { cwd: repo });
    }
    const wt = join(repo, ".sekhemet", "worktrees", CARD);
    if (turn.worktree) writeFileSync(join(wt, turn.worktree.file), turn.worktree.content);
    if (turn.sh) execFileSync("sh", ["-c", turn.sh], { cwd: wt, env: { ...process.env, REPO: repo }, stdio: "ignore" });
    message = { role: "assistant", content: "", tool_calls: turn.calls.map((c) => ({ function: c })) };
  }
  const final = { model: body.model, message, done: true, done_reason: "stop", prompt_eval_count: 10, eval_count: 5 };
  return body.stream ? new Response(JSON.stringify(final) + "\\n") : json(final);
};
`;

/**
 * In `r`: a project with one passing gate, `src/a.ts` and `src/b.ts` on
 * main, and Ready card `c1` scoped to `src/a.ts` with `stepBudget`; the
 * scripted Worker, which plays `turns` one per request (the last repeated),
 * recorded as qualified. Returns the arguments to put before the binary and
 * the environment to add.
 */
export async function scriptedTurnsProject(
  r: G6Repo,
  turns: Turn[],
  opts: { stepBudget: number; scope?: string[]; maxFiles?: number },
): Promise<{ nodeArgs: string[]; env: Record<string, string> }> {
  write(
    r.repo,
    ".sekhemet/gates.toml",
    `[project]\nmax_files = ${opts.maxFiles ?? 3}\nmax_diff_lines = 200\n\n[[gate]]\nid = "unit"\nrung = "test"\nlayer = "functional"\ncommand = "node"\nargs = ["-e", "process.exit(0)"]\ntimeout_s = 60\nparser = "generic"\n`,
  );
  write(r.repo, "src/a.ts", "export const a = 0;\n");
  write(r.repo, "src/b.ts", "export const b = 0;\n");
  r.git("add", "-A");
  r.git("commit", "-q", "-m", "seed");
  const { db, log } = openLocalLedger(r.repo);
  try {
    await new CardStore(db, log).createCard({
      id: "c1",
      tier: "story",
      title: "Change a",
      scopeFiles: opts.scope ?? ["src/a.ts"],
      stepBudget: opts.stepBudget,
      spec: "Change the constant in src/a.ts",
    });
  } finally {
    db.close();
  }
  recordQualified(r, [[WORKER, "worker"]]);
  const preload = join(r.home, "scripted_turns.mjs");
  writeFileSync(preload, TURNS_PRELOAD);
  return {
    nodeArgs: ["--import", preload],
    env: {
      SEKHEMET_MODEL_LOADS: "",
      G6_TURNS: JSON.stringify(turns),
      G6_CARD: "c1",
      G6_REPO: r.repo,
    },
  };
}
