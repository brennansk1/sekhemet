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
  span.className = "level-note";
  span.id = id;
  span.textContent = note;
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
