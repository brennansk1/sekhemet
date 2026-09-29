/**
 * Where a milestone needs a card built and no model may load, a stand-in
 * answers for the model: a local server speaking the OpenAI chat API that
 * the product's own `HttpInferenceAdapter` speaks to llama-server. The card
 * is built by the product's `executeCard` — the Worker loop, its tools, the
 * sandboxed checks, the evidence bundle and the ledger — exactly as a queue
 * run builds it; only the model's replies are scripted, and the usage each
 * reply reports is what the ledger charges its person (runtime RUN-34).
 *
 * The stand-in listens on a port the OS picks, never the Worker's (8098).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { built } from "./core.mjs";

/** A built module of this checkout, or of another built checkout at `root`. */
const from = (root, rel) => (root ? import(pathToFileURL(join(root, rel)).href) : built(rel));

const GATES = `[project]
max_files = 3
max_diff_lines = 200

[[gate]]
id = "unit"
rung = "test"
layer = "functional"
command = "node"
args = ["-e", "process.exit(0)"]
timeout_s = 30
parser = "generic"
`;

/**
 * A real git repository with one check the stand-in's cards pass: `src/`,
 * `.sekhemet/gates.toml`, and an ignore list for the ledger and run files.
 */
export function makeRepo(repo) {
  const git = (...a) => execFileSync("git", a, { cwd: repo, stdio: "ignore" });
  mkdirSync(join(repo, "src"), { recursive: true });
  mkdirSync(join(repo, ".sekhemet"), { recursive: true });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "owner@northwind.test");
  git("config", "user.name", "Nora Owner");
  git("config", "commit.gpgsign", "false");
  writeFileSync(join(repo, "src", "index.ts"), "export {};\n");
  writeFileSync(join(repo, ".sekhemet", "gates.toml"), GATES);
  writeFileSync(join(repo, ".gitignore"), ".sekhemet/*\n!.sekhemet/gates.toml\n");
  git("add", "-A");
  git("commit", "-q", "-m", "Initial commit");
  return repo;
}

/** This build's kernel (or `options.root`'s) over a repository's ledger. */
export async function openKernel(repo, options = {}) {
  const kernel = await from(options.root, "packages/kernel/dist/index.js");
  const { BoardServiceImpl } = await from(options.root, "packages/board/dist/index.js");
  const db = new DatabaseSync(join(repo, ".sekhemet", "events.db"));
  kernel.initSchema(db);
  const log = new kernel.EventLog(db, options.setup ? { setup: options.setup } : {});
  const store = new kernel.CardStore(db, log);
  const boardService = new BoardServiceImpl(store);
  return { kernel, db, log, store, boardService, close: () => db.close() };
}

/**
 * The stand-in model server. `plan` maps a card id to the file its Agent
 * writes and the usage each reply reports, `[input, output]` tokens: the
 * first request that names the card writes the file, every later one
 * finishes the card.
 */
export async function startFakeModel(plan) {
  const requests = [];
  const turns = new Map();
  const server = createServer(async (req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method === "GET" && req.url === "/health") return send(200, { status: "ok" });
    if (req.method === "GET" && req.url === "/v1/models") {
      return send(200, { object: "list", data: [{ id: "stand-in", object: "model" }] });
    }
    if (req.method !== "POST" || !req.url?.startsWith("/v1/chat/completions")) {
      return send(404, { error: "not served by the stand-in" });
    }
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    const text = JSON.stringify(body.messages ?? []);
    const cardId = Object.keys(plan)
      .sort((a, b) => b.length - a.length)
      .find((id) => text.includes(id) || (plan[id].title && text.includes(plan[id].title)));
    requests.push({ cardId, stream: Boolean(body.stream), text });
    const step = cardId ? (turns.get(cardId) ?? 0) : 1;
    if (cardId) turns.set(cardId, step + 1);
    const p = cardId ? plan[cardId] : undefined;
    const call =
      p && step === 0
        ? { name: "write_file", arguments: { path: p.path, content: p.content } }
        : { name: "finish_card", arguments: {} };
    const [input, output] = p?.usage ?? [1, 1];
    const usage = { prompt_tokens: input, completion_tokens: output, total_tokens: input + output };
    const id = `call_${requests.length}`;
    const args = JSON.stringify(call.arguments);
    if (body.response_format) {
      // A constrained reply is the JSON object the schema asks for.
      const content = JSON.stringify({ tool_calls: [call] });
      if (!body.stream) {
        return send(200, {
          choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
          usage,
        });
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
      res.write(
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage })}\n\n`,
      );
      return res.end("data: [DONE]\n\n");
    }
    const toolCall = { id, type: "function", function: { name: call.name, arguments: args } };
    if (!body.stream) {
      return send(200, {
        choices: [
          {
            message: { role: "assistant", content: "", tool_calls: [toolCall] },
            finish_reason: "tool_calls",
          },
        ],
        usage,
      });
    }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, ...toolCall }] } }] })}\n\n`,
    );
    res.write(
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }], usage })}\n\n`,
    );
    return res.end("data: [DONE]\n\n");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** The product's adapter, pointed at the stand-in. */
export async function standInAdapter(modelUrl, root) {
  const { HttpInferenceAdapter } = await from(root, "packages/models/dist/index.js");
  return new HttpInferenceAdapter({
    modelId: "stand-in",
    baseUrl: modelUrl,
    apiFormat: "openai",
    // The stand-in has no window of its own; this one fits the prompt's zones.
    contextTokens: 32768,
    maxTokens: 1024,
    disableReasoning: true,
  });
}

/**
 * Build cards with this build's `executeCard` (or that of the built
 * checkout at `root`) against the stand-in: each card is created Ready
 * (unless it exists) and run once; the result is its pass and the status it
 * ends in (Review once its checks pass).
 */
export async function buildCards({ repo, modelUrl, cards, kernel: given, order, root }) {
  const k = given ?? (await openKernel(repo, { root }));
  const { executeCard } = await from(root, "apps/harness/dist/execute.js");
  const adapter = await standInAdapter(modelUrl, root);
  const ctx = {
    repoPath: repo,
    restrictedMode: false,
    cardStore: k.store,
    boardService: k.boardService,
    log: () => {},
    // The host's memory moves with whatever else runs; this is not a model run.
    headroomCheck: false,
  };
  try {
    for (const c of cards) {
      if (!(await k.store.getCard(c.id))) {
        await k.store.createCard({
          tier: "story",
          status: "ready",
          stepBudget: 6,
          spec: `${c.title}.`,
          acceptanceCriteria: [`${c.title}.`],
          ...c,
        });
      }
    }
    const out = [];
    const queue = order ? order(cards) : cards;
    for await (const c of queue) {
      const card = await k.store.getCard(c.id);
      const r = await executeCard(ctx, card, adapter);
      const after = await k.store.getCard(c.id);
      out.push({ id: c.id, passed: r.passed, status: after?.status });
    }
    return out;
  } finally {
    if (!given) k.close();
  }
}
