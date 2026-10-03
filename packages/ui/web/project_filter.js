// The project filter of the views that span a workspace's projects —
// My issues, the Inbox and the palette's Issues (dashboard DB-N26-2; DEC-57).
// Every word and count is `crossProjectRows`'s (`/app/lib/switcher.js`); the
// projects are the ones this person can see, as the project switcher lists
// them. Opening an issue of another project makes that project current.
import { esc } from "./dom.js";
import { CROSS_PROJECT_COPY as C, crossProjectRows } from "./lib/switcher.js";
import { store } from "./store.js";
import { chooseProject } from "./switcher.js";

/** The projects this person can see: the switcher's list. */
export function visibleProjects() {
  return (store.state.project?.list ?? []).map((p) => ({ id: p.id, name: p.name }));
}

/**
 * `items` (each with `projectId`) across the visible projects, filtered to
 * `filter`; with the filter's control. No control with one project.
 */
export function crossProject(items, filter) {
  const v = crossProjectRows(items, visibleProjects(), filter);
  const control = v.filters.length
    ? `<label class="xp-filter"><span>${esc(C.filterLabel)}</span><select data-project-filter>${v.filters
        .map(
          (f) =>
            `<option value="${esc(f.id)}"${f.selected ? " selected" : ""}>${esc(f.label)} (${f.count})</option>`,
        )
        .join("")}</select></label>`
    : "";
  return { ...v, control };
}

/** DB-N26-2: an issue of another project makes that project current; the page goes on. */
export function followProject(projectId) {
  if (projectId && projectId !== store.state.project?.id) chooseProject(projectId, { stay: true });
}
