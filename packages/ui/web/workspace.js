// Workspace (U7): the master board across projects. One row per project with
// its flow across the columns, what needs you there, and its run state. Opening
// a row scopes the board to that project.
import { $, esc, getJSON, icon } from "./dom.js";
import { BOARD_COLUMN_ORDER, columnLabel } from "./lib/vocabulary.js";
import { setTopbar } from "./shell.js";
import { store } from "./store.js";

const ui = { root: null, last: "", boards: new Map(), loading: false };

/** Column counts, review queue and working cards for one project's board. */
export function projectSummary(cards) {
  const counts = Object.fromEntries(BOARD_COLUMN_ORDER.map((s) => [s, 0]));
  for (const c of cards) if (c.status in counts) counts[c.status]++;
  return {
    total: cards.length,
    counts,
    review: counts.review ?? 0,
    working: counts.in_progress ?? 0,
    parked: counts.parked ?? 0,
    done: counts.done ?? 0,
  };
}

async function load() {
  ui.loading = true;
  const p = await getJSON("/api/projects").catch(() => ({ ok: false }));
  const list = p.ok ? (p.data.projects ?? []) : [];
  store.set({
    project: { ...store.state.project, list, activeCap: p.ok ? p.data.activeCap : undefined },
  });
  await Promise.all(
    list.map(async (proj) => {
      const b = await getJSON(`/api/board?project=${encodeURIComponent(proj.id)}`).catch(() => ({
        ok: false,
      }));
      if (b.ok) ui.boards.set(proj.id, b.data.cards ?? []);
    }),
  );
  ui.loading = false;
  render();
}

function bar(sum) {
  if (!sum.total) return '<span class="sec">No cards</span>';
  return `<span class="ws-bar" role="img" aria-label="${esc(
    BOARD_COLUMN_ORDER.filter((s) => sum.counts[s])
      .map((s) => `${sum.counts[s]} ${columnLabel(s)}`)
      .join(", "),
  )}">${BOARD_COLUMN_ORDER.filter((s) => sum.counts[s])
    .map(
      (s) =>
        `<i class="ws-seg s-${s}" style="flex:${sum.counts[s]}" title="${esc(`${sum.counts[s]} ${columnLabel(s)}`)}"></i>`,
    )
    .join("")}</span>`;
}

function render() {
  if (!ui.root) return;
  const { list, activeCap } = store.state.project;
  const active = list.filter((p) => p.status === "active").length;
  setTopbar({
    title: "Workspace",
    crumb: `${list.length} project${list.length === 1 ? "" : "s"}${activeCap ? ` · ${active} of ${activeCap} running at once` : ""}`,
  });
  let html;
  if (ui.loading && list.length === 0) html = '<div class="sk" style="height:160px"></div>';
  else if (list.length === 0)
    html = `<div class="ib-empty">${icon("layers", 24, "ic s24")}<b>No projects recorded yet.</b><span>Each repository Sekhemet runs in becomes a project. Run the harness in another repository and it appears here with its own flow.</span></div>`;
  else
    html = `<div class="tbl-wrap"><table class="tbl ws"><thead><tr><th>Project</th><th>Flow</th><th class="num">Review</th><th class="num">Working</th><th class="num">Parked</th><th class="num">Done</th><th>State</th></tr></thead><tbody>${list
      .map((p) => {
        const sum = projectSummary(ui.boards.get(p.id) ?? []);
        return `<tr data-project="${esc(p.id)}" tabindex="0"><td><b>${esc(p.name ?? p.id)}</b><span class="mono sec"> ${esc(p.id)}</span></td><td>${bar(sum)}<span class="sec tnum"> ${sum.total} cards</span></td><td class="num tnum${sum.review ? " warn" : ""}">${sum.review}</td><td class="num tnum">${sum.working}</td><td class="num tnum">${sum.parked}</td><td class="num tnum">${sum.done}</td><td>${esc(p.status ?? "")}</td></tr>`;
      })
      .join(
        "",
      )}</tbody></table></div><p class="sec ws-hint">${store.state.project.id ? `The board shows <b>${esc(list.find((p) => p.id === store.state.project.id)?.name ?? store.state.project.id)}</b> only. <button class="btn ghost sm" type="button" data-all>Show every project</button>` : "Open a project to scope the board to it. Review counts are cards waiting on you."}</p>`;
  if (html === ui.last) return;
  ui.last = html;
  $(".sc", ui.root).innerHTML = html;
}

function open(id) {
  store.set({ project: { ...store.state.project, id } });
  window.dispatchEvent(new CustomEvent("sekhemet:refresh"));
  location.hash = "#/board";
}

export function mount(view) {
  const root = document.createElement("div");
  root.className = "view-host";
  root.innerHTML = '<section class="sc ws-view" aria-label="Workspace"></section>';
  view.append(root);
  ui.root = root;
  ui.last = "";
  root.addEventListener("click", (e) => {
    const t = e.target instanceof Element ? e.target : null;
    if (t?.closest("[data-all]")) {
      store.set({ project: { ...store.state.project, id: null } });
      window.dispatchEvent(new CustomEvent("sekhemet:refresh"));
      ui.last = "";
      render();
      return;
    }
    const row = t?.closest("[data-project]");
    if (row) open(row.dataset.project);
  });
  root.addEventListener("keydown", (e) => {
    const row = e.target instanceof Element ? e.target.closest("[data-project]") : null;
    if (row && e.key === "Enter") open(row.dataset.project);
  });
  render();
  load();
  return {
    unmount() {
      root.remove();
      ui.root = null;
    },
  };
}
