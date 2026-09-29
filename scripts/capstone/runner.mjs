/**
 * The capstone's arms runner (W2 G5; CAPSTONE_SELECTION "Protocol").
 *
 * Every run starts from a fresh seed repository (`seed.mjs`), under the runs
 * root, outside this repository, outside `~/.sekhemet` and outside the hidden
 * suite's directory, which the runner never reads. Every arm is given
 * `prompt.md` first and `change_request.md` at the fixed point, each
 * hash-checked against `manifest.json` immediately before it is given, and
 * every step goes to the run's log (`log.jsonl`).
 *
 *   node scripts/capstone/runner.mjs one-shot --arm <id> --run <n> [--base-url <url>] [--via print]
 *   node scripts/capstone/runner.mjs one-shot --arm <id> --run <n> --reply <file> [--tokens-in N --tokens-out N]
 *   node scripts/capstone/runner.mjs claude-code --arm <id> --run <n>
 *   node scripts/capstone/runner.mjs sekhemet prepare --run <n>
 *   node scripts/capstone/runner.mjs sekhemet drive --run <n> --url <dashboard url>
 *   node scripts/capstone/runner.mjs arms
 *
 * One shot: one request per phase, no tools, no retries, the same for every
 * model. The first request is `prompt.md` byte for byte, then the seed
 * repository as text. The second holds the whole conversation so far, as one
 * message: the first request, the first reply unchanged, then
 * `change_request.md` byte for byte and the tree the first reply left. A
 * request that does not fit the common window is not sent, for every model
 * alike. A local model is asked through the product's inference adapter with
 * its registry sampling; a Claude model through `claude -p` with every tool
 * disabled, or by a person (`--via print`, then `--reply`).
 *
 * With its harness: Claude Code is driven by the runner itself (`claude -p`,
 * a pinned configuration, the operator's own files and servers left out),
 * and a question it ends on is answered from the frozen FAQ, as the Sekhemet
 * arm's person-simulator (`person.mjs`) answers Seshat. Both need the OS
 * isolation check (`grid.mjs isolationProblems`) to pass first.
 */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { devNull } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  ARMS,
  REPO_ROOT,
  TIMESHEET_DIR,
  arm as armOf,
  frozenText,
  hiddenDir,
  isolationProblems,
  logEvent,
  readLog,
  runPaths,
  runsRootRefusal,
  sha256,
  webbenchDir,
  writeInput,
  writeRecord,
} from "./grid.mjs";
import { logDecision, replyTo } from "./person.mjs";
import { applyReply, parseReply, renderTree } from "./reply.mjs";
import * as seed from "./seed.mjs";

/**
 * What every one-shot cell gets beside the frozen text, identical for every
 * model, all recorded:
 * - one system line and one output allowance;
 * - one common window: a request whose estimated prompt plus the output
 *   allowance exceeds it is not sent, for a Claude model as for a local one
 *   (a local server must report at least this context, `/props` `n_ctx`);
 * - reasoning off (local: the adapter's switch; Claude: `MAX_THINKING_TOKENS=0`);
 * - one request time limit.
 */
export const ONE_SHOT = {
  system:
    "You are given one message and reply to it once, in text only. You have no tools: you cannot run commands, read files or ask questions. Where the message says how to reply in text, reply that way.",
  maxOutputTokens: 32768,
  contextTokens: 131072,
  reasoning: "off",
  requestTimeoutMs: 6 * 60 * 60_000,
};

/**
 * Characters per token for the common-window estimate: the product's own
 * `PROMPT_CHARS_PER_TOKEN` (packages/models), so every cell is measured by one
 * rule whatever its tokenizer.
 */
export const CHARS_PER_TOKEN = 3.2;

/** The estimated prompt tokens of a one-shot request, system line included. */
export function estimatedPromptTokens(message) {
  return Math.ceil((ONE_SHOT.system.length + message.length) / CHARS_PER_TOKEN);
}

/** Why a request is not sent (it does not fit the common window), or null. */
export function windowRefusal(message) {
  const prompt = estimatedPromptTokens(message);
  if (prompt + ONE_SHOT.maxOutputTokens <= ONE_SHOT.contextTokens) return null;
  return `the request does not fit the common window: about ${prompt} prompt tokens plus the ${ONE_SHOT.maxOutputTokens}-token output allowance exceed ${ONE_SHOT.contextTokens}; not sent`;
}

/** The fixed text between the frozen text and the repository listing. */
export const LISTING_HEADINGS = {
  "release-1":
    "\n---\n\n## The repository you are given\n\nEvery file of the seed repository, in the reply format described above.\n\n",
  "change-request":
    "\n---\n\n## The repository as your first reply left it\n\nEvery file of the repository after your first reply, in the reply format described above. List only the files you add, change or delete.\n\n",
};

/** The fixed text that carries the conversation so far into the second one-shot request. */
export const CONVERSATION_HEADINGS = {
  firstReply: "\n---\n\n## Your reply to the message above\n\nYour first reply, unchanged.\n\n",
  next: "\n---\n\n## The next message\n\n",
};

export const PHASES = ["release-1", "change-request"];
const FROZEN_OF = { "release-1": "prompt.md", "change-request": "change_request.md" };

/** The identity every commit the runner itself makes carries: no arm, no model. */
const RUNNER_IDENTITY = { name: "Contestant", email: "contestant@example.invalid" };

function git(cwd, args, extraEnv = {}) {
  const r = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: cwd,
      GIT_CONFIG_GLOBAL: devNull,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: RUNNER_IDENTITY.name,
      GIT_AUTHOR_EMAIL: RUNNER_IDENTITY.email,
      GIT_COMMITTER_NAME: RUNNER_IDENTITY.name,
      GIT_COMMITTER_EMAIL: RUNNER_IDENTITY.email,
      LC_ALL: "C",
      ...extraEnv,
    },
  });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.trim()}`);
  return r.stdout.trim();
}

/** Commit whatever the working tree holds (nothing when clean); returns the commit made, or null. */
export function commitAll(repo, message) {
  git(repo, ["add", "--all"]);
  const status = git(repo, ["status", "--porcelain"]);
  if (!status) return null;
  git(repo, ["-c", "commit.gpgsign=false", "commit", "--quiet", "--no-verify", "-m", message]);
  return git(repo, ["rev-parse", "HEAD"]);
}

/** Tag the tree's HEAD `release-1`: the point regressions are measured against. */
export function tagReleaseOne(repo) {
  git(repo, ["tag", "--force", "release-1"]);
  return git(repo, ["rev-parse", "release-1^{commit}"]);
}

/**
 * The one-shot message of a phase.
 * - release-1: `prompt.md` byte for byte (checked against the manifest now),
 *   the fixed heading, and the seed as text (checked against `seed.json`).
 * - change-request: the conversation so far as one message, the same for
 *   every model: `first.message` (the release-1 request as it was sent), the
 *   first reply unchanged (`first.reply`), then `change_request.md` byte for
 *   byte, the fixed heading and the tree as the first reply left it.
 */
export function oneShotMessage(phase, { fixture = TIMESHEET_DIR, tree, first } = {}) {
  const frozen = frozenText(FROZEN_OF[phase], fixture);
  let prefix = "";
  let listing;
  let carried = null;
  if (phase === "release-1") {
    listing = seed.renderListing(fixture);
    const recorded = seed.loadRecord(fixture).listingSha256;
    if (sha256(listing) !== recorded)
      throw new Error("the seed's listing is not the one seed.json records");
  } else {
    if (!tree) throw new Error("the change request's message needs the tree after release 1");
    if (!first || typeof first.message !== "string" || typeof first.reply !== "string")
      throw new Error("the change request's message needs the first request and its reply");
    const opening = frozenText(FROZEN_OF["release-1"], fixture);
    if (!first.message.startsWith(opening.text))
      throw new Error("the first request did not begin with prompt.md byte for byte");
    prefix = `${first.message}${CONVERSATION_HEADINGS.firstReply}${first.reply}${CONVERSATION_HEADINGS.next}`;
    carried = {
      firstMessageSha256: sha256(first.message),
      firstReplySha256: sha256(first.reply),
    };
    listing = renderTree(tree);
  }
  const message = `${prefix}${frozen.text}${LISTING_HEADINGS[phase]}${listing}`;
  const at = prefix.length;
  if (sha256(message.slice(at, at + frozen.text.length)) !== frozen.sha256) {
    throw new Error(`the ${phase} message does not hold ${frozen.name} byte for byte`);
  }
  return {
    phase,
    frozen: frozen.name,
    frozenSha256: frozen.sha256,
    frozenBytes: frozen.bytes,
    frozenAt: at,
    carried,
    listingSha256: sha256(listing),
    messageSha256: sha256(message),
    estimatedPromptTokens: estimatedPromptTokens(message),
    message,
  };
}

/**
 * A fresh seed repository for one run, refused when the run already exists,
 * when the runs root is not allowed (`runsRootRefusal`), or, for an agentic
 * arm, when the OS isolation check fails (`isolationProblems`).
 */
export function prepareRun(armId, run, { env = process.env, fixture = TIMESHEET_DIR } = {}) {
  const a = armOf(armId);
  const paths = runPaths(a.id, run, env);
  if (existsSync(paths.dir)) {
    throw new Error(
      `${paths.dir} already exists: a run is never repeated in place; use the next run number`,
    );
  }
  const refusal = runsRootRefusal(env);
  if (refusal) throw new Error(refusal);
  if (a.row === "harness") {
    const problems = isolationProblems(paths, env);
    if (problems.length)
      throw new Error(
        `an agentic run is not isolated (CAPSTONE_SELECTION, Protocol: isolation):\n- ${problems.join("\n- ")}`,
      );
  }
  mkdirSync(paths.dir, { recursive: true });
  let seeded;
  try {
    seeded = seed.materialise(paths.repo, { fixture, env });
  } catch (err) {
    rmSync(paths.dir, { recursive: true, force: true });
    throw err;
  }
  writeRecord(paths, {
    about: "One capstone run (W2 G5). Written by scripts/capstone/runner.mjs.",
    arm: a.id,
    row: a.row,
    column: a.column,
    model: a.model,
    run: Number(run),
    seed: seeded,
    oneShot: a.row === "one-shot" ? { ...ONE_SHOT, systemSha256: sha256(ONE_SHOT.system) } : null,
    agentic: a.row === "harness" ? AGENTIC : null,
  });
  logEvent(paths, { kind: "prepared", arm: a.id, run: Number(run), seedCommit: seeded.seedCommit });
  return paths;
}

// --- one shot -------------------------------------------------------------------------

/**
 * The context a running llama-server gives each request (`GET /props`,
 * `default_generation_settings.n_ctx`), refused below the common window.
 */
export async function serverContext(baseUrl) {
  const origin = new URL(baseUrl).origin;
  let props;
  try {
    const res = await fetch(`${origin}/props`, { signal: AbortSignal.timeout(10_000) });
    props = res.ok ? await res.json() : null;
  } catch {
    props = null;
  }
  const n = props?.default_generation_settings?.n_ctx ?? props?.n_ctx;
  if (typeof n !== "number")
    throw new Error(
      `the server at ${origin} does not report its context (/props n_ctx): the common window cannot be checked`,
    );
  if (n < ONE_SHOT.contextTokens)
    throw new Error(
      `the server at ${origin} gives each request ${n} tokens of context, below the common window of ${ONE_SHOT.contextTokens}: start it with -c ${ONE_SHOT.contextTokens} or more (one slot)`,
    );
  return n;
}

/** The product's inference adapter for a registered local model, with its registry sampling. */
export async function localAdapter({
  model,
  baseUrl,
  registryPath,
  reasoning = ONE_SHOT.reasoning,
  root = REPO_ROOT,
}) {
  const models = await import(
    pathToFileURL(join(root, "packages", "models", "dist", "index.js")).href
  );
  const registry = JSON.parse(readFileSync(registryPath, "utf8"));
  const entries = Array.isArray(registry.models)
    ? registry.models
    : Object.values(registry.models ?? {});
  const entry = entries.find((m) => m.id === model);
  if (!entry)
    throw new Error(
      `${model} is not in the model registry ${registryPath}: register it with \`sekhemet models add\``,
    );
  const recorded = entry.sampling;
  let sampling;
  let samplingSource;
  if (recorded && Object.values(recorded).some((v) => typeof v === "number")) {
    sampling = {
      ...(recorded.temperature !== undefined ? { temperature: recorded.temperature } : {}),
      ...(recorded.topP !== undefined ? { topP: recorded.topP } : {}),
      ...(recorded.topK !== undefined ? { topK: recorded.topK } : {}),
      ...(recorded.minP !== undefined ? { minP: recorded.minP } : {}),
    };
    samplingSource = "registry";
  } else if (entry.family && models.FAMILY_SAMPLING?.[entry.family]) {
    sampling = { ...models.FAMILY_SAMPLING[entry.family] };
    samplingSource = `the ${entry.family} family's published defaults (the registry records none)`;
  } else {
    throw new Error(
      `${model} has no sampling in the registry and no family default: record its model card's sampling first`,
    );
  }
  const adapter = new models.HttpInferenceAdapter({
    modelId: model,
    baseUrl,
    apiFormat: "openai",
    contextTokens: ONE_SHOT.contextTokens,
    maxTokens: ONE_SHOT.maxOutputTokens,
    maxRetries: 0,
    requestTimeoutMs: ONE_SHOT.requestTimeoutMs,
    coldLoadTimeoutMs: ONE_SHOT.requestTimeoutMs,
    disableReasoning: reasoning === "off",
    promptCache: false,
    memoryAware: false,
    telemetry: false,
    sampling,
  });
  return { adapter, sampling, samplingSource, reasoning, weightsSha256: entry.sha256 ?? null };
}

/** One request through the product's adapter: one call, no tools, no retries. */
function askLocal(adapter, request) {
  return adapter
    .generate({
      systemPrompt: ONE_SHOT.system,
      prompt: request.message,
      toolArm: "arm_a_flat",
      tools: [],
      maxTokens: ONE_SHOT.maxOutputTokens,
      purpose: "code",
      role: "worker",
    })
    .then((r) => ({
      text: r.text,
      finishReason: r.finishReason ?? null,
      usage: {
        inputTokens: r.usage.promptTokens,
        cacheReadTokens: 0,
        outputTokens: r.usage.completionTokens,
        durationMs: r.usage.durationMs,
      },
    }));
}

/**
 * One request through `claude -p` with every tool disabled, no MCP server, no
 * customisation, no session saved and the one-shot system line in place of
 * Claude Code's own. The message goes on standard input, byte for byte.
 */
export function claudeArgs(model) {
  return [
    "-p",
    "--model",
    model,
    "--tools",
    "",
    "--strict-mcp-config",
    "--safe-mode",
    "--no-session-persistence",
    "--system-prompt",
    ONE_SHOT.system,
    "--output-format",
    "json",
  ];
}

/** The environment of a one-shot `claude -p`: the output allowance, and reasoning off. */
export function claudeOneShotEnv(env) {
  return {
    ...env,
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(ONE_SHOT.maxOutputTokens),
    MAX_THINKING_TOKENS: "0",
  };
}

/**
 * Prompt tokens as every cell counts them: all the tokens the model read for
 * the request, cached or not (a local server with its prompt cache off reads
 * every one); the cached part is also given apart.
 */
function claudeUsage(u = {}) {
  return {
    inputTokens:
      (u.input_tokens ?? 0) +
      (u.cache_creation_input_tokens ?? 0) +
      (u.cache_read_input_tokens ?? 0),
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
  };
}

function askClaude(model, request, cwd, env) {
  mkdirSync(cwd, { recursive: true });
  const bin = env.SEKHEMET_CLAUDE_BIN || "claude";
  const r = spawnSync(bin, claudeArgs(model), {
    cwd,
    input: request.message,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    timeout: ONE_SHOT.requestTimeoutMs,
    env: claudeOneShotEnv(env),
  });
  if (r.status !== 0)
    throw new Error(`claude exited ${r.status ?? r.signal}: ${(r.stderr ?? "").slice(-600)}`);
  let out;
  try {
    out = JSON.parse(r.stdout);
  } catch {
    throw new Error(`claude's output was not JSON: ${r.stdout.slice(0, 300)}`);
  }
  if (out.is_error)
    throw new Error(`claude reported an error: ${String(out.result).slice(0, 300)}`);
  const turns = out.num_turns ?? 1;
  if (turns !== 1) throw new Error(`claude took ${turns} turns: a one-shot request is one`);
  return {
    text: typeof out.result === "string" ? out.result : "",
    finishReason: out.stop_reason ?? null,
    usage: { ...claudeUsage(out.usage), durationMs: out.duration_ms ?? null },
    costUsd: typeof out.total_cost_usd === "number" ? out.total_cost_usd : null,
    models: out.modelUsage ? Object.keys(out.modelUsage) : null,
  };
}

/** Write one phase's reply into the tree, commit it, and (release 1) tag it. */
function landReply(paths, phase, reply, request, calls) {
  const replyFile = join(paths.input, `${phase}-reply.md`);
  writeFileSync(replyFile, reply.text ?? "");
  const applied = applyReply(paths.repo, parseReply(reply.text ?? ""));
  const commit = commitAll(
    paths.repo,
    `The one-shot reply to the ${phase === "release-1" ? "first" : "second"} message`,
  );
  const tag = phase === "release-1" ? tagReleaseOne(paths.repo) : null;
  logEvent(paths, {
    kind: "reply",
    phase,
    calls,
    replySha256: sha256(reply.text ?? ""),
    replyBytes: Buffer.byteLength(reply.text ?? ""),
    finishReason: reply.finishReason ?? null,
    written: applied.written.length,
    deleted: applied.deleted.length,
    unparsed: applied.unparsed,
    unparsedCount: applied.unparsedCount,
    replacedInReply: applied.replacedInReply,
    ignoredLines: applied.ignoredLines,
    commit,
    releaseOneTag: tag,
    error: reply.error ?? null,
  });
  if (reply.usage) {
    logEvent(paths, {
      kind: "usage",
      phase,
      ...reply.usage,
      costUsd: reply.costUsd ?? null,
      models: reply.models ?? null,
    });
  }
  return { request, applied, commit };
}

function logRequest(paths, request) {
  writeFileSync(join(paths.input, `${request.phase}-request.txt`), request.message);
  logEvent(paths, {
    kind: "given",
    phase: request.phase,
    frozen: request.frozen,
    frozenSha256: request.frozenSha256,
    frozenBytes: request.frozenBytes,
    frozenAt: request.frozenAt,
    carried: request.carried,
    listingSha256: request.listingSha256,
    messageSha256: request.messageSha256,
    estimatedPromptTokens: request.estimatedPromptTokens,
    systemSha256: sha256(ONE_SHOT.system),
  });
  // The change request is given at the fixed point; the log says so the same way for every arm.
  if (request.phase === "change-request")
    logEvent(paths, {
      kind: "change_given",
      given: "change_request.md",
      frozenSha256: request.frozenSha256,
    });
}

/** The first request as sent and its reply as received, read back for the second request. */
function firstExchange(paths) {
  const log = readLog(paths);
  const given = log.find((e) => e.kind === "given" && e.phase === "release-1");
  const message = readFileSync(join(paths.input, "release-1-request.txt"), "utf8");
  if (!given || sha256(message) !== given.messageSha256)
    throw new Error("the first request on disk is not the one the log records as given");
  const replyFile = join(paths.input, "release-1-reply.md");
  const reply = existsSync(replyFile) ? readFileSync(replyFile, "utf8") : "";
  const landed = log.find((e) => e.kind === "reply" && e.phase === "release-1");
  if (!landed || sha256(reply) !== landed.replySha256)
    throw new Error("the first reply on disk is not the one the log records as landed");
  return { message, reply };
}

/**
 * A whole one-shot cell: a fresh seed, then one request per phase through
 * `ask(request)`, each called at most once. A request that does not fit the
 * common window is not sent; a failed one is logged. Either way the tree is
 * left as it was, and the change request is still given over it.
 */
export async function runOneShot(
  armId,
  run,
  ask,
  { env = process.env, fixture = TIMESHEET_DIR, describe = null } = {},
) {
  const a = armOf(armId);
  if (a.row !== "one-shot") throw new Error(`${a.id} is not a one-shot arm`);
  const paths = prepareRun(a.id, run, { env, fixture });
  mkdirSync(paths.input, { recursive: true });
  logEvent(paths, { kind: "start" });
  if (describe) logEvent(paths, { kind: "asker", ...describe });
  const results = [];
  for (const phase of PHASES) {
    const request = oneShotMessage(phase, {
      fixture,
      tree: paths.repo,
      ...(phase === "change-request" ? { first: firstExchange(paths) } : {}),
    });
    logRequest(paths, request);
    let reply;
    let calls = 0;
    const refused = windowRefusal(request.message);
    if (refused) reply = { text: "", error: refused };
    else {
      try {
        calls += 1;
        reply = await ask(request, paths);
      } catch (err) {
        reply = { text: "", error: err instanceof Error ? err.message : String(err) };
      }
    }
    results.push(landReply(paths, phase, reply, request, calls));
  }
  logEvent(paths, { kind: "end" });
  return { paths, results };
}

/** The asker for an arm: the product's adapter for a local model, `claude -p` for a Claude one. */
export async function askerFor(a, { baseUrl, registryPath, reasoning, env = process.env } = {}) {
  if (a.kind === "local") {
    if (!baseUrl)
      throw new Error(
        "a local one-shot arm needs --base-url (the model's llama-server, started beforehand)",
      );
    const serverContextTokens = await serverContext(baseUrl);
    const made = await localAdapter({ model: a.model, baseUrl, registryPath, reasoning });
    return {
      describe: {
        via: "the product's HttpInferenceAdapter",
        baseUrl,
        serverContextTokens,
        commonWindow: ONE_SHOT.contextTokens,
        sampling: made.sampling,
        samplingSource: made.samplingSource,
        reasoning: made.reasoning,
        weightsSha256: made.weightsSha256,
      },
      ask: (request) => askLocal(made.adapter, request),
    };
  }
  if (a.kind === "claude") {
    return {
      describe: {
        via: "claude -p, every tool disabled",
        args: claudeArgs(a.model),
        commonWindow: ONE_SHOT.contextTokens,
        reasoning: "off (MAX_THINKING_TOKENS=0)",
      },
      ask: (request, paths) => askClaude(a.model, request, join(paths.dir, "claude-cwd"), env),
    };
  }
  throw new Error(`${a.id} is not a one-shot arm`);
}

/**
 * The person's path for a one-shot cell (`--via print`): the runner writes
 * the exact message and says where the reply goes; `--reply` lands it and
 * moves to the next phase. The phase is whichever has not been answered. A
 * message that does not fit the common window is landed as not sent.
 */
export function oneShotByHand(
  armId,
  run,
  { reply, usage, env = process.env, fixture = TIMESHEET_DIR } = {},
) {
  const a = armOf(armId);
  let paths = runPaths(a.id, run, env);
  if (!existsSync(paths.record)) {
    paths = prepareRun(a.id, run, { env, fixture });
    logEvent(paths, { kind: "start" });
  }
  mkdirSync(paths.input, { recursive: true });
  const log = readLog(paths);
  const answered = new Set(log.filter((e) => e.kind === "reply").map((e) => e.phase));
  const phase = PHASES.find((p) => !answered.has(p));
  if (!phase) return { paths, done: true };
  const request = oneShotMessage(phase, {
    fixture,
    tree: paths.repo,
    ...(phase === "change-request" ? { first: firstExchange(paths) } : {}),
  });
  const given = log.some((e) => e.kind === "given" && e.phase === phase);
  if (!given) logRequest(paths, request);
  const refused = windowRefusal(request.message);
  if (refused) {
    const landed = landReply(paths, phase, { text: "", error: refused }, request, 0);
    if (phase === PHASES[PHASES.length - 1]) logEvent(paths, { kind: "end" });
    return { paths, phase, landed, refused };
  }
  if (reply === undefined) {
    return {
      paths,
      phase,
      requestFile: join(paths.input, `${phase}-request.txt`),
      replyFile: join(paths.input, `${phase}-reply.md`),
      system: ONE_SHOT.system,
      messageSha256: request.messageSha256,
    };
  }
  const landed = landReply(paths, phase, { text: reply, usage }, request, 1);
  if (phase === PHASES[PHASES.length - 1]) logEvent(paths, { kind: "end" });
  return { paths, phase, landed };
}

// --- with its harness ------------------------------------------------------------------

/**
 * What every agentic arm is held to, the same for each and recorded in the
 * run (`run.json`):
 * - a wall-clock budget per phase: the change request is given when release 1
 *   ends or its budget is spent, whichever comes first, and the run ends when
 *   the change phase ends or its budget is spent;
 * - at most `maxReplies` FAQ answers per phase to a question the harness ends
 *   on (Claude Code) or asks (Seshat);
 * - for Claude Code, one effort and one permission mode.
 * PROPOSED values (W2 fix round, 2026-09-29), for the owner to confirm before
 * the first agentic run.
 */
export const AGENTIC = {
  budgetMinutes: { "release-1": 360, "change-request": 180 },
  maxReplies: 20,
  claudeCode: { effort: "high", permissionMode: "bypassPermissions" },
};

/**
 * The Claude Code session's settings: the web tools off, and the sealed
 * directories and this repository denied to its file tools. Absolute paths
 * take `//` in Claude Code's rules. These rules are defence in depth only:
 * the boundary is the OS isolation check the run must pass first.
 */
export function claudeCodeSettings(env = process.env) {
  const deny = ["WebSearch", "WebFetch"];
  for (const dir of [hiddenDir(env), webbenchDir(env), REPO_ROOT]) {
    const abs = `/${resolve(dir)}`;
    deny.push(`Read(${abs}/**)`, `Edit(${abs}/**)`);
  }
  return { permissions: { deny, additionalDirectories: [] } };
}

/**
 * One `claude -p` turn of the Claude Code arm, pinned so the operator's own
 * configuration never reaches it: `--safe-mode` (no CLAUDE.md, skills,
 * plugins, hooks or custom agents of the operator's), `--strict-mcp-config`
 * with no server, only the working directory's own project settings plus the
 * run's settings file, one effort, one permission mode, no permission prompt
 * (nobody answers one), the web tools disallowed, and the whole stream kept.
 */
export function claudeCodeArgs(model, { settings, sessionId, resume }) {
  return [
    "-p",
    "--model",
    model,
    "--safe-mode",
    "--strict-mcp-config",
    "--setting-sources",
    "project",
    "--settings",
    settings,
    "--permission-mode",
    AGENTIC.claudeCode.permissionMode,
    "--permission-prompts",
    "none",
    "--disallowedTools",
    "WebSearch",
    "WebFetch",
    "--effort",
    AGENTIC.claudeCode.effort,
    "--no-chrome",
    "--output-format",
    "stream-json",
    "--verbose",
    ...(resume ? ["--resume", sessionId] : ["--session-id", sessionId]),
  ];
}

/**
 * What one turn's stream says: the last result (its text, whether it failed),
 * and the tokens used by every model the turn called, subagents included
 * (`modelUsage`), else each assistant message counted once.
 */
export function readStream(text) {
  const lines = [];
  for (const l of text.split("\n")) {
    if (!l.trim()) continue;
    try {
      lines.push(JSON.parse(l));
    } catch {
      // A line that is not JSON is not a stream event.
    }
  }
  const result = [...lines].reverse().find((l) => l.type === "result") ?? null;
  let usage;
  if (result?.modelUsage && Object.keys(result.modelUsage).length) {
    usage = { inputTokens: 0, cacheReadTokens: 0, outputTokens: 0 };
    for (const m of Object.values(result.modelUsage)) {
      usage.inputTokens +=
        (m.inputTokens ?? 0) + (m.cacheCreationInputTokens ?? 0) + (m.cacheReadInputTokens ?? 0);
      usage.cacheReadTokens += m.cacheReadInputTokens ?? 0;
      usage.outputTokens += m.outputTokens ?? 0;
    }
    usage.source = "modelUsage (every model, subagents included)";
  } else {
    const byId = new Map();
    for (const l of lines)
      if (l.type === "assistant" && l.message?.usage)
        byId.set(l.message.id ?? `n${byId.size}`, l.message.usage);
    usage = { inputTokens: 0, cacheReadTokens: 0, outputTokens: 0 };
    for (const u of byId.values()) {
      const c = claudeUsage(u);
      usage.inputTokens += c.inputTokens;
      usage.cacheReadTokens += c.cacheReadTokens;
      usage.outputTokens += c.outputTokens;
    }
    usage.source = "assistant messages, each counted once";
  }
  return {
    text: typeof result?.result === "string" ? result.result : "",
    failed: result ? Boolean(result.is_error) : true,
    subtype: result?.subtype ?? null,
    turns: result?.num_turns ?? null,
    costUsd: typeof result?.total_cost_usd === "number" ? result.total_cost_usd : null,
    models: result?.modelUsage ? Object.keys(result.modelUsage) : null,
    usage,
  };
}

function claudeTurn(a, paths, { message, phase, n, sessionId, resume, settings, timeoutMs, env }) {
  const out = join(paths.input, `${phase}-turn-${n}.jsonl`);
  const fd = openSync(out, "w");
  const began = Date.now();
  let r;
  try {
    r = spawnSync(
      env.SEKHEMET_CLAUDE_BIN || "claude",
      claudeCodeArgs(a.model, { settings, sessionId, resume }),
      {
        cwd: paths.repo,
        input: message,
        stdio: ["pipe", fd, "pipe"],
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        timeout: Math.max(1, timeoutMs),
        killSignal: "SIGTERM",
        env,
      },
    );
  } finally {
    closeSync(fd);
  }
  const read = readStream(readFileSync(out, "utf8"));
  const timedOut = r.error?.code === "ETIMEDOUT" || r.signal === "SIGTERM";
  const turn = {
    kind: "turn",
    phase,
    n,
    messageSha256: sha256(message),
    exit: r.status,
    signal: r.signal ?? null,
    timedOut,
    failed: read.failed,
    subtype: read.subtype,
    modelTurns: read.turns,
    minutes: Math.round(((Date.now() - began) / 60_000) * 10) / 10,
    stream: out,
    stderrTail: (r.stderr ?? "").slice(-400),
  };
  logEvent(paths, turn);
  logEvent(paths, {
    kind: "usage",
    phase,
    ...read.usage,
    costUsd: read.costUsd,
    models: read.models,
  });
  return { ...read, timedOut, exit: r.status };
}

/**
 * One phase of the Claude Code arm: `message` first, then, while the session
 * ends on a question, the FAQ's answer to it (the same words Seshat would
 * get), until it ends on none, the reply cap is reached or the budget is
 * spent. Returns why the phase ended.
 */
function claudeCodePhase(a, paths, { phase, message, given, sessionId, settings, env, budget }) {
  const deadline = Date.now() + budget.budgetMinutes[phase] * 60_000;
  let next = message;
  let replies = 0;
  for (let n = 1; ; n += 1) {
    const left = deadline - Date.now();
    if (left <= 0) return "the phase's time budget was spent";
    const t = claudeTurn(a, paths, {
      message: next,
      phase,
      n,
      sessionId,
      resume: !(phase === "release-1" && n === 1),
      settings,
      timeoutMs: left,
      env,
    });
    if (t.timedOut) return "the phase's time budget was spent";
    if (t.exit !== 0 && !t.text) return `the session failed (exit ${t.exit})`;
    const answer = replyTo(t.text, { given });
    if (!answer) return "the session ended without a question";
    if (replies >= budget.maxReplies) return "the reply cap was reached";
    replies += 1;
    logDecision(
      paths,
      "answer Claude Code",
      { decision: "answer", why: "from the frozen FAQ" },
      { phase, questions: answer.questions, usedDefault: answer.usedDefault },
    );
    next = answer.text;
  }
}

/**
 * A whole Claude Code cell, driven by the runner: `prompt.md` as the first
 * message, the release-1 phase, the tree tagged `release-1`,
 * `change_request.md` in the same session, the change phase, then any work
 * left uncommitted committed. Refused unless the OS isolation check passes.
 */
export function runClaudeCode(
  armId,
  run,
  { env = process.env, fixture = TIMESHEET_DIR, budget = AGENTIC } = {},
) {
  const a = armOf(armId);
  if (a.kind !== "claude-code") throw new Error(`${a.id} is not a Claude Code arm`);
  const paths = prepareRun(a.id, run, { env, fixture });
  mkdirSync(paths.input, { recursive: true });
  const settings = join(paths.input, "claude-settings.json");
  const settingsText = `${JSON.stringify(claudeCodeSettings(env), null, 2)}\n`;
  writeFileSync(settings, settingsText);
  const sessionId = randomUUID();
  const prompt = frozenText("prompt.md", fixture);
  logEvent(paths, {
    kind: "start",
    sessionId,
    args: claudeCodeArgs(a.model, { settings, sessionId, resume: false }),
    settingsSha256: sha256(settingsText),
    budget,
  });
  writeInput(paths, prompt);
  logEvent(paths, {
    kind: "given",
    phase: "release-1",
    frozen: "prompt.md",
    frozenSha256: prompt.sha256,
    frozenBytes: prompt.bytes,
    messageSha256: sha256(prompt.text),
  });
  const r1 = claudeCodePhase(a, paths, {
    phase: "release-1",
    message: prompt.text,
    given: ["release-1"],
    sessionId,
    settings,
    env,
    budget,
  });
  const leftover = commitAll(
    paths.repo,
    "Work left uncommitted at the change request (committed by the runner)",
  );
  const tag = tagReleaseOne(paths.repo);
  logEvent(paths, {
    kind: "release_1_finished",
    reason: r1,
    leftoverCommit: leftover,
    releaseOneTag: tag,
  });
  const change = frozenText("change_request.md", fixture);
  writeInput(paths, change);
  logEvent(paths, {
    kind: "change_given",
    given: "change_request.md",
    frozenSha256: change.sha256,
    frozenBytes: change.bytes,
    messageSha256: sha256(change.text),
  });
  const r2 = claudeCodePhase(a, paths, {
    phase: "change-request",
    message: change.text,
    given: ["release-1", "change-request"],
    sessionId,
    settings,
    env,
    budget,
  });
  const last = commitAll(paths.repo, "Work left uncommitted at the end (committed by the runner)");
  logEvent(paths, { kind: "end", reason: r2, leftoverCommit: last });
  return { paths, releaseOne: r1, change: r2 };
}

// --- the command line ---------------------------------------------------------------

function flags(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      out._.push(a);
      continue;
    }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[key] = true;
    else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

async function main(argv) {
  const f = flags(argv);
  const [command, sub] = f._;
  if (command === "arms") {
    for (const a of ARMS)
      console.log(`${a.id.padEnd(22)} ${a.row.padEnd(9)} ${a.column.padEnd(12)} ${a.model}`);
    return 0;
  }
  if (command === "one-shot") {
    const a = armOf(f.arm);
    if (f.reply || f.via === "print") {
      const r = oneShotByHand(a.id, f.run, {
        ...(typeof f.reply === "string" ? { reply: readFileSync(f.reply, "utf8") } : {}),
        ...(f["tokens-in"]
          ? {
              usage: {
                inputTokens: Number(f["tokens-in"]),
                outputTokens: Number(f["tokens-out"] ?? 0),
                source: "pasted by the person",
              },
            }
          : {}),
      });
      if (r.done) console.log(`${a.id} run ${f.run}: both phases are answered`);
      else if (r.refused) console.log(`${a.id} run ${f.run}: ${r.phase} ${r.refused}`);
      else if (!r.landed) {
        console.log(
          `Give ${a.model} this system line and then the message in ${r.requestFile} (SHA-256 ${r.messageSha256}), as one message with no tools and thinking off:\n\n${r.system}\n\nSave its reply, unchanged, and run:\n  node scripts/capstone/runner.mjs one-shot --arm ${a.id} --run ${f.run} --reply <file>`,
        );
      } else
        console.log(
          `${a.id} run ${f.run}: ${r.phase} landed (${r.landed.applied.written.length} files, ${r.landed.applied.unparsedCount} unparsed)`,
        );
      return 0;
    }
    const asker = await askerFor(a, {
      baseUrl: f["base-url"],
      registryPath:
        f.registry ??
        process.env.SEKHEMET_MODEL_REGISTRY ??
        join(process.env.HOME ?? "", ".sekhemet", "models.json"),
      reasoning: ONE_SHOT.reasoning,
    });
    const { paths, results } = await runOneShot(a.id, f.run, asker.ask, {
      describe: asker.describe,
    });
    for (const r of results)
      console.log(
        `${r.request.phase}: ${r.applied.written.length} files written, ${r.applied.unparsedCount} unparsed`,
      );
    console.log(`the run: ${paths.dir}`);
    return 0;
  }
  if (command === "claude-code") {
    const r = runClaudeCode(f.arm, f.run);
    console.log(
      `${f.arm} run ${f.run}: release 1 ended (${r.releaseOne}); the change phase ended (${r.change}). The run: ${r.paths.dir}`,
    );
    return 0;
  }
  if (command === "sekhemet") {
    if (sub === "prepare") {
      const paths = prepareRun("sekhemet-local", f.run);
      console.log(
        `The run's repository: ${paths.repo}\nStart \`sekhemet serve\` (Solo) on it, then:\n  node scripts/capstone/runner.mjs sekhemet drive --run ${f.run} --url <dashboard url>`,
      );
      return 0;
    }
    if (sub === "drive") {
      const { driveSekhemet } = await import("./person.mjs");
      const r = await driveSekhemet({ run: f.run, url: f.url, csrf: f.csrf });
      console.log(JSON.stringify(r, null, 2));
      return r.ok ? 0 : 1;
    }
  }
  console.error(
    "usage: runner.mjs arms | one-shot --arm <id> --run <n> [--base-url <url>] [--via print] [--reply <file>] | claude-code --arm <id> --run <n> | sekhemet prepare --run <n> | sekhemet drive --run <n> --url <url>",
  );
  return 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    },
  );
}
