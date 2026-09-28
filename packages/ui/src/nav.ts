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
    search: "Inbox decisions questions waiting on you",
  }),
  item({
    name: "my-issues",
    label: "My issues",
    group: "workspace",
    chord: "y",
    icon: "user",
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
    short: "PM",
    group: "project",
    chord: "p",
    icon: "chat",
    search: "Seshat PM project manager conversation",
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
  item({ name: "ledger", label: "Ledger", group: "more", chord: "l", icon: "ledger" }),
  item({
    name: "configuration",
    label: "Configuration",
    group: "bottom",
    chord: "c",
    icon: "settings",
    search: "Configuration models registry benchmark settings",
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
      ["Pick an option", ["1", "…", "9"]],
      ["Answer", ["↵"]],
      ["Next or previous request", ["j", "k"]],
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
      ["Send back", ["r"]],
      ["Park", ["p"]],
      ["Acknowledge the focused finding", ["x"]],
      ["Undo accept", ["z"]],
      ["Next or previous issue", ["j", "k"]],
      ["Open issue", ["o"]],
      ["Previous or next attempt", ["[", "]"]],
      ["Next or previous annotation", ["n", "N"]],
      ["Expand file", ["Space"]],
      ["Unified or split diff", ["u"]],
      ["Facts rail", ["f"]],
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
      ["Open ledger entry", ["↵"]],
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
  const status = visible.some((i) => i.name === "status");
  return status
    ? "Changed: g s is Status, g p the Project manager and g i Insights. Integrations is g n, Playbook g k and Inbox g x."
    : "Changed: g p is the Project manager and g i Insights. Integrations is g n (g s opens nothing until Status is built), Playbook g k and Inbox g x.";
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
