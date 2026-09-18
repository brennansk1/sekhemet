import { generateTokenCss } from "@sekhemet/ui";

/**
 * The Basalt dashboard, served as a single self-contained document.
 *
 * No build step and no CDN: the harness is local-first and must work air-gapped,
 * so the page ships its own styles and script. Colors come exclusively from the
 * token stylesheet — nothing here hard-codes a hex value.
 */
export function generateDashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="en" data-theme="basalt">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Sekhemet</title>
<style>
${generateTokenCss()}

*, *::before, *::after { box-sizing: border-box; }
html, body { height: 100%; }
body {
  margin: 0;
  background: var(--bg-base);
  color: var(--text-primary);
  font-family: var(--font-sans);
  font-size: var(--text-base);
  line-height: var(--leading-normal);
  -webkit-font-smoothing: antialiased;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
/* Metrics and timestamps must not jitter as digits change. */
.tnum, time, .metric, .count, .budget-text { font-variant-numeric: tabular-nums; }
button { font: inherit; color: inherit; background: none; border: none; cursor: pointer; }
:focus-visible { outline: 2px solid var(--border-strong); outline-offset: 2px; border-radius: var(--radius-control); }

/* ---------- Top bar ---------- */
header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 0 var(--space-4); height: 48px; flex: 0 0 48px;
  background: var(--bg-surface); border-bottom: 1px solid var(--border-subtle);
}
.brand { display: flex; align-items: center; gap: var(--space-3); }
.glyph { width: 20px; height: 20px; color: var(--accent); }
.brand h1 { font-size: var(--text-md); font-weight: 600; letter-spacing: -0.01em; margin: 0; }
.chip {
  font-size: var(--text-xs); font-weight: 500; padding: 2px var(--space-2);
  border-radius: var(--radius-control); border: 1px solid var(--border-subtle);
  color: var(--text-secondary); background: var(--bg-raised); white-space: nowrap;
}
.chip.pass { color: var(--state-pass); border-color: var(--state-pass); }
.chip.fail { color: var(--state-fail); border-color: var(--state-fail); }
.chip.warn { color: var(--state-parked); border-color: var(--state-parked); }
.chip.run  { color: var(--state-running); border-color: var(--state-running); }
.header-right { display: flex; align-items: center; gap: var(--space-3); font-size: var(--text-sm); color: var(--text-secondary); }
.icon-btn {
  display: inline-flex; align-items: center; justify-content: center;
  width: 28px; height: 28px; border-radius: var(--radius-control);
  color: var(--text-secondary); transition: var(--motion);
}
.icon-btn:hover { background: var(--bg-overlay); color: var(--text-primary); }

/* ---------- Back-pressure banner ---------- */
.banner {
  display: none; align-items: center; gap: var(--space-2);
  padding: var(--space-2) var(--space-4); font-size: var(--text-sm);
  background: var(--bg-raised); border-bottom: 1px solid var(--state-parked);
  color: var(--state-parked); flex: 0 0 auto;
}
.banner.on { display: flex; }

/* ---------- Board ---------- */
main { flex: 1; display: flex; flex-direction: column; min-height: 0; }
.board { flex: 1; display: flex; gap: var(--space-3); padding: var(--space-4); overflow-x: auto; min-height: 0; }
.column {
  flex: 0 0 272px; display: flex; flex-direction: column; min-height: 0;
  background: var(--bg-surface); border: 1px solid var(--border-subtle); border-radius: var(--radius-card);
}
.column-header {
  display: flex; align-items: center; justify-content: space-between; gap: var(--space-2);
  padding: var(--space-3); border-bottom: 1px solid var(--border-subtle); flex: 0 0 auto;
}
.column-name { font-size: var(--text-xs); font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--text-secondary); }
.count { font-size: var(--text-xs); color: var(--text-muted); }
.count.at-capacity { color: var(--state-parked); font-weight: 600; }
.wip-track { height: 2px; background: var(--bg-overlay); border-radius: 1px; overflow: hidden; }
.wip-fill { height: 100%; background: var(--text-muted); transition: var(--motion); }
.wip-fill.at-capacity { background: var(--state-parked); }
/* The scroller owns the scrollbar; the sizer gives it the full virtual height. */
.card-scroll { flex: 1; overflow-y: auto; padding: var(--space-3); min-height: 0; }
.card-sizer { position: relative; }

.card {
  position: absolute; left: 0; right: 0;
  background: var(--bg-raised); border: 1px solid var(--border-subtle);
  border-radius: var(--radius-card); padding: var(--space-3);
  display: flex; flex-direction: column; gap: var(--space-2);
  transition: var(--motion); cursor: pointer;
}
.card:hover { background: var(--bg-overlay); border-color: var(--border-strong); }
.card.selected { border-color: var(--accent); }
.card-top { display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); }
.tier { font-size: var(--text-xs); font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; color: var(--accent); }
.card-id { font-family: var(--font-mono); font-size: var(--text-xs); color: var(--text-muted); }
.card-title {
  font-size: var(--text-sm); font-weight: 500; line-height: var(--leading-tight); margin: 0;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}
.card-bottom { display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); }
.budget { flex: 1; display: flex; flex-direction: column; gap: 3px; }
.budget-track { height: 3px; background: var(--bg-base); border-radius: 2px; overflow: hidden; }
.budget-fill { height: 100%; background: var(--state-running); transition: var(--motion); }
.budget-fill.warn { background: var(--state-parked); }
.budget-fill.over { background: var(--state-fail); }
.budget-text { font-size: var(--text-xs); color: var(--text-muted); }

/* Five-box gate strip: colour is never the only signal — each box has a letter. */
.gates { display: flex; gap: 3px; }
.gate-box {
  width: 15px; height: 15px; border-radius: 3px; border: 1px solid var(--border-subtle);
  background: var(--bg-base); color: var(--text-muted);
  font-size: 9px; font-weight: 700; display: flex; align-items: center; justify-content: center;
}
.gate-box.pass { background: var(--state-pass); border-color: var(--state-pass); color: var(--bg-base); }
.gate-box.fail { background: var(--state-fail); border-color: var(--state-fail); color: var(--bg-base); }
.gate-box.run  { background: var(--state-running); border-color: var(--state-running); color: var(--bg-base); }
.deps { font-size: var(--text-xs); color: var(--text-muted); }

.empty { padding: var(--space-4) var(--space-3); color: var(--text-muted); font-size: var(--text-sm); text-align: center; }

/* ---------- Log drawer ---------- */
.drawer { flex: 0 0 auto; border-top: 1px solid var(--border-subtle); background: var(--bg-surface); max-height: 34vh; display: flex; flex-direction: column; }
.drawer-head { display: flex; align-items: center; justify-content: space-between; padding: var(--space-2) var(--space-4); flex: 0 0 auto; }
.drawer-title { font-size: var(--text-xs); font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--text-secondary); }
.log { overflow-y: auto; padding: 0 var(--space-4) var(--space-3); }
table { width: 100%; border-collapse: collapse; font-family: var(--font-mono); font-size: var(--text-xs); }
th { text-align: left; font-weight: 500; color: var(--text-muted); padding: var(--space-1) var(--space-2); position: sticky; top: 0; background: var(--bg-surface); }
td { padding: var(--space-1) var(--space-2); border-top: 1px solid var(--border-subtle); color: var(--text-secondary); white-space: nowrap; }
td.type { color: var(--accent); }
td.hash { color: var(--text-muted); }

/* ---------- Command palette ---------- */
.scrim { position: fixed; inset: 0; background: rgba(0,0,0,0.5); display: none; align-items: flex-start; justify-content: center; padding-top: 12vh; }
.scrim.on { display: flex; }
.palette { width: min(560px, 92vw); background: var(--bg-raised); border: 1px solid var(--border-strong); border-radius: var(--radius-card); overflow: hidden; }
.palette input { width: 100%; padding: var(--space-4); background: none; border: none; color: var(--text-primary); font-size: var(--text-md); outline: none; }
.palette-list { max-height: 320px; overflow-y: auto; border-top: 1px solid var(--border-subtle); }
.palette-item { padding: var(--space-3) var(--space-4); display: flex; justify-content: space-between; gap: var(--space-3); font-size: var(--text-sm); }
.palette-item:hover, .palette-item.active { background: var(--bg-overlay); }
.palette-item .muted { color: var(--text-muted); font-family: var(--font-mono); font-size: var(--text-xs); }
.kbd { font-family: var(--font-mono); font-size: var(--text-xs); color: var(--text-muted); border: 1px solid var(--border-subtle); border-radius: 3px; padding: 1px 4px; }
</style>
</head>
<body>
<header>
  <div class="brand">
    <svg class="glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M4 20V7a3 3 0 0 1 3-3h6"/><path d="M13 4l7 5-7 5"/><path d="M4 20h16"/>
    </svg>
    <h1>Sekhemet</h1>
    <span class="chip" id="chain-chip">chain &mdash;</span>
  </div>
  <div class="header-right">
    <span id="model-chip" class="chip">model &mdash;</span>
    <span id="mem-chip" class="chip">memory &mdash;</span>
    <span class="chip" id="stream-chip">connecting</span>
    <button class="icon-btn" id="theme-btn" title="Toggle theme" aria-label="Toggle theme">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>
    </button>
    <button class="icon-btn" id="palette-btn" title="Command palette (Cmd+K)" aria-label="Command palette">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
    </button>
  </div>
</header>

<div class="banner" id="banner">
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>
  <span><strong>Review at capacity.</strong> No card may enter Verify until a review is accepted or returned.</span>
</div>

<main>
  <div class="board" id="board"></div>
  <section class="drawer">
    <div class="drawer-head">
      <span class="drawer-title">Event log</span>
      <span class="chip" id="log-chip">0 events</span>
    </div>
    <div class="log">
      <table>
        <thead><tr><th>seq</th><th>type</th><th>actor</th><th>hash</th><th>prev</th><th>time</th></tr></thead>
        <tbody id="log-body"></tbody>
      </table>
    </div>
  </section>
</main>

<div class="scrim" id="scrim">
  <div class="palette" role="dialog" aria-label="Command palette">
    <input id="palette-input" type="text" placeholder="Search cards and commands..." autocomplete="off" spellcheck="false">
    <div class="palette-list" id="palette-list"></div>
  </div>
</div>

<script>
"use strict";
const COLUMNS = [
  ["backlog","Backlog"],["ready","Ready"],["planning","Planning"],
  ["in_progress","In Progress"],["verify","Verify"],["review","Review"],["done","Done"],
];
const ROW_H = 96, GAP = 8, OVERSCAN = 3;

// Every value rendered below originates from card titles and event fields that
// a model can write, so all interpolation goes through this. Never innerHTML
// with raw data.
function esc(v) {
  return String(v == null ? "" : v)
    .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
    .replace(/"/g,"&quot;").replace(/'/g,"&#39;");
}

let state = { cards: [], wipLimits: {}, backpressureActive: false, events: [], verification: null, doctor: null };
const scroll = {};   // column -> scrollTop
let selected = null;

function gateStrip(card) {
  // Five rungs, each labelled so colour is never the only signal.
  const rungs = [["P","parse"],["T","typecheck"],["U","test"],["L","lint"],["B","bounds"]];
  const results = (card.gateResults || {});
  return '<div class="gates" role="img" aria-label="gate status">' + rungs.map(function(r){
    const v = results[r[1]];
    const cls = v === "pass" ? " pass" : v === "fail" ? " fail" : v === "running" ? " run" : "";
    return '<span class="gate-box'+cls+'" title="'+esc(r[1])+': '+esc(v||"not run")+'">'+r[0]+'</span>';
  }).join("") + '</div>';
}

function cardHtml(card, top) {
  const used = card.stepsUsed || 0, budget = card.stepBudget || 1;
  const pct = Math.min(100, Math.round(used / budget * 100));
  const cls = pct >= 100 ? " over" : pct >= 75 ? " warn" : "";
  const deps = (card.dependsOn || []).length;
  return '<article class="card'+(selected===card.id?" selected":"")+'" style="top:'+top+'px;height:'+ROW_H+'px" data-id="'+esc(card.id)+'" tabindex="0">'
    + '<div class="card-top"><span class="tier">'+esc(card.tier)+'</span><span class="card-id">'+esc(card.id)+'</span></div>'
    + '<h3 class="card-title">'+esc(card.title)+'</h3>'
    + '<div class="card-bottom">'
      + '<div class="budget"><div class="budget-track"><div class="budget-fill'+cls+'" style="width:'+pct+'%"></div></div>'
      + '<span class="budget-text">'+used+'/'+budget+' steps'+(deps?' &middot; '+deps+' dep'+(deps>1?'s':''):'')+'</span></div>'
      + gateStrip(card)
    + '</div></article>';
}

function renderBoard() {
  const board = document.getElementById("board");
  const existing = {};
  board.querySelectorAll(".card-scroll").forEach(function(el){ existing[el.dataset.col] = el.scrollTop; });

  board.innerHTML = COLUMNS.map(function(col){
    const status = col[0];
    const cards = state.cards.filter(function(c){ return c.status === status; });
    const limit = state.wipLimits[status];
    const atCap = typeof limit === "number" && limit < 1000 && cards.length >= limit;
    const pct = typeof limit === "number" && limit < 1000 ? Math.min(100, cards.length/limit*100) : 0;
    const counter = typeof limit === "number" && limit < 1000 ? cards.length+"/"+limit : String(cards.length);

    return '<section class="column" data-col="'+status+'">'
      + '<div class="column-header"><span class="column-name">'+esc(col[1])+'</span>'
      + '<span class="count'+(atCap?" at-capacity":"")+'">'+counter+'</span></div>'
      + '<div class="wip-track"><div class="wip-fill'+(atCap?" at-capacity":"")+'" style="width:'+pct+'%"></div></div>'
      + '<div class="card-scroll" data-col="'+status+'"><div class="card-sizer" style="height:'+(cards.length*(ROW_H+GAP))+'px"></div></div>'
      + '</section>';
  }).join("");

  COLUMNS.forEach(function(col){
    const el = board.querySelector('.card-scroll[data-col="'+col[0]+'"]');
    if (!el) return;
    if (existing[col[0]]) el.scrollTop = existing[col[0]];
    el.addEventListener("scroll", function(){ scroll[col[0]] = el.scrollTop; paintColumn(col[0]); }, { passive: true });
    paintColumn(col[0]);
  });
}

// Only the rows intersecting the viewport are materialised; the sizer keeps the
// scrollbar honest about the full list height.
function paintColumn(status) {
  const scroller = document.querySelector('.card-scroll[data-col="'+status+'"]');
  if (!scroller) return;
  const sizer = scroller.querySelector(".card-sizer");
  const cards = state.cards.filter(function(c){ return c.status === status; });

  if (cards.length === 0) { sizer.innerHTML = '<div class="empty">No cards</div>'; return; }

  const stride = ROW_H + GAP;
  const top = scroller.scrollTop;
  const first = Math.max(0, Math.floor(top / stride) - OVERSCAN);
  const last = Math.min(cards.length, Math.ceil((top + scroller.clientHeight) / stride) + OVERSCAN);

  let html = "";
  for (let i = first; i < last; i++) html += cardHtml(cards[i], i * stride);
  sizer.innerHTML = html;

  sizer.querySelectorAll(".card").forEach(function(el){
    el.addEventListener("click", function(){ selected = el.dataset.id; renderBoard(); });
  });
}

function renderLog() {
  const body = document.getElementById("log-body");
  const rows = state.events.slice(-40).reverse();
  body.innerHTML = rows.map(function(e){
    return '<tr><td>'+esc(e.seq)+'</td><td class="type">'+esc(e.type)+'</td><td>'+esc(e.actor)+'</td>'
      + '<td class="hash" title="'+esc(e.hash)+'">'+esc(String(e.hash||"").slice(0,8))+'</td>'
      + '<td class="hash" title="'+esc(e.prevHash)+'">'+esc(String(e.prevHash||"").slice(0,8))+'</td>'
      + '<td>'+esc(String(e.createdAt||"").replace("T"," ").slice(0,19))+'</td></tr>';
  }).join("");
  document.getElementById("log-chip").textContent = state.events.length + " events";
}

function renderChrome() {
  const v = state.verification;
  const chip = document.getElementById("chain-chip");
  if (v) {
    chip.textContent = v.valid ? "chain verified \\u00b7 " + v.totalEvents : "CHAIN BROKEN at #" + v.corruptedSeq;
    chip.className = "chip " + (v.valid ? "pass" : "fail");
  }
  document.getElementById("banner").classList.toggle("on", !!state.backpressureActive);

  const d = state.doctor;
  if (d && d.checks) {
    const mem = d.checks.find(function(c){ return c.name === "Unified memory"; });
    const inf = d.checks.find(function(c){ return c.name === "Local inference socket"; });
    if (mem) {
      const el = document.getElementById("mem-chip");
      el.textContent = mem.detail.split("(")[0].trim();
      el.className = "chip " + (mem.status === "pass" ? "" : mem.status === "warn" ? "warn" : "fail");
    }
    if (inf) {
      const el = document.getElementById("model-chip");
      el.textContent = inf.status === "pass" ? (inf.detail.split("—")[1] || "inference ready").trim().slice(0, 34) : "inference offline";
      el.className = "chip " + (inf.status === "pass" ? "run" : "fail");
    }
  }
}

function render() { renderBoard(); renderLog(); renderChrome(); }

/* ---------- Command palette ---------- */
const COMMANDS = [
  { label: "Toggle theme", run: toggleTheme },
  { label: "Reload board", run: function(){ hydrate(); } },
];
let paletteIndex = 0;

function paletteItems(q) {
  const query = q.toLowerCase();
  const cards = state.cards
    .filter(function(c){ return (c.title+" "+c.id).toLowerCase().includes(query); })
    .slice(0, 8)
    .map(function(c){ return { label: c.title, hint: c.id, run: function(){ selected = c.id; render(); } }; });
  const cmds = COMMANDS.filter(function(c){ return c.label.toLowerCase().includes(query); })
    .map(function(c){ return { label: c.label, hint: "command", run: c.run }; });
  return cmds.concat(cards);
}

function renderPalette() {
  const items = paletteItems(document.getElementById("palette-input").value);
  paletteIndex = Math.min(paletteIndex, Math.max(0, items.length - 1));
  document.getElementById("palette-list").innerHTML = items.map(function(it, i){
    return '<div class="palette-item'+(i===paletteIndex?" active":"")+'" data-i="'+i+'">'
      + '<span>'+esc(it.label)+'</span><span class="muted">'+esc(it.hint)+'</span></div>';
  }).join("") || '<div class="palette-item"><span class="muted">No matches</span></div>';

  document.querySelectorAll(".palette-item[data-i]").forEach(function(el){
    el.addEventListener("click", function(){ items[Number(el.dataset.i)].run(); closePalette(); });
  });
}
function openPalette() {
  document.getElementById("scrim").classList.add("on");
  const input = document.getElementById("palette-input");
  input.value = ""; paletteIndex = 0; renderPalette(); input.focus();
}
function closePalette() { document.getElementById("scrim").classList.remove("on"); }

function toggleTheme() {
  const root = document.documentElement;
  const next = root.dataset.theme === "sand" ? "basalt" : "sand";
  root.dataset.theme = next;
  try { localStorage.setItem("sekhemet-theme", next); } catch (e) { /* private mode */ }
}

document.addEventListener("keydown", function(e){
  if ((e.metaKey || e.ctrlKey) && e.key === "k") { e.preventDefault(); openPalette(); return; }
  if (e.key === "Escape") closePalette();
  const open = document.getElementById("scrim").classList.contains("on");
  if (open) {
    const items = paletteItems(document.getElementById("palette-input").value);
    if (e.key === "ArrowDown") { e.preventDefault(); paletteIndex = Math.min(paletteIndex+1, items.length-1); renderPalette(); }
    if (e.key === "ArrowUp") { e.preventDefault(); paletteIndex = Math.max(paletteIndex-1, 0); renderPalette(); }
    if (e.key === "Enter" && items[paletteIndex]) { items[paletteIndex].run(); closePalette(); }
  }
});
document.getElementById("palette-input").addEventListener("input", function(){ paletteIndex = 0; renderPalette(); });
document.getElementById("palette-btn").addEventListener("click", openPalette);
document.getElementById("theme-btn").addEventListener("click", toggleTheme);
document.getElementById("scrim").addEventListener("click", function(e){ if (e.target.id === "scrim") closePalette(); });

try {
  const saved = localStorage.getItem("sekhemet-theme");
  if (saved) document.documentElement.dataset.theme = saved;
} catch (e) { /* private mode */ }

/* ---------- Data ---------- */
async function hydrate() {
  try {
    const [board, events, doctor] = await Promise.all([
      fetch("/api/board").then(function(r){ return r.json(); }),
      fetch("/api/events").then(function(r){ return r.json(); }),
      fetch("/api/doctor").then(function(r){ return r.json(); }),
    ]);
    state.cards = board.cards || [];
    state.wipLimits = board.wipLimits || {};
    state.backpressureActive = !!board.backpressureActive;
    state.events = events.events || [];
    state.verification = events.verification || null;
    state.doctor = doctor;
    render();
  } catch (err) {
    document.getElementById("stream-chip").textContent = "offline";
    document.getElementById("stream-chip").className = "chip fail";
  }
}

// The kernel is an event log, so the dashboard subscribes to it rather than
// re-fetching on a timer. Polling an append-only log is the wrong shape and
// destroys scroll position on every tick.
function connect() {
  const chip = document.getElementById("stream-chip");
  const es = new EventSource("/api/stream");

  es.addEventListener("open", function(){ chip.textContent = "live"; chip.className = "chip pass"; });
  es.addEventListener("append", function(ev){
    try {
      const payload = JSON.parse(ev.data);
      if (payload.events) { state.events = state.events.concat(payload.events).slice(-500); renderLog(); }
      if (payload.board) {
        state.cards = payload.board.cards || state.cards;
        state.wipLimits = payload.board.wipLimits || state.wipLimits;
        state.backpressureActive = !!payload.board.backpressureActive;
        renderBoard(); renderChrome();
      }
      if (payload.verification) { state.verification = payload.verification; renderChrome(); }
    } catch (e) { /* malformed frame */ }
  });
  es.addEventListener("error", function(){
    chip.textContent = "reconnecting"; chip.className = "chip warn";
  });
}

hydrate().then(connect);
</script>
</body>
</html>`;
}
