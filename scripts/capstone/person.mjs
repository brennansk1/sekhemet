/**
 * The person-simulator for the capstone's Sekhemet arm (W2 G5): the stand-in
 * for Marisol and for the person who accepts the work.
 *
 * - **She answers Seshat only from the frozen FAQ:** a question gets, word for
 *   word, the stakeholder script's answers whose keywords match it, from the
 *   phases she has already given (`render_prompt.mjs` `answerFor`), or the
 *   default answer. She never says anything an arm in another cell would not
 *   also have read.
 * - **She decides nothing on judgement:** she approves the plan Seshat sends
 *   her for approval, and accepts an issue or a release exactly when all its
 *   checks passed and, where an AI reviewer is configured, its review passed;
 *   otherwise she sends it back with the reason those records give. With no
 *   reviewer configured (the Review role ships unfilled until RG-P8-13), the
 *   checks alone decide, as they do for the Claude Code arm, and the log says
 *   no review ran.
 * - **Every simulated decision is logged** in the run's `log.jsonl`, with
 *   what it was based on, and counted as zero hands-on minutes (she is not a
 *   person; the log says so).
 *
 * `driveSekhemet` runs the conversation's first step against a running
 * `sekhemet serve` (Solo): it gives Seshat `prompt.md`, then reads the thread
 * back and refuses to continue unless Seshat holds exactly that text.
 */
import { TIMESHEET_DIR, frozenText, logEvent, readRecord, runPaths } from "./grid.mjs";
import { answerFor, loadScript } from "./render_prompt.mjs";

const SIMULATED = { minutes: 0, simulated: true };

/** The questions in a message from Seshat: its sentences ending in a question mark. */
export function questionsIn(text) {
  return (text.replace(/\r\n/g, "\n").match(/[^.!?\n][^.!?\n]*\?/g) ?? [])
    .map((q) => q.trim())
    .filter(Boolean);
}

/**
 * Her reply to a message from Seshat: the FAQ's answers to each of its
 * questions, joined, without repeating an answer; null when it asks nothing.
 */
export function replyTo(text, { given = ["release-1"], fixture = TIMESHEET_DIR } = {}) {
  const script = loadScript(fixture);
  const qs = questionsIn(text);
  if (qs.length === 0) return null;
  const answers = [];
  for (const q of qs) {
    const a = answerFor(script, given, q);
    for (const part of a.split("\n\n")) if (!answers.includes(part)) answers.push(part);
  }
  return {
    questions: qs,
    text: answers.join("\n\n"),
    usedDefault: answers.includes(script.defaultAnswer),
  };
}

/** She approves the plan Seshat sends: she is the stakeholder, not a reviewer of plans. */
export function planDecision(plan) {
  return {
    decision: "approve",
    why: "the stakeholder approves the plan she is sent",
    plan: plan?.id ?? null,
  };
}

/**
 * Accept or send back: accepted exactly when every check passed and, when an
 * AI reviewer is configured, its review passed. `checks` is `[{ id, passed }]`;
 * `review` is `{ passed }` or null when no AI review ran. With a reviewer
 * configured, nothing unreviewed is accepted; with none configured, the
 * checks decide alone and the decision says no review ran.
 */
export function acceptDecision({ checks = [], review = null, reviewerConfigured = true } = {}) {
  const failed = checks.filter((c) => !c.passed).map((c) => c.id);
  if (checks.length === 0) return { decision: "send back", why: "no checks are recorded" };
  if (failed.length) return { decision: "send back", why: `checks failed: ${failed.join(", ")}` };
  if (review && !review.passed) return { decision: "send back", why: "the AI review did not pass" };
  if (review) return { decision: "accept", why: "all checks passed and the AI review passed" };
  if (reviewerConfigured) return { decision: "send back", why: "no AI review is recorded" };
  return {
    decision: "accept",
    why: "all checks passed; no AI reviewer is configured, so no review ran",
  };
}

/** Log one simulated decision in the run's log. */
export function logDecision(paths, what, decision, basis = {}) {
  return logEvent(paths, { kind: "person", what, ...decision, basis, ...SIMULATED });
}

async function call(base, path, { method = "GET", body, csrf } = {}) {
  const origin = new URL(base).origin;
  const res = await fetch(`${origin}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(method !== "GET"
        ? { Origin: origin, "X-Sekhemet-Action": "1", ...(csrf ? { "X-Sekhemet-Csrf": csrf } : {}) }
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

/**
 * The conversation's first step, against a running dashboard at `url`: the
 * whole of `prompt.md` as Marisol's first message to Seshat, then the thread
 * read back. The run stops (`ok: false`) unless the thread holds exactly
 * `prompt.md`: a product that shortens or rewrites the message has not been
 * given the frozen input, and the arm is not run on anything else.
 */
export async function driveSekhemet({
  run,
  url,
  csrf,
  env = process.env,
  fixture = TIMESHEET_DIR,
}) {
  if (!url)
    throw new Error("the Sekhemet arm needs --url, the dashboard of the run's `sekhemet serve`");
  const paths = runPaths("sekhemet-local", run, env);
  if (!readRecord(paths))
    throw new Error(`no run at ${paths.dir}: prepare it with the runner first`);
  const frozen = frozenText("prompt.md", fixture);
  logEvent(paths, { kind: "start", via: "person.mjs driveSekhemet" });
  let token = csrf;
  if (!token) {
    const session = await call(url, "/api/session");
    token = session.json?.csrf;
  }
  logEvent(paths, {
    kind: "given",
    phase: "release-1",
    frozen: "prompt.md",
    frozenSha256: frozen.sha256,
    via: "POST /api/pm/messages",
  });
  const sent = await call(url, "/api/pm/messages", {
    method: "POST",
    body: { text: frozen.text },
    csrf: token,
  });
  if (sent.status !== 200) {
    logEvent(paths, { kind: "stopped", why: `Seshat refused the message: HTTP ${sent.status}` });
    return { ok: false, why: `HTTP ${sent.status} from /api/pm/messages`, paths: paths.dir };
  }
  const thread = await call(url, "/api/pm/thread");
  const mine = (thread.json?.messages ?? []).filter((m) => m.role === "user");
  const held = mine[0]?.text ?? "";
  const exact =
    held === frozen.text
      ? "exact"
      : held === frozen.text.trim()
        ? "surrounding whitespace trimmed by the product"
        : null;
  if (!exact) {
    const why = `Seshat holds ${held.length} characters of the ${frozen.text.length} in prompt.md: the product did not receive the frozen input`;
    logEvent(paths, { kind: "stopped", why });
    return { ok: false, why, paths: paths.dir };
  }
  logEvent(paths, { kind: "received", phase: "release-1", match: exact });
  const replies = (thread.json?.messages ?? []).filter(
    (m) => m.role === "pm" && m.state === "done",
  );
  const last = replies[replies.length - 1];
  if (last) {
    const answer = replyTo(last.text, { fixture });
    if (answer) {
      logDecision(
        paths,
        "answer Seshat",
        { decision: "answer", why: "from the frozen FAQ" },
        { questions: answer.questions, usedDefault: answer.usedDefault },
      );
      await call(url, "/api/pm/messages", {
        method: "POST",
        body: { text: answer.text },
        csrf: token,
      });
    }
  }
  return { ok: true, match: exact, paths: paths.dir };
}
