// The issue's closing and reopening actions (dashboard §2.6 *Issue actions*,
// NEW-dashboard-21; FINDINGS ISS-04): *Won't do* (a reason required),
// *Reopen* and *Revert* (a confirmation naming the commit first), from the
// issue page's `⋯` menu, the peek and the palette. Won't do and Reopen offer
// Undo for 10 s (§2.4.23); Revert is undone only by its own revert. Which
// actions an issue offers, and every word, come from `/app/lib/issue_actions.js`.
import { copyText, esc, getJSON, icon, kbd, postJSON } from "./dom.js";
import { ISSUE_ACTION_COPY as C, issueActions, revertConfirmText } from "./lib/issue_actions.js";
import { placeUnder, pushOverlay, trapFocus } from "./overlay.js";
import { toast } from "./toast.js";
import { blockedToast, mutationsBlocked } from "./triage.js";
import { toastWithUndo } from "./undo.js";

/** DB-N9-17: Won't do and Reopen need the review permission on the issue's project. */
function needsAttr(card) {
  return `data-needs="review"${card?.projectId ? ` data-needs-project="${esc(card.projectId)}"` : ""}`;
}

/** The `⋯` button, or "" when the issue offers none of these actions or the server is read-only. */
export function issueMoreHtml(card) {
  if (!card || mutationsBlocked() === "readonly" || issueActions(card).length === 0) return "";
  return `<button class="btn ghost ia-more" type="button" data-issue-more aria-haspopup="menu" aria-label="${esc(C.menu)}">${icon("more", 14, "ic s14")}</button>`;
}

function refreshSoon() {
  window.dispatchEvent(new CustomEvent("sekhemet:refresh"));
}

function failure(res) {
  return res.data?.error ?? `The server returned ${res.status}.`;
}

/** The review desk's answer on Revert, loaded when the caller has none (DB-N21-3). */
async function deskFor(card, detail) {
  if (detail?.desk) return detail.desk;
  const res = await getJSON(`/api/cards/${encodeURIComponent(card.id)}/review`).catch(() => null);
  return res?.ok ? res.data : null;
}

/**
 * Open the `⋯` menu for an issue under `anchor`. Each action has its hint
 * beneath it; a disabled Revert says who may revert, as adjacent text.
 */
export async function openIssueMenu(anchor, card, { detail, onDone } = {}) {
  if (!card) return;
  const desk = card.status === "done" ? await deskFor(card, detail) : null;
  const actions = issueActions(card, desk);
  if (!actions.length) return;
  const menu = document.createElement("div");
  menu.className = "menu ia-menu";
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", C.menu);
  menu.innerHTML = actions
    .map(
      (a) =>
        `<button type="button" role="menuitem" data-ia="${esc(a.id)}"${a.enabled ? "" : ` disabled aria-describedby="ia-why-${esc(a.id)}"`}${a.id === "revert" ? "" : ` ${needsAttr(card)}`}>${esc(a.label)}</button><div class="mnote"${a.why ? ` id="ia-why-${esc(a.id)}"` : ""}>${esc(a.why ?? a.hint)}</div>`,
    )
    .join("");
  document.getElementById("overlay-root").append(menu);
  placeUnder(menu, anchor, { align: "right" });
  const buttons = () => Array.from(menu.querySelectorAll("button:not([disabled])"));
  const close = () => {
    remove();
    menu.remove();
    document.removeEventListener("pointerdown", outside, true);
  };
  const remove = pushOverlay({
    kind: "menu",
    modal: true,
    close: () => {
      menu.remove();
      document.removeEventListener("pointerdown", outside, true);
      anchor?.focus?.();
    },
    onKey: (e) => {
      const list = buttons();
      const i = list.indexOf(document.activeElement);
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        const step = e.key === "ArrowDown" ? 1 : -1;
        list[(i + step + list.length) % list.length]?.focus();
        e.preventDefault();
        return true;
      }
      return e.key !== "Escape" && e.key !== "Enter" && e.key !== " " && e.key !== "Tab";
    },
  });
  function outside(e) {
    if (!menu.contains(e.target) && e.target !== anchor) close();
  }
  setTimeout(() => document.addEventListener("pointerdown", outside, true), 0);
  menu.addEventListener("click", (e) => {
    const b = e.target instanceof Element ? e.target.closest("[data-ia]") : null;
    if (!b || b.disabled) return;
    close();
    void runIssueAction(b.dataset.ia, card, { anchor, detail: { ...detail, desk }, onDone });
  });
  (buttons()[0] ?? menu.querySelector("button"))?.focus();
}

/** Run one action by id: `wontdo`, `reopen` or `revert`. */
export async function runIssueAction(id, card, { anchor, detail, onDone } = {}) {
  if (!card || blockedToast()) return;
  const offered = issueActions(card, id === "revert" ? await deskFor(card, detail) : null).find(
    (a) => a.id === id,
  );
  if (!offered) return;
  if (!offered.enabled) {
    toast({
      text: `Couldn't ${offered.label.toLowerCase()}.`,
      detail: offered.why,
      tone: "parked",
    });
    return;
  }
  const at =
    anchor ??
    document.getElementById(`tile-${card.id}`) ??
    document.querySelector(".cv-h .acts") ??
    document.body;
  if (id === "wontdo") openWontDo(at, card, { onDone });
  else if (id === "reopen") await reopenIssue(card, { onDone });
  else if (id === "revert") openRevert(at, card, { onDone });
}

/* ---------- Won't do ---------- */

function openWontDo(anchor, card, { onDone } = {}) {
  const pop = document.createElement("form");
  pop.className = "park-pop ia-pop";
  pop.setAttribute("role", "dialog");
  pop.setAttribute("aria-label", C.wontDo);
  pop.noValidate = true;
  pop.innerHTML = `<label for="ia-reason">${esc(C.reasonLabel)}</label><input id="ia-reason" autocomplete="off" placeholder="${esc(C.reasonPlaceholder)}" aria-describedby="ia-reason-err" required><div class="err" id="ia-reason-err" role="alert" hidden>${esc(C.reasonMissing)}</div><div class="chips">${C.reasonPresets.map((p) => `<button type="button" class="chip" data-preset>${esc(p)}</button>`).join("")}</div><div class="acts"><button type="button" class="btn ghost" data-cancel>${esc(C.cancel)} ${kbd("Esc")}</button><button type="submit" class="btn">${esc(C.confirmWontDo)} ${kbd("↵")}</button></div>`;
  document.getElementById("overlay-root").append(pop);
  placeUnder(pop, anchor, { align: "right" });
  const input = pop.querySelector("input");
  const err = pop.querySelector(".err");
  const remove = pushOverlay({
    kind: "wontdo",
    modal: true,
    close: () => {
      pop.remove();
      anchor?.focus?.();
    },
    onKey: (e) => {
      if (trapFocus(pop, e)) return true;
      return e.key !== "Escape" && e.key !== "Tab";
    },
  });
  const close = () => {
    remove();
    pop.remove();
    anchor?.focus?.();
  };
  for (const b of pop.querySelectorAll("[data-preset]")) {
    b.addEventListener("click", () => {
      input.value = b.textContent;
      err.hidden = true;
      input.removeAttribute("aria-invalid");
      input.focus();
    });
  }
  pop.querySelector("[data-cancel]").addEventListener("click", close);
  pop.addEventListener("submit", async (e) => {
    e.preventDefault();
    const reason = input.value.trim();
    if (!reason) {
      err.hidden = false;
      input.setAttribute("aria-invalid", "true");
      input.focus();
      return;
    }
    const res = await postJSON(`/api/cards/${encodeURIComponent(card.id)}/reject`, { reason });
    if (!res.ok) {
      err.textContent = failure(res);
      err.hidden = false;
      input.focus();
      return;
    }
    close();
    // §2.4.23: Won't do offers Undo, which reopens the issue.
    toastWithUndo({ text: C.wontDoDone, tone: "info", iconName: "x" }, async () => {
      const back = await postJSON(`/api/cards/${encodeURIComponent(card.id)}/reopen`, {});
      refreshSoon();
      return back.ok
        ? { text: C.reopened }
        : { text: "Couldn't undo.", detail: failure(back), tone: "fail" };
    });
    refreshSoon();
    onDone?.(card, "rejected");
  });
  input.focus();
}

/* ---------- Reopen ---------- */

async function reopenIssue(card, { onDone } = {}) {
  const res = await postJSON(`/api/cards/${encodeURIComponent(card.id)}/reopen`, {});
  if (!res.ok) {
    toast({ text: "Couldn't reopen.", detail: failure(res), tone: "fail" });
    return;
  }
  // §2.4.23: Reopen offers Undo, which marks the issue Won't do again.
  toastWithUndo({ text: C.reopened, tone: "info", iconName: "refresh" }, async () => {
    const back = await postJSON(`/api/cards/${encodeURIComponent(card.id)}/reject`, {
      reason: C.undoReopenReason,
    });
    refreshSoon();
    return back.ok
      ? { text: C.wontDoAgain }
      : { text: "Couldn't undo.", detail: failure(back), tone: "fail" };
  });
  refreshSoon();
  onDone?.(card, "ready");
}

/* ---------- Revert ---------- */

function openRevert(anchor, card, { onDone } = {}) {
  const sha = card.display?.acceptedSha ?? "";
  const pop = document.createElement("div");
  pop.className = "park-pop ia-pop";
  pop.setAttribute("role", "alertdialog");
  pop.setAttribute("aria-modal", "true");
  pop.setAttribute("aria-labelledby", "ia-rv-h");
  pop.setAttribute("aria-describedby", "ia-rv-d");
  pop.innerHTML = `<label id="ia-rv-h">${esc(C.revertTitle)}</label><p class="sec" id="ia-rv-d">${esc(revertConfirmText(sha))}</p><div class="err" role="alert" hidden></div><div class="acts"><button type="button" class="btn ghost" data-cancel>${esc(C.cancel)} ${kbd("Esc")}</button><button type="button" class="btn primary" data-confirm-revert>${icon("undo", 14, "ic s14")}${esc(C.confirmRevert)}</button></div>`;
  document.getElementById("overlay-root").append(pop);
  placeUnder(pop, anchor, { align: "right" });
  const remove = pushOverlay({
    kind: "revert",
    modal: true,
    close: () => {
      pop.remove();
      anchor?.focus?.();
    },
    onKey: (e) => {
      if (trapFocus(pop, e)) return true;
      return e.key !== "Escape" && e.key !== "Tab" && e.key !== "Enter";
    },
  });
  const close = () => {
    remove();
    pop.remove();
    anchor?.focus?.();
  };
  pop.querySelector("[data-cancel]").addEventListener("click", close);
  const confirm = pop.querySelector("[data-confirm-revert]");
  confirm.addEventListener("click", async () => {
    confirm.disabled = true;
    const res = await postJSON(`/api/cards/${encodeURIComponent(card.id)}/revert`, {});
    if (!res.ok) {
      // DB-N21-4: the issue stays in Done; the server's reason names the files.
      close();
      toast({ text: C.revertFailed, detail: failure(res), tone: "fail" });
      return;
    }
    close();
    const revertSha = String(res.data?.sha ?? "");
    toast({
      text: C.reverted(revertSha),
      tone: "pass",
      iconName: "undo",
      duration: 8000,
      ...(revertSha ? { action: { label: "Copy", run: () => copyText(revertSha) } } : {}),
    });
    refreshSoon();
    onDone?.(card, "ready");
  });
  pop.querySelector("[data-cancel]").focus();
}
