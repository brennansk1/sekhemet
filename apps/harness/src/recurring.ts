import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import type { CardRecord, CardStore, EventLog } from "@sekhemet/kernel";
import { isAirgapped } from "./airgap.js";
import { isReserved, parseHours } from "./scheduler.js";

/**
 * Scheduled and recurring cards (X16, design "Scheduled and recurring
 * cards"). A card becomes a template when it carries a schedule (cron) or a
 * trigger (a webhook, a file change, a dependency release). Each firing
 * clones the template into a Ready card that inherits its acceptance tests,
 * criteria, scope and budget: its gates. Wake-ups inside the user's declared
 * hours wait for free hours unless the template is marked urgent.
 *
 * The schedule lives on the card as labels, so the board shows it and the
 * ledger records every change:
 *   template, schedule:<cron>, trigger:file:<glob>, trigger:release:npm:<pkg>,
 *   trigger:webhook:<name>, urgent
 * Firings, baselines and webhook triggers are ledger events.
 */

// ------------------------------------------------------------------- cron

const FIELDS = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "day of week", min: 0, max: 7 },
] as const;
const NAMES: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};
const MACROS: Record<string, string> = {
  "@hourly": "0 * * * *",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@weekly": "0 0 * * 0",
  "@monthly": "0 0 1 * *",
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
};

export interface Cron {
  sets: Set<number>[];
  /** Day of month and day of week both restricted: either matches (POSIX). */
  domStar: boolean;
  dowStar: boolean;
}

export function parseCron(expr: string): Cron {
  const parts = (MACROS[expr.trim()] ?? expr).trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`cron "${expr}" needs five fields`);
  const sets = parts.map((part, i) => {
    const f = FIELDS[i] as (typeof FIELDS)[number];
    const out = new Set<number>();
    for (const item of part.split(",")) {
      const m = /^(\*|[\w]+)(?:-([\w]+))?(?:\/(\d+))?$/.exec(item.toLowerCase());
      if (!m) throw new Error(`cron ${f.name} "${item}" is not valid`);
      const num = (s: string) => {
        const n = NAMES[s] ?? Number(s);
        if (!Number.isInteger(n) || n < f.min || n > f.max)
          throw new Error(`cron ${f.name} "${s}" is out of range ${f.min}-${f.max}`);
        return n;
      };
      const lo = m[1] === "*" ? f.min : num(m[1] as string);
      const hi = m[2] ? num(m[2]) : m[1] === "*" || m[3] ? f.max : lo;
      const step = m[3] ? Number(m[3]) : 1;
      if (step < 1) throw new Error(`cron ${f.name} step must be positive`);
      for (let v = lo; v <= hi; v += step) out.add(i === 4 && v === 7 ? 0 : v);
    }
    return out;
  });
  return { sets, domStar: parts[2] === "*", dowStar: parts[4] === "*" };
}

export function cronMatches(expr: string | Cron, at: Date): boolean {
  const c = typeof expr === "string" ? parseCron(expr) : expr;
  const [min, hour, dom, mon, dow] = c.sets as [
    Set<number>,
    Set<number>,
    Set<number>,
    Set<number>,
    Set<number>,
  ];
  if (!min.has(at.getMinutes()) || !hour.has(at.getHours()) || !mon.has(at.getMonth() + 1))
    return false;
  const d = dom.has(at.getDate());
  const w = dow.has(at.getDay());
  if (c.domStar || c.dowStar) return d && w;
  return d || w;
}

/** The first matching minute strictly after `after` (within a year and a day). */
export function nextRun(expr: string, after: Date): Date | undefined {
  const c = parseCron(expr);
  const t = new Date(after);
  t.setSeconds(0, 0);
  t.setMinutes(t.getMinutes() + 1);
  for (let i = 0; i < 366 * 24 * 60 + 1440; i++) {
    if (cronMatches(c, t)) return t;
    t.setMinutes(t.getMinutes() + 1);
  }
  return undefined;
}

// --------------------------------------------------------------- schedules

export interface Schedule {
  cron?: string;
  trigger?: string;
  urgent: boolean;
}

const OWN = /^(template|urgent|schedule:.*|trigger:.*)$/;

export function scheduleOf(card: Pick<CardRecord, "labels">): Schedule | undefined {
  const labels = card.labels ?? [];
  if (!labels.includes("template")) return undefined;
  const cron = labels.find((l) => l.startsWith("schedule:"))?.slice("schedule:".length);
  const trigger = labels.find((l) => l.startsWith("trigger:"))?.slice("trigger:".length);
  if (!cron && !trigger) return undefined;
  return {
    ...(cron ? { cron } : {}),
    ...(trigger ? { trigger } : {}),
    urgent: labels.includes("urgent"),
  };
}

const TRIGGER = /^(file:.+|release:npm:[@\w./-]+|webhook:[\w.-]+)$/;

/** Make a card a recurring template (`sekhemet schedule`). */
export async function scheduleCard(
  store: Pick<CardStore, "getCard" | "updateCard" | "updateCardStatus" | "recordEvent">,
  cardId: string,
  spec: { cron?: string; trigger?: string; urgent?: boolean },
  opts: { now?: Date } = {},
): Promise<CardRecord> {
  const card = await store.getCard(cardId);
  if (!card) throw new Error(`No card ${cardId}`);
  if (!spec.cron && !spec.trigger) throw new Error("a schedule needs --cron or --on");
  if (spec.cron) parseCron(spec.cron);
  if (spec.trigger && !TRIGGER.test(spec.trigger))
    throw new Error(
      `trigger "${spec.trigger}": use file:<glob>, release:npm:<package> or webhook:<name>`,
    );
  const labels = [
    ...(card.labels ?? []).filter((l) => !OWN.test(l)),
    "template",
    ...(spec.cron ? [`schedule:${spec.cron}`] : []),
    ...(spec.trigger ? [`trigger:${spec.trigger}`] : []),
    ...(spec.urgent ? ["urgent"] : []),
  ];
  await store.updateCard(cardId, { labels }, "human");
  // A template is not work itself: it waits in the backlog.
  if (card.status !== "backlog")
    await store.updateCardStatus(cardId, "backlog", "recurring template", "human");
  await store.recordEvent({
    type: "recurring/scheduled",
    cardId,
    actor: "human",
    payload: { ...spec, at: (opts.now ?? new Date()).toISOString() },
  });
  return (await store.getCard(cardId)) as CardRecord;
}

/** A webhook trigger (the dashboard's `POST /api/recurring/trigger/<name>`). */
export async function fireTrigger(
  log: EventLog,
  name: string,
  payload: Record<string, unknown> = {},
): Promise<void> {
  await log.append({
    actor: "system",
    type: "recurring/trigger",
    cardId: "board",
    payload: { ...payload, name, at: new Date().toISOString() },
  });
}

// -------------------------------------------------------------------- tick

export interface TickResult {
  fired: { template: string; cloneId: string; reason: string }[];
  deferred: { template: string; reason: string }[];
  skipped: { template: string; why: string }[];
}

export interface TickOptions {
  now?: Date;
  /** `[machine] hours`; unset means no reserved hours. */
  hours?: string;
  latestVersion?: (pkg: string) => Promise<string | undefined>;
}

interface Mark {
  at: string;
  head?: string;
  version?: string;
}

const run = promisify(execFile);

async function npmLatest(pkg: string): Promise<string | undefined> {
  try {
    const { stdout } = await run("npm", ["view", pkg, "version"], { timeout: 15_000 });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

function globRe(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string;
    if (c === "*" && glob[i + 1] === "*") {
      re += ".*";
      i++;
      if (glob[i + 1] === "/") i++;
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

function head(repo: string): string | undefined {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

function changedSince(repo: string, from: string, to: string): string[] {
  try {
    return execFileSync("git", ["diff", "--name-only", `${from}..${to}`], {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .split("\n")
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * One pass over the templates: fire what is due, defer what the declared
 * hours hold back, skip a template whose last clone is still open.
 * Called by the dashboard server every minute, by `sekhemet overnight`
 * before each round and by `sekhemet recurring tick`.
 */
export async function tickRecurring(
  repo: string,
  store: CardStore,
  log: EventLog,
  opts: TickOptions = {},
): Promise<TickResult> {
  const now = opts.now ?? new Date();
  const result: TickResult = { fired: [], deferred: [], skipped: [] };
  const reserved = opts.hours ? isReserved(parseHours(opts.hours), now) : false;
  const cards = await store.listCards();
  const templates = cards.filter((c) => scheduleOf(c));
  if (templates.length === 0) return result;
  const events = await log.getEventsByTypes([
    "recurring/scheduled",
    "recurring/fired",
    "recurring/baseline",
    "recurring/trigger",
  ]);
  const lastEvent = (type: string, cardId: string) =>
    events.filter((e) => e.type === type && e.cardId === cardId).at(-1);
  const latestOf = (type: string, cardId: string) =>
    lastEvent(type, cardId)?.payload as Mark | undefined;
  // Air-gapped, a release trigger never reaches the registry (X10).
  const version = opts.latestVersion ?? (isAirgapped(repo) ? async () => undefined : npmLatest);
  const tip = head(repo);

  for (const t of templates) {
    const s = scheduleOf(t) as Schedule;
    const fired = latestOf("recurring/fired", t.id);
    const scheduled = latestOf("recurring/scheduled", t.id);
    const baseline = latestOf("recurring/baseline", t.id);
    const since = new Date(fired?.at ?? scheduled?.at ?? t.createdAt);
    const mark: Mark = { at: now.toISOString() };
    let reason: string | undefined;

    if (s.cron) {
      const next = nextRun(s.cron, since);
      if (next && next <= now) reason = `schedule ${s.cron}`;
    }
    const trig = s.trigger ?? "";
    if (!reason && trig.startsWith("file:")) {
      const last = fired?.head ?? baseline?.head;
      if (tip) mark.head = tip;
      if (!last) {
        if (tip) await baselineEvent(log, t.id, { at: mark.at, head: tip });
      } else if (tip && last !== tip) {
        const re = globRe(trig.slice(5));
        const hit = changedSince(repo, last, tip).filter((f) => re.test(f));
        if (hit.length) reason = `file change: ${hit.slice(0, 3).join(", ")}`;
      }
    }
    if (!reason && trig.startsWith("release:npm:")) {
      const pkg = trig.slice("release:npm:".length);
      const v = await version(pkg);
      const last = fired?.version ?? baseline?.version;
      if (v) mark.version = v;
      if (v && !last) await baselineEvent(log, t.id, { at: mark.at, version: v });
      else if (v && last && v !== last) reason = `release npm:${pkg} ${v}`;
    }
    if (!reason && trig.startsWith("webhook:")) {
      const name = trig.slice("webhook:".length);
      // Ledger order, not clocks: a trigger after the last firing (or the scheduling).
      const after =
        (lastEvent("recurring/fired", t.id) ?? lastEvent("recurring/scheduled", t.id))?.seq ?? 0;
      const hit = events.find(
        (e) =>
          e.type === "recurring/trigger" &&
          (e.payload as { name?: string }).name === name &&
          e.seq > after,
      );
      if (hit) reason = `webhook ${name}`;
    }
    if (!reason) continue;

    const open = cards.find(
      (c) =>
        (c.labels ?? []).includes(`recurring:${t.id}`) && !["done", "rejected"].includes(c.status),
    );
    if (open) {
      result.skipped.push({ template: t.id, why: `${open.id} is still open` });
      continue;
    }
    if (reserved && !s.urgent) {
      result.deferred.push({ template: t.id, reason });
      continue;
    }
    const clone = await store.createCard(
      {
        tier: t.tier,
        title: `${t.title} (${now.toISOString().slice(0, 10)})`,
        status: "ready",
        scopeFiles: t.scopeFiles,
        stepBudget: t.stepBudget,
        ...(t.spec !== undefined ? { spec: t.spec } : {}),
        ...(t.acceptanceCriteria ? { acceptanceCriteria: t.acceptanceCriteria } : {}),
        ...(t.acceptanceTests ? { acceptanceTests: t.acceptanceTests } : {}),
        ...(t.difficulty !== undefined ? { difficulty: t.difficulty } : {}),
        ...(t.tokenBudget !== undefined ? { tokenBudget: t.tokenBudget } : {}),
        ...(t.modelRoute ? { modelRoute: t.modelRoute } : {}),
        ...(t.priority !== undefined ? { priority: s.urgent ? 1 : t.priority } : {}),
        ...(t.parentId ? { parentId: t.parentId } : {}),
        labels: [...(t.labels ?? []).filter((l) => !OWN.test(l)), `recurring:${t.id}`],
      },
      "system",
    );
    await log.append({
      actor: "system",
      type: "recurring/fired",
      cardId: t.id,
      payload: { ...mark, cloneId: clone.id, reason },
    });
    result.fired.push({ template: t.id, cloneId: clone.id, reason });
  }
  return result;
}

async function baselineEvent(log: EventLog, cardId: string, mark: Mark): Promise<void> {
  await log.append({ actor: "system", type: "recurring/baseline", cardId, payload: mark });
}

/** `sekhemet schedule` / `sekhemet recurring`: the CLI. */
export async function recurringCommand(
  repo: string,
  args: string[],
  deps: { store: CardStore; log: EventLog; hours?: string; print: (l: string) => void },
): Promise<number> {
  const flag = (n: string) => {
    const i = args.indexOf(n);
    return i === -1 ? undefined : args[i + 1];
  };
  const [sub, id] = args;
  if (sub === "add" && id) {
    const cron = flag("--cron");
    const trigger = flag("--on");
    const card = await scheduleCard(deps.store, id, {
      ...(cron ? { cron } : {}),
      ...(trigger ? { trigger } : {}),
      urgent: args.includes("--urgent"),
    });
    const s = scheduleOf(card);
    deps.print(
      `${id} is a recurring template: ${s?.cron ? `cron ${s.cron}` : `on ${s?.trigger}`}${s?.urgent ? " (urgent)" : ""}.`,
    );
    return 0;
  }
  if (sub === "trigger" && id) {
    await fireTrigger(deps.log, id, { by: "cli" });
    deps.print(`Fired webhook trigger ${id}.`);
    return 0;
  }
  if (sub === "list") {
    for (const c of await deps.store.listCards()) {
      const s = scheduleOf(c);
      if (!s) continue;
      const next = s.cron ? nextRun(s.cron, new Date())?.toISOString() : undefined;
      deps.print(
        `${c.id}  ${s.cron ? `cron "${s.cron}"${next ? ` next ${next}` : ""}` : `on ${s.trigger}`}${s.urgent ? "  urgent" : ""}  ${c.title}`,
      );
    }
    return 0;
  }
  if (sub === "tick") {
    const r = await tickRecurring(repo, deps.store, deps.log, {
      ...(deps.hours ? { hours: deps.hours } : {}),
    });
    for (const f of r.fired) deps.print(`fired ${f.template} -> ${f.cloneId} (${f.reason})`);
    for (const d of r.deferred)
      deps.print(`deferred ${d.template} (${d.reason}): reserved hours, not urgent`);
    for (const s of r.skipped) deps.print(`skipped ${s.template}: ${s.why}`);
    if (!r.fired.length && !r.deferred.length && !r.skipped.length) deps.print("Nothing due.");
    return 0;
  }
  deps.print(
    "Usage: sekhemet recurring add <card> (--cron '<expr>' | --on file:<glob>|release:npm:<pkg>|webhook:<name>) [--urgent] | list | tick | trigger <name>",
  );
  return 1;
}
