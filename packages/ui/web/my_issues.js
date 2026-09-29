// My issues (dashboard §2.17.3, DB-N9-15; Team only): the issues you own,
// are delegated or are asked to review, across the projects you can see,
// grouped by project — Linear's and Jira's "My issues". One table per
// project in the List view's look; a row opens the issue. An issue the Agent
// is working on shows its state with the AI badge (teams item 19). Every
// word is `/app/lib/inbox.js`'s.
import { $, aiBadge, esc, getJSON, icon } from "./dom.js";
import { MY_ISSUES_COPY as C, myIssueGroups } from "./lib/inbox.js";
import { aiStateLine } from "./lib/teammates.js";
import { parseTitle, shortId } from "./lib/vocabulary.js";
import { setTopbar } from "./shell.js";
import { store } from "./store.js";

const ui = { root: null, last: "", issues: undefined };

async function load() {
  const r = await getJSON("/api/my-issues").catch(() => ({ ok: false, status: 0 }));
  ui.issues = r.ok ? (r.data?.issues ?? []) : { error: r.status || "no response" };
  render();
}

function aiHtml(ai) {
  if (!ai?.length) return "";
  return ai
    .map((a) => {
      const l = aiStateLine(a);
      return `<span class="ib-ai-line"><b>${esc(l.name)}</b>${aiBadge()}<span class="ib-state">${esc(l.label)}</span></span>`;
    })
    .join("");
}

function tableHtml(g) {
  const rows = g.issues
    .map(
      (i) =>
        `<tr><td data-col="issue"><span class="pj-lbl">${esc(C.columns.issue)}</span><a href="#/card/${encodeURIComponent(i.id)}/activity"><span class="mono sec">${esc(shortId(i.id))}</span> <b>${esc(parseTitle(i.title).title)}</b></a>${aiHtml(i.ai)}</td><td data-col="status"><span class="pj-lbl">${esc(C.columns.status)}</span>${esc(i.statusLabel)}</td><td data-col="why"><span class="pj-lbl">${esc(C.columns.why)}</span>${esc(i.whyLabel)}</td></tr>`,
    )
    .join("");
  return `<section class="ib-group" aria-labelledby="mi-h-${esc(g.id || "none")}"><h2 id="mi-h-${esc(g.id || "none")}">${esc(g.name)} <span class="sec tnum">${g.issues.length}</span></h2><div class="tbl-wrap"><table class="tbl pj-tbl mi-tbl"><caption class="sr-only">${esc(`${C.title}: ${g.name}`)}</caption><thead><tr><th scope="col">${esc(C.columns.issue)}</th><th scope="col">${esc(C.columns.status)}</th><th scope="col">${esc(C.columns.why)}</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
}

function render() {
  if (!ui.root) return;
  const v = ui.issues;
  let html;
  if (v === undefined) html = '<div class="sk" style="height:160px"></div>';
  else if (!Array.isArray(v))
    html = `<p class="stp-notice" role="status"><b>Couldn't load your issues.</b> <span class="sec">The server returned ${esc(v.error)}.</span></p>`;
  else if (v.length === 0)
    html = `<div class="ib-empty">${icon("user", 24, "ic s24")}<b>${esc(C.empty)}</b><span>${esc(C.emptyHint)}</span></div>`;
  else html = myIssueGroups(v).map(tableHtml).join("");
  setTopbar({
    title: C.title,
    crumb: Array.isArray(v) && v.length ? `${v.length} ${v.length === 1 ? "issue" : "issues"}` : "",
  });
  if (html === ui.last) return;
  ui.last = html;
  $(".sc", ui.root).innerHTML = html;
}

export function mount(view) {
  const root = document.createElement("div");
  root.className = "view-host";
  root.innerHTML = `<section class="sc mi" aria-label="${esc(C.title)}"></section>`;
  view.append(root);
  ui.root = root;
  ui.last = "";
  ui.issues = undefined;
  // A change on the board can change what is yours: refetch then.
  let soon = 0;
  const unsub = store.on((_s, patch) => {
    if (!("cards" in patch) || soon) return;
    soon = setTimeout(() => {
      soon = 0;
      void load();
    }, 1000);
  });
  render();
  void load();
  return {
    unmount() {
      clearTimeout(soon);
      unsub();
      root.remove();
      ui.root = null;
    },
  };
}
