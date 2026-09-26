// Small shared marks for team-practice fields: the priority glyph, labels,
// points and card chips (PM_DESIGN §3.1, §2.4). Every string is escaped.
import { esc, icon, tip } from "./dom.js";
import { PRIORITY_LABELS, formatPoints, priorityIcon, priorityOf } from "./lib/pm.js";
import { STATE_GLYPHS, columnLabel } from "./lib/vocabulary.js";
import { store } from "./store.js";

/** The fixed-slot priority glyph; the shape carries the meaning, not colour. */
export function prioMark(value, size = 12) {
  const p = priorityOf(value);
  return `<span class="prio p${p}" title="${esc(PRIORITY_LABELS[p])}" role="img" aria-label="${esc(PRIORITY_LABELS[p])}">${icon(priorityIcon(p), size, `ic s${size}`)}</span>`;
}

export function labelChips(labels = [], max = 2) {
  if (!labels?.length) return "";
  const shown = labels.slice(0, max).map((l) => `<span class="lbl-chip">${esc(l)}</span>`);
  if (labels.length > max) {
    shown.push(
      `<span class="lbl-more" title="${esc(labels.slice(max).join(", "))}">+${labels.length - max}</span>`,
    );
  }
  return shown.join("");
}

export function pointsText(n) {
  const t = formatPoints(n);
  return t === "None" ? "" : t;
}

const TONE_ICON = {
  running: () => '<span class="dot run" aria-hidden="true"></span>',
  pass: () => icon(STATE_GLYPHS.pass, 12, "ic s12 i-pass"),
  fail: () => icon(STATE_GLYPHS.fail, 12, "ic s12 i-fail"),
  parked: () => icon(STATE_GLYPHS.parked, 12, "ic s12 i-park"),
  blocked: () => icon(STATE_GLYPHS.blocked, 12, "ic s12 i-blk"),
};

function truncate(s, n) {
  const t = String(s ?? "");
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
}

/**
 * A card reference: state mark, short id, title. Unknown ids return null so
 * a model that invents an id shows nothing clickable (PM_DESIGN §2.4).
 */
export function cardChip(id, { max = 32 } = {}) {
  const card = store.card(id) ?? store.state.cards.find((c) => c.display?.shortId === id);
  if (!card) return null;
  const d = card.display ?? {};
  const tone = card.status === "done" ? "pass" : d.tone;
  const mark = TONE_ICON[tone]?.() ?? "";
  const title = d.title ?? card.title ?? card.id;
  return `<a class="cchip" href="#/card/${esc(encodeURIComponent(card.id))}" data-chip="${esc(card.id)}" ${tip(`${title} · ${columnLabel(card.status)}`)}>${mark}<span class="mono">${esc(d.shortId ?? card.id)}</span><span class="t">${esc(truncate(title, max))}</span></a>`;
}

export function diffContext() {
  const s = store.state;
  return { cycles: s.cycles, epics: s.epics, cards: s.cards, statusLabel: columnLabel };
}
