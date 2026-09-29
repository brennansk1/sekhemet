// Review plan for a `start_project` proposal (design-stage §2.9, DS-P2-6, -7):
// the group shown before anything exists, Accept and Remove on each
// candidate, a release line moved with its arrows (or by dragging a
// candidate across it), the Type, the questions, and one Create project
// that applies the proposal with the person's choices (PM_CONTRACT §3). In
// the Team setup a Stakeholder sends it for approval to a Member or an Admin
// they name instead, and that person approves it (teams TEAM-20, TEAM-42).
import { getJSON, postJSON } from "./dom.js";
import { closeTop, pushOverlay, trapFocus } from "./overlay.js";
import {
  choicesOf,
  keptCandidates,
  moveLine,
  planAction,
  reviewPlanHtml,
  reviewState,
  setAnswer,
  setType,
  toggleCandidate,
} from "./review_plan_view.js";
import { toast } from "./toast.js";

/** A proposal Review plan can show; kept pure in the view module. */
export { hasReviewPlan } from "./review_plan_view.js";

/** The Members and Admins a Stakeholder may send a plan to, by name; never themselves. */
async function loadApprovers(me) {
  const r = await getJSON("/api/members");
  if (!r.ok) return [];
  return (r.data?.members ?? [])
    .filter((m) => !m.pending && (m.level === "member" || m.level === "admin"))
    .filter((m) => m.principal !== me)
    .map((m) => ({ principal: m.principal, name: m.name ?? m.principal }));
}

/**
 * Open Review plan for `proposal`; resolves with the apply's (or the send's)
 * result, or undefined when closed. `level` and `me` are the signed-in
 * person's in the Team setup.
 */
export function openReviewPlan(
  proposal,
  { post = postJSON, setup = "solo", level, me, approvers: given = loadApprovers } = {},
) {
  const group = proposal.patch.group;
  const approval = proposal.approval;
  let state = reviewState(group, approval?.choices);
  const view = { setup, level, me, approval, approvers: undefined };
  const host = document.createElement("div");
  host.className = "rp-dialog";
  host.setAttribute("role", "dialog");
  host.setAttribute("aria-modal", "true");
  host.setAttribute("aria-labelledby", "rp-h");
  document.body.appendChild(host);
  let settle;
  const done = new Promise((resolve) => {
    settle = resolve;
  });
  const close = (result) => {
    host.remove();
    settle(result);
  };
  const remove = pushOverlay({
    kind: "review-plan",
    close: () => close(undefined),
    onKey: (e) => trapFocus(host, e),
  });
  const draw = () => {
    const approver = host.querySelector("[data-approver]")?.value;
    const typed = host.querySelector("[data-plan-comment] textarea")?.value;
    host.innerHTML = reviewPlanHtml(group, state, view);
    const select = host.querySelector("[data-approver]");
    if (select && approver) select.value = approver;
    const box = host.querySelector("[data-plan-comment] textarea");
    if (box && typed) box.value = typed;
  };
  // Who the plan can be sent to, fetched once for a Stakeholder.
  if (planAction(view) === "send") {
    Promise.resolve(given(me))
      .catch(() => [])
      .then((list) => {
        view.approvers = list;
        if (host.isConnected) draw();
      });
  }
  // Send, Approve or Create: one request, its refusal said in a toast.
  const submit = async (btn, path, body, failed) => {
    btn.disabled = true;
    const r = await post(path, body);
    if (!r.ok) {
      btn.disabled = false;
      toast({
        tone: "fail",
        text: failed,
        detail: r.data?.error ?? `The server returned ${r.status || "no response"}.`,
      });
      return;
    }
    remove();
    window.dispatchEvent(new CustomEvent("sekhemet:refresh"));
    close(r.data);
  };
  const base = `/api/pm/proposals/${encodeURIComponent(proposal.id)}`;
  host.addEventListener("click", async (e) => {
    const t = e.target instanceof Element ? e.target : null;
    if (!t) return;
    const accept = t.closest("[data-accept]")?.getAttribute("data-accept");
    const removeKey = t.closest("[data-remove]")?.getAttribute("data-remove");
    if (accept) state = toggleCandidate(state, accept, "accept");
    else if (removeKey) state = toggleCandidate(state, removeKey, "remove");
    else if (t.closest("[data-line-up]")) state = moveLine(group, state, -1);
    else if (t.closest("[data-line-down]")) state = moveLine(group, state, +1);
    else if (t.closest("[data-create]")) {
      await submit(
        t.closest("[data-create]"),
        `${base}/apply`,
        { choices: choicesOf(state) },
        "The project was not created.",
      );
      return;
    } else if (t.closest("[data-send]")) {
      const approver = host.querySelector("[data-approver]")?.value;
      if (!approver) return;
      await submit(
        t.closest("[data-send]"),
        `${base}/send-for-approval`,
        { approver, choices: choicesOf(state) },
        "The plan was not sent.",
      );
      return;
    } else if (t.closest("[data-approve]")) {
      await submit(
        t.closest("[data-approve]"),
        `${base}/approve`,
        { choices: choicesOf(state) },
        "The plan was not approved.",
      );
      return;
    } else return;
    // Keep the line within what is kept after an Accept or a Remove.
    state = moveLine(group, state, 0);
    draw();
  });
  // Design-stage §2.9 item 7: a question (the approver's) or an answer (the
  // sender's) in the plan's thread; the dialog stays open and shows it.
  host.addEventListener("submit", async (e) => {
    const form = e.target instanceof HTMLFormElement ? e.target : null;
    if (!form?.hasAttribute("data-plan-comment")) return;
    e.preventDefault();
    const box = form.querySelector("textarea");
    const btn = form.querySelector('button[type="submit"]');
    const text = box?.value.trim() ?? "";
    if (!text) {
      box?.focus();
      return;
    }
    if (btn) btn.disabled = true;
    const r = await post(`${base}/comments`, { text });
    if (btn) btn.disabled = false;
    if (!r.ok) {
      toast({
        tone: "fail",
        text: "Not sent.",
        detail: r.data?.error ?? `The server returned ${r.status || "no response"}.`,
      });
      return;
    }
    const approvalNow = r.data?.proposal?.approval;
    if (approvalNow) {
      view.approval = approvalNow;
      proposal.approval = approvalNow;
    }
    if (box) box.value = "";
    draw();
    host.querySelector("[data-plan-comment] textarea")?.focus();
  });
  host.addEventListener("change", (e) => {
    const t = e.target instanceof Element ? e.target : null;
    if (t?.matches("[data-type]")) state = setType(state, t.value);
    else if (t?.matches("[data-answer]"))
      state = setAnswer(state, Number(t.getAttribute("data-answer")), Number(t.value));
    else return;
    draw();
  });
  // Dragging a candidate across the line moves the line to where it was dropped.
  host.addEventListener("dragstart", (e) => {
    const key = e.target instanceof Element ? e.target.closest("[data-cand]")?.dataset.cand : "";
    if (key) e.dataTransfer?.setData("text/plain", key);
  });
  host.addEventListener("dragover", (e) => {
    if (e.target instanceof Element && e.target.closest("[data-release-line],[data-cand]"))
      e.preventDefault();
  });
  host.addEventListener("drop", (e) => {
    const over = e.target instanceof Element ? e.target.closest("[data-cand]")?.dataset.cand : "";
    if (!over) return;
    e.preventDefault();
    const at = keptCandidates(group, state).findIndex((c) => c.key === over);
    if (at < 0) return;
    state = moveLine(group, state, at + 1 - state.line);
    draw();
  });
  draw();
  host.querySelector("[data-create],[data-send],[data-approve]")?.focus();
  return done.finally(() => {
    if (host.isConnected) closeTop();
  });
}
