import { aiBadge, esc, icon } from "./dom.js";
import { editField } from "./fields.js";
// The issue page's properties rail (dashboard §2.6, NEW-dashboard-19,
// DB-N19-1, -2; FINDINGS ISS-01): the approved Issue mockup's label/value
// list — Assignee, Delegate, Reviewers, Reporter, Type, Priority, Points,
// Sprint, Epic, Labels, Due, Blocked by, Blocks, Branch and Watchers. Each
// value the list edits opens the list's own editor (`fields.js`), so a rail
// edit records the same event and offers the same Undo; a field the viewer's
// level cannot change is read-only with the level note beside it. 288 px on
// the right from 1280 px; a *Properties* disclosure under the header below.
import { practiceTip } from "./learn.js";
import { noteFor } from "./level_gate.js";
import { issueProperties } from "./lib/issue.js";
import { fieldPermission } from "./lib/team_admin.js";
import { actorLabel } from "./lib/vocabulary.js";
import { getSession } from "./session.js";
import { store } from "./store.js";

/** §2.9.5 (NEW-dashboard-13): the rail rows a practice lesson sits beside, with Tips on. */
const PRACTICE_ROWS = { Priority: "practice:priority", "Blocked by": "practice:blocked" };
const PRACTICE_TERMS = { Priority: "Priority", "Blocked by": "Blocked work" };

const WIDE = "(min-width: 1280px)";

/** Who filed the issue, from its creation on the ledger. */
function reporterOf(events) {
  const created = (events ?? []).find((e) => e.type === "card/created");
  if (!created) return undefined;
  return created.principalName?.trim() || actorLabel(created.actor);
}

/** The suggested accepters (CODEOWNERS), as the file names them. */
function reviewersOf(desk) {
  const s = desk?.suggestedAccepters;
  if (!s) return [];
  const members = s.principals?.length ?? 0;
  return [
    ...(s.unmapped ?? []),
    ...(members ? [`${members} ${members === 1 ? "member" : "members"}`] : []),
  ];
}

/**
 * `notes` keeps the level notes already written in this draw: a note shared
 * by several read-only fields is written once, under the first, and the rest
 * are described by it (DB-N9-17, FINDINGS ISS-09).
 */
function valueHtml(row, card, notes) {
  if (row.links) {
    if (!row.links.length) return `<span class="none">${esc(row.text)}</span>`;
    return row.links
      .map(
        (l) =>
          `<a class="mono" href="#/card/${encodeURIComponent(l.id)}">${esc(l.text)}</a> <span class="sec">${esc(l.column)}</span>`,
      )
      .join("<br>");
  }
  const none = /^(None|None yet|Unassigned|No priority|No one yet|Unknown)$/.test(row.text);
  const text = `${row.ai ? `${esc(row.text)} ${aiBadge()}` : esc(row.text)}${row.state ? ` <span class="sec">${esc(row.state)}</span>` : ""}`;
  const body = `<span class="${row.mono ? "mono " : ""}${none ? "none" : ""}">${text}</span>`;
  if (row.copy) {
    return `${body}<button class="icon-btn sm" type="button" data-copy="${esc(row.copy)}" aria-label="Copy branch name">${icon("copy", 14, "ic s14")}</button>`;
  }
  if (!row.field) return body;
  const note = noteFor(fieldPermission(row.field), card.projectId, card.projectName);
  if (note) {
    const seen = notes.get(note);
    if (seen) return body.replace("<span ", `<span aria-describedby="${seen}" `);
    const id = `iprop-note-${notes.size + 1}`;
    notes.set(note, id);
    return `${body}<span class="iprop-note" id="${id}">${esc(note)}</span>`;
  }
  return `<button class="iprop-edit" type="button" data-prop="${esc(row.field)}" aria-label="${esc(`${row.label}: ${row.text}. Change`)}">${body}</button>`;
}

/**
 * Mount the rail into `host` (a `<details>`). `ctx` gives the card, its
 * detail, its events and the watchers; `draw()` redraws it.
 */
export function mountProperties(host, ctx) {
  const list = host.querySelector("[data-props]");
  let last = "";
  const media = window.matchMedia(WIDE);
  const fit = () => {
    // Wide: always open, the summary hidden by CSS; narrow: a closed disclosure.
    host.open = media.matches;
  };
  fit();
  media.addEventListener("change", fit);

  const draw = () => {
    const card = ctx.card();
    if (!card) {
      list.innerHTML = "";
      last = "";
      return;
    }
    const detail = ctx.detail();
    const s = store.state;
    const agent = (detail?.ai ?? []).find((a) => a.who === "agent");
    const team = getSession().mode === "team";
    const rows = issueProperties(card, {
      cycles: s.cycles,
      epics: s.epics,
      cards: s.cards,
      estimation: s.estimation,
      reporter: reporterOf(ctx.events()),
      branch: detail?.branch,
      reviewers: reviewersOf(detail?.desk),
      ...(team ? { watchers: ctx.watchers() } : {}),
      ...(agent?.state ? { agentState: agent.state } : {}),
    });
    const notes = new Map();
    const next = `<dl class="iprops">${rows
      .map(
        (r) =>
          `<div class="iprop" data-prop-row="${esc(r.label)}"><dt>${esc(r.label)}${PRACTICE_ROWS[r.label] ? practiceTip(PRACTICE_ROWS[r.label], PRACTICE_TERMS[r.label]) : ""}</dt><dd>${valueHtml(r, card, notes)}</dd></div>`,
      )
      .join("")}</dl>`;
    if (next === last) return;
    const focused = document.activeElement?.dataset?.prop;
    list.innerHTML = next;
    last = next;
    if (focused) list.querySelector(`[data-prop="${focused}"]`)?.focus();
  };

  host.addEventListener("click", (e) => {
    const b = e.target instanceof Element ? e.target.closest("[data-prop]") : null;
    if (!b) return;
    const card = ctx.card();
    if (card) editField(b.dataset.prop, [card.id], b);
  });

  draw();
  return { draw, destroy: () => media.removeEventListener("change", fit) };
}
