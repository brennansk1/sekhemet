import { escapeHtml } from "./card_tile.js";
import type { DagLayout } from "./dag_layout.js";

export interface Point {
  x: number;
  y: number;
}

/** screen = world * scale + offset */
export interface Viewport {
  x: number;
  y: number;
  scale: number;
}

export const MIN_SCALE = 0.25;
export const MAX_SCALE = 4;

export function worldToScreen(v: Viewport, p: Point): Point {
  return { x: p.x * v.scale + v.x, y: p.y * v.scale + v.y };
}

export function screenToWorld(v: Viewport, p: Point): Point {
  return { x: (p.x - v.x) / v.scale, y: (p.y - v.y) / v.scale };
}

export function pan(v: Viewport, dx: number, dy: number): Viewport {
  return { x: v.x + dx, y: v.y + dy, scale: v.scale };
}

/** Zoom by `factor`, keeping the world point under `anchor` fixed on screen. */
export function zoomAt(v: Viewport, factor: number, anchor: Point): Viewport {
  if (!(factor > 0)) throw new RangeError("zoom factor must be positive");
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, v.scale * factor));
  const world = screenToWorld(v, anchor);
  return { x: anchor.x - world.x * scale, y: anchor.y - world.y * scale, scale };
}

/** The topmost node under a screen point, or null. */
export function hitTest(layout: DagLayout, v: Viewport, screen: Point): string | null {
  const p = screenToWorld(v, screen);
  for (let i = layout.nodes.length - 1; i >= 0; i--) {
    const n = layout.nodes[i];
    if (n && n.x <= p.x && p.x < n.x + n.width && n.y <= p.y && p.y < n.y + n.height) {
      return n.id;
    }
  }
  return null;
}

export function renderDagSvg(layout: DagLayout, v: Viewport, selectedId: string | null): string {
  const edges = layout.edges.map((edge) => `<path class="edge" d="${edge.path}"/>`).join("");
  const nodes = layout.nodes
    .map((node) => {
      const id = escapeHtml(node.id);
      const cls = node.id === selectedId ? "node is-selected" : "node";
      return `<g class="${cls}" data-id="${id}"><rect x="${node.x}" y="${node.y}" width="${node.width}" height="${node.height}" rx="4"/><text x="${node.x + 8}" y="${node.y + node.height / 2}">${id}</text></g>`;
    })
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${layout.width}" height="${layout.height}"><g transform="translate(${v.x} ${v.y}) scale(${v.scale})">${edges}${nodes}</g></svg>`;
}
