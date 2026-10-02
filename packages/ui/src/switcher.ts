/**
 * The shell's two switchers (dashboard §2.2 item 7, NEW-dashboard-25,
 * DB-N25-1..3; DEC-57; FINDINGS SHL-01, STA-07) and the one sentence a view
 * shows when a read fails (FINDINGS ERR-04), as pure models with exact
 * outputs. `web/shell.js` and `web/account.js` render them; the browser
 * loads the compiled module as `/app/lib/switcher.js`, so it stays free of
 * runtime imports.
 */

/** A project the person can see, as `GET /api/projects/overview` lists it. */
export interface SwitcherProject {
  id: string;
  name: string;
  state?: string;
  /** Where its repository is on the server: the switcher's tooltip, never the sidebar. */
  rootPath?: string;
}

export interface ProjectSwitcherRow {
  id: string;
  name: string;
  /** The project's state in words, and its folder when two projects share a name. */
  detail: string;
  initials: string;
  current: boolean;
}

export interface ProjectSwitcherView {
  /** The current project's name, as the sidebar shows it. */
  label: string;
  initials: string;
  /** The button's tooltip: the name and, after it, the repository's path. */
  title: string;
  rows: ProjectSwitcherRow[];
  /** *New project* at the list's foot, for a person who may create one. */
  newProject: { label: string } | null;
  /** Nothing matches what the person typed. */
  empty?: string;
}

const STATE_WORDS: Record<string, string> = {
  active: "Active",
  idle: "Idle",
  done: "Done",
  paused: "Paused",
  archived: "Archived",
};

/** The project's initials badge: the first letters of its first two words. */
export function projectInitials(name: string): string {
  const words = name
    .trim()
    .split(/[\s_-]+/)
    .filter(Boolean);
  const letters = words
    .slice(0, 2)
    .map((w) => w[0] ?? "")
    .join("");
  return letters.toUpperCase() || "?";
}

const folderOf = (path: string | undefined) =>
  (path ?? "")
    .replace(/[\\/]+$/, "")
    .split(/[\\/]/)
    .pop() ?? "";

/**
 * The project switcher (DB-N25-1, -2): the current project's badge and name
 * — the first project the person can see while none is chosen — and the
 * list, the current one first, then by name; filtered as the person types;
 * two projects of one name told apart by their folders (STA-07).
 */
export function projectSwitcher(
  projects: readonly SwitcherProject[],
  current: string | null | undefined,
  opts: { canCreate: boolean; filter?: string },
): ProjectSwitcherView {
  const named = new Map<string, number>();
  for (const p of projects) named.set(p.name, (named.get(p.name) ?? 0) + 1);
  const chosen = projects.find((p) => p.id === current) ?? projects[0];
  const q = (opts.filter ?? "").trim().toLowerCase();
  const rows = [...projects]
    .sort((a, b) => {
      if (a.id === chosen?.id) return -1;
      if (b.id === chosen?.id) return 1;
      return (
        a.name.localeCompare(b.name) || folderOf(a.rootPath).localeCompare(folderOf(b.rootPath))
      );
    })
    .filter((p) => !q || p.name.toLowerCase().includes(q))
    .map((p) => {
      const state = STATE_WORDS[p.state ?? ""] ?? "";
      const folder = (named.get(p.name) ?? 0) > 1 ? folderOf(p.rootPath) : "";
      return {
        id: p.id,
        name: p.name,
        detail: [state, folder].filter(Boolean).join(" · "),
        initials: projectInitials(p.name),
        current: p.id === chosen?.id,
      };
    });
  const label = chosen?.name ?? "No project yet";
  return {
    label,
    initials: chosen ? projectInitials(chosen.name) : "?",
    title: chosen?.rootPath ? `${label} · ${chosen.rootPath}` : label,
    rows,
    newProject: opts.canCreate ? { label: "New project" } : null,
    ...(q && rows.length === 0 ? { empty: `No project matches “${opts.filter?.trim()}”.` } : {}),
  };
}

/** One workspace this machine's person has used (`GET /api/workspaces`, runtime item 23c). */
export interface WorkspaceEntry {
  id: string;
  name: string;
  address: string;
  setup: "solo" | "team";
  lastOpened?: string;
}

export interface WorkspaceSwitcherView {
  rows: {
    id: string;
    label: string;
    detail: string;
    current: boolean;
    /** Where choosing it goes: its own address, in this tab, where its own sign-in applies. */
    href: string;
    /** Solo's *Remove*: any entry but the workspace the page is in. */
    removable: boolean;
  }[];
  /** Solo adds a workspace to its list; a Team server opens another by address. */
  add: { kind: "add" | "open"; label: string };
}

/**
 * The account menu's *Switch workspace* (DB-N25-3): the current workspace
 * first, then the rest as the server listed them, each with its address and
 * setup. Solo offers *Add a workspace…* and *Remove*; a Team server, which
 * lists itself alone, *Open another workspace…*.
 */
export function workspaceSwitcher(
  list: { current?: string; workspaces: readonly WorkspaceEntry[]; complete: boolean },
  opts: { setup: "solo" | "team" },
): WorkspaceSwitcherView {
  const solo = opts.setup === "solo";
  const rows = [...list.workspaces]
    .sort((a, b) => Number(b.id === list.current) - Number(a.id === list.current))
    .map((w) => ({
      id: w.id,
      label: w.name,
      detail: `${w.address} · ${w.setup === "team" ? "Team" : "Solo"}`,
      current: w.id === list.current,
      href: `${w.address.replace(/\/+$/, "")}/`,
      removable: solo && w.id !== list.current,
    }));
  return {
    rows,
    add: solo
      ? { kind: "add", label: "Add a workspace…" }
      : { kind: "open", label: "Open another workspace…" },
  };
}

/**
 * A view's read failed (FINDINGS ERR-04; dashboard §A *Error messages*):
 * what could not load, and what to do, in words — never a status code or
 * the browser's *Failed to fetch*. `status` is the HTTP status, 0 for no
 * answer at all. The view puts Retry beside it.
 */
export function loadFailedText(thing: string, status: number): { title: string; detail: string } {
  const title = `Couldn't load ${thing}.`;
  if (!status) {
    return {
      title,
      detail: "Sekhemet can't be reached. Check that it is running, then try again.",
    };
  }
  if (status === 404) {
    return {
      title,
      detail: "This Sekhemet server doesn't have them. Update Sekhemet and restart it.",
    };
  }
  if (status === 401) return { title, detail: "Your session ended. Sign in again to see them." };
  if (status === 403) {
    return { title, detail: "You don't have access to them. An Admin can grant it." };
  }
  return {
    title,
    detail: "Sekhemet had a problem answering. Try again; if it keeps happening, restart it.",
  };
}
