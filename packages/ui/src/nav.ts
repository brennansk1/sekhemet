/**
 * The dashboard's navigation and keymap, as pure data and functions
 * (dashboard §2.2.1, §2.3, change P11).
 *
 * One source for the sidebar, the phone's bottom bar, the `g` chords, the
 * cheat sheet and the palette's Go to group, so no two of them can disagree.
 * The browser imports the compiled module as `/app/lib/nav.js`, so it must
 * stay free of runtime imports.
 */

export type NavGroup = "workspace" | "project" | "more" | "bottom";

export interface NavItem {
  /** The nav item's name, which is also its route: `#/<name>`. */
  name: string;
  label: string;
  /** Secondary text after the label (Project manager · Seshat). */
  sub?: string;
  /** The bottom bar's one-word label. */
  short?: string;
  group: NavGroup;
  /** The letter after `g`. */
  chord: string;
  icon: string;
  route: string;
  /** Extra words the palette matches on. */
  search?: string;
  /** When the item is shown, beyond its view being mounted. */
  when?: (ctx: NavContext) => boolean;
}

/** What the page knows that decides which items show. */
export interface NavContext {
  /** The views the page mounts, by nav name; a view not built is never linked. */
  views: ReadonlySet<string>;
  /** The Team setup (DEC-35); Solo otherwise. */
  team: boolean;
  completedRuns: number;
  dependencyEdges: number;
  playbookEntries: number;
}

const item = (i: Omit<NavItem, "route">): NavItem => ({ ...i, route: `#/${i.name}` });

/** Top to bottom, as §2.2.1's table orders them. */
export const NAV_ITEMS: readonly NavItem[] = [
  item({
    name: "projects",
    label: "Projects",
    group: "workspace",
    chord: "w",
    icon: "layers",
    search: "Projects workspace all projects",
  }),
  item({
    name: "inbox",
    label: "Inbox",
    group: "workspace",
    chord: "x",
    icon: "inbox",
    search: "Inbox mentions review requests watching decisions questions waiting on you",
  }),
  item({
    name: "my-issues",
    label: "My issues",
    group: "workspace",
    chord: "y",
    icon: "user",
    search: "My issues assigned owned delegated review requested",
    when: (c) => c.team,
  }),
  item({
    name: "status",
    label: "Status",
    short: "Status",
    group: "project",
    chord: "s",
    icon: "check-circle",
    search: "Status how is it going health update",
  }),
  item({
    name: "board",
    label: "Board",
    short: "Board",
    group: "project",
    chord: "b",
    icon: "board",
  }),
  item({
    name: "review",
    label: "Review",
    short: "Review",
    group: "project",
    chord: "r",
    icon: "review",
  }),
  item({
    name: "pm",
    label: "Project manager",
    sub: "Seshat",
    short: "Seshat",
    group: "project",
    chord: "p",
    icon: "chat",
    search: "Seshat project manager pm conversation",
  }),
  item({
    name: "insights",
    label: "Insights",
    group: "project",
    chord: "i",
    icon: "insights",
    search: "Insights flow metrics cycle time throughput",
  }),
  item({
    name: "runs",
    label: "Runs",
    group: "more",
    chord: "u",
    icon: "runs",
    when: (c) => c.completedRuns > 0,
  }),
  item({
    name: "graph",
    label: "Dependencies",
    group: "more",
    chord: "d",
    icon: "link",
    search: "Dependencies graph waits on",
    when: (c) => c.dependencyEdges > 0,
  }),
  item({
    name: "playbook",
    label: "Playbook",
    group: "more",
    chord: "k",
    icon: "playbook",
    search: "Playbook rules suggestions",
    when: (c) => c.playbookEntries > 0,
  }),
  item({
    name: "integrations",
    label: "Integrations",
    group: "more",
    chord: "n",
    icon: "plug",
    search: "Integrations GitHub Jira Linear Slack import export",
  }),
  item({ name: "machine", label: "Machine", group: "more", chord: "m", icon: "machine" }),
  item({
    name: "ledger",
    label: "Activity log",
    group: "more",
    chord: "l",
    icon: "ledger",
    search: "Activity log history events",
  }),
  item({
    name: "configuration",
    label: "Configuration",
    group: "bottom",
    chord: "c",
    icon: "settings",
    search: "Configuration models benchmark settings preferences",
  }),
];

/** The phone's bottom bar, in order (§2.2.2). */
export const BOTTOM_BAR = ["status", "review", "board", "pm"] as const;

/**
 * The previous chords, kept working silently for one release (§2.3.1): they
 * are in no list, and they go only where the new chord would.
 */
export const LEGACY_CHORDS: Readonly<Record<string, string>> = {
  a: "pm",
  f: "insights",
  q: "runs",
  e: "configuration",
  ",": "configuration",
};

/** Old route names that open the nav item that replaced them (§2.2.1). */
export const ROUTE_ALIASES: Readonly<Record<string, string>> = {
  workspace: "projects",
  registry: "configuration",
  settings: "configuration",
};

/** The items to show, in order: mounted, and with something in them. */
export function visibleNav(ctx: NavContext): NavItem[] {
  return NAV_ITEMS.filter((i) => ctx.views.has(i.name) && (!i.when || i.when(ctx)));
}

/** The bottom bar's items, of those shown. */
export function bottomBar(visible: readonly NavItem[]): NavItem[] {
  return BOTTOM_BAR.map((n) => visible.find((i) => i.name === n)).filter(
    (i): i is NavItem => i !== undefined,
  );
}

/** Where `g` then `letter` goes, or nothing when the view is not shown. */
export function chordTarget(letter: string, visible: readonly NavItem[]): NavItem | undefined {
  const direct = visible.find((i) => i.chord === letter);
  if (direct) return direct;
  const legacy = LEGACY_CHORDS[letter];
  return legacy ? visible.find((i) => i.name === legacy) : undefined;
}

/** The nav item a route belongs to (`card` belongs to none). */
export function navNameOf(route: string): string {
  const name = ROUTE_ALIASES[route] ?? route;
  return NAV_ITEMS.some((i) => i.name === name) ? name : "";
}

export interface KeyRow {
  label: string;
  /** Keys pressed in sequence; `Mod+K` is ⌘K on a Mac and Ctrl+K elsewhere. */
  keys: string[];
}

export interface KeyGroup {
  name: string;
  /** The views it applies to; dimmed elsewhere. Absent: everywhere. */
  views?: string[];
  rows: KeyRow[];
  note?: string;
}

const rows = (list: [string, string[]][]): KeyRow[] =>
  list.map(([label, keys]) => ({ label, keys }));

/**
 * Every key the dashboard binds, apart from the `g` chords (which come from
 * {@link NAV_ITEMS}). The cheat sheet is generated from this; a key not in it
 * has no binding (§2.3.3). No bare `t` (§2.3.2).
 */
export const KEY_GROUPS: readonly KeyGroup[] = [
  {
    name: "Global",
    rows: rows([
      ["Command palette", ["Mod+K"]],
      ["Search issues", ["/"]],
      ["Keyboard shortcuts", ["?"]],
      ["Close or cancel", ["Esc"]],
    ]),
  },
  {
    name: "Inbox",
    views: ["inbox"],
    rows: rows([
      ["Next or previous item", ["j", "k"]],
      ["Open, or answer the picked option", ["↵"]],
      ["Done", ["e"]],
      ["Pick an option", ["1", "…", "9"]],
    ]),
  },
  {
    name: "Dependencies",
    views: ["graph"],
    rows: rows([
      ["Pan", ["drag"]],
      ["Zoom", ["+", "−"]],
      ["Fit the graph", ["f"]],
      ["Actual size", ["0"]],
      ["Open the focused issue", ["↵"]],
    ]),
  },
  {
    name: "Seshat · Project manager",
    rows: rows([
      ["Open or close the panel", ["Mod+J"]],
      ["Send", ["↵"]],
      ["New line", ["⇧", "↵"]],
      ["Mention an issue", ["@"]],
      ["Apply or discard a proposal", ["y", "n"]],
      ["Apply all in a group", ["⇧", "Y"]],
    ]),
  },
  {
    name: "Board",
    views: ["board"],
    rows: rows([
      ["Move between columns", ["h", "l"]],
      ["Move within a column", ["j", "k"]],
      ["First or last in column", ["Home", "End"]],
      ["Peek", ["Space"]],
      ["Open issue", ["↵"]],
      ["Select", ["x"]],
      ["Extend selection (list)", ["⇧", "J"]],
      ["Priority, points, labels", ["⇧", "P"]],
      ["Sprint, assignee", ["⇧", "C"]],
      ["Any field", ["."]],
      ["Board or list", ["v"]],
      ["Group into swimlanes", ["⇧", "S"]],
      ["Pipeline stages", ["⇧", "V"]],
      ["Filter", ["/"]],
      ["New issue", ["c"]],
    ]),
  },
  {
    name: "Review",
    views: ["review", "card"],
    rows: rows([
      ["Accept", ["a"]],
      ["Request changes", ["r"]],
      ["Put on hold", ["p"]],
      ["Acknowledge the focused finding", ["x"]],
      ["Undo accept", ["z"]],
      ["Next or previous issue", ["j", "k"]],
      ["Open issue", ["o"]],
      ["Previous or next attempt", ["[", "]"]],
      ["Next or previous annotation", ["n", "N"]],
      ["Expand file", ["Space"]],
      ["Unified or split diff", ["u"]],
      ["Details panel", ["f"]],
      ["Send the note", ["Mod+↵"]],
    ]),
  },
  {
    name: "Issue and lists",
    views: ["card", "ledger", "runs", "machine"],
    rows: rows([
      // The issue page's tabs (dashboard DB-N8-1), in `issue.ts` ISSUE_TABS order.
      ["Activity, Checks, Changes, AI review, Steps, Plan", ["1", "6"]],
      ["Next or previous tab", ["←", "→"]],
      ["Next or previous row", ["j", "k"]],
      ["Open Activity log entry", ["↵"]],
      ["Re-run health checks", ["⇧", "R"]],
    ]),
  },
];

/**
 * For one release, the chords that changed meaning say so (§2.3.1). `g s` was
 * Integrations; it is kept for Status and, until Status is shown, opens nothing,
 * so the note never announces a view that is not there.
 */
export function chordChangeNote(visible: readonly NavItem[]): string {
  const shown = (name: string) => visible.some((i) => i.name === name);
  // The moved views, each only while it is shown (Playbook waits for its first entry).
  const moved = (
    [
      ["integrations", "Integrations is g n"],
      ["playbook", "Playbook g k"],
      ["inbox", "Inbox g x"],
    ] as const
  )
    .filter(([name]) => shown(name))
    .map(([name, words], i) =>
      i === 0 && !shown("status") && name === "integrations"
        ? `${words} (g s opens nothing until Status is built)`
        : words,
    );
  const list =
    moved.length > 1 ? `${moved.slice(0, -1).join(", ")} and ${moved.at(-1)}` : (moved[0] ?? "");
  const head = shown("status")
    ? "Changed: g s is Status, g p the Project manager and g i Insights."
    : "Changed: g p is the Project manager and g i Insights.";
  return list ? `${head} ${list}.` : head;
}

/** The palette's Go to group: one entry per shown view, with its chord. */
export function paletteGoTo(visible: readonly NavItem[]): (KeyRow & NavItem)[] {
  return visible.map((i) => ({ ...i, keys: ["g", i.chord] }));
}

/** The cheat sheet: Global, then Navigate from the shown views, then the rest. */
export function cheatSheet(visible: readonly NavItem[]): KeyGroup[] {
  const [global, ...rest] = KEY_GROUPS as [KeyGroup, ...KeyGroup[]];
  const navigate: KeyGroup = {
    name: "Navigate",
    rows: paletteGoTo(visible).map((p) => ({ label: p.label, keys: p.keys })),
    note: chordChangeNote(visible),
  };
  return [global, navigate, ...rest];
}

/**
 * The Agent status line at the foot of the sidebar (§2.2.3, DB-N9-10): the
 * Agent's state in one line — *Agent working on CHR-12 · step 14 of 40*,
 * *Agent idle*, or *Agent paused after step 5 while Seshat replies*.
 */
/** One of Configuration's role rows (`GET /api/config/roles`), as far as readiness reads it. */
export interface RoleRowLike {
  role: string;
  /** The assigned model; absent when the role is not configured. */
  model?: string;
  /** The assigned model is verified for this role on this machine (qualified or overridden). */
  qualified?: boolean;
  /** The model the harness would use, and whether its file is here (undefined: not known). */
  effective?: { model?: string; present?: boolean };
}

/**
 * Whether the Coding model can run issues here (SHL-04, wave 8 B3): one fact,
 * read from Configuration's roles, for the sidebar, the *No Coding model*
 * bar, Status, Projects, the board's tiles and the issue page. Ready means
 * assigned (Configuration says it is configured), its file on this machine
 * when Configuration can tell, and verified here for the Coding role.
 */
export interface CodingModelFact {
  ready: boolean;
  /** The assigned Coding model, or null when none is. */
  model: string | null;
  /** Why it is not ready; null when it is. */
  why: "none" | "missing" | "unverified" | null;
}

export function codingModelFact(roles: readonly RoleRowLike[] | undefined): CodingModelFact {
  const w = roles?.find((r) => r.role === "worker");
  const model = w?.model ? String(w.model) : null;
  if (!w || !model) return { ready: false, model: null, why: "none" };
  if (w.effective?.model === model && w.effective.present === false)
    return { ready: false, model, why: "missing" };
  if (w.qualified !== true) return { ready: false, model, why: "unverified" };
  return { ready: true, model, why: null };
}

/** The fact in words, as the sidebar's model line says it and the other surfaces repeat. */
export function codingModelWords(f: CodingModelFact): string {
  if (f.why === "none" || !f.model) return "No Coding model set up";
  if (f.why === "missing") return `Coding model ${f.model} is not on this machine`;
  if (f.why === "unverified") return `Coding model ${f.model} is not verified on this machine`;
  return `Coding model ${f.model}`;
}

/** A Ready issue's state while no Coding model is ready: it waits for one, never *queued*. */
export const WAITS_FOR_CODING_MODEL =
  "Waiting for a Coding model: the Agent starts this issue once one is set up and verified on this machine.";

/**
 * A Ready issue the board would not start now (wave 9 A3): the unmet *Ready
 * to start* condition the start checks (`startBlocker`), never *queued*.
 */
export function waitsToStart(reason: string): string {
  const r = reason.trim().replace(/\.$/, "");
  return `Waiting to start: ${r.charAt(0).toLowerCase()}${r.slice(1)}. The Agent starts it once that is met.`;
}

/**
 * Where the viewer's own Agent issue stands in the Team queue, for the line
 * under the Agent status line (teams item 31, dashboard §2.2.3): its key and
 * place with an estimate (*CHR-14 · 2nd in queue, about 6 minutes*), or —
 * when it is next while another person's issue runs — *Priya's issue is
 * running; yours starts next*. Undefined when none of theirs waits.
 */
export function agentQueueLine(
  queue:
    | { cardId: string; place: number; message: string; runningFor?: string | undefined }
    | null
    | undefined,
  keyOf: (cardId: string) => string,
): string | undefined {
  if (!queue) return undefined;
  if (queue.place === 1 && queue.runningFor) {
    return `${queue.runningFor}'s issue is running; yours starts next`;
  }
  return `${keyOf(queue.cardId)} · ${queue.message}`;
}

/** A card as the Agent's work reads it: the board's card, or a view model's. */
export interface AgentCardLike {
  id: string;
  key?: string;
  status: string;
  tier?: string;
  /** A person's name or principal (a view model's), or the board's `{ kind, id }`. */
  delegate?: string | { kind: string; id?: string } | null;
  /** The server's fact: a runner or slot lease names the card, or its attempt is running. */
  liveRun?: boolean;
  updatedAt?: string;
  stepBudget?: number;
  display?: { shortId?: string; lastStep?: { turn?: number }; [field: string]: unknown };
}

/** The card is the Agent's to build, not a person's (no delegate, or the Worker). */
export const isAgentsCard = (c: Pick<AgentCardLike, "delegate">): boolean =>
  !c.delegate ||
  c.delegate === "worker" ||
  (typeof c.delegate === "object" && c.delegate.kind === "worker");

/**
 * What the Agent is doing, from one source (dashboard §2.1.6, §2.2.3; wave 2
 * A1, A2): `running` is every card a run backs (`liveRun`), whatever column
 * it is in, the most recently moved first, so every view that names one item
 * names the same one; `notRunning` is the Agent's cards stored In progress
 * with no run behind them, which no view may call working.
 */
export function agentWork<C extends AgentCardLike>(
  cards: readonly C[],
): { running: C[]; notRunning: C[] } {
  const isWork = (c: C) => !c.tier || c.tier === "story" || c.tier === "task";
  const recent = (a: C, b: C) => Date.parse(b.updatedAt ?? "") - Date.parse(a.updatedAt ?? "");
  const mine = cards.filter((c) => isWork(c) && isAgentsCard(c));
  return {
    running: mine.filter((c) => c.liveRun === true).sort(recent),
    notRunning: mine.filter((c) => c.status === "in_progress" && c.liveRun !== true).sort(recent),
  };
}

const keyOf = (c: AgentCardLike) => c.key ?? c.display?.shortId ?? c.id;

export function agentStatusLine(input: {
  running: readonly AgentCardLike[];
  notRunning?: readonly AgentCardLike[];
  pausedForSeshat?: { step?: number | undefined } | undefined;
}): { text: string; state: "working" | "idle" | "paused" } {
  if (input.pausedForSeshat) {
    const step = input.pausedForSeshat.step;
    return {
      text: `Agent paused${step ? ` after step ${step}` : ""} while Seshat replies`,
      state: "paused",
    };
  }
  const [only, ...rest] = input.running;
  if (!only) {
    // A card stored In progress with no run is named as such, never as work (A1).
    const stalled = input.notRunning ?? [];
    const [one] = stalled;
    if (!one) return { text: "Agent idle", state: "idle" };
    return {
      text:
        stalled.length === 1
          ? `Agent idle · ${keyOf(one)} is in progress with no run`
          : `Agent idle · ${stalled.length} issues are in progress with no run`,
      state: "idle",
    };
  }
  if (rest.length)
    return { text: `Agent working on ${input.running.length} issues`, state: "working" };
  const turn = only.display?.lastStep?.turn;
  const step =
    turn !== undefined
      ? ` · step ${turn}${only.stepBudget !== undefined ? ` of ${only.stepBudget}` : ""}`
      : "";
  return { text: `Agent working on ${keyOf(only)}${step}`, state: "working" };
}
