// Card tile (dashboard §2.4.4). Returns markup; every model string is escaped.
import { aiBadge, esc, icon, tip } from "./dom.js";
import { PRESENCE_COPY } from "./lib/live.js";
import { tileAiState } from "./lib/teammates.js";
import { tileModel } from "./lib/tiles.js";
import { GATE_STATE_LABELS, ISSUE_TYPE_LABELS, formatDuration } from "./lib/vocabulary.js";
import { prioMark } from "./marks.js";

const PIP_ICON = { pass: "check", fail: "x", skipped: "minus", running: "ring" };

/** The issue type as a tag (DEC-31: Story, Task, Bug, Spike, Epic), from the card's `display.type`. */
export function typeTag(type, extraClass = "kind") {
  const meta = ISSUE_TYPE_LABELS[type];
  if (!meta) return "";
  // The explanation is reachable without hovering (DB-P12-6): `tip` sets it as the description too.
  return `<span class="${extraClass}" ${tip(`${meta.label}: ${meta.tooltip.charAt(0).toLowerCase()}${meta.tooltip.slice(1)}`)}>${esc(meta.label)}</span>`;
}

/** "Types failed, Tests failed, Size passed" — the words behind the pips. */
export function gatesAria(gates) {
  if (gates.length > 0 && gates.every((g) => g.state === "pass")) {
    return `All ${gates.length} checks passed`;
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

/** Above this many checks a tile shows one summary pip and the count (BRD-02). */
export const PIP_SUMMARY_ABOVE = 6;

/** "11 of 13 checks passed, 2 skipped": the summary pip's words. */
export function gatesSummaryAria(gates) {
  const n = (state) => gates.filter((g) => g.state === state).length;
  const parts = [`${n("pass")} of ${gates.length} checks passed`];
  if (n("fail")) parts.push(`${n("fail")} failed`);
  if (n("running")) parts.push(`${n("running")} running`);
  if (n("skipped")) parts.push(`${n("skipped")} skipped`);
  if (n("not_run")) parts.push(`${n("not_run")} not run`);
  return parts.join(", ");
}

export function pips(gates) {
  if (!gates?.length) return "";
  if (gates.length > PIP_SUMMARY_ABOVE) {
    // One pip in the worst state, and passed / ran; the popover lists each check.
    const state = gates.some((g) => g.state === "fail")
      ? "fail"
      : gates.some((g) => g.state === "running")
        ? "running"
        : "pass";
    const passed = gates.filter((g) => g.state === "pass").length;
    return `<span class="pips sum" role="img" aria-label="${esc(gatesSummaryAria(gates))}" data-pips><span class="pip ${state}">${icon(PIP_ICON[state], 10)}</span><span class="pip-n tnum" aria-hidden="true">${passed}/${gates.length}</span></span>`;
  }
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

/**
 * Markup for one tile (dashboard §2.4.4), from the pure tile model
 * (`lib/tiles.js`, DB-P3-4…8). `opts.focused` sets the roving tab stop,
 * `opts.selected` the `x` selection, `opts.justNow` the 10-second `just now`.
 */
export function tileHtml(card, opts = {}) {
  const now = opts.now ?? Date.now();
  const t = tileModel(card, {
    now,
    epics: opts.epics ?? [],
    pmPaused: Boolean(opts.pmPaused),
    estimation: opts.estimation,
  });
  const d = card.display ?? {};
  const st = t.status;
  const tone =
    st && (st.tone === "running" || st.tone === "fail" || st.tone === "parked")
      ? ` t-${st.tone}`
      : "";
  const cls = `tile${tone}${d.mark === "blocked" ? " blocked" : ""}${card.status === "done" ? " done" : ""}`;
  const sel = opts.selected
    ? `<span class="sel" aria-hidden="true">${icon("check", 10)}</span>`
    : "";
  const just = opts.justNow ? '<span class="just">just now</span>' : "";

  // Row 1: type icon · issue key · points · owner · delegate chip.
  const type = `<span class="ttype" role="img" aria-label="${esc(t.type.label)}" ${tip(t.type.label)}>${icon(t.type.icon, 12, "ic s12")}</span>`;
  const key = `<span class="key" ${tip(card.id)}>${esc(t.key)}</span>`;
  const pts = t.points ? `<span class="pts tnum">${esc(t.points)}</span>` : "";
  const owner = t.owner
    ? `<span class="av" role="img" aria-label="${esc(`Assignee: ${t.owner.name}`)}" ${tip(`Assignee: ${t.owner.name}`)}>${esc(t.owner.initials)}</span><span class="av-name" aria-hidden="true">${esc(t.owner.name)}</span>`
    : "";
  // The delegate is a text chip; the Agent never has an avatar (DB-P3-5) and
  // carries the AI badge after its name, a person never (DB-N9-18).
  const delegate = t.delegate
    ? `<span class="dlg" ${tip(`Delegate: ${t.delegate.text}`)}>${esc(t.delegate.text)}${t.delegate.worker ? aiBadge() : ""}</span>`
    : "";
  // DB-N9-20: someone else dragging this card shows their avatar on it (in memory, never recorded).
  const moving = (opts.draggedBy ?? [])
    .map(
      (f) =>
        `<span class="av pres" role="img" aria-label="${esc(PRESENCE_COPY.dragging(f.name))}" ${tip(PRESENCE_COPY.dragging(f.name))}>${esc(f.initials)}</span>`,
    )
    .join("");
  const r1 = `<div class="r1">${sel}${type}${key}${just}<span class="r1-end">${moving}${pts}${owner}${delegate}</span></div>`;

  // Row 3: priority glyph (none for No priority) · epic chip · up to two labels.
  const prio = t.priority !== 0 && !opts.hidePriority ? prioMark(t.priority) : "";
  const epic = t.epic
    ? `<span class="epic-chip" ${tip(`Epic: ${t.epic.title}`)}>${icon("layers", 12, "ic s12")}<span>${esc(t.epic.title)}</span></span>`
    : "";
  const labels = t.labels.length
    ? `<span class="lbls">${t.labels.map((l) => `<span class="lbl-chip">${esc(l)}</span>`).join("")}${t.moreLabels.length ? `<span class="lbl-more" ${tip(t.moreLabels.join(", "))}>+${t.moreLabels.length}</span>` : ""}</span>`
    : "";
  const r3 = prio || epic || labels ? `<div class="r3">${prio}${epic}${labels}</div>` : "";

  const blkId = `blk-${card.id}`;
  const blocker = t.blocker
    ? `<div class="blk" id="${esc(blkId)}">${icon("link", 12, "ic s12")}<span>${esc(t.blocker.text)}</span></div>`
    : "";

  // Row 4: status badge (icon, colour and words) · gate pips · work item age.
  const stId = `st-${card.id}`;
  const gates = d.evidence?.gates ?? [];
  let r4s = "";
  if (st || t.age) {
    const mark = st ? (t.pips ? pips(gates) : (MARK[st.mark]?.() ?? "")) : "";
    const waitIcon = t.pips && st?.mark === "wait" ? MARK.wait() : "";
    const status = st
      ? `<span class="st${st.old ? " old" : ""}" id="${esc(stId)}">${waitIcon}<span>${esc(st.text)}</span></span>`
      : "";
    const age = t.age
      ? `<span class="age tnum" ${tip(`Work item age ${t.age}`)}>${esc(t.age)}</span>`
      : "";
    r4s = `<div class="r4s">${mark}${status}${age}</div>`;
  }
  // Teams item 19: the Agent's state on this issue, as the harness set it
  // (`GET /api/agent/states`), with the AI badge; its sentence is the description.
  const ai = tileAiState(opts.ai);
  const aiId = `ai-${card.id}`;
  const aiRow = ai
    ? `<div class="tile-ai" id="${esc(aiId)}" ${tip(ai.sentence)}><b>${esc(ai.name)}</b>${aiBadge()}<span class="tile-ai-st">${esc(ai.label)}</span></div>`
    : "";

  // No step, token or time budget on the card face (DEC-31, DB-N7-3): the issue shows them.
  const excerpt = card.spec
    ? `<p class="spec comfy">${esc(String(card.spec).split("\n")[0].slice(0, 160))}</p>`
    : "";
  const described = [t.blocker ? blkId : "", st ? stId : "", ai ? aiId : ""]
    .filter(Boolean)
    .join(" ");
  // A11Y-05: a short name — type, key, title, owner and delegate — never the
  // whole face; the status, a blocker and the Agent's state are its description.
  const name = [
    `${t.type.label} ${t.key}: ${t.title}`,
    t.owner ? `owner ${t.owner.name}` : "",
    t.delegate ? `delegate ${t.delegate.text}` : "",
  ]
    .filter(Boolean)
    .join(", ");
  return `<li class="${cls}" role="option" id="tile-${esc(card.id)}" data-id="${esc(card.id)}" aria-label="${esc(name)}" aria-selected="${opts.selected ? "true" : "false"}"${described ? ` aria-describedby="${esc(described)}"` : ""}>${r1}<p class="title">${esc(t.title)}</p>${r3}${blocker}${r4s}${aiRow}${excerpt}</li>`;
}
