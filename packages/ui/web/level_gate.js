// DB-N9-17 (dashboard §2.2.7; teams items 6, 9): a control the viewer's
// access level does not allow is disabled, with the level they hold and a
// level that can do it written beside it — *You're a Stakeholder on
// Chronicle. A Member can start the Agent on this issue.* — everywhere, by
// one rule: a view marks a control with the permission it needs
// (`data-needs="agent.start"`, and `data-needs-project` for an issue's or a
// project's own level), and this module disables it and writes the note, on
// every render. The server still checks every write (TEAM-4): the note says
// in advance what its refusal would. Solo's one person is Admin, so nothing
// is ever disabled there. The sentence is `/app/lib/team_admin.js`'s.
// A control in a tight place — a column header's `+`, a table cell — is
// marked `data-needs-quiet`: its note is its title and, for screen readers,
// a hidden description, and its view writes the sentence once where it reads.
import { levelNote } from "./lib/team_admin.js";
import { getSession } from "./session.js";
import { store } from "./store.js";

let seq = 0;

/** A project's name, for "on Chronicle": the control's own, else an issue of that project's. */
function projectName(control, id) {
  if (control.dataset.needsProjectName) return control.dataset.needsProjectName;
  if (!id) return undefined;
  return store.state.cards?.find?.((c) => c.projectId === id && c.projectName)?.projectName;
}

/**
 * The note for a permission on a project for the signed-in person, or
 * undefined when they may (always in Solo). For views that act from the
 * keyboard or a drag, where there is no control to disable.
 */
export function noteFor(permission, project, projectNameText) {
  return levelNote(getSession(), permission, {
    project: project || undefined,
    projectName: projectNameText ?? (project ? projectName({ dataset: {} }, project) : undefined),
  });
}

/**
 * One visible sentence for a view's quiet controls (DB-N9-17): the first
 * permission's note, and each further one that differs without repeating
 * *You're a …* — written once where the view reads, beside its controls'
 * titles. Empty when the person may do all of them (always in Solo).
 */
export function levelSentence(permissions, project, projectNameText) {
  const notes = [];
  for (const p of permissions) {
    const note = noteFor(p, project, projectNameText);
    if (!note) continue;
    const text = notes.length ? note.replace(/^You're [^.]*\. /, "") : note;
    if (!notes.includes(text) && !notes.includes(note)) notes.push(text);
  }
  return notes.join(" ");
}

/** Disable one marked control and write its note beside it, or leave it. */
export function applyLevelGate(control) {
  if (!(control instanceof HTMLElement) || control.dataset.needsDone) return;
  const permission = control.dataset.needs;
  if (!permission) return;
  const project = control.dataset.needsProject || undefined;
  const note = levelNote(getSession(), permission, {
    project,
    projectName: projectName(control, project),
  });
  control.dataset.needsDone = "1";
  if (!note) return;
  if ("disabled" in control) control.disabled = true;
  else {
    control.setAttribute("aria-disabled", "true");
    control.setAttribute("tabindex", "-1");
  }
  const id = `level-note-${++seq}`;
  const span = document.createElement("span");
  // A quiet control's note is its title and a hidden description (see above).
  const quiet = control.dataset.needsQuiet !== undefined;
  span.className = quiet ? "level-note sr-only" : "level-note";
  span.id = id;
  span.textContent = note;
  if (quiet) control.title = note;
  const described = control.getAttribute("aria-describedby");
  control.setAttribute("aria-describedby", described ? `${described} ${id}` : id);
  control.insertAdjacentElement("afterend", span);
}

function applyAll(root) {
  if (!(root instanceof Element)) return;
  if (root.matches("[data-needs]")) applyLevelGate(root);
  for (const el of root.querySelectorAll("[data-needs]:not([data-needs-done])")) applyLevelGate(el);
}

export function initLevelGates() {
  if (getSession().mode !== "team") return;
  applyAll(document.body);
  new MutationObserver((records) => {
    for (const r of records) for (const n of r.addedNodes) applyAll(n);
  }).observe(document.body, { childList: true, subtree: true });
  // A link or custom control marked aria-disabled does nothing when pressed.
  document.addEventListener(
    "click",
    (e) => {
      const t = e.target instanceof Element ? e.target.closest("[data-needs]") : null;
      if (t?.getAttribute("aria-disabled") === "true") {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    },
    true,
  );
}
