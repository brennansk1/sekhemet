/**
 * The capstone's Sekhemet arm, driven end to end (W2b G2; CAPSTONE_SELECTION
 * "Protocol", the Sekhemet arm).
 *
 * The person-simulator (`person.mjs`) uses the product as a person would,
 * against a running `sekhemet serve` (Solo) on the run's repository, and does
 * nothing a person could not do there or at a terminal:
 *
 * 1. **The brief.** `prompt.md`, hash-checked, is her first message to Seshat
 *    (`POST /api/pm/messages`). The run stops unless the thread holds it whole.
 * 2. **The conversation.** Each of Seshat's replies is read back from the
 *    thread. Every proposal it carries is applied (`planDecision`: she approves
 *    the plan she is sent), and a question is answered only with the frozen
 *    FAQ's words (`replyTo`), at most `maxReplies` answers a phase. The
 *    conversation ends when a reply asks nothing.
 * 3. **The plan's criteria.** Every issue waiting in Planning for a person's
 *    approval is approved as shown (`GET`, then `POST /api/cards/:id/approve`
 *    with the hash she was shown).
 * 4. **The queue.** `sekhemet queue --repo <repo>` in a terminal: the command a
 *    person runs, its output kept in the run's `input/`.
 * 5. **Review.** Each issue in Review is decided by `acceptDecision` on its
 *    latest evidence's checks and its AI review, as `GET /api/cards/:id/review`
 *    and `/evidence` give them. Accepted: the files Accept requires are opened
 *    (`/opened`), then Accept. Otherwise it is sent back (`/return`) with the
 *    reason those records give.
 * 6. **The next issue.** When nothing is Ready she moves the next Backlog
 *    issue, in the board's order, with the product's own `/ready <issue>` in
 *    Seshat's composer (`pullDecision`); release 1 never pulls an issue of a
 *    later release.
 *    Steps 3 to 6 repeat until every issue of the phase is done or its budget
 *    is spent. A stall (nothing can move) is waited on until the budget ends,
 *    never taken for the end of release 1 (the protocol's fixed point).
 * 7. **Release 1.** She accepts release 1 (`POST /api/slices/<id>/accept`) and
 *    tags it (`sekhemet release --confirm <id>`) when the product proposes it.
 *    The runner then tags the integration branch `release-1` for the
 *    regression count: the fixed point.
 * 8. **The change.** `change_request.md`, hash-checked, is her next message;
 *    steps 2 to 6 run again for the change phase, then the run ends.
 *
 * Accept moves the integration branch by plumbing and leaves the person's
 * checkout behind (RG-S5-2); the product says how to catch up
 * (`git read-tree -m -u <old> <branch>`), and she does so after every act that
 * moves the branch, so the tree scored is what was accepted.
 *
 * Every simulated decision is logged with its basis and counted as zero
 * hands-on minutes. The Coding model's tokens are read from the product's
 * ledger (`card/step` usage); the other roles' are not recorded there, so
 * each `usage` event says so and the scorer compares no tokens across arms.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import {
  REPO_ROOT,
  TIMESHEET_DIR,
  frozenText,
  logEvent,
  readRecord,
  runPaths,
  sha256,
  writeInput,
} from "./grid.mjs";
import { acceptDecision, logDecision, planDecision, pullDecision, replyTo } from "./person.mjs";
import { AGENTIC, tagReleaseOne } from "./runner.mjs";

/** The product's command line, this checkout's build (`tsc -b` first). */
export const DEFAULT_CLI = join(REPO_ROOT, "apps", "harness", "dist", "index.js");

/** How often the thread is read while Seshat answers. */
export const POLL_MS = 2000;

/** At the budget's end the queue gets Ctrl+C (stop after the turn), then a second, then a kill. */
export const QUEUE_STOP_GRACE_MS = { second: 60_000, kill: 30_000 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const minutesSince = (t) => Math.round(((Date.now() - t) / 60_000) * 10) / 10;

/** The dashboard as its page uses it: reads, and writes with the page's headers and token. */
export async function dashboard(url, csrf) {
  const origin = new URL(url).origin;
  async function call(path, { method = "GET", body } = {}) {
    const res = await fetch(`${origin}${path}`, {
      method,
      headers: {
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(method !== "GET"
          ? {
              Origin: origin,
              "X-Sekhemet-Action": "1",
              ...(token ? { "X-Sekhemet-CSRF": token } : {}),
            }
          : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: res.status, json, text };
  }
  let token = csrf;
  if (!token) token = (await call("/api/session")).json?.csrf;
  return {
    origin,
    get: (path) => call(path),
    post: (path, body = {}) => call(path, { method: "POST", body }),
  };
}

// --- the checkout ----------------------------------------------------------------------

function gitOut(repo, args) {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}

/**
 * Bring the person's checkout up to the integration branch, as the product's
 * notice says (RG-S5-2): a two-tree `read-tree` from the commit the files
 * were last brought to. Nothing to do when the branch has not moved.
 */
export function catchUp(ctx, why, notice) {
  const head = gitOut(ctx.repo, ["rev-parse", ctx.branch]);
  if (head === ctx.synced) return null;
  const args = ["read-tree", "-m", "-u", ctx.synced, ctx.branch];
  const r = spawnSync("git", args, { cwd: ctx.repo, encoding: "utf8" });
  const event = {
    kind: "checkout",
    why,
    from: ctx.synced,
    to: head,
    command: `git ${args.join(" ")}`,
    ok: r.status === 0,
    ...(notice ? { notice } : {}),
    ...(r.status === 0 ? {} : { error: (r.stderr ?? "").trim().slice(-400) }),
  };
  if (r.status === 0) ctx.synced = head;
  logEvent(ctx.paths, event);
  return event;
}

// --- Seshat ----------------------------------------------------------------------------

/**
 * Give one frozen text as the person's message to Seshat, logged as given
 * before it is sent (`given` for prompt.md, `change_given` for the change),
 * then read the thread back: the message must hold the text whole (its
 * surrounding whitespace trimmed is accepted and recorded). Returns
 * `{ ok, seq }`, or `{ ok: false, why }` after logging `stopped`.
 */
export async function giveFrozen(ctx, phase, frozen) {
  const { d, paths } = ctx;
  writeInput(paths, frozen);
  const given = {
    frozen: frozen.name,
    frozenSha256: frozen.sha256,
    frozenBytes: frozen.bytes,
    messageSha256: sha256(frozen.text),
    via: "POST /api/pm/messages",
  };
  if (phase === "release-1") logEvent(paths, { kind: "given", phase, ...given });
  else logEvent(paths, { kind: "change_given", given: frozen.name, ...given });
  const sent = await d.post("/api/pm/messages", { text: frozen.text });
  if (sent.status !== 200) {
    const why = `Seshat refused ${frozen.name}: HTTP ${sent.status}${sent.json?.error ? ` (${sent.json.error})` : ""}`;
    logEvent(paths, { kind: "stopped", why });
    return { ok: false, why };
  }
  const id = sent.json?.message?.id;
  const thread = await d.get("/api/pm/thread");
  const mine = (thread.json?.messages ?? []).filter((m) => m.role === "user");
  const held = (id ? mine.find((m) => m.id === id) : mine.at(-1)) ?? mine[0];
  const text = held?.text ?? "";
  const match =
    text === frozen.text
      ? "exact"
      : text === frozen.text.trim()
        ? "surrounding whitespace trimmed by the product"
        : null;
  if (!match) {
    const why = `Seshat holds ${text.length} characters of the ${frozen.text.length} in ${frozen.name}: the product did not receive the frozen input`;
    logEvent(paths, { kind: "stopped", why });
    return { ok: false, why };
  }
  // A long message is also a project document, committed byte for byte (PM-N10-2).
  const own = (held.documents ?? []).find((doc) => doc.fromMessage);
  logEvent(paths, {
    kind: "received",
    phase,
    match,
    ...(own
      ? {
          document: {
            path: own.path ?? null,
            sha256: own.sha256,
            // The bytes sent, final newline and all (PM-N10-2).
            whole: own.sha256 === frozen.sha256,
          },
        }
      : {}),
  });
  if (ctx.repo) catchUp(ctx, `the message's notice (${frozen.name})`, sent.json?.notice);
  return { ok: true, seq: held.seq ?? 0 };
}

/**
 * Seshat's answer to the message at `afterSeq`: every reply after it (not the
 * notifier's) once Seshat is idle again, their words joined and their
 * proposals together; null when the deadline passes first.
 */
export async function awaitReply(ctx, afterSeq, deadline) {
  for (;;) {
    const r = await ctx.d.get("/api/pm/thread");
    const messages = r.json?.messages ?? [];
    const after = messages.filter(
      (m) => m.role === "pm" && (m.seq ?? 0) > afterSeq && m.model !== "notifier",
    );
    const idle = (r.json?.status?.phase ?? "idle") === "idle";
    if (after.length && idle && after.every((m) => m.state === "done" || m.state === "error")) {
      return {
        ids: after.map((m) => m.id),
        seq: Math.max(...after.map((m) => m.seq ?? 0)),
        text: after.map((m) => m.text ?? "").join("\n\n"),
        failed: after.some((m) => m.state === "error"),
        proposals: after.flatMap((m) => m.proposals ?? []),
      };
    }
    if (Date.now() >= deadline) return null;
    await sleep(ctx.pollMs);
  }
}

/** Whether Seshat is idle (nothing queued or being answered) by `deadline`, looked at every `pollMs`. */
export async function awaitIdle(ctx, deadline) {
  for (;;) {
    const r = await ctx.d.get("/api/pm/thread");
    if ((r.json?.status?.phase ?? "idle") === "idle") return true;
    if (Date.now() >= deadline) return false;
    await sleep(ctx.pollMs);
  }
}

/** She approves every open proposal Seshat sends (`planDecision`), each logged with the product's answer. */
async function applyProposals(ctx, phase, reply) {
  for (const p of reply.proposals.filter((x) => x.state === "open")) {
    const decision = planDecision(p);
    const r = await ctx.d.post(`/api/pm/proposals/${encodeURIComponent(p.id)}/apply`, {});
    logDecision(ctx.paths, "approve the plan", decision, {
      phase,
      proposal: p.id,
      kind: p.kind,
      summary: p.summary ?? null,
      applied: r.status === 200,
      status: r.status,
      ...(r.status === 200
        ? { issues: (r.json?.cards ?? []).length }
        : { refused: r.json?.error ?? r.text.slice(0, 300) }),
    });
    if (r.status === 200) catchUp(ctx, "applying the plan", r.json?.notice);
  }
}

/**
 * The conversation of one phase, from the message at `seq`: proposals
 * applied, questions answered from the FAQ (or by `ctx.answer`, a benchmark
 * with no stakeholder: Web-Bench), until a reply asks nothing, the reply cap,
 * a failed reply or the deadline. Returns why it ended.
 */
export async function converse(ctx, phase, seq, given, deadline) {
  let answered = 0;
  let at = seq;
  for (;;) {
    const reply = await awaitReply(ctx, at, deadline);
    if (!reply) return "the phase's time budget was spent waiting for Seshat";
    logEvent(ctx.paths, {
      kind: "seshat",
      phase,
      replies: reply.ids,
      failed: reply.failed,
      proposals: reply.proposals.map((p) => ({ id: p.id, kind: p.kind, state: p.state })),
      textSha256: sha256(reply.text),
    });
    at = reply.seq;
    await applyProposals(ctx, phase, reply);
    if (reply.failed) return "Seshat's reply failed";
    const answer = ctx.answer
      ? ctx.answer(reply.text)
      : replyTo(reply.text, { given, fixture: ctx.fixture });
    if (!answer) return "Seshat asked nothing more";
    if (answered >= ctx.budget.maxReplies) return "the reply cap was reached";
    answered += 1;
    logDecision(
      ctx.paths,
      "answer Seshat",
      { decision: "answer", why: answer.why ?? "from the frozen FAQ" },
      { phase, questions: answer.questions, usedDefault: answer.usedDefault },
    );
    const sent = await ctx.d.post("/api/pm/messages", { text: answer.text });
    if (sent.status !== 200) return `Seshat refused an answer: HTTP ${sent.status}`;
    at = Math.max(at, sent.json?.message?.seq ?? at);
    catchUp(ctx, "the message's notice (an answer)", sent.json?.notice);
  }
}

// --- the board -------------------------------------------------------------------------

async function issues(ctx) {
  const r = await ctx.d.get("/api/board");
  return (r.json?.cards ?? []).filter((c) => c.tier !== "epic");
}

/**
 * Every issue waiting in Planning whose criteria no person has approved yet
 * is approved as shown: the stakeholder approves the plan she is sent. An
 * issue the product still holds after that (its criteria refused by the
 * lint, say) is logged with the product's reason.
 */
async function approveCriteria(ctx, phase) {
  for (const card of (await issues(ctx)).filter((c) => c.status === "planning")) {
    for (let tries = 0; tries < 2; tries += 1) {
      const view = await ctx.d.get(`/api/cards/${encodeURIComponent(card.id)}/approval`);
      const pending = (view.json?.cards ?? []).filter((c) => !c.approved);
      if (view.status !== 200 || pending.length === 0 || ctx.approved.has(view.json.sha256)) break;
      const r = await ctx.d.post(`/api/cards/${encodeURIComponent(card.id)}/approve`, {
        sha256: view.json.sha256,
      });
      if (r.status === 409 && r.json?.reason === "stale") continue;
      ctx.approved.add(view.json.sha256);
      logDecision(ctx.paths, "approve the plan's criteria", planDecision({ id: card.id }), {
        phase,
        issue: card.id,
        shown: view.json.sha256,
        status: r.status,
        approved: r.json?.approved ?? [],
        released: r.json?.released ?? [],
        held: r.json?.held ?? [],
        ...(r.status === 200 ? {} : { refused: r.json?.error ?? r.text.slice(0, 300) }),
      });
      break;
    }
  }
}

/**
 * What the AI review of an issue says, from its dossier entries since the
 * latest evidence (`GET /api/cards/:id/review` `findings`):
 * - a verdict on the criteria (`met`, `unmet`, `unclear`; Seshat's older
 *   `likely_send_back`): the review ran, and passed only when every verdict is
 *   `met`;
 * - otherwise `not_reviewed` with the product's "no Review model" words: no
 *   reviewer is configured;
 * - otherwise (a review that failed, or none recorded): a reviewer is taken
 *   to be configured and no review is recorded, so nothing is accepted
 *   unreviewed.
 */
export function aiReview(findings, noReviewer) {
  const verdicts = findings.filter((f) =>
    ["met", "unmet", "unclear", "likely_send_back"].includes(f.verdict),
  );
  if (verdicts.length) {
    const failed = verdicts.filter((f) => f.verdict !== "met");
    return {
      review: { passed: failed.length === 0 },
      reviewerConfigured: true,
      failed: failed.map((f) => `${f.verdict}: ${f.text ?? ""}`.trim()),
    };
  }
  const notReviewed = findings.filter((f) => f.verdict === "not_reviewed");
  if (notReviewed.some((f) => f.text === noReviewer))
    return { review: null, reviewerConfigured: false, failed: [], note: noReviewer };
  return {
    review: null,
    reviewerConfigured: true,
    failed: [],
    note: notReviewed.at(-1)?.text ?? "no AI review is recorded for this change",
  };
}

/** The checks of an evidence bundle: every rung that ran, passed or not. */
export function checksOf(evidence) {
  return (evidence?.rungResults ?? [])
    .filter((r) => !r.skipped)
    .map((r) => ({ id: r.gate, passed: r.passed === true }));
}

/**
 * Decide every issue in Review on its latest evidence, once per evidence:
 * accept (the files Accept requires opened first) or send back with the
 * reason the records give. Returns how many were decided.
 */
async function decideReviews(ctx, phase) {
  let decided = 0;
  for (const card of (await issues(ctx)).filter((c) => c.status === "review")) {
    const id = encodeURIComponent(card.id);
    const ev = await ctx.d.get(`/api/cards/${id}/evidence`);
    const evidence = ev.json?.evidence ?? null;
    const key = `${card.id}:${evidence?.id ?? "none"}`;
    if (ctx.decided.has(key)) continue;
    ctx.decided.add(key);
    const rv = await ctx.d.get(`/api/cards/${id}/review`);
    const findings = rv.json?.findings ?? [];
    const checks = checksOf(evidence);
    const ai = aiReview(findings, ctx.noReviewer);
    const decision = acceptDecision({
      checks,
      review: ai.review,
      reviewerConfigured: ai.reviewerConfigured,
    });
    const basis = {
      phase,
      issue: card.id,
      title: card.title ?? null,
      evidence: evidence?.id ?? null,
      checks,
      review: ai.review,
      reviewerConfigured: ai.reviewerConfigured,
      ...(ai.failed.length ? { reviewFailed: ai.failed } : {}),
      ...(ai.note ? { reviewNote: ai.note } : {}),
    };
    if (decision.decision === "accept") {
      const files = rv.json?.implementationFiles ?? [];
      await ctx.d.post(`/api/cards/${id}/opened`, { filesShown: files });
      const r = await ctx.d.post(`/api/cards/${id}/accept`, {
        acknowledgedFindings: findings.map((f) => f.id).filter(Boolean),
      });
      logDecision(ctx.paths, "accept", decision, {
        ...basis,
        filesShown: files,
        status: r.status,
        ...(r.status === 200 ? { sha: r.json?.sha ?? null } : { refused: r.json?.error ?? null }),
      });
      if (r.status === 200) catchUp(ctx, `accepting ${card.id}`, r.json?.notice);
    } else {
      const reason = [
        `Sent back: ${decision.why}.`,
        ...ai.failed.map((f) => `The AI review: ${f}`),
      ].join("\n");
      const r = await ctx.d.post(`/api/cards/${id}/return`, { reason });
      logDecision(ctx.paths, "send back", decision, {
        ...basis,
        reason,
        status: r.status,
        ...(r.status === 200 ? {} : { refused: r.json?.error ?? null }),
      });
    }
    decided += 1;
  }
  return decided;
}

// --- the queue -------------------------------------------------------------------------

/**
 * `sekhemet queue --repo <repo>`, as a person runs it in a terminal, its
 * output in the run's `input/`. At the deadline it gets Ctrl+C (stop after the
 * current turn), a second one after a grace, then a kill.
 */
export function cliQueue({
  cli = DEFAULT_CLI,
  env = process.env,
  grace = QUEUE_STOP_GRACE_MS,
} = {}) {
  return ({ repo, deadline, logFile }) =>
    new Promise((resolve) => {
      const out = openSync(logFile, "a");
      const args = [cli, "queue", "--repo", repo];
      const child = spawn(process.execPath, args, { cwd: repo, env, stdio: ["ignore", out, out] });
      closeSync(out);
      const timers = [];
      let stopped = false;
      const at = (ms, fn) => timers.push(setTimeout(fn, Math.max(0, ms)));
      at(deadline - Date.now(), () => {
        stopped = true;
        child.kill("SIGINT");
        at(grace.second, () => child.kill("SIGINT"));
        at(grace.second + grace.kill, () => child.kill("SIGKILL"));
      });
      child.on("exit", (code, signal) => {
        for (const t of timers) clearTimeout(t);
        resolve({ command: ["sekhemet", ...args.slice(1)], exit: code, signal, timedOut: stopped });
      });
    });
}

function statusesOf(cards) {
  return JSON.stringify(cards.map((c) => [c.id, c.status]).sort());
}

/** How often a stalled board is looked at again while the phase waits out its budget. */
export const STALL_POLL_MS = 60_000;

const STALLED = "the phase's time budget was spent while nothing could be moved";

/**
 * The issues of a later release (the story map's slices after the first), so
 * release 1's phase neither pulls them nor waits on them. Empty with no story
 * map, or in the change phase.
 */
async function laterReleases(ctx, phase) {
  if (phase !== "release-1") return new Set();
  const map = await ctx.d.get("/api/story-map");
  const later = (map.json?.slices ?? []).slice(1);
  return new Set(
    later.flatMap((s) => (s.requirements ?? []).flatMap((r) => r.cards ?? [])).map((c) => c.id),
  );
}

/**
 * When nothing is Ready, she moves the next Backlog issue of the phase, in
 * the board's order, with the product's own `/ready <issue>` in Seshat's
 * composer (slash.ts: "Move an issue to Ready."; the move is the person's on
 * the ledger). Each issue is tried once for a given board; a refusal is
 * logged with the product's words and the next is tried. Returns whether one
 * moved.
 */
async function pullNext(ctx, phase, cards, later, deadline) {
  const board = statusesOf(cards);
  ctx.pulled ??= new Set();
  for (const card of cards.filter((c) => c.status === "backlog" && !later.has(c.id))) {
    const key = `${card.id}:${board}`;
    if (ctx.pulled.has(key)) continue;
    ctx.pulled.add(key);
    const via = `/ready ${card.id}`;
    const sent = await ctx.d.post("/api/pm/messages", { text: via });
    const reply =
      sent.status === 200 ? await awaitReply(ctx, sent.json?.message?.seq ?? 0, deadline) : null;
    const now = (await issues(ctx)).find((c) => c.id === card.id);
    const moved = now?.status === "ready";
    logDecision(ctx.paths, "move to Ready", pullDecision(card), {
      phase,
      issue: card.id,
      title: card.title ?? null,
      via,
      status: sent.status,
      reply: reply?.text ?? (sent.status === 200 ? null : (sent.json?.error ?? sent.text ?? null)),
      moved,
    });
    if (moved) return true;
  }
  return false;
}

/**
 * The work of one phase: approve criteria, decide Review, pull the next issue
 * when none is Ready, run the queue while one is. The phase ends when every
 * issue it holds is done (release 1: every issue not in a later release) or
 * its budget is spent; a board nothing can move is waited on, looked at again
 * every `stallPollMs`, until the budget ends (the protocol's fixed point is
 * never a stall). With `ctx.waitOnStall` false (a Web-Bench attempt, which
 * has no fixed point to protect) a stall ends the phase at once. Returns why
 * it ended.
 */
export async function work(ctx, phase, deadline) {
  let stalledFor = null;
  for (let pass = 1; ; pass += 1) {
    await approveCriteria(ctx, phase);
    await decideReviews(ctx, phase);
    let cards = await issues(ctx);
    if (Date.now() >= deadline) return stalledFor ? STALLED : "the phase's time budget was spent";
    const later = await laterReleases(ctx, phase);
    const open = () =>
      cards.filter((c) => !["done", "rejected"].includes(c.status) && !later.has(c.id));
    if (open().length === 0)
      return phase === "release-1" ? "every issue of release 1 is done" : "every issue is done";
    if (!cards.some((c) => c.status === "ready")) {
      if (await pullNext(ctx, phase, cards, later, deadline)) cards = await issues(ctx);
    }
    const ready = cards.filter((c) => c.status === "ready");
    if (ready.length === 0) {
      const waiting = open().map((c) => ({
        id: c.id,
        status: c.status,
        why: c.blockedReason ?? null,
      }));
      const key = JSON.stringify(waiting);
      if (stalledFor !== key) {
        stalledFor = key;
        logEvent(ctx.paths, { kind: "no_ready_issue", phase, waiting });
      }
      if (ctx.waitOnStall === false)
        return "no issue is Ready or in Review, and none could be moved to Ready";
      const wait = Math.min(ctx.stallPollMs ?? STALL_POLL_MS, deadline - Date.now());
      if (wait <= 0) return STALLED;
      await sleep(wait);
      continue;
    }
    stalledFor = null;
    const before = statusesOf(cards);
    const logFile = join(ctx.paths.input, `${phase}-queue-${pass}.log`);
    const began = Date.now();
    logEvent(ctx.paths, { kind: "queue", phase, pass, ready: ready.map((c) => c.id), logFile });
    const q = await ctx.runQueue({ repo: ctx.repo, deadline, logFile, phase, pass });
    logEvent(ctx.paths, { kind: "queue_ended", phase, pass, minutes: minutesSince(began), ...q });
    const moved = statusesOf(await issues(ctx)) !== before;
    const decided = await decideReviews(ctx, phase);
    if (q.timedOut) return "the phase's time budget was spent";
    if (!moved && decided === 0) {
      // The queue ran and moved nothing: a stall, waited on like any other.
      logEvent(ctx.paths, { kind: "queue_moved_nothing", phase, pass });
      if (ctx.waitOnStall === false) return "a queue pass moved no issue";
      stalledFor = "a queue pass moved no issue";
      const wait = Math.min(ctx.stallPollMs ?? STALL_POLL_MS, deadline - Date.now());
      if (wait <= 0) return STALLED;
      await sleep(wait);
    }
  }
}

// --- release 1 -------------------------------------------------------------------------

/**
 * The fixed point: she accepts release 1 on the product and tags it when the
 * product proposes it; the runner tags the integration branch `release-1`.
 */
async function finishReleaseOne(ctx, reason) {
  const map = await ctx.d.get("/api/story-map");
  const slice = (map.json?.slices ?? [])[0];
  let product = { accepted: false, why: "the product has no release planned" };
  if (slice && !slice.accepted) {
    const r = await ctx.d.post(`/api/slices/${encodeURIComponent(slice.id)}/accept`, {});
    const decision = {
      decision: "accept release 1",
      why: "release 1 ends here (the protocol's fixed point)",
    };
    logDecision(ctx.paths, "accept release 1", decision, {
      release: slice.id,
      provenLine: slice.provenLine ?? null,
      status: r.status,
      ...(r.status === 200
        ? {
            version: r.json?.release?.version ?? null,
            releaseRefused: r.json?.releaseRefused ?? null,
          }
        : { refused: r.json?.error ?? null }),
    });
    product = { accepted: r.status === 200, release: slice.id };
    if (r.status === 200 && r.json?.release) {
      const t = ctx.releaseTag(slice.id);
      logDecision(
        ctx.paths,
        "tag release 1",
        { decision: "confirm", why: "the product proposed the release she accepted" },
        t,
      );
      product.tag = t.ok ? t.tag : null;
    } else if (r.status === 200) product.releaseRefused = r.json?.releaseRefused ?? null;
  } else if (slice?.accepted) product = { accepted: true, release: slice.id, before: true };
  catchUp(ctx, "release 1");
  const releaseOneTag = tagReleaseOne(ctx.repo);
  logEvent(ctx.paths, { kind: "release_1_finished", reason, releaseOneTag, product });
  return { releaseOneTag, product };
}

/** `sekhemet release --confirm <slice>`, as a person runs it: the product's own tag. */
export function cliReleaseTag({ cli = DEFAULT_CLI, env = process.env } = {}) {
  return (repo) => (sliceId) => {
    const args = [cli, "release", "--confirm", sliceId, "--repo", repo];
    const r = spawnSync(process.execPath, args, { cwd: repo, env, encoding: "utf8" });
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
    const tag = /Tagged (\S+) at/.exec(out)?.[1] ?? null;
    return {
      command: ["sekhemet", ...args.slice(1)],
      exit: r.status,
      ok: r.status === 0 && tag !== null,
      tag,
      output: out.slice(-600),
    };
  };
}

// --- tokens ----------------------------------------------------------------------------

export function ledgerSeq(repo) {
  const file = join(repo, ".sekhemet", "events.db");
  if (!existsSync(file)) return 0;
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare("SELECT COALESCE(MAX(seq), 0) AS n FROM events").get().n;
  } finally {
    db.close();
  }
}

/** The Coding model's tokens since `sinceSeq`, as the ledger charges them (`card/step` usage). */
export function workerTokens(repo, sinceSeq) {
  const file = join(repo, ".sekhemet", "events.db");
  if (!existsSync(file)) return { inputTokens: 0, outputTokens: 0 };
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const row = db
      .prepare(
        `SELECT SUM(COALESCE(json_extract(payload, '$.usage.promptTokens'), 0)) AS i,
                SUM(COALESCE(json_extract(payload, '$.usage.completionTokens'), 0)) AS o
           FROM events WHERE type = 'card/step' AND seq > ?`,
      )
      .get(sinceSeq);
    return { inputTokens: row.i ?? 0, outputTokens: row.o ?? 0 };
  } finally {
    db.close();
  }
}

export function logUsage(ctx, phase, sinceSeq) {
  logEvent(ctx.paths, {
    kind: "usage",
    phase,
    ...workerTokens(ctx.repo, sinceSeq),
    cacheReadTokens: 0,
    source: "the product's ledger: card/step usage, the Coding model's requests",
    notCounted:
      "Seshat's, the Planning model's and the Review model's tokens: the product's ledger does not record them",
  });
}

// --- the whole arm ---------------------------------------------------------------------

/**
 * What the person works with for one run: the dashboard, her checkout of the
 * run's repository on `main`, the queue and release commands (the product's
 * command line unless a test gives stand-ins), and what she has already
 * approved and decided. Web-Bench's Sekhemet arm (`webbench.mjs`) uses the
 * same, with its own `answer`.
 */
export async function armContext({
  paths,
  url,
  csrf,
  fixture = TIMESHEET_DIR,
  budget = AGENTIC,
  pollMs = POLL_MS,
  stallPollMs = STALL_POLL_MS,
  cli = DEFAULT_CLI,
  cliEnv = process.env,
  runQueue,
  releaseTag,
  answer,
  waitOnStall = true,
}) {
  const repo = realpathSync(paths.repo);
  const { REVIEW_DESK_COPY } = await import(
    pathToFileURL(join(REPO_ROOT, "packages", "ui", "dist", "index.js")).href
  );
  return {
    paths,
    repo,
    fixture,
    budget,
    pollMs,
    stallPollMs,
    waitOnStall,
    d: await dashboard(url, csrf),
    branch: "main",
    synced: gitOut(repo, ["rev-parse", "HEAD"]),
    approved: new Set(),
    decided: new Set(),
    noReviewer: REVIEW_DESK_COPY.noReviewer,
    runQueue: runQueue ?? cliQueue({ cli, env: cliEnv }),
    releaseTag: (releaseTag ?? cliReleaseTag({ cli, env: cliEnv }))(repo),
    ...(answer ? { answer } : {}),
  };
}

/**
 * The Sekhemet arm, end to end, against the dashboard at `url` of a
 * `sekhemet serve` (Solo) started on the run's repository. `runQueue` and
 * `releaseTag` default to the product's command line (`cli`, run with
 * `cliEnv`); a test gives stand-ins. Returns why each phase ended.
 */
export async function driveSekhemet({
  run,
  url,
  csrf,
  env = process.env,
  fixture = TIMESHEET_DIR,
  budget = AGENTIC,
  pollMs = POLL_MS,
  stallPollMs = STALL_POLL_MS,
  cli = DEFAULT_CLI,
  cliEnv = env,
  runQueue,
  releaseTag,
}) {
  if (!url)
    throw new Error("the Sekhemet arm needs --url, the dashboard of the run's `sekhemet serve`");
  const paths = runPaths("sekhemet-local", run, env);
  if (!readRecord(paths))
    throw new Error(`no run at ${paths.dir}: prepare it with the runner first`);
  const ctx = await armContext({
    paths,
    url,
    csrf,
    fixture,
    budget,
    pollMs,
    stallPollMs,
    cli,
    cliEnv,
    runQueue,
    releaseTag,
  });
  const repo = ctx.repo;
  mkdirSync(paths.input, { recursive: true });
  logEvent(paths, {
    kind: "start",
    via: "sekhemet_arm.mjs driveSekhemet",
    dashboard: ctx.d.origin,
    cli: runQueue ? "a stand-in" : cli,
    budget,
  });

  // Release 1: the brief, the conversation, the plan, the queue and Review.
  const deadline1 = Date.now() + budget.budgetMinutes["release-1"] * 60_000;
  const seq1 = ledgerSeq(repo);
  const first = await giveFrozen(ctx, "release-1", frozenText("prompt.md", fixture));
  if (!first.ok) {
    logEvent(paths, { kind: "end", reason: first.why });
    return { ok: false, why: first.why, paths: paths.dir };
  }
  const talk1 = await converse(ctx, "release-1", first.seq, ["release-1"], deadline1);
  const r1 = await work(ctx, "release-1", deadline1);
  logUsage(ctx, "release-1", seq1);
  const release = await finishReleaseOne(ctx, r1);

  // The change: change_request.md at the fixed point, then the same again.
  const deadline2 = Date.now() + budget.budgetMinutes["change-request"] * 60_000;
  const seq2 = ledgerSeq(repo);
  const second = await giveFrozen(ctx, "change-request", frozenText("change_request.md", fixture));
  if (!second.ok) {
    logEvent(paths, { kind: "end", reason: second.why });
    return { ok: false, why: second.why, paths: paths.dir };
  }
  const talk2 = await converse(
    ctx,
    "change-request",
    second.seq,
    ["release-1", "change-request"],
    deadline2,
  );
  const r2 = await work(ctx, "change-request", deadline2);
  logUsage(ctx, "change-request", seq2);
  catchUp(ctx, "the end of the run");
  logEvent(paths, { kind: "end", reason: r2 });
  return {
    ok: true,
    paths: paths.dir,
    releaseOne: { conversation: talk1, work: r1, ...release },
    change: { conversation: talk2, work: r2 },
  };
}
