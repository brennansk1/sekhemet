// Review plan for a `start_project` proposal (design-stage §2.9, DS-P2-6, -7):
// the group shown before anything exists, Accept and Remove on each
// candidate, a release line moved with its arrows (or by dragging a
// candidate across it), the Type, the questions, and one Create project
// that applies the proposal with the person's choices (PM_CONTRACT §3).
import { postJSON } from "./dom.js";
import { closeTop, pushOverlay, trapFocus } from "./overlay.js";
import {
  choicesOf,
  keptCandidates,
  moveLine,
  reviewPlanHtml,
  reviewState,
  setAnswer,
  setType,
  toggleCandidate,
} from "./review_plan_view.js";
import { toast } from "./toast.js";

/** A proposal Review plan can show; kept pure in the view module. */
export { hasReviewPlan } from "./review_plan_view.js";

/** Open Review plan for `proposal`; resolves with the apply's result, or undefined when closed. */
export function openReviewPlan(proposal, { post = postJSON, setup = "solo" } = {}) {
  const group = proposal.patch.group;
  let state = reviewState(group);
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
    host.innerHTML = reviewPlanHtml(group, state, { setup });
  };
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
      const btn = t.closest("[data-create]");
      btn.disabled = true;
      const r = await post(`/api/pm/proposals/${encodeURIComponent(proposal.id)}/apply`, {
        choices: choicesOf(state),
      });
      if (!r.ok) {
        btn.disabled = false;
        toast({
          tone: "fail",
          text: "The project was not created.",
          detail: r.data?.error ?? `The server returned ${r.status || "no response"}.`,
        });
        return;
      }
      remove();
      window.dispatchEvent(new CustomEvent("sekhemet:refresh"));
      close(r.data);
      return;
    } else return;
    // Keep the line within what is kept after an Accept or a Remove.
    state = moveLine(group, state, 0);
    draw();
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
  host.querySelector("[data-create]")?.focus();
  return done.finally(() => {
    if (host.isConnected) closeTop();
  });
}
