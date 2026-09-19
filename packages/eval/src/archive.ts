import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Variant archives (E13, loop 7, after the Darwin Gödel Machine's open-ended
 * archive): every harness variant that was evaluated is kept with its
 * parent, its configuration and its scores, never only the current best.
 * A new variant is bred from a parent chosen for score and novelty, so a
 * stepping stone that scored lower but differs can still lead somewhere.
 * Deterministic selection (seeded), JSON-persisted.
 */
export interface Variant {
  id: string;
  parentId?: string;
  description: string;
  /** What differs from the base harness: prompt section, budget, rule set, arm. */
  config: Record<string, string | number | boolean>;
  /** Pass rate per suite, in [0, 1]. */
  scores: Record<string, number>;
  createdAt: string;
  /** Times it has been chosen as a parent. */
  children: number;
}

function mean(v: Record<string, number>): number {
  const xs = Object.values(v);
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

/** Share of config keys whose values differ (0 identical .. 1 disjoint). */
export function configDistance(a: Variant["config"], b: Variant["config"]): number {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  if (keys.size === 0) return 0;
  let diff = 0;
  for (const k of keys) if (a[k] !== b[k]) diff++;
  return diff / keys.size;
}

export class VariantArchive {
  private variants: Variant[];

  constructor(
    private readonly path: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.variants = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Variant[]) : [];
  }

  public all(): Variant[] {
    return [...this.variants];
  }

  public get(id: string): Variant | undefined {
    return this.variants.find((v) => v.id === id);
  }

  public add(input: Omit<Variant, "id" | "createdAt" | "children"> & { id?: string }): Variant {
    if (input.parentId && !this.get(input.parentId))
      throw new Error(`Unknown parent ${input.parentId}`);
    const id =
      input.id ??
      `var_${createHash("sha256")
        .update(JSON.stringify([input.parentId ?? "", input.config]))
        .digest("hex")
        .slice(0, 10)}`;
    if (this.get(id)) throw new Error(`Variant ${id} is already archived`);
    const v: Variant = { ...input, id, createdAt: this.now().toISOString(), children: 0 };
    this.variants.push(v);
    this.save();
    return v;
  }

  public score(id: string, suite: string, passRate: number): void {
    const v = this.get(id);
    if (!v) throw new Error(`Unknown variant ${id}`);
    v.scores[suite] = passRate;
    this.save();
  }

  /** Root-to-variant lineage. */
  public lineage(id: string): Variant[] {
    const out: Variant[] = [];
    let cur = this.get(id);
    while (cur) {
      out.unshift(cur);
      cur = cur.parentId ? this.get(cur.parentId) : undefined;
    }
    return out;
  }

  public best(): Variant | undefined {
    return [...this.variants].sort(
      (a, b) => mean(b.scores) - mean(a.scores) || a.id.localeCompare(b.id),
    )[0];
  }

  /**
   * Choose a parent: score x (1 + novelty) / (1 + children), where novelty
   * is the mean config distance to the rest of the archive. Sampling is
   * proportional and seeded, so a run is reproducible.
   */
  public selectParent(seed: number): Variant | undefined {
    if (this.variants.length === 0) return undefined;
    const weights = this.variants.map((v) => {
      const others = this.variants.filter((o) => o !== v);
      const novelty = others.length
        ? others.reduce((a, o) => a + configDistance(v.config, o.config), 0) / others.length
        : 0;
      return (Math.max(1e-6, mean(v.scores)) * (1 + novelty)) / (1 + v.children);
    });
    const total = weights.reduce((a, b) => a + b, 0);
    // Mulberry32 from the seed.
    let t = (seed >>> 0) + 0x6d2b79f5;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    const r = (((t ^ (t >>> 14)) >>> 0) / 4294967296) * total;
    let acc = 0;
    for (let i = 0; i < weights.length; i++) {
      acc += weights[i] as number;
      if (r < acc) {
        const chosen = this.variants[i] as Variant;
        chosen.children++;
        this.save();
        return chosen;
      }
    }
    return this.variants[this.variants.length - 1];
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.variants, null, 2)}\n`);
    renameSync(tmp, this.path);
  }
}
