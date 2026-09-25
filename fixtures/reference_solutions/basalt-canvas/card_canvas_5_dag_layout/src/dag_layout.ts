import type { DagEdge, DagNode } from "./tokens.js";

/** `from` is the dependency; `to` depends on it. */
export interface EdgeInput {
  from: string;
  to: string;
}

export interface LayoutOptions {
  nodeWidth?: number;
  nodeHeight?: number;
  rankGap?: number;
  nodeGap?: number;
}

export interface DagLayout {
  nodes: DagNode[];
  edges: DagEdge[];
  width: number;
  height: number;
}

/** Longest-path ranks; throws on an unknown node or a cycle. */
export function computeRanks(ids: string[], edges: EdgeInput[]): Map<string, number> {
  const known = new Set(ids);
  const incoming = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const edge of edges) {
    if (!known.has(edge.from)) throw new Error(`unknown node: ${edge.from}`);
    if (!known.has(edge.to)) throw new Error(`unknown node: ${edge.to}`);
    incoming.get(edge.to)?.push(edge.from);
  }
  const ranks = new Map<string, number>();
  const visiting = new Set<string>();
  const rankOf = (id: string): number => {
    const done = ranks.get(id);
    if (done !== undefined) return done;
    if (visiting.has(id)) throw new Error("cycle detected");
    visiting.add(id);
    let rank = 0;
    for (const from of incoming.get(id) ?? []) rank = Math.max(rank, rankOf(from) + 1);
    visiting.delete(id);
    ranks.set(id, rank);
    return rank;
  };
  for (const id of ids) rankOf(id);
  return new Map(ids.map((id) => [id, ranks.get(id) ?? 0]));
}

export function bezierPath(x1: number, y1: number, x2: number, y2: number): string {
  const mx = (x1 + x2) / 2;
  return `M ${x1} ${y1} C ${mx} ${y1} ${mx} ${y2} ${x2} ${y2}`;
}

export function layoutDag(
  ids: string[],
  edges: EdgeInput[],
  options: LayoutOptions = {},
): DagLayout {
  const nodeWidth = options.nodeWidth ?? 160;
  const nodeHeight = options.nodeHeight ?? 40;
  const rankGap = options.rankGap ?? 80;
  const nodeGap = options.nodeGap ?? 24;
  const ranks = computeRanks(ids, edges);
  if (ids.length === 0) return { nodes: [], edges: [], width: 0, height: 0 };

  const perRank = new Map<number, number>();
  const nodes: DagNode[] = ids.map((id) => {
    const rank = ranks.get(id) ?? 0;
    const order = perRank.get(rank) ?? 0;
    perRank.set(rank, order + 1);
    return {
      id,
      rank,
      order,
      x: rank * (nodeWidth + rankGap),
      y: order * (nodeHeight + nodeGap),
      width: nodeWidth,
      height: nodeHeight,
    };
  });
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const laidEdges: DagEdge[] = edges.map((edge) => {
    const from = byId.get(edge.from) as DagNode;
    const to = byId.get(edge.to) as DagNode;
    return {
      from: edge.from,
      to: edge.to,
      path: bezierPath(from.x + nodeWidth, from.y + nodeHeight / 2, to.x, to.y + nodeHeight / 2),
    };
  });
  const rankCount = Math.max(...nodes.map((n) => n.rank)) + 1;
  const rows = Math.max(...perRank.values());
  return {
    nodes,
    edges: laidEdges,
    width: rankCount * nodeWidth + (rankCount - 1) * rankGap,
    height: rows * nodeHeight + (rows - 1) * nodeGap,
  };
}
