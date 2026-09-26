// What Sekhemet has learned (PM_CONTRACT §6): playbook rules, the user
// profile and the stopping-policy tuner, from GET /api/learning. Everything
// is local, on the ledger, and takes effect only when you approve it.
import { getJSON, sendJSON } from "./dom.js";
import { store } from "./store.js";
import { toast } from "./toast.js";
import { mutationsBlocked } from "./triage.js";

/** `store.state.learning`: `{ status, data }`; status 0 until the first fetch. */
function set(patch) {
  store.set({ learning: { ...(store.state.learning ?? { status: 0, data: null }), ...patch } });
}

let inflight = null;

export function loadLearning() {
  if (inflight) return inflight;
  inflight = getJSON("/api/learning")
    .then((r) => set({ status: r.status, data: r.ok ? r.data : null }))
    .catch(() => set({ status: -1, data: null }))
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

function send(method, path, body) {
  return sendJSON(method, path, body ?? {});
}

function why(r) {
  if (r.status === 404 && !r.data?.error) return "This server can't change learned rules yet.";
  if (r.status === 403 && !r.data?.refused)
    return "This action must come from the dashboard. Reload the page.";
  return r.data?.error ?? `The server returned ${r.status || "no response"}.`;
}

/** Patch one item locally so the page answers at once; the refetch confirms it. */
function patchLocal(kind, id, patch) {
  const d = store.state.learning?.data;
  if (!d) return;
  const list = (d[kind] ?? []).map((x) => (x.id === id ? { ...x, ...patch } : x));
  set({ data: { ...d, [kind]: list } });
}

async function act({ method, path, body, kind, id, patch, done, failed }) {
  const blocked = mutationsBlocked();
  if (blocked) {
    toast({
      tone: "parked",
      text: blocked === "readonly" ? "Read-only." : "Offline.",
      detail: "Learned rules and your profile can't change right now.",
    });
    return false;
  }
  const before = (store.state.learning?.data?.[kind] ?? []).find((x) => x.id === id);
  patchLocal(kind, id, patch);
  const r = await send(method, path, body);
  if (!r.ok) {
    if (before) patchLocal(kind, id, before);
    toast({ tone: "fail", text: failed, detail: why(r) });
    return false;
  }
  toast({ tone: "pass", text: done });
  loadLearning();
  return true;
}

const enc = encodeURIComponent;

/** `reach`: "project" (default) or "global", which applies in every repository. */
export const approveRule = (r, reach = "project") =>
  act({
    method: "POST",
    path: `/api/learning/rules/${enc(r.id)}/approve`,
    body: reach === "global" ? { reach: "global" } : {},
    kind: "rules",
    id: r.id,
    patch: { status: "active", reach },
    done:
      reach === "global"
        ? "Approved for all projects. Every repository on this machine uses it from the next matching card."
        : "Approved. The rule is given to the Worker from the next matching card.",
    failed: "Couldn't approve the rule.",
  });

export const retireRule = (r) =>
  act({
    method: "POST",
    path: `/api/learning/rules/${enc(r.id)}/retire`,
    kind: "rules",
    id: r.id,
    patch: { status: "retired" },
    done: "Retired. The rule is no longer given to the Worker.",
    failed: "Couldn't retire the rule.",
  });

export const editRule = (r, text) =>
  act({
    method: "PATCH",
    path: `/api/learning/rules/${enc(r.id)}`,
    body: { text },
    kind: "rules",
    id: r.id,
    patch: { text },
    done: "Saved the rule.",
    failed: "Couldn't save the rule.",
  });

export const dismissEntry = (e) =>
  act({
    method: "POST",
    path: `/api/learning/profile/${enc(e.id)}/dismiss`,
    kind: "profile",
    id: e.id,
    patch: { status: "dismissed" },
    done: "Dismissed. Seshat no longer uses it.",
    failed: "Couldn't dismiss it.",
  });

export const editEntry = (e, statement) =>
  act({
    method: "PATCH",
    path: `/api/learning/profile/${enc(e.id)}`,
    body: { statement },
    kind: "profile",
    id: e.id,
    patch: { statement },
    done: "Saved. Seshat uses your wording from now on.",
    failed: "Couldn't save it.",
  });
