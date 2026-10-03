// Triage (FRONTEND_DESIGN §2.4.1, §2.5.6): Accept with a grace window, Send back
// with a note, Park with a reason. Every mutation carries the CSRF header.
import { errorCode, isAcceptanceTest, matchesAny } from "./diff_parse.js";
import { MOD, actionHeaders, announce, copyText, esc, icon, kbd, postJSON } from "./dom.js";
import { practiceTip } from "./learn.js";
import { ISSUE_COPY, lineCommentLabel, sendBackBody } from "./lib/issue.js";
import { ISSUE_ACTION_COPY } from "./lib/issue_actions.js";
import { THREAD_COPY, acceptChecklist, acceptVerdict, dismissalNote } from "./lib/review_desk.js";
import { gateLabel } from "./lib/vocabulary.js";
import { placeUnder, pushOverlay } from "./overlay.js";
import { acknowledgedIds, deskBlocker } from "./review_desk.js";
import { getSession } from "./session.js";
import { store } from "./store.js";
import { toast } from "./toast.js";
import { toastWithUndo } from "./undo.js";

const GRACE_MS = 3000;
let pending = null;
/** The server's latest refusal of an Accept, shown in the checklist where Accept is (REV-02). */
let refusal = null;

export const READ_ONLY_TEXT = "Read-only.";
export const READ_ONLY_DETAIL =
  "This server is read-only. Restart it with sekhemet serve to accept or request changes.";

/**
 * Whether Accept is allowed, and the plain reason when it is not. `detail`
 * (the card's loaded detail) adds what Accept itself refuses beyond the
 * gates: who may accept, unacknowledged findings, files not yet shown
 * (dashboard DB-N5-3, DB-N5-9).
 */
export function acceptState(card, evidence, detail) {
  const s = store.state;
  const ctx = {
    triage: s.meta?.triage !== false,
    offline: s.connection === "offline",
    ledger: s.verification,
  };
  // The desk's reason is only worked out when nothing earlier refuses.
  const first = acceptVerdict(ctx, card, evidence);
  return first.ok ? acceptVerdict(ctx, card, evidence, deskBlocker(card, detail)) : first;
}

export function mutationsBlocked() {
  const s = store.state;
  if (s.meta && s.meta.triage === false) return "readonly";
  if (s.connection === "offline") return "offline";
  return null;
}

function explainFailure(verb, res) {
  const msg = res.data?.error ?? "";
  if (res.status === 403)
    return { text: "This action must come from the dashboard.", detail: "Reload the page." };
  if (res.status === 501) return { text: READ_ONLY_TEXT, detail: READ_ONLY_DETAIL };
  if (res.status === 0)
    return { text: `Couldn't ${verb}. Sekhemet is not reachable.`, detail: msg };
  return { text: `Couldn't ${verb}.`, detail: msg || `The server returned ${res.status}.` };
}

/** Say why a mutation is not possible now (read-only or offline); true when blocked. */
export function blockedToast() {
  const b = mutationsBlocked();
  if (b === "readonly")
    toast({ text: READ_ONLY_TEXT, detail: READ_ONLY_DETAIL, tone: "parked", iconName: "lock" });
  else if (b === "offline")
    toast({
      text: "Offline.",
      detail: "Actions are disabled until Sekhemet is reachable.",
      tone: "parked",
    });
  return Boolean(b);
}

function refreshSoon() {
  window.dispatchEvent(new CustomEvent("sekhemet:refresh"));
}

/* ---------- Accept ---------- */

export function acceptPending(cardId) {
  return pending && (!cardId || pending.cardId === cardId);
}

/**
 * The accept's request. `keepalive` lets it finish after the page goes away,
 * so an Accept the toast announced is never dropped (FINDINGS REV-06).
 */
function sendAccept(cardId, body, keepalive = false) {
  const path = `/api/cards/${encodeURIComponent(cardId)}/accept`;
  if (!keepalive) return postJSON(path, body);
  return fetch(path, {
    method: "POST",
    keepalive: true,
    headers: actionHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(body),
  }).catch(() => undefined);
}

/**
 * Leaving the page or the view inside the grace window sends the Accept now
 * instead of dropping it (REV-06): a route change runs it at once, a closing
 * page hands it to the browser with `keepalive`.
 */
function flushAccept(leaving) {
  if (!pending) return;
  if (leaving) {
    clearTimeout(pending.timer);
    const p = pending;
    pending = null;
    void sendAccept(p.cardId, p.body, true);
    return;
  }
  clearTimeout(pending.timer);
  void pending.run();
}
window.addEventListener("pagehide", () => flushAccept(true));
window.addEventListener("hashchange", () => flushAccept(false));

/** The latest refusal of an Accept of this card, for the checklist (REV-02); "" when none. */
export function acceptRefusal(cardId) {
  return refusal && refusal.cardId === cardId ? refusal.text : "";
}

export function accept(card, evidence, { onMerged, onChange, detail } = {}) {
  if (pending || blockedToast()) return;
  const st = acceptState(card, evidence, detail);
  if (!st.ok) {
    // REV-02: the reasons are listed where Accept is; point at them, no toast far away.
    const list = document.getElementById("accept-why");
    if (list) {
      list.classList.remove("flash");
      void list.offsetWidth;
      list.classList.add("flash");
      announce(`Couldn't accept. ${st.reason}`);
    } else toast({ text: "Couldn't accept.", detail: st.reason, tone: "fail" });
    return;
  }
  refusal = null;
  const title = card.display?.title ?? card.title;
  const t = toast({
    text: `Accepting “${title}”`,
    detail: "Merges to main as one commit.",
    iconName: "merge",
    sticky: true,
    action: { label: "Undo", kbd: "Z", run: () => undoAccept() },
  });
  // review-git §2.4.3: the findings this person acknowledged go with the accept.
  const body = { acknowledgedFindings: acknowledgedIds(card, detail) };
  const run = async () => {
    const p = pending;
    pending = null;
    const res = await sendAccept(card.id, body);
    if (res.ok) {
      const sha = String(res.data?.sha ?? "");
      // REV-04: the merge in one line — never the server's path or a git
      // command; a Solo person learns their checkout is behind. The issue
      // page offers Revert (NEW-dashboard-21), so the toast says so (§2.5.10).
      const behind = res.data?.notice && getSession().mode !== "team";
      t.update({
        text: `Merged to main as ${sha.slice(0, 7)}`,
        detail: [
          behind ? "Your checkout of main is now behind it." : "",
          // Only a merge is reverted; a pull request opened on Accept is not merged yet.
          res.data?.status === "done" ? ISSUE_ACTION_COPY.canRevert : "",
        ]
          .filter(Boolean)
          .join(" "),
        tone: "pass",
        iconName: "merge",
        action: sha ? { label: "Copy", run: () => copyText(sha) } : undefined,
      });
      refreshSoon();
      onMerged?.(card);
    } else {
      const e = explainFailure("accept", res);
      refusal = { cardId: card.id, text: [e.text, e.detail].filter(Boolean).join(" ") };
      t.update({ ...e, tone: "fail", duration: 4000 });
    }
    p?.onChange?.();
  };
  pending = {
    cardId: card.id,
    toast: t,
    onChange,
    body,
    run,
    timer: setTimeout(run, GRACE_MS),
  };
  onChange?.();
}

/** `z` within the grace window: nothing is sent. */
export function undoAccept() {
  if (!pending) return false;
  clearTimeout(pending.timer);
  pending.toast.update({
    text: "Accept cancelled. Nothing was merged.",
    tone: "info",
    iconName: "undo",
    duration: 2500,
  });
  const cb = pending.onChange;
  pending = null;
  cb?.();
  return true;
}

/* ---------- Send back ---------- */

/** One-click notes derived from the failures, so the common case is not typed out. */
export function quickNotes(card, evidence, gatesConfig) {
  const notes = [];
  const scope = card?.scopeFiles?.[0];
  const protectedHit = (path) =>
    isAcceptanceTest(path, card?.acceptanceTests ?? []) ||
    matchesAny(path, gatesConfig?.protected ?? []);
  const seen = new Set();
  for (const f of evidence?.failures ?? []) {
    const code = errorCode(f.errorExcerpt);
    const file = f.location?.file;
    const key = `${f.gate ?? f.rung}|${code}|${file}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (file && protectedHit(file) && scope) {
      notes.push(
        `Fix ${code ?? gateLabel(f.rung)} in ${scope}; ${file} is a protected test and must pass unmodified.`,
      );
    } else if (file) {
      notes.push(
        `Fix ${code ?? `the ${gateLabel(f.rung)} failure`} at ${file}${f.location.line ? `:${f.location.line}` : ""}.`,
      );
    } else {
      notes.push(
        `Make ${gateLabel(f.rung)} pass: ${String(f.errorExcerpt).split("\n")[0].slice(0, 80)}`,
      );
    }
    if (notes.length >= 3) break;
  }
  if (evidence?.stopReason === "oscillation_detected")
    notes.push("Stop repeating the same step; change the file, then run the checks.");
  if (notes.length === 0 && scope) notes.push(`Keep the change inside ${scope}.`);
  return notes.slice(0, 4);
}

/** DB-N8-4: the line comments this send-back carries, listed above its buttons. */
function carriedHtml(comments) {
  if (!comments?.length) return "";
  return `<div class="carried" data-carried><span class="sec">${esc(ISSUE_COPY.lineComment.carried(comments.length))}</span><ul class="plain">${comments.map((c) => `<li><span class="mono">${esc(lineCommentLabel(c))}</span> ${esc(c.text)}</li>`).join("")}</ul></div>`;
}

export function composerHtml(notes, { comments = [] } = {}) {
  const chips = notes
    .map((n) => `<button type="button" class="chip" data-chip title="${esc(n)}">${esc(n)}</button>`)
    .join("");
  return `<form class="composer" data-composer aria-label="Request changes"><label class="lbl" for="sb-note">What should the Agent do differently?</label>${practiceTip("practice:request_changes", "Request changes")}<textarea id="sb-note" name="note" placeholder="Your note is the first thing the Agent reads on its next attempt." aria-describedby="sb-err"></textarea><div class="err" id="sb-err" role="alert" hidden>Add a note for the Agent. It's what it reads next.</div>${chips ? `<div class="chips"><span class="sec" style="font-size:var(--text-xs)">Quick notes</span>${chips}</div>` : ""}${carriedHtml(comments)}<div class="row"><label class="cbx"><input type="checkbox" checked disabled> Suggest as a playbook rule <small>· your note becomes a candidate rule in Playbook</small></label><span class="acts"><button type="button" class="btn ghost" data-cancel>Cancel ${kbd("Esc")}</button><button type="submit" class="btn">${icon("send-back")}Request changes ${kbd(`${MOD}↵`)}</button></span></div></form>`;
}

/**
 * Wire a rendered composer. Returns a close function. `onSent` runs after the
 * server accepted the note, `onClose` whenever the composer goes away.
 */
export function wireComposer(form, card, { onSent, onClose, comments }) {
  const area = form.querySelector("textarea");
  const err = form.querySelector(".err");
  let removeOverlay = () => {};
  // REV-07: while the note is open its own Send back is the one shown.
  document.body.classList.add("composing");
  const close = () => {
    removeOverlay();
    form.remove();
    document.body.classList.remove("composing");
    onClose?.();
  };
  removeOverlay = pushOverlay({
    kind: "composer",
    modal: false,
    close: () => close(),
    onKey: () => false,
  });
  for (const chip of form.querySelectorAll("[data-chip]")) {
    chip.addEventListener("click", () => {
      area.value = (area.value ? `${area.value}\n` : "") + chip.title;
      area.focus();
    });
  }
  form.querySelector("[data-cancel]").addEventListener("click", close);
  area.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      form.requestSubmit();
    }
  });
  area.addEventListener("input", () => {
    if (area.value.trim()) {
      err.hidden = true;
      area.removeAttribute("aria-invalid");
    }
  });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const note = area.value.trim();
    if (!note) {
      err.hidden = false;
      area.setAttribute("aria-invalid", "true");
      area.focus();
      return;
    }
    if (blockedToast()) return;
    // DB-N8-4: the line comments go with the reason, each an instruction to the next attempt.
    const res = await postJSON(
      `/api/cards/${encodeURIComponent(card.id)}/return`,
      sendBackBody(note, comments?.() ?? []),
    );
    if (res.ok) {
      removeOverlay();
      form.remove();
      document.body.classList.remove("composing");
      // The board's column (NAMING row 26): Ready is To do.
      toast({
        text: "Changes requested. The issue is back in To do with your note.",
        iconName: "send-back",
        tone: "info",
      });
      refreshSoon();
      onSent?.(card);
    } else {
      toast({ ...explainFailure("request changes", res), tone: "fail" });
    }
  });
  area.focus();
  return close;
}

/* ---------- Comment (teams item 25) ---------- */

/**
 * The *Comment* verdict's form: a review with no verdict, as GitHub's. Its
 * text opens a thread on the whole change; each line comment drafted in
 * Changes opens one on its line. Nothing moves on the board.
 */
export function commentFormHtml({ comments = [] } = {}) {
  const carried = comments.length
    ? `<div class="carried" data-carried><span class="sec">${esc(THREAD_COPY.carried(comments.length))}</span><ul class="plain">${comments.map((c) => `<li><span class="mono">${esc(lineCommentLabel(c))}</span> ${esc(c.text)}</li>`).join("")}</ul></div>`
    : "";
  return `<form class="composer" data-comment-form aria-label="${esc(THREAD_COPY.formLabel)}"><label class="lbl" for="rv-body">${esc(THREAD_COPY.formLabel)}</label><p class="sec">${esc(THREAD_COPY.formHint)}</p><textarea id="rv-body" name="body" placeholder="${esc(THREAD_COPY.placeholder)}" aria-describedby="rv-err"></textarea><div class="err" id="rv-err" role="alert" hidden>${esc(THREAD_COPY.empty)}</div>${carried}<div class="row"><span></span><span class="acts"><button type="button" class="btn ghost" data-cancel>Cancel ${kbd("Esc")}</button><button type="submit" class="btn">${icon("chat")}${esc(THREAD_COPY.send)} ${kbd(`${MOD}↵`)}</button></span></div></form>`;
}

/** Wire a rendered Comment form; `onSent` runs once the review is recorded. Returns a close function. */
export function wireCommentForm(form, card, { onSent, onClose, comments }) {
  const area = form.querySelector("textarea");
  const err = form.querySelector(".err");
  let removeOverlay = () => {};
  const close = () => {
    removeOverlay();
    form.remove();
    onClose?.();
  };
  removeOverlay = pushOverlay({ kind: "composer", modal: false, close, onKey: () => false });
  form.querySelector("[data-cancel]").addEventListener("click", close);
  area.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      form.requestSubmit();
    }
  });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const body = area.value.trim();
    const lines = (comments?.() ?? []).map((c) => ({ file: c.file, line: c.line, text: c.text }));
    if (!body && lines.length === 0) {
      err.hidden = false;
      area.setAttribute("aria-invalid", "true");
      area.focus();
      return;
    }
    if (blockedToast()) return;
    const res = await postJSON(`/api/cards/${encodeURIComponent(card.id)}/reviews`, {
      ...(body ? { body } : {}),
      ...(lines.length ? { comments: lines } : {}),
    });
    if (res.ok) {
      removeOverlay();
      form.remove();
      toast({
        text: THREAD_COPY.sent(res.data?.threads?.length ?? 0),
        iconName: "chat",
        tone: "info",
      });
      onSent?.(card);
      onClose?.();
    } else {
      toast({ ...explainFailure("comment", res), tone: "fail" });
    }
  });
  area.focus();
  return close;
}

/* ---------- Park ---------- */

const PRESETS = ["Waiting on me", "Needs a decision", "Not now"];

export function openPark(anchor, card, { onDone } = {}) {
  if (blockedToast()) return;
  const pop = document.createElement("form");
  pop.className = "park-pop";
  pop.setAttribute("role", "dialog");
  pop.setAttribute("aria-label", "Put on hold");
  pop.innerHTML = `<label for="park-reason">Why put it on hold? <span class="sec" style="font-weight:400">Optional</span></label><input id="park-reason" autocomplete="off" placeholder="Sets the issue aside. Nothing runs until you take it off hold."><div class="chips">${PRESETS.map((p) => `<button type="button" class="chip" data-preset>${esc(p)}</button>`).join("")}</div><div class="acts"><button type="button" class="btn ghost" data-cancel>Cancel ${kbd("Esc")}</button><button type="submit" class="btn">${icon("park")}Put on hold ${kbd("↵")}</button></div>`;
  document.getElementById("overlay-root").append(pop);
  placeUnder(pop, anchor);
  const input = pop.querySelector("input");
  const remove = pushOverlay({
    kind: "park",
    modal: true,
    close: () => {
      pop.remove();
      anchor?.focus?.();
    },
    onKey: (e) => e.key !== "Escape" && e.key !== "Tab",
  });
  const close = () => {
    remove();
    pop.remove();
    anchor?.focus?.();
  };
  for (const b of pop.querySelectorAll("[data-preset]")) {
    b.addEventListener("click", () => {
      input.value = b.textContent;
      input.focus();
    });
  }
  pop.querySelector("[data-cancel]").addEventListener("click", close);
  pop.addEventListener("submit", async (e) => {
    e.preventDefault();
    const reason = input.value.trim();
    const res = await postJSON(
      `/api/cards/${encodeURIComponent(card.id)}/park`,
      reason ? { reason } : {},
    );
    remove();
    pop.remove();
    if (res.ok) {
      // §2.4.23: a hold offers Undo, which takes the issue back off hold.
      toastWithUndo(
        {
          text: "On hold. Nothing runs until you take it off hold.",
          tone: "parked",
          iconName: "park",
        },
        async () => {
          const back = await postJSON(`/api/cards/${encodeURIComponent(card.id)}/unpark`, {});
          refreshSoon();
          return back.ok
            ? { text: "Taken off hold. It is back where it was." }
            : { ...explainFailure("take it off hold", back), tone: "fail" };
        },
      );
      refreshSoon();
      onDone?.(card);
    } else {
      toast({ ...explainFailure("put it on hold", res), tone: "fail" });
      anchor?.focus?.();
    }
  });
  input.focus();
}

/* ---------- The bar ---------- */

const CHECK_ICON = {
  conversation: "chat",
  refused: "x",
};

/**
 * Accept's conditions as a full-width checklist (REV-02, GitHub's merge box):
 * one line each, the server's refusal first, then the open conversations
 * (REV-03). `links` maps a line's kind to where it is met (§8 question 7):
 * `{ findings: "#/card/X/ai_review", files: "#/card/X/changes" }`. "" when
 * nothing keeps Accept disabled and no conversation is open.
 */
export function acceptChecklistHtml(card, evidence, detail, { links = {} } = {}) {
  if (!card || card.status === "done" || card.status === "rejected") return "";
  const s = store.state;
  if (s.meta && s.meta.triage === false) return "";
  const st = acceptState(card, evidence, detail);
  if (!evidence && s.connection !== "offline") return "";
  const items = acceptChecklist(st.ok ? "" : st.reason, detail?.desk, acceptRefusal(card.id));
  if (!items.length) return "";
  const rows = items
    .map((i) => {
      const href = links[i.kind];
      const name = href
        ? `<a href="${esc(href)}">${esc(i.text)}</a>`
        : `<span>${esc(i.text)}</span>`;
      return `<li class="${i.blocking ? "bl-block" : "bl-info"} bl-${esc(i.kind)}">${icon(CHECK_ICON[i.kind] ?? (i.blocking ? "alert" : "chat"), 14, "ic s14")}${name}</li>`;
    })
    .join("");
  const label = items.some((i) => i.blocking) ? "Before you can accept" : "Open conversations";
  return `<ul class="blockers plain" id="accept-why" aria-label="${esc(label)}">${rows}</ul>`;
}

/**
 * The triage toolbar. `opts.hint` adds the j/k hint; `opts.checklist`
 * (default on) puts Accept's conditions above the buttons; a page that
 * places the checklist itself passes false.
 */
export function triageBarHtml(card, evidence, { hint = true, detail, checklist = true } = {}) {
  const s = store.state;
  if (s.meta && s.meta.triage === false) {
    return `<div class="triage readonly" role="note">${icon("lock", 14, "ic s14")}<span><b>Read-only.</b> This server is read-only. Restart it with <span class="mono">sekhemet serve</span> to accept or request changes.</span></div>`;
  }
  // A merged or closed card has no verdict left to give.
  if (card?.status === "done" || card?.status === "rejected") {
    const sha = card.display?.acceptedSha;
    return card.status === "done"
      ? `<div class="triage settled" role="note">${icon("merge", 14, "ic s14")}<span>${sha ? `Merged to main as <span class="mono">${esc(sha.slice(0, 7))}</span>` : "Accepted"}</span></div>`
      : `<div class="triage settled" role="note"><span>Closed</span></div>`;
  }
  const offline = s.connection === "offline";
  // A disabled button's reason is adjacent text, never a hover title (DB-P12-3).
  const dis = offline ? ' disabled aria-describedby="accept-why"' : "";
  // DB-N9-17: Send back and Park need the review permission on the issue's project.
  const needs = `data-needs="review"${card?.projectId ? ` data-needs-project="${esc(card.projectId)}"` : ""}`;
  const st = acceptState(card, evidence, detail);
  const merging = acceptPending(card?.id);
  const acceptBtn = !evidence
    ? ""
    : `<button class="btn primary" type="button" data-accept${st.ok && !merging ? "" : ` disabled aria-describedby="accept-why"`}>${icon("merge")}${merging ? "Merging…" : "Accept"} ${kbd("A")}</button>`;
  const why = checklist ? acceptChecklistHtml(card, evidence, detail) : "";
  const back = evidence
    ? `<button class="btn" type="button" data-back ${needs}${dis}>${icon("send-back")}Request changes ${kbd("R")}</button>`
    : "";
  const park =
    card?.status === "parked"
      ? ""
      : `<button class="btn ghost" type="button" data-park ${needs}${dis}>${icon("park")}Put on hold ${kbd("P")}</button>`;
  // Teams item 25: in the Team setup, Comment — a review with no verdict — beside Accept and Send back.
  const comment =
    getSession().mode === "team" && evidence
      ? `<button class="btn ghost" type="button" data-comment${dis}>${icon("chat")}${esc(THREAD_COPY.comment)}</button>`
      : "";
  // TEAM-24: an accept new commits dismissed says so until a new decision.
  const note = dismissalNote(detail?.desk);
  const dismissed = note
    ? `<span class="why" role="note">${icon("alert", 14, "ic s14")}<b>${esc(note.text)}</b> ${esc(note.detail)}</span>`
    : "";
  const hints = hint
    ? `<span class="hint">${kbd("j")}${kbd("k")} next · ${kbd("?")} keys</span>`
    : "";
  return `<div class="triage" role="toolbar" aria-label="Triage">${why}${acceptBtn}${back}${comment}${park}${dismissed}${hints}</div>`;
}
