// Triage (FRONTEND_DESIGN §2.4.1, §2.5.6): Accept with a grace window, Send back
// with a note, Park with a reason. Every mutation carries the CSRF header.
import { errorCode, isAcceptanceTest, matchesAny } from "./diff_parse.js";
import { MOD, copyText, esc, icon, kbd, postJSON } from "./dom.js";
import { gateLabel } from "./lib/vocabulary.js";
import { placeUnder, pushOverlay } from "./overlay.js";
import { ledgerAltered, store } from "./store.js";
import { toast } from "./toast.js";

const GRACE_MS = 3000;
let pending = null;

export const READ_ONLY_TEXT = "Read-only.";
export const READ_ONLY_DETAIL =
  "This server was started without triage. Restart with sekhemet serve to accept or send back.";

/** Whether Accept is allowed, and the plain reason when it is not. */
export function acceptState(card, evidence) {
  const s = store.state;
  if (s.meta && s.meta.triage === false) return { ok: false, reason: "Read-only." };
  if (s.connection === "offline") return { ok: false, reason: "Offline." };
  if (ledgerAltered(s)) {
    return {
      ok: false,
      reason: `Ledger altered at entry #${s.verification.corruptedSeq}. Inspect before accepting.`,
    };
  }
  if (!evidence) return { ok: false, reason: "Accept needs evidence from a run." };
  if (!evidence.passed) return { ok: false, reason: "Accept needs every gate passing." };
  if (!card || card.status !== "review")
    return { ok: false, reason: "Only cards in Review can be accepted." };
  return { ok: true, reason: "" };
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

function blockedToast() {
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

export function accept(card, evidence, { onMerged, onChange } = {}) {
  if (pending || blockedToast()) return;
  const st = acceptState(card, evidence);
  if (!st.ok) {
    toast({ text: "Couldn't accept.", detail: st.reason, tone: "fail" });
    return;
  }
  const title = card.display?.title ?? card.title;
  const t = toast({
    text: `Accepting “${title}”`,
    detail: "Merges to main as one commit.",
    iconName: "merge",
    sticky: true,
    action: { label: "Undo", kbd: "Z", run: () => undoAccept() },
  });
  pending = {
    cardId: card.id,
    toast: t,
    onChange,
    timer: setTimeout(async () => {
      const p = pending;
      pending = null;
      const res = await postJSON(`/api/cards/${encodeURIComponent(card.id)}/accept`);
      if (res.ok) {
        const sha = String(res.data?.sha ?? "");
        t.update({
          text: `Merged to main as ${sha.slice(0, 7)}`,
          ...(res.data?.notice ? { detail: String(res.data.notice) } : {}),
          tone: "pass",
          iconName: "merge",
          action: sha ? { label: "Copy", run: () => copyText(sha) } : undefined,
        });
        refreshSoon();
        onMerged?.(card);
      } else {
        const e = explainFailure("accept", res);
        t.update({ ...e, tone: "fail", sticky: true });
      }
      p?.onChange?.();
    }, GRACE_MS),
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
    notes.push("Stop repeating the same step; change the file, then run the gates.");
  if (notes.length === 0 && scope) notes.push(`Keep the change inside ${scope}.`);
  return notes.slice(0, 4);
}

export function composerHtml(notes) {
  const chips = notes
    .map((n) => `<button type="button" class="chip" data-chip title="${esc(n)}">${esc(n)}</button>`)
    .join("");
  return `<form class="composer" data-composer aria-label="Send back"><label class="lbl" for="sb-note">What should the Worker do differently?</label><textarea id="sb-note" name="note" placeholder="Your note is the first thing the Worker reads on its next attempt." aria-describedby="sb-err"></textarea><div class="err" id="sb-err" role="alert" hidden>Add a note for the Worker. It's what they'll read next.</div>${chips ? `<div class="chips"><span class="sec" style="font-size:var(--text-xs)">Quick notes</span>${chips}</div>` : ""}<div class="row"><label class="cbx"><input type="checkbox" checked disabled> Suggest as a playbook rule <small>· your note becomes a candidate rule in Playbook</small></label><span class="acts"><button type="button" class="btn ghost" data-cancel>Cancel ${kbd("Esc")}</button><button type="submit" class="btn">${icon("send-back")}Send back ${kbd(`${MOD}↵`)}</button></span></div></form>`;
}

/**
 * Wire a rendered composer. Returns a close function. `onSent` runs after the
 * server accepted the note, `onClose` whenever the composer goes away.
 */
export function wireComposer(form, card, { onSent, onClose }) {
  const area = form.querySelector("textarea");
  const err = form.querySelector(".err");
  let removeOverlay = () => {};
  const close = () => {
    removeOverlay();
    form.remove();
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
    const res = await postJSON(`/api/cards/${encodeURIComponent(card.id)}/return`, {
      reason: note,
    });
    if (res.ok) {
      removeOverlay();
      form.remove();
      toast({ text: "Sent back to Ready with your note", iconName: "send-back", tone: "info" });
      refreshSoon();
      onSent?.(card);
    } else {
      toast({ ...explainFailure("send back", res), tone: "fail" });
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
  pop.setAttribute("aria-label", "Park");
  pop.innerHTML = `<label for="park-reason">Why park it? <span class="sec" style="font-weight:400">Optional</span></label><input id="park-reason" autocomplete="off" placeholder="Sets the card aside. Nothing runs until you unpark it."><div class="chips">${PRESETS.map((p) => `<button type="button" class="chip" data-preset>${esc(p)}</button>`).join("")}</div><div class="acts"><button type="button" class="btn ghost" data-cancel>Cancel ${kbd("Esc")}</button><button type="submit" class="btn">${icon("park")}Park ${kbd("↵")}</button></div>`;
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
      toast({
        text: "Parked. Nothing runs until you unpark it.",
        tone: "parked",
        iconName: "park",
      });
      refreshSoon();
      onDone?.(card);
    } else {
      toast({ ...explainFailure("park", res), tone: "fail" });
      anchor?.focus?.();
    }
  });
  input.focus();
}

/* ---------- The bar ---------- */

/**
 * The triage toolbar. `opts.hint` adds the j/k hint; `opts.failing` swaps
 * Accept out for failing cards (Retry with planner arrives with POST /run).
 */
export function triageBarHtml(card, evidence, { hint = true } = {}) {
  const s = store.state;
  if (s.meta && s.meta.triage === false) {
    return `<div class="triage readonly" role="note">${icon("lock", 14, "ic s14")}<span><b>Read-only.</b> This server was started without triage. Restart with <span class="mono">sekhemet serve</span> to accept or send back.</span></div>`;
  }
  // A merged or closed card has no verdict left to give.
  if (card?.status === "done" || card?.status === "rejected") {
    const sha = card.display?.acceptedSha;
    return card.status === "done"
      ? `<div class="triage settled" role="note">${icon("merge", 14, "ic s14")}<span>${sha ? `Merged to main as <span class="mono">${esc(sha.slice(0, 7))}</span>` : "Accepted"}</span></div>`
      : `<div class="triage settled" role="note"><span>Closed</span></div>`;
  }
  const offline = s.connection === "offline";
  const dis = offline ? ' disabled title="Offline"' : "";
  const st = acceptState(card, evidence);
  const merging = acceptPending(card?.id);
  const acceptBtn = !evidence
    ? ""
    : `<button class="btn primary" type="button" data-accept${st.ok && !merging ? "" : ` disabled aria-describedby="accept-why"`}>${icon("merge")}${merging ? "Merging…" : "Accept"} ${kbd("A")}</button>`;
  const why =
    !st.ok && evidence ? `<span class="why" id="accept-why">${esc(st.reason)}</span>` : "";
  const back = evidence
    ? `<button class="btn" type="button" data-back${dis}>${icon("send-back")}Send back ${kbd("R")}</button>`
    : "";
  const park =
    card?.status === "parked"
      ? ""
      : `<button class="btn ghost" type="button" data-park${dis}>${icon("park")}Park ${kbd("P")}</button>`;
  const hints = hint
    ? `<span class="hint">${kbd("j")}${kbd("k")} next · ${kbd("?")} keys</span>`
    : "";
  return `<div class="triage" role="toolbar" aria-label="Triage">${acceptBtn}${back}${park}${why}${hints}</div>`;
}
