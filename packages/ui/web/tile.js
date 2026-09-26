// Card tile (FRONTEND_DESIGN §2.5.1). Returns markup; every model string is escaped.
import { esc, icon, tip } from "./dom.js";
import { GATE_STATE_LABELS, KIND_LABELS, formatDuration, formatWait } from "./lib/vocabulary.js";
import { labelChips, pointsText, prioMark } from "./marks.js";

const PIP_ICON = { pass: "check", fail: "x", skipped: "minus", running: "ring" };

export function kindTags(kinds = [], extraClass = "kind") {
  return kinds
    .map((k) => {
      const meta = KIND_LABELS[k];
      if (!meta) return "";
      return `<span class="${extraClass}" title="${esc(`${meta.label}: ${meta.tooltip.charAt(0).toLowerCase()}${meta.tooltip.slice(1)}`)}">${esc(meta.label)}</span>`;
    })
    .join("");
}

/** "Types failed, Tests failed, Size passed" — the words behind the pips. */
export function gatesAria(gates) {
  if (gates.length > 0 && gates.every((g) => g.state === "pass")) {
    return `All ${gates.length} gates passed`;
  }
  return gates.map((g) => `${g.label} ${GATE_STATE_LABELS[g.state].toLowerCase()}`).join(", ");
}

export function gateDetail(g) {
  const parts = [g.label, GATE_STATE_LABELS[g.state].toLowerCase()];
  if (g.failures) parts.push(`${g.failures} ${g.failures === 1 ? "error" : "errors"}`);
  if (g.detail) parts.push(g.detail);
  else if (g.durationMs !== undefined) parts.push(formatDuration(g.durationMs));
  return parts.join(" · ");
}

export function pips(gates) {
  if (!gates?.length) return "";
  const items = gates
    .map((g) => {
      const glyph = PIP_ICON[g.state];
      return `<span class="pip ${g.state}" data-gate="${esc(g.id)}">${glyph ? icon(glyph, 10) : ""}</span>`;
    })
    .join("");
  return `<span class="pips" role="img" aria-label="${esc(gatesAria(gates))}" data-pips>${items}</span>`;
}

const MARK = {
  blocked: () => icon("link", 12, "ic s12 i-blk"),
  planning: () => icon("pencil", 12, "ic s12"),
  running: () => '<span class="dot run" aria-hidden="true"></span>',
  parked: () => icon("pause", 12, "ic s12 i-park"),
  done: () => icon("check-circle", 12, "ic s12"),
  wait: () => icon("clock", 12, "ic s12"),
  fail: () => icon("x", 12, "ic s12 i-fail"),
};

/** The tile's live wait text, recomputed from enteredColumnAt so it counts up. */
function statusText(card, now, opts = {}) {
  const d = card.display;
  // PM_DESIGN §2.5: the Worker waits at a step boundary while Seshat replies.
  if (opts.pmPaused && card.status === "in_progress") {
    return `Paused for Seshat${card.stepsUsed ? ` · step ${card.stepsUsed} of ${card.stepBudget}` : ""}`;
  }
  if (card.status === "review" && d.enteredColumnAt) {
    return `Waiting ${formatWait(now - Date.parse(d.enteredColumnAt))}`;
  }
  return d.statusLine;
}

function kilo(n) {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(Math.round(n));
}

/**
 * Token and seconds bars (§2.5.1, comfortable density): shown once the card
 * has used something against a budget it has.
 */
export function usageBars(card) {
  const rows = [];
  const bar = (used, budget, text) => {
    const ratio = budget > 0 ? Math.min(1, used / budget) : 0;
    const cls =
      used >= budget
        ? " over"
        : ratio >= 0.75
          ? " warn"
          : card.status === "in_progress"
            ? " run"
            : "";
    rows.push(
      `<div class="r5 comfy"><span class="budget${cls}"><i style="width:${Math.round(ratio * 100)}%"></i></span><span class="tnum">${esc(text)}</span></div>`,
    );
  };
  if (card.tokenBudget && card.tokensUsed)
    bar(
      card.tokensUsed,
      card.tokenBudget,
      `${kilo(card.tokensUsed)} of ${kilo(card.tokenBudget)} tokens`,
    );
  if (card.secondsBudget && card.secondsUsed)
    bar(
      card.secondsUsed,
      card.secondsBudget,
      `${formatDuration(card.secondsUsed * 1000)} of ${formatDuration(card.secondsBudget * 1000)}`,
    );
  return rows.join("");
}

/** The planner's 1-10 difficulty, as a diamond and the number (comfortable density). */
export function difficultyMark(card) {
  if (typeof card.difficulty !== "number") return "";
  return `<span class="diff comfy tnum" title="${esc(`Difficulty ${card.difficulty} of 10`)}"><i aria-hidden="true"></i>${card.difficulty}</span>`;
}

/**
 * Markup for one tile. `opts.focused` sets the roving tab stop, `opts.selected`
 * the `x` selection, `opts.justNow` the 10-second `just now` meta.
 */
export function tileHtml(card, opts = {}) {
  const d = card.display ?? {
    title: card.title,
    kinds: [],
    shortId: card.id,
    statusLine: "",
    tone: "neutral",
    mark: "none",
  };
  const now = opts.now ?? Date.now();
  const tone =
    d.tone === "running" || d.tone === "fail" || d.tone === "parked" ? ` t-${d.tone}` : "";
  const cls = `tile${tone}${d.mark === "blocked" ? " blocked" : ""}${card.status === "done" ? " done" : ""}`;
  const waits = d.waitsOn ?? [];
  const dep = waits.length
    ? `<span class="dep" title="${esc(`Waits on ${waits.map((w) => w.title).join(", ")}`)}">${icon("link", 12, "ic s12")}${waits.length}</span>`
    : "";
  const sel = opts.selected
    ? `<span class="sel" aria-hidden="true">${icon("check", 10)}</span>`
    : "";
  const just = opts.justNow ? '<span class="just">just now</span>' : "";
  const gates = d.evidence?.gates ?? [];
  const showPips = (d.mark === "pips" || d.mark === "wait") && gates.length > 0;
  const mark = showPips ? pips(gates) : (MARK[d.mark]?.() ?? "");
  const text = statusText(card, now, opts);
  const old =
    card.status === "review" &&
    d.enteredColumnAt &&
    now - Date.parse(d.enteredColumnAt) > 2 * 3600_000;
  const waitIcon = showPips && d.mark === "wait" ? MARK.wait() : "";
  const stId = `st-${card.id}`;

  let r4 = "";
  const usage = card.status !== "done" ? usageBars(card) : "";
  const excerpt = card.spec
    ? `<p class="spec comfy">${esc(String(card.spec).split("\n")[0].slice(0, 160))}</p>`
    : "";
  if (d.budgetText && card.status !== "done" && card.status !== "review") {
    const ratio = d.budgetRatio ?? 0;
    const bcls =
      ratio >= 1
        ? " over"
        : card.status === "in_progress"
          ? " run"
          : ratio >= 0.75 || card.status === "parked"
            ? " warn"
            : "";
    r4 = `<div class="r4"><span class="budget${bcls}"><i style="width:${Math.round(ratio * 100)}%"></i></span><span class="tnum">${esc(d.budgetText)}</span></div>`;
  }

  // PM_DESIGN §3.1: priority in a fixed slot, then kind, labels, points, id.
  const prio = opts.hidePriority ? "" : prioMark(card.priority);
  const pts = pointsText(card.estimate);
  const labels = labelChips(card.labels, d.kinds?.length > 1 ? 1 : 2);
  return `<li class="${cls}" role="option" id="tile-${esc(card.id)}" data-id="${esc(card.id)}" aria-selected="${opts.selected ? "true" : "false"}" aria-describedby="${esc(stId)}"><div class="r1">${sel}${prio}${kindTags(d.kinds)}${labels ? `<span class="lbls">${labels}</span>` : ""}<span class="id" ${tip(card.id)}>${just}${difficultyMark(card)}${dep}${pts ? `<span class="pts tnum">${esc(pts)}</span>` : ""}${esc(d.shortId)}</span></div><p class="title">${esc(d.title)}</p><div class="r3">${mark}<span class="st${old ? " old" : ""}" id="${esc(stId)}" title="${esc(text)}">${waitIcon}<span>${esc(text)}</span></span></div>${r4}${usage}${excerpt}</li>`;
}
