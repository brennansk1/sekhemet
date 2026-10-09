/**
 * A real Team server for the team milestones (B4.10, B4.11): this build's
 * `sekhemet serve` in a separate process, configured for the Team setup by
 * its own user config (teams §2.1), over a real repository and ledger, with
 * people who sign in through its own routes — the setup token, invites,
 * passwords and sessions with CSRF (teams §2.3).
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CLI, isolatedEnv } from "./core.mjs";
import { makeRepo } from "./stand_in.mjs";

export const PASSWORD = "orchid-lantern-milestone-4410";

async function freePort() {
  const s = createServer();
  await new Promise((resolve) => s.listen(0, "127.0.0.1", resolve));
  const { port } = s.address();
  await new Promise((resolve) => s.close(resolve));
  return port;
}

/** Levels in order (teams item 6): each can do everything the one below can. */
export const RANK = { viewer: 0, stakeholder: 1, member: 2, admin: 3 };

export async function startTeamServer(base, { workspace = "Northwind" } = {}) {
  const env = isolatedEnv(base, {
    userConfig: `[team]\nmode = "team"\nworkspace = "${workspace}"\n`,
  });
  // The server names the project after its folder.
  const repo = join(base, "chronicle");
  mkdirSync(repo, { recursive: true });
  makeRepo(repo);
  const port = await freePort();
  const child = spawn(process.execPath, [CLI, "serve", "--repo", repo, "--port", String(port)], {
    env,
    cwd: repo,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (d) => {
    output += d;
  });
  child.stderr.on("data", (d) => {
    output += d;
  });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 120; i++) {
    const r = await fetch(`${url}/api/session`).catch(() => undefined);
    if (r?.ok) break;
    if (child.exitCode !== null) throw new Error(`the server exited: ${output.trim()}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const team = new Team(url, env, repo);
  team.stop = async () => {
    child.kill("SIGTERM");
    await new Promise((resolve) =>
      child.exitCode !== null ? resolve() : child.on("exit", resolve),
    );
  };
  team.output = () => output;
  return team;
}

export class Team {
  constructor(url, env, repo) {
    this.url = url;
    this.env = env;
    this.repo = repo;
    this.people = {};
  }

  call(method, path, who, body) {
    return fetch(`${this.url}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        "X-Sekhemet-Action": "1",
        ...(who?.headers ?? {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  /** A request, its status and its JSON body. */
  async send(method, path, who, body) {
    const res = await this.call(method, path, who, body);
    let data;
    try {
      data = await res.json();
    } catch {
      data = undefined;
    }
    return { status: res.status, data };
  }

  async #signedIn(res, person) {
    const body = await res.json();
    if (res.status !== 200) throw new Error(`${person.name}: ${res.status} ${body.error ?? ""}`);
    const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    person.principal = body.principal;
    person.headers = { Cookie: cookie, "X-Sekhemet-CSRF": body.csrf };
    this.people[person.key] = person;
    return person;
  }

  /** The first Admin, with the setup token the server wrote (TEAM-31). */
  async setup(key, name, email) {
    // The identity is the workspace's own (`identity/<workspace id>/`, runtime
    // item 35a); this server's user directory holds its one workspace.
    const identity = join(this.env.SEKHEMET_CONFIG_DIR, "identity");
    const dirs = readdirSync(identity).filter((d) => existsSync(join(identity, d, "setup-token")));
    if (dirs.length !== 1)
      throw new Error(`expected one workspace's setup token in ${identity}, found ${dirs.length}`);
    const token = readFileSync(join(identity, dirs[0], "setup-token"), "utf8").trim();
    return this.#signedIn(
      await this.call("POST", "/api/setup", undefined, { token, name, email, password: PASSWORD }),
      { key, name, email, level: "admin" },
    );
  }

  /** Invited at `level` by `by`, joins with a password. */
  async invite(by, key, name, email, level) {
    const r = await this.send("POST", "/api/invites", by, { level, email });
    if (r.status !== 200) throw new Error(`invite ${email}: ${r.status} ${r.data?.error ?? ""}`);
    return this.#signedIn(
      await this.call("POST", `/api/invites/${r.data.id}/accept`, undefined, {
        name,
        email,
        password: PASSWORD,
      }),
      { key, name, email, level },
    );
  }

  /** Sign in again with email and password: a new session. */
  async signIn(person) {
    return this.#signedIn(
      await this.call("POST", "/api/session", undefined, {
        email: person.email,
        password: PASSWORD,
      }),
      person,
    );
  }

  /** Who the server says this session is. */
  async session(person) {
    return (await this.send("GET", "/api/session", person)).data;
  }

  /** The ledger's last seq, read only. */
  mark() {
    const db = new DatabaseSync(join(this.repo, ".sekhemet", "events.db"), { readOnly: true });
    try {
      return db.prepare("SELECT COALESCE(MAX(seq), 0) AS s FROM events").get().s;
    } finally {
      db.close();
    }
  }

  /** The events a person caused since `seq`, with their principal (DoD §6.6: every event names its person). */
  personEvents(since) {
    const db = new DatabaseSync(join(this.repo, ".sekhemet", "events.db"), { readOnly: true });
    try {
      return db
        .prepare(
          "SELECT seq, type, principal FROM events WHERE seq > ? AND actor IN ('human', 'mcp') AND type != 'token/used' ORDER BY seq",
        )
        .all(since);
    } finally {
      db.close();
    }
  }
}
