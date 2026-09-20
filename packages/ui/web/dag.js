// Pure layout for the dependency graph (U17): cards in layers by their longest
// dependency chain, edges from each dependency to its dependant. No DOM here,
// so the tests import it as-is.

export const NODE_W = 216;
export const NODE_H = 56;
const COL_GAP = 72;
const ROW_GAP = 16;

const STATUS_ORDER = [
  "in_progress",
  "verify",
  "review",
  "planning",
  "ready",
  "parked",
  "backlog",
  "done",
  "rejected",
];

/**
 * @param {{id: string, status: string, dependsOn?: string[]}[]} cards
 * @returns {{nodes: {id, x, y, layer}[], edges: {from, to, done: boolean}[], width, height, cycles: string[]}}
 */
export function layoutDag(cards) {
  const byId = new Map(cards.map((c) => [c.id, c]));
  const deps = (c) => (c.dependsOn ?? []).filter((d) => byId.has(d));
  const layer = new Map();
  const cycles = [];
  const visiting = new Set();
  const depth = (id) => {
    if (layer.has(id)) return layer.get(id);
    if (visiting.has(id)) {
      cycles.push(id);
      return 0;
    }
    visiting.add(id);
    const c = byId.get(id);
    const d = deps(c).reduce((m, x) => Math.max(m, depth(x) + 1), 0);
    visiting.delete(id);
    layer.set(id, d);
    return d;
  };
  for (const c of cards) depth(c.id);
  const layers = [];
  for (const c of cards) {
    const l = layer.get(c.id) ?? 0;
    (layers[l] ??= []).push(c);
  }
  const rank = (s) => {
    const i = STATUS_ORDER.indexOf(s);
    return i === -1 ? STATUS_ORDER.length : i;
  };
  const nodes = [];
  const pos = new Map();
  let height = 0;
  layers.forEach((list = [], l) => {
    // Within a layer: keep dependants near the average row of what they wait on.
    const weight = (c) => {
      const rows = deps(c)
        .map((d) => pos.get(d)?.row)
        .filter((r) => r !== undefined);
      return rows.length ? rows.reduce((a, b) => a + b, 0) / rows.length : Number.POSITIVE_INFINITY;
    };
    list.sort(
      (a, b) =>
        weight(a) - weight(b) || rank(a.status) - rank(b.status) || a.id.localeCompare(b.id),
    );
    list.forEach((c, row) => {
      const x = l * (NODE_W + COL_GAP);
      const y = row * (NODE_H + ROW_GAP);
      pos.set(c.id, { row, x, y });
      nodes.push({ id: c.id, x, y, layer: l });
      height = Math.max(height, y + NODE_H);
    });
  });
  const edges = [];
  for (const c of cards)
    for (const d of deps(c))
      edges.push({ from: d, to: c.id, done: byId.get(d)?.status === "done" });
  return {
    nodes,
    edges,
    width: Math.max(0, layers.length * (NODE_W + COL_GAP) - COL_GAP),
    height,
    cycles,
  };
}

/** Zoom about a point: returns the new {x, y, k} view transform. */
export function zoomAt(view, factor, px, py, min = 0.2, max = 2.5) {
  const k = Math.min(max, Math.max(min, view.k * factor));
  const f = k / view.k;
  return { k, x: px - (px - view.x) * f, y: py - (py - view.y) * f };
}

/** The transform that fits a `w`×`h` graph into a `vw`×`vh` viewport. */
export function fitView(w, h, vw, vh, pad = 32) {
  if (w <= 0 || h <= 0) return { x: pad, y: pad, k: 1 };
  const k = Math.min(1.25, Math.max(0.2, Math.min((vw - 2 * pad) / w, (vh - 2 * pad) / h)));
  return { k, x: (vw - w * k) / 2, y: Math.max(pad, (vh - h * k) / 2) };
}
