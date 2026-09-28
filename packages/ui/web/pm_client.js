// The project manager's thread and status (PM_CONTRACT §3 Chat, PM_DESIGN §2).
// One copy of the conversation in the store; the panel and #/pm both render it.
import { announce, getJSON, postJSON } from "./dom.js";
import { statusStep } from "./lib/pm.js";
import { store } from "./store.js";
import { toast } from "./toast.js";

export const PM_NAME = "Seshat";

function setPm(patch) {
  store.set({ pm: { ...store.state.pm, ...patch } });
}

function bySeq(a, b) {
  return (a.seq ?? 0) - (b.seq ?? 0) || String(a.createdAt).localeCompare(String(b.createdAt));
}

function upsert(message) {
  if (!message?.id) return;
  const list = store.state.pm.messages.filter((m) => m.id !== message.id);
  list.push(message);
  list.sort(bySeq);
  setPm({ messages: list });
}

/** Keep per-phase first-seen times so timers work even without `since`. */
function applyStatus(status) {
  if (!status) return;
  const pm = store.state.pm;
  if (status.phase === "idle") {
    setPm({ status, phaseSeenAt: {}, workerInvolved: false, step: undefined });
    return;
  }
  const seen = { ...pm.phaseSeenAt };
  const since = status.since ? Date.parse(status.since) : Number.NaN;
  if (!seen[status.phase] || Number.isFinite(since)) {
    seen[status.phase] = Number.isFinite(since) ? since : Date.now();
  }
  const workerInvolved =
    pm.workerInvolved ||
    Boolean(status.workerPaused) ||
    status.phase === "waiting_for_step" ||
    status.phase === "resuming_worker";
  setPm({ status, phaseSeenAt: seen, workerInvolved, step: statusStep(status) ?? pm.step });
}

export async function loadThread() {
  try {
    const r = await getJSON("/api/pm/thread");
    if (r.status === 404) {
      setPm({ available: false, error: null });
      return;
    }
    if (!r.ok) {
      setPm({ error: { status: r.status, message: r.data?.error ?? "" } });
      return;
    }
    setPm({
      available: true,
      error: null,
      messages: [...(r.data?.messages ?? [])].sort(bySeq),
      model: r.data?.model ?? store.state.pm.model,
    });
    applyStatus(r.data?.status);
  } catch (err) {
    setPm({ error: { status: 0, message: String(err?.message ?? err) } });
  }
}

/** SSE `pm` frames: `{ kind: "message", message }` or `{ kind: "status", status }`. */
export function onPmEvent(payload) {
  if (!payload) return;
  if (store.state.pm.available !== true) setPm({ available: true });
  if (payload.kind === "message") {
    const was = store.state.pm.messages.find((m) => m.id === payload.message?.id);
    upsert(payload.message);
    const m = payload.message;
    if (m?.role === "pm" && m.state === "done" && !was) {
      const n = (m.proposals ?? []).filter((p) => p.state === "open").length;
      announce(
        `${PM_NAME} replied.${n ? ` ${n} proposed ${n === 1 ? "change" : "changes"}.` : ""}`,
      );
    }
  } else if (payload.kind === "status") {
    applyStatus(payload.status);
  } else if (payload.kind === "refresh") {
    // Team setup (PM-N9-8): the stream carries no message; each person
    // reloads their own part of the thread.
    void loadThread();
  }
}

/** The user message Seshat is working on, if any. */
export function pendingMessage(messages = store.state.pm.messages) {
  return messages.find(
    (m) => m.role === "user" && (m.state === "queued" || m.state === "thinking"),
  );
}

export async function sendMessage(text, context) {
  const body = { text };
  if (context && (context.cardId || context.view)) body.context = context;
  const r = await postJSON("/api/pm/messages", body);
  if (r.status === 404) {
    setPm({ available: false });
    return false;
  }
  if (!r.ok) {
    toast({
      tone: "fail",
      text: `Couldn't send to ${PM_NAME}.`,
      detail:
        r.status === 403
          ? "This action must come from the dashboard. Reload the page."
          : (r.data?.error ?? `The server returned ${r.status || "no response"}.`),
    });
    return false;
  }
  upsert(r.data?.message);
  // Before the first status frame arrives, the thread already shows the wait.
  if (store.state.pm.status.phase === "idle") {
    setPm({ phaseSeenAt: { ...store.state.pm.phaseSeenAt, queued: Date.now() } });
  }
  return true;
}

function patchProposal(proposal) {
  if (!proposal?.id) return;
  const messages = store.state.pm.messages.map((m) =>
    m.proposals?.some((p) => p.id === proposal.id)
      ? {
          ...m,
          proposals: m.proposals.map((p) => (p.id === proposal.id ? { ...p, ...proposal } : p)),
        }
      : m,
  );
  setPm({ messages });
}

/**
 * Apply or discard one proposal. Returns `{ ok, error? }`. The ledger records
 * the apply with actor `human` (contract §3); the board refreshes after.
 */
export async function decide(proposal, verb, { quiet = false } = {}) {
  const r = await postJSON(`/api/pm/proposals/${encodeURIComponent(proposal.id)}/${verb}`);
  if (!r.ok) {
    const error =
      r.status === 404 && !r.data?.error
        ? "This server can't apply proposals yet."
        : (r.data?.error ?? `The server returned ${r.status || "no response"}.`);
    if (!quiet) {
      toast({
        tone: "fail",
        text: `Couldn't ${verb} “${proposal.summary}”.`,
        detail: error,
      });
    }
    return { ok: false, error };
  }
  const next = {
    ...proposal,
    ...(r.data?.proposal ?? {}),
    state: verb === "apply" ? "applied" : "discarded",
  };
  if (!next.decidedAt) next.decidedAt = new Date().toISOString();
  patchProposal(next);
  if (verb === "apply") window.dispatchEvent(new CustomEvent("sekhemet:refresh"));
  return { ok: true, proposal: next };
}

/** Apply in order and stop at the first failure (PM_DESIGN §2.4). */
export async function applyAll(proposals) {
  const open = proposals.filter((p) => p.state === "open");
  let done = 0;
  for (const p of open) {
    const r = await decide(p, "apply", { quiet: true });
    if (!r.ok) {
      toast({
        tone: "fail",
        text: `Applied ${done} of ${open.length}. “${p.summary}” failed.`,
        detail: r.error,
      });
      return done;
    }
    done++;
  }
  toast({ tone: "pass", text: `Applied ${done} ${done === 1 ? "change" : "changes"}` });
  return done;
}

export async function discardAll(proposals) {
  const open = proposals.filter((p) => p.state === "open");
  for (const p of open) {
    const r = await decide(p, "discard", { quiet: true });
    if (!r.ok) {
      toast({ tone: "fail", text: `Couldn't discard “${p.summary}”.`, detail: r.error });
      return;
    }
  }
  toast({ text: `Discarded ${open.length} ${open.length === 1 ? "change" : "changes"}` });
}

/**
 * PM-P6-10: while this page is visible and focused, tell the server once a
 * minute, so Seshat's unsolicited items come to the panel instead of a
 * notification ("an offer in the panel beats a ping").
 */
function reportFocus() {
  if (document.visibilityState !== "visible" || !document.hasFocus()) return;
  postJSON("/api/pm/focus", {}).catch(() => {});
}

export function initPm() {
  loadThread();
  reportFocus();
  window.addEventListener("focus", reportFocus);
  document.addEventListener("visibilitychange", reportFocus);
  setInterval(reportFocus, 60_000);
}
