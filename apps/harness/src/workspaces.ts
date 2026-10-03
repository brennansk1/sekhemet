import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname } from "node:path";

/**
 * The machine's list of workspaces (runtime item 23c, NEW-runtime-17,
 * RUN-84..86; DEC-57; dashboard DB-N25-3): `<user dir>/workspaces.json`,
 * the Sekhemet workspaces this machine's person has used, for the account
 * menu's *Switch workspace*. A convenience, like a browser's bookmarks: it
 * grants nothing, decides nothing, records no event and is never the only
 * copy of anything — each server rewrites its own entry at its next start,
 * and an unreadable file reads as empty. No command chooses what it acts on
 * from it.
 */

export interface WorkspaceRecord {
  /** The workspace id (`ws_…`, kernel rule 38a) or, for one added by address, `addr_…`. */
  id: string;
  name: string;
  /** Where its dashboard answers: `http://127.0.0.1:7420`, never with a trailing slash. */
  address: string;
  /** Unknown for a workspace a person added by its address alone. */
  setup?: "solo" | "team";
  /** The workspace folder and its projects' roots, when it runs on this machine. */
  folder?: string;
  projectRoots?: string[];
  lastOpened: string;
}

interface WorkspacesFile {
  workspaces: WorkspaceRecord[];
}

/** The list, or nothing: a missing or unreadable file is an empty list (RUN-86). */
export function readWorkspaces(path: string): WorkspaceRecord[] {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<WorkspacesFile>;
    return (Array.isArray(parsed.workspaces) ? parsed.workspaces : []).filter(
      (w): w is WorkspaceRecord =>
        Boolean(w) &&
        typeof w.id === "string" &&
        typeof w.name === "string" &&
        typeof w.address === "string",
    );
  } catch {
    return [];
  }
}

/** Written whole, through a temporary file, so a reader never sees half a list. */
function writeWorkspaces(path: string, list: WorkspaceRecord[]): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ workspaces: list }, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

/**
 * Write or refresh this server's own entry (RUN-84). Never throws: a list
 * that cannot be written leaves every project served as before (RUN-86).
 */
export function recordOwnWorkspace(path: string, own: WorkspaceRecord): void {
  try {
    const rest = readWorkspaces(path).filter((w) => w.id !== own.id);
    writeWorkspaces(path, [own, ...rest]);
  } catch {
    // The list is a convenience; the server runs without it.
  }
}

/** An address a person may add: http or https, with a host, and no path, query or credentials. */
export function workspaceAddress(raw: unknown): string | undefined {
  if (typeof raw !== "string" || raw.length > 500) return undefined;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  if (!url.hostname || url.username || url.password) return undefined;
  return `${url.protocol}//${url.host}`;
}

/**
 * The person's name in Solo (FINDINGS SHL-02): git's `user.name`, then the
 * computer's account name; undefined lets the page say *You*. Never a principal.
 */
export function soloPersonName(gitUser: string | undefined, osUser: string | undefined) {
  return gitUser?.trim() || osUser?.trim() || undefined;
}

/** What the route needs from its server (`server.ts`). */
export interface WorkspacesRouteDeps {
  path: string;
  setup: "solo" | "team";
  /** This server's entry now: its id, name, address, folder and project roots. */
  own: () => WorkspaceRecord | undefined;
  json: (res: ServerResponse, status: number, body: unknown) => void;
  readBody: (req: IncomingMessage) => Promise<Record<string, unknown> | undefined>;
}

/**
 * `GET`, `POST` and `DELETE /api/workspaces` (runtime item 23c, RUN-85). In
 * Solo, which binds loopback with no sign-in, the page's person is this
 * machine's person: the whole list, the current one marked, and Add and
 * Remove. A Team server answers its own entry alone (`complete: false`) and
 * refuses changes: its machine's list is not the person's. Returns true when
 * it answered.
 */
export async function workspacesRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: string,
  deps: WorkspacesRouteDeps,
): Promise<boolean> {
  if (url !== "/api/workspaces" && !url.startsWith("/api/workspaces/")) return false;
  const method = req.method ?? "GET";
  const own = deps.own();
  // SUR-76: which workspace this server serves, its id alone — reachable
  // before signing in, so `sekhemet` and `serve` find a Team server too.
  if (url === WORKSPACE_ID_ROUTE && method === "GET") {
    deps.json(res, 200, own ? { current: own.id } : {});
    return true;
  }
  if (own) recordOwnWorkspace(deps.path, own);
  if (url === "/api/workspaces" && method === "GET") {
    const solo = deps.setup === "solo";
    const list = solo
      ? readWorkspaces(deps.path)
          .filter((w) => w.id !== own?.id)
          .sort((a, b) => b.lastOpened.localeCompare(a.lastOpened))
      : [];
    deps.json(res, 200, {
      ...(own ? { current: own.id } : {}),
      workspaces: [...(own ? [own] : []), ...list],
      complete: solo,
    });
    return true;
  }
  if (deps.setup !== "solo") {
    deps.json(res, 403, {
      error:
        "A Team server keeps no list of your workspaces. Open another workspace by its address, or manage your list from your own Solo workspace.",
      refused: "team",
    });
    return true;
  }
  if (url === "/api/workspaces" && method === "POST") {
    const body = await deps.readBody(req).catch(() => undefined);
    const address = workspaceAddress(body?.address);
    if (!address) {
      deps.json(res, 400, {
        error: "Give the workspace's address, such as http://192.168.1.20:7420.",
      });
      return true;
    }
    const list = readWorkspaces(deps.path);
    const known = list.find((w) => w.address === address);
    const entry: WorkspaceRecord = known ?? {
      id: `addr_${createHash("sha256").update(address).digest("hex").slice(0, 12)}`,
      name: new URL(address).host,
      address,
      lastOpened: new Date().toISOString(),
    };
    if (!known) {
      try {
        writeWorkspaces(deps.path, [...list, entry]);
      } catch {
        deps.json(res, 500, { error: "Sekhemet couldn't save the list of workspaces." });
        return true;
      }
    }
    deps.json(res, 200, { workspace: entry });
    return true;
  }
  const one = /^\/api\/workspaces\/([A-Za-z0-9_-]{1,64})$/.exec(url);
  if (one && method === "DELETE") {
    const id = one[1] as string;
    if (id === own?.id) {
      deps.json(res, 409, { error: "This is the workspace you are in; it stays on the list." });
      return true;
    }
    const list = readWorkspaces(deps.path);
    if (!list.some((w) => w.id === id)) {
      deps.json(res, 404, { error: "That workspace is not on the list." });
      return true;
    }
    try {
      writeWorkspaces(
        deps.path,
        list.filter((w) => w.id !== id),
      );
    } catch {
      deps.json(res, 500, { error: "Sekhemet couldn't save the list of workspaces." });
      return true;
    }
    deps.json(res, 200, { removed: id });
    return true;
  }
  deps.json(res, 405, { error: "Not allowed here." });
  return true;
}

/** The id of the workspace a server serves, answered without a session (SUR-76). */
export const WORKSPACE_ID_ROUTE = "/api/workspaces/id";

/**
 * SUR-76: the address of a running server that already serves this
 * workspace, if any: an entry of the machine's list for this workspace's
 * folder and id whose address answers `GET /api/workspaces/id` naming that
 * id as its own — a route that needs no sign-in, so a Team server is found
 * as a Solo one is. The list only says where to ask; the server's answer decides.
 */
export async function runningServerFor(
  path: string,
  workspace: { folder: string; id: string | undefined },
  fetchImpl: typeof fetch = fetch,
): Promise<string | undefined> {
  if (!workspace.id) return undefined;
  const same = (a: string | undefined) => {
    if (!a) return false;
    try {
      return realpathSync(a) === realpathSync(workspace.folder);
    } catch {
      return false;
    }
  };
  for (const w of readWorkspaces(path)) {
    if (w.id !== workspace.id || !same(w.folder)) continue;
    try {
      const res = await fetchImpl(`${w.address}${WORKSPACE_ID_ROUTE}`, {
        signal: AbortSignal.timeout(1500),
      });
      if (!res.ok) continue;
      const body = (await res.json()) as { current?: unknown };
      if (body.current === workspace.id) return w.address;
    } catch {
      // Not running there: start one.
    }
  }
  return undefined;
}
