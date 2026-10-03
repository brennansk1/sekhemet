// The sprint lifecycle (dashboard §2.4 item 20, NEW-dashboard-11): Start
// sprint, the Complete sprint sheet with its carry-over, the sprint report and
// New sprint. Every rule and word is `lib/sprints.js`'s; the records and the
// report are the server's (planner-pm §2.7 item 7a). Opened from the sprint
// header, the palette and the Sprint field.
import { esc, getJSON, icon, postJSON } from "./dom.js";
import { practiceTip } from "./learn.js";
import { formatShortDate } from "./lib/pm.js";
import {
  SPRINT_COPY as C,
  nextSprintDefaults,
  noSprintOptions,
  sprintLifecycle,
  sprintReportRows,
} from "./lib/sprints.js";
import { pushOverlay, trapFocus } from "./overlay.js";
import { openPicker } from "./picker.js";
import { askMerit } from "./pm_panel.js";
import { store } from "./store.js";
import { toast } from "./toast.js";

let open = null;

function refresh() {
  window.dispatchEvent(new CustomEvent("sekhemet:refresh"));
}

function errorOf(r) {
  if (r.status === 0) return "Sekhemet is not reachable.";
  return r.data?.error ?? `The server returned ${r.status}.`;
}

/** The current project's sprints, as the board holds them. */
function sprints() {
  return store.state.cycles ?? [];
}

function titleOf(id) {
  const c = store.state.cards.find((x) => x.id === id);
  return c?.display?.title ?? c?.title ?? id;
}

export function closeSprintSheet() {
  if (!open) return;
  const { node, remove, invoker } = open;
  open = null;
  remove();
  node.remove();
  invoker?.focus?.({ preventScroll: true });
}

/** §2.9.5 (NEW-dashboard-13): the practice each sheet is, taught beside its heading with Tips on. */
const SHEET_LESSON = {
  new: ["practice:sprint_planning", "Sprint planning"],
  complete: ["practice:retrospective", "Retrospective"],
  report: ["practice:retrospective", "Retrospective"],
};

/** A modal sheet, the cheat sheet's pattern: Esc closes, Tab stays inside. */
function sheet(kind, heading, body) {
  closeSprintSheet();
  const node = document.createElement("div");
  node.className = "scrim";
  const lesson = SHEET_LESSON[kind] ? practiceTip(...SHEET_LESSON[kind]) : "";
  node.innerHTML = `<div class="dialog sprint-sheet" role="dialog" aria-modal="true" aria-labelledby="sprint-h" data-sprint-sheet="${esc(kind)}"><header><h2 id="sprint-h">${esc(heading)}</h2>${lesson}<button class="icon-btn" type="button" data-close aria-label="Close (Esc)">${icon("x")}</button></header><div class="sprint-body">${body}</div></div>`;
  document.getElementById("overlay-root").append(node);
  const invoker = document.activeElement;
  const remove = pushOverlay({
    kind: "sprint",
    modal: true,
    close: () => closeSprintSheet(),
    onKey: (e) => trapFocus(node, e),
  });
  node.addEventListener("click", (e) => {
    if (e.target === node || (e.target instanceof Element && e.target.closest("[data-close]")))
      closeSprintSheet();
  });
  open = { node, remove, invoker };
  return node;
}

function issueList(cards, label) {
  if (!cards.length) return "";
  return `<section class="sprint-list"><h3>${esc(label)} <span class="tnum">${cards.length}</span></h3><ul>${cards
    .map((c) => `<li>${esc(c.display?.title ?? c.title ?? c.id)}</li>`)
    .join("")}</ul></section>`;
}

/** DB-N11-1: start a planned sprint; a refusal names the active sprint. */
export async function startSprint(cycle) {
  const r = await postJSON(`/api/cycles/${encodeURIComponent(cycle.id)}/start`, {});
  if (!r.ok) {
    toast({ tone: "fail", text: `Couldn't start ${cycle.name}.`, detail: errorOf(r) });
    return false;
  }
  toast({ tone: "pass", text: `${C.started}: ${cycle.name}` });
  refresh();
  return true;
}

/**
 * DB-N11-2: the Complete sheet. It lists the done and not-done issues, asks
 * where the not-done ones go, and completes the sprint as one recorded group;
 * the report follows in the same sheet (DB-N11-3).
 */
export function openCompleteSheet(cycle) {
  const v = sprintLifecycle(cycle, sprints(), store.state.cards);
  const first = v.carryOptions.find((o) => !o.disabled)?.value ?? "backlog";
  const choices = v.open.length
    ? `<fieldset class="sprint-carry"><legend>${esc(C.carryHeading)}</legend>${v.carryOptions
        .map(
          (o) =>
            `<label class="${o.disabled ? "off" : ""}"><input type="radio" name="carry" value="${esc(o.value)}"${o.value === first ? " checked" : ""}${o.disabled ? " disabled" : ""}><span><b>${esc(o.label)}</b><small>${esc(o.detail)}</small></span></label>`,
        )
        .join("")}</fieldset>`
    : `<p class="sprint-note">Every issue in ${esc(cycle.name)} is done.</p>`;
  const body = `<p class="sprint-sub tnum">${esc(formatShortDate(cycle.startsOn))} – ${esc(formatShortDate(cycle.endsOn))} · ${v.done.length} done · ${v.open.length} not done</p>
${issueList(v.done, C.done)}${issueList(v.open, C.open)}${issueList(v.wontDo, C.wontDo)}
<form data-complete>${choices}<div class="sprint-acts"><button class="btn" type="button" data-close>Cancel</button><button class="btn primary" type="submit">${esc(C.complete)}</button></div></form>`;
  const node = sheet("complete", `${C.complete}: ${cycle.name}`, body);
  node.querySelector("[data-complete]").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = e.currentTarget.querySelector("[type=submit]");
    btn.disabled = true;
    const carryTo = node.querySelector("input[name=carry]:checked")?.value ?? "backlog";
    const r = await postJSON(`/api/cycles/${encodeURIComponent(cycle.id)}/complete`, {
      carryTo,
    });
    if (!r.ok) {
      btn.disabled = false;
      toast({ tone: "fail", text: `Couldn't complete ${cycle.name}.`, detail: errorOf(r) });
      return;
    }
    refresh();
    if (r.data?.report) {
      toast({ tone: "pass", text: `${C.completed}: ${cycle.name}` });
      const known = r.data.next ? { [r.data.next.id]: r.data.next.name } : {};
      showReport({ ...cycle, state: "closed" }, r.data.report, known);
      return;
    }
    // A sprint made active before starts were recorded has no committed list.
    closeSprintSheet();
    toast({ tone: "pass", text: `${C.completed}: ${cycle.name}`, detail: C.noStartRecorded });
  });
  node.querySelector("input[name=carry]:checked, [type=submit]")?.focus();
}

function showReport(cycle, report, known = {}) {
  const sprintName = (id) => known[id] ?? sprints().find((c) => c.id === id)?.name;
  const rows = sprintReportRows(report)
    .map(
      (r) =>
        `<div class="sprint-row" data-row="${esc(r.key)}"><dt>${esc(r.label)}</dt><dd class="tnum">${esc(r.value)}</dd>${
          r.issues.length
            ? `<dd class="ids">${r.issues
                .map((id) => {
                  const to = r.key === "carriedOver" ? report.carriedOver.to[id] : undefined;
                  const dest =
                    to === "backlog"
                      ? " → Backlog"
                      : to
                        ? ` → ${sprintName(to) ?? "the next sprint"}`
                        : "";
                  return `<span>${esc(titleOf(id))}${esc(dest)}</span>`;
                })
                .join("")}</dd>`
            : ""
        }</div>`,
    )
    .join("");
  sheet(
    "report",
    `${C.report}: ${cycle.name}`,
    `<p class="sprint-sub">Computed from the Activity log: what was committed when the sprint started, what changed while it ran, and where the not-done issues went.</p><dl class="sprint-report">${rows}</dl><div class="sprint-acts"><button class="btn primary" type="button" data-close>Done</button></div>`,
  );
}

/** DB-N11-3: a sprint's report, from the server's ledger reading. */
export async function openSprintReport(cycle) {
  const r = await getJSON(`/api/cycles/${encodeURIComponent(cycle.id)}/report`);
  if (!r.ok) {
    toast({ tone: "fail", text: `No report for ${cycle.name} yet.`, detail: errorOf(r) });
    return;
  }
  showReport(cycle, r.data.report);
}

/** DB-N11-5: New sprint — a name and two dates, the next sprint's by default. */
export function openNewSprint() {
  const list = sprints();
  const last = [...list].sort((a, b) => b.endsOn.localeCompare(a.endsOn))[0];
  const today = new Date().toISOString().slice(0, 10);
  const d = last
    ? nextSprintDefaults(last, list)
    : {
        name: "Sprint 1",
        startsOn: today,
        endsOn: new Date(Date.now() + 13 * 86_400_000).toISOString().slice(0, 10),
      };
  const node = sheet(
    "new",
    C.newSprint,
    `<form class="sprint-new" data-new-sprint><label><span>Name</span><input name="name" type="text" value="${esc(d.name)}" required></label><div class="sprint-dates"><label><span>Starts</span><input name="startsOn" type="date" value="${esc(d.startsOn)}" required></label><label><span>Ends</span><input name="endsOn" type="date" value="${esc(d.endsOn)}" required></label></div><label><span>Goal <small>optional</small></span><input name="goal" type="text" placeholder="What this sprint is for"></label><div class="sprint-acts"><button class="btn" type="button" data-close>Cancel</button><button class="btn primary" type="submit">Create sprint</button></div></form>`,
  );
  const form = node.querySelector("[data-new-sprint]");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = new FormData(form);
    const project = store.state.project?.id;
    const r = await postJSON("/api/cycles", {
      name: String(f.get("name") ?? "").trim(),
      startsOn: String(f.get("startsOn") ?? ""),
      endsOn: String(f.get("endsOn") ?? ""),
      ...(String(f.get("goal") ?? "").trim() ? { goal: String(f.get("goal")).trim() } : {}),
      ...(project ? { projectId: project } : {}),
    });
    if (!r.ok) {
      toast({ tone: "fail", text: "Couldn't create the sprint.", detail: errorOf(r) });
      return;
    }
    closeSprintSheet();
    toast({ tone: "pass", text: `Created ${r.data.cycle.name}`, detail: "It is planned." });
    refresh();
  });
  form.querySelector("input[name=name]").focus();
}

/** DB-N11-5: with no sprint, the two offers in place of a dead end. */
export function offerNoSprint(anchor) {
  openPicker(anchor, {
    heading: C.noSprints,
    search: false,
    options: noSprintOptions(),
    onPick: (v) => {
      if (v === "__new_sprint__") setTimeout(openNewSprint, 0);
      else askMerit("Plan a sprint");
    },
  });
}

/** Run a sprint action by name (the header's buttons, the palette's commands). */
export function sprintAction(action, cycle) {
  if (action === "start") return startSprint(cycle);
  if (action === "complete") return openCompleteSheet(cycle);
  if (action === "report") return openSprintReport(cycle);
}

/** The palette's Sprints group: every action each sprint offers now, and New sprint. */
export function sprintPaletteItems() {
  const list = sprints();
  const out = [];
  for (const c of list) {
    for (const a of sprintLifecycle(c, list, store.state.cards).actions) {
      out.push({
        label: `${a === "start" ? C.start : a === "complete" ? C.complete : C.report}: ${c.name}`,
        search: `sprint ${a} ${c.name}`,
        run: () => setTimeout(() => sprintAction(a, c), 0),
      });
    }
  }
  out.push({
    label: `${C.newSprint}…`,
    search: "new sprint create iteration",
    run: () => setTimeout(openNewSprint, 0),
  });
  return out;
}
