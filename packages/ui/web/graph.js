// Dependencies (U17): a pan-and-zoom graph of the cards and what each waits on.
// Drag to pan, wheel or pinch to zoom, `f` fits, `0` resets, `+`/`-` zoom,
// Enter on a focused node opens the card.
import { NODE_H, NODE_W, fitView, layoutDag, zoomAt } from "./dag.js";
import { $, esc } from "./dom.js";
import { columnLabel, parseTitle } from "./lib/vocabulary.js";
import { setTopbar } from "./shell.js";
import { store } from "./store.js";

const ui = { root: null, view: null, fitted: false, drag: null, last: "", layout: null };

const TONE = {
  in_progress: "running",
  verify: "running",
  review: "pass",
  done: "done",
  parked: "parked",
  rejected: "fail",
};

function titleOf(c) {
  return c.display?.title ?? parseTitle(c.title).title;
}

function clip(s, n) {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function edgePath(a, b) {
  const x1 = a.x + NODE_W;
  const y1 = a.y + NODE_H / 2;
  const x2 = b.x;
  const y2 = b.y + NODE_H / 2;
  const mx = (x1 + x2) / 2;
  return `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`;
}

function svgHtml(cards) {
  const lay = layoutDag(cards);
  ui.layout = lay;
  const at = new Map(lay.nodes.map((n) => [n.id, n]));
  const byId = new Map(cards.map((c) => [c.id, c]));
  const edges = lay.edges
    .map(
      (e) =>
        `<path class="dg-e${e.done ? " done" : ""}" d="${edgePath(at.get(e.from), at.get(e.to))}" marker-end="url(#dg-arrow)"/>`,
    )
    .join("");
  const nodes = lay.nodes
    .map((n) => {
      const c = byId.get(n.id);
      const tone = TONE[c.status] ?? "idle";
      const waits = (c.dependsOn ?? []).filter(
        (d) => byId.get(d) && byId.get(d).status !== "done",
      ).length;
      return `<g class="dg-n ${tone}" transform="translate(${n.x},${n.y})" data-id="${esc(c.id)}" tabindex="-1" role="link" aria-label="${esc(`${titleOf(c)}, ${columnLabel(c.status)}${waits ? `, waits on ${waits}` : ""}`)}"><rect width="${NODE_W}" height="${NODE_H}" rx="6"/><circle class="dot" cx="14" cy="18" r="4"/><text class="t" x="26" y="22">${esc(clip(titleOf(c), 28))}</text><text class="s" x="14" y="42">${esc(columnLabel(c.status))}${waits ? ` · waits on ${waits}` : ""}</text></g>`;
    })
    .join("");
  return {
    lay,
    html: `<svg class="dg-svg" role="img" aria-label="Card dependency graph"><defs><marker id="dg-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0,0 L8,4 L0,8 z"/></marker></defs><g class="dg-world">${edges}${nodes}</g></svg>`,
  };
}

function apply() {
  const g = $(".dg-world", ui.root);
  if (g && ui.view)
    g.setAttribute("transform", `translate(${ui.view.x},${ui.view.y}) scale(${ui.view.k})`);
  const z = $(".dg-zoom", ui.root);
  if (z && ui.view) z.textContent = `${Math.round(ui.view.k * 100)}%`;
}

function fit() {
  const host = $(".dg-host", ui.root);
  if (!host || !ui.layout) return;
  ui.view = fitView(ui.layout.width, ui.layout.height, host.clientWidth, host.clientHeight);
  apply();
}

function render() {
  if (!ui.root) return;
  const cards = store.state.cards.filter((c) => c.status !== "rejected");
  const linked = cards.filter(
    (c) => (c.dependsOn ?? []).length || cards.some((o) => (o.dependsOn ?? []).includes(c.id)),
  );
  setTopbar({
    title: "Dependencies",
    crumb: `${store.state.meta?.project ?? ""} · ${linked.length} of ${cards.length} cards linked`,
  });
  const shown = linked.length ? linked : cards;
  const { html, lay } = svgHtml(shown);
  const key = html;
  if (key === ui.last) return;
  ui.last = key;
  const host = $(".dg-host", ui.root);
  host.innerHTML = shown.length
    ? html
    : '<div class="ib-empty"><b>No cards yet.</b><span>Cards and the cards they wait on appear here as a graph.</span></div>';
  const note = $(".dg-note", ui.root);
  note.textContent = lay.cycles.length
    ? `A dependency loop runs through ${lay.cycles.length} card(s); Sekhemet refuses to add another.`
    : linked.length
      ? "Arrows point from a card to the cards that wait on it. Faded arrows are satisfied."
      : "No card depends on another yet, so every card stands alone.";
  if (!ui.fitted || !ui.view) {
    ui.fitted = true;
    fit();
  } else apply();
}

function onWheel(e) {
  e.preventDefault();
  const host = $(".dg-host", ui.root);
  const r = host.getBoundingClientRect();
  const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015));
  ui.view = zoomAt(ui.view, factor, e.clientX - r.left, e.clientY - r.top);
  apply();
}

function focusNode(id) {
  const n = ui.root.querySelector(`.dg-n[data-id="${CSS.escape(id)}"]`);
  for (const x of ui.root.querySelectorAll(".dg-n"))
    x.setAttribute("tabindex", x === n ? "0" : "-1");
  n?.focus();
  store.state.focusedId = id;
}

export function onKey(e) {
  const host = $(".dg-host", ui.root);
  const cx = host.clientWidth / 2;
  const cy = host.clientHeight / 2;
  if (e.key === "f") fit();
  else if (e.key === "0") {
    ui.view = { x: 32, y: 32, k: 1 };
    apply();
  } else if (e.key === "+" || e.key === "=") {
    ui.view = zoomAt(ui.view, 1.2, cx, cy);
    apply();
  } else if (e.key === "-") {
    ui.view = zoomAt(ui.view, 1 / 1.2, cx, cy);
    apply();
  } else if (e.key === "Enter" && store.state.focusedId) {
    location.hash = `#/card/${encodeURIComponent(store.state.focusedId)}/evidence`;
  } else if (/^[hjkl]$|^Arrow/.test(e.key) && ui.layout?.nodes.length) {
    const nodes = ui.layout.nodes;
    const cur = nodes.find((n) => n.id === store.state.focusedId) ?? nodes[0];
    const dir = {
      h: [-1, 0],
      l: [1, 0],
      j: [0, 1],
      k: [0, -1],
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowDown: [0, 1],
      ArrowUp: [0, -1],
    }[e.key];
    const next = nodes
      .filter((n) =>
        dir[0]
          ? Math.sign(n.x - cur.x) === dir[0]
          : n.x === cur.x && Math.sign(n.y - cur.y) === dir[1],
      )
      .sort(
        (a, b) =>
          Math.abs(a.x - cur.x) +
          Math.abs(a.y - cur.y) -
          (Math.abs(b.x - cur.x) + Math.abs(b.y - cur.y)),
      )[0];
    focusNode((next ?? cur).id);
  } else return false;
  return true;
}

export function mount(view) {
  const root = document.createElement("div");
  root.className = "view-host";
  root.innerHTML = `<section class="dg-view" aria-label="Dependencies"><div class="dg-bar"><span class="dg-note sec"></span><span class="dg-tools"><button class="btn ghost sm" type="button" data-zoom="out" aria-label="Zoom out">−</button><span class="dg-zoom tnum sec">100%</span><button class="btn ghost sm" type="button" data-zoom="in" aria-label="Zoom in">+</button><button class="btn sm" type="button" data-zoom="fit">Fit<kbd>F</kbd></button></span></div><div class="dg-host"></div></section>`;
  view.append(root);
  ui.root = root;
  ui.last = "";
  ui.fitted = false;
  const host = $(".dg-host", root);
  host.addEventListener("wheel", onWheel, { passive: false });
  host.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    const node = e.target instanceof Element ? e.target.closest(".dg-n") : null;
    ui.drag = {
      x: e.clientX,
      y: e.clientY,
      vx: ui.view.x,
      vy: ui.view.y,
      moved: false,
      node: node?.dataset.id,
    };
    host.setPointerCapture(e.pointerId);
  });
  host.addEventListener("pointermove", (e) => {
    if (!ui.drag) return;
    const dx = e.clientX - ui.drag.x;
    const dy = e.clientY - ui.drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) ui.drag.moved = true;
    if (!ui.drag.moved) return;
    host.classList.add("panning");
    ui.view = { ...ui.view, x: ui.drag.vx + dx, y: ui.drag.vy + dy };
    apply();
  });
  host.addEventListener("pointerup", () => {
    const d = ui.drag;
    ui.drag = null;
    host.classList.remove("panning");
    if (d && !d.moved && d.node) location.hash = `#/card/${encodeURIComponent(d.node)}/evidence`;
  });
  root.addEventListener("click", (e) => {
    const b = e.target instanceof Element ? e.target.closest("[data-zoom]") : null;
    if (!b) return;
    const cx = host.clientWidth / 2;
    const cy = host.clientHeight / 2;
    if (b.dataset.zoom === "fit") fit();
    else ui.view = zoomAt(ui.view, b.dataset.zoom === "in" ? 1.2 : 1 / 1.2, cx, cy);
    apply();
  });
  const unsub = store.on((_s, patch) => {
    if ("cards" in patch) render();
  });
  const onResize = () => fit();
  window.addEventListener("resize", onResize);
  render();
  return {
    onKey,
    unmount() {
      unsub();
      window.removeEventListener("resize", onResize);
      root.remove();
      ui.root = null;
    },
  };
}
