// Ledger (FRONTEND_DESIGN §2.4.5): the tamper-evident history, one sentence per
// row, newest first, filterable, with the full entry on Enter.
import { $, $$, esc, getJSON, icon } from "./dom.js";
import { actorLabel, eventSentence, parseTitle, shortId } from "./lib/vocabulary.js";
import { pushOverlay } from "./overlay.js";
import { setTopbar } from "./shell.js";
import { store } from "./store.js";

const PAGE = 100;
const ui = {
  root: null,
  events: [],
  cursor: null,
  filter: { card: "", actor: "", type: "" },
  selected: null,
  checkedAt: 0,
  seq: 0,
  detailClose: null,
};

function titleOf(id) {
  const c = store.card(id);
  return c ? (c.display?.title ?? parseTitle(c.title).title) : undefined;
}

function when(iso) {
  const d = new Date(iso);
  return d.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
}

function query(before) {
  const p = new URLSearchParams({ limit: String(PAGE), order: "desc" });
  for (const [k, v] of Object.entries(ui.filter)) if (v) p.set(k, v);
  if (before) p.set("before", String(before));
  return `/api/events?${p}`;
}

function headerHtml() {
  const v = store.state.verification;
  const at = ui.checkedAt
    ? new Date(ui.checkedAt).toLocaleTimeString([], { hourCycle: "h23" })
    : "";
  if (v && v.valid === false) {
    return `<div class="lg-state bad" role="alert">${icon("alert")}<span><b>Ledger altered at entry #${esc(v.corruptedSeq)}.</b> <span class="sec">An entry no longer matches its hash. Stop and inspect before accepting anything. Accept is disabled.</span></span></div>`;
  }
  return `<div class="lg-state">${icon("check", 16, "ic i-pass")}<span><b>Ledger intact</b> <span class="sec">· ${esc(v?.totalEvents ?? "…")} entries${at ? ` · verified ${esc(at)}` : ""}</span></span></div>`;
}

function filtersHtml() {
  const cards = store.state.cards
    .map(
      (c) =>
        `<option value="${esc(c.id)}"${ui.filter.card === c.id ? " selected" : ""}>${esc(c.display?.title ?? c.title)}</option>`,
    )
    .join("");
  const actors = ["executor", "planner", "human", "sync"]
    .map(
      (a) =>
        `<option value="${a}"${ui.filter.actor === a ? " selected" : ""}>${esc(actorLabel(a))}</option>`,
    )
    .join("");
  const types = [
    "card/created",
    "card/status_changed",
    "card/updated",
    "card/step",
    "card/accepted",
    "card/repair_plan",
    "checkpoint/recorded",
  ]
    .map((t) => `<option value="${t}"${ui.filter.type === t ? " selected" : ""}>${t}</option>`)
    .join("");
  return `<div class="lg-filters" role="group" aria-label="Filters"><label>Card <select data-f="card"><option value="">All cards</option>${cards}</select></label><label>Actor <select data-f="actor"><option value="">Everyone</option>${actors}</select></label><label>Type <select data-f="type" class="mono"><option value="">All types</option>${types}</select></label>${ui.filter.card || ui.filter.actor || ui.filter.type ? '<button class="link-btn" type="button" data-clear>Clear filters</button>' : ""}</div>`;
}

function rowHtml(e) {
  const s = eventSentence(e, titleOf);
  const bad =
    store.state.verification?.valid === false && e.seq === store.state.verification.corruptedSeq;
  const title = s.title
    ? ` <a href="#/card/${encodeURIComponent(e.cardId ?? "")}/thread" class="ttl-link">${esc(s.title)}</a>`
    : "";
  return `<tr class="${bad ? "bad" : ""}${ui.selected === e.seq ? " sel" : ""}" data-seq="${e.seq}" tabindex="${ui.selected === e.seq ? "0" : "-1"}"><td class="r tnum">${e.seq}</td><td class="tnum sec">${esc(when(e.createdAt))}</td><td>${esc(s.actor)}</td><td class="sentence"><span>${esc(s.verb)}${title}${s.rest ? ` ${esc(s.rest)}` : ""}</span>${s.quote ? `<span class="q">“${esc(s.quote.length > 140 ? `${s.quote.slice(0, 137)}…` : s.quote)}”</span>` : ""}</td><td class="mono sec">${esc(e.type)}</td><td class="mono sec" title="prev ${esc(e.prevHash)}">${esc(String(e.hash).slice(0, 8))}</td></tr>`;
}

function tableHtml() {
  if (!ui.events.length) {
    return `<div class="ev-empty">${icon("ledger", 24, "ic s24")}<b>No entries match.</b><span>${ui.filter.card || ui.filter.actor || ui.filter.type ? "Clear the filters to see the whole ledger." : "Every change to the board is written here as it happens."}</span></div>`;
  }
  return `<div class="tbl-wrap"><table class="tbl lg"><thead><tr><th class="r">#</th><th>Time</th><th>Actor</th><th>What happened</th><th>Type</th><th>Hash</th></tr></thead><tbody>${ui.events.map(rowHtml).join("")}</tbody></table></div>${ui.cursor ? '<button class="more-lines lg-more" type="button" data-more>Load older entries</button>' : '<p class="sec lg-end">The first entry of the ledger.</p>'}`;
}

function render() {
  if (!ui.root) return;
  const v = store.state.verification;
  setTopbar({
    title: "Ledger",
    crumb: `${store.state.meta?.project ?? ""} · ${v?.totalEvents ?? ""} entries`,
  });
  const body = $(".lg-body", ui.root);
  const top = body.scrollTop;
  $(".lg-head", ui.root).innerHTML = headerHtml() + filtersHtml();
  body.innerHTML = tableHtml();
  body.scrollTop = top;
}

async function load({ more = false } = {}) {
  const seq = ++ui.seq;
  const res = await getJSON(query(more ? ui.cursor : undefined));
  if (seq !== ui.seq || !ui.root) return;
  if (!res.ok) {
    $(".lg-body", ui.root).innerHTML =
      `<div class="ev-error" role="alert">${icon("alert")}<span><b>Couldn't load the ledger.</b> <span class="sec">The server returned ${esc(res.status)}.</span></span><button class="btn sm" type="button" data-reload>Retry</button></div>`;
    return;
  }
  ui.events = more ? [...ui.events, ...res.data.events] : res.data.events;
  ui.cursor = res.data.nextCursor;
  ui.checkedAt = Date.now();
  if (res.data.verification) store.state.verification = res.data.verification;
  render();
}

function matches(e) {
  const f = ui.filter;
  return (
    (!f.card || e.cardId === f.card) &&
    (!f.actor || e.actor === f.actor) &&
    (!f.type || e.type === f.type)
  );
}

function openDetail(seq) {
  const e = ui.events.find((x) => x.seq === seq);
  if (!e) return;
  ui.selected = seq;
  ui.detailClose?.();
  const s = eventSentence(e, titleOf);
  const node = document.createElement("aside");
  node.className = "peek lg-detail";
  node.setAttribute("aria-label", `Ledger entry ${seq}`);
  node.innerHTML = `<header><div><div class="crumb">Ledger ${icon("chevron-right", 12, "ic s12")}<span class="mono">#${esc(seq)}</span> · ${esc(when(e.createdAt))}</div><h3>${esc(s.actor)} ${esc(s.verb)} ${s.title ? esc(s.title) : ""} ${s.rest ? esc(s.rest) : ""}</h3><div class="out"><span class="mono">${esc(e.type)}</span>${e.cardId ? ` · <a href="#/card/${encodeURIComponent(e.cardId)}/thread">${esc(shortId(e.cardId))}</a>` : ""}</div></div><button class="icon-btn" type="button" data-close aria-label="Close (Esc)">${icon("x")}</button></header><div class="body"><section><h4>Payload</h4><pre class="json">${esc(JSON.stringify(e.payload, null, 2))}</pre></section><section><h4>Chain</h4><dl class="kv chain"><dt>Payload hash</dt><dd class="mono">${esc(e.payloadHash)}</dd><dt>Hash</dt><dd class="mono">${esc(e.hash)}</dd><dt>Previous</dt><dd class="mono">${esc(e.prevHash)}</dd><dt>Entry id</dt><dd class="mono">${esc(e.id)}</dd></dl></section></div>`;
  document.getElementById("overlay-root").append(node);
  const close = () => {
    remove();
    node.remove();
    ui.detailClose = null;
    ui.root?.querySelector(`tr[data-seq="${seq}"]`)?.focus();
  };
  const remove = pushOverlay({ kind: "ledger-detail", modal: false, close, onKey: () => false });
  node.querySelector("[data-close]").addEventListener("click", close);
  ui.detailClose = () => {
    remove();
    node.remove();
    ui.detailClose = null;
  };
  render();
}

function moveSel(dir) {
  const i = ui.events.findIndex((e) => e.seq === ui.selected);
  const next = ui.events[Math.max(0, Math.min(ui.events.length - 1, (i < 0 ? -1 : i) + dir))];
  if (!next) return;
  ui.selected = next.seq;
  for (const tr of $$("tr[data-seq]", ui.root)) {
    const on = Number(tr.dataset.seq) === next.seq;
    tr.classList.toggle("sel", on);
    tr.tabIndex = on ? 0 : -1;
    if (on) {
      tr.focus({ preventScroll: true });
      tr.scrollIntoView({ block: "nearest" });
    }
  }
  if (ui.detailClose) openDetail(next.seq);
}

export function mount(view, route) {
  const root = document.createElement("div");
  root.className = "view-host";
  root.innerHTML =
    '<section class="lg-view"><div class="lg-head"></div><div class="lg-body"></div></section>';
  view.append(root);
  ui.root = root;
  ui.events = [];
  ui.selected = null;
  if (route.params?.[0]) ui.filter = { card: route.params[0], actor: "", type: "" };
  root.addEventListener("change", (e) => {
    const sel = e.target instanceof Element ? e.target.closest("[data-f]") : null;
    if (!sel) return;
    ui.filter[sel.dataset.f] = sel.value;
    load();
  });
  root.addEventListener("click", (e) => {
    const t = e.target instanceof Element ? e.target : null;
    if (!t) return;
    if (t.closest("[data-more]")) return load({ more: true });
    if (t.closest("[data-reload]")) return load();
    if (t.closest("[data-clear]")) {
      ui.filter = { card: "", actor: "", type: "" };
      return load();
    }
    if (t.closest("a")) return;
    const tr = t.closest("tr[data-seq]");
    if (tr) openDetail(Number(tr.dataset.seq));
  });
  const unsub = store.on((_s, patch) => {
    if (!ui.root) return;
    const fresh = (store.state.feed ?? []).filter(
      (e) => matches(e) && !ui.events.some((x) => x.seq === e.seq),
    );
    if ("cards" in patch && fresh.length) {
      ui.events = [...fresh.sort((a, b) => b.seq - a.seq), ...ui.events];
      ui.checkedAt = Date.now();
      render();
    } else if ("verification" in patch) render();
  });
  render();
  load();
  return {
    setParams() {},
    onKey(e) {
      if (e.key === "j" || e.key === "ArrowDown") {
        moveSel(1);
        return true;
      }
      if (e.key === "k" || e.key === "ArrowUp") {
        moveSel(-1);
        return true;
      }
      if (e.key === "Enter" && ui.selected !== null && !e.target.closest?.("a,button,select")) {
        openDetail(ui.selected);
        return true;
      }
      return false;
    },
    unmount() {
      ui.detailClose?.();
      unsub();
      root.remove();
      ui.root = null;
    },
  };
}
