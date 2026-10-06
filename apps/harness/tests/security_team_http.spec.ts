import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { type Place, freePort, place, runCli, spawnCli } from "./support/cli_spawn.js";

/**
 * security item 41b (NEW-security-14) at the door (C2d, FINDINGS_C1 TST-01):
 * two Team servers of one operating-system user — two `sekhemet serve`
 * processes with one home — each with its own credential store and setup
 * token, driven over HTTP; then a store an older build left at the old place,
 * moved by the next server start and reported by `sekhemet doctor`.
 */

const PASSWORD = "correct horse battery staple, kept";
const ADA = { name: "Ada Admin", email: "ada@northwind.test", password: PASSWORD };

function repoAt(dir: string): string {
  mkdirSync(join(dir, "src"), { recursive: true });
  const git = (...a: string[]) =>
    execFileSync("git", ["-c", "user.email=e@x", "-c", "user.name=E", ...a], { cwd: dir });
  git("init", "-q", "-b", "main");
  writeFileSync(join(dir, "src", "a.ts"), "export const a = 0;\n");
  writeFileSync(join(dir, ".gitignore"), ".sekhemet/\n");
  git("add", "-A");
  git("commit", "-q", "-m", "seed");
  return dir;
}

/** A Team `sekhemet serve` in `cwd`; its address and the setup token file it names. */
async function teamServe(p: Place, cwd: string, env: Record<string, string>) {
  const s = spawnCli(["serve", "--port", String(await freePort())], p, { cwd, env });
  const [url] = (await s.until(/http:\/\/127\.0\.0\.1:\d+/, 60_000)) as RegExpMatchArray;
  const tokenFile = s.out().match(/Setup token written to (\S+?setup-token)/)?.[1];
  const call = (path: string, body: unknown) =>
    fetch(`${url}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "X-Sekhemet-Action": "1" },
      body: JSON.stringify(body),
    });
  return { s, url: url as string, tokenFile, call };
}

function teamPlace(): { p: Place; a: string; b: string; env: Record<string, string> } {
  const p = place("sek-g6-team-");
  const team = join(p.root, "team.toml");
  writeFileSync(team, '[team]\nmode = "team"\nworkspace = "Northwind"\n');
  return {
    p,
    a: repoAt(p.repo),
    b: repoAt(join(p.root, "repo-b")),
    env: { SEKHEMET_USER_CONFIG: team },
  };
}

describe("SEC-N14-1: two Team servers of one user keep their own credentials", () => {
  it("SEC-N14-1: each server's setup token and store are its own folder's; A's token makes no Admin on B, and A's password signs no one in on B", async () => {
    const { p, a, b, env } = teamPlace();
    const A = await teamServe(p, a, env);
    const B = await teamServe(p, b, env);
    try {
      expect(A.tokenFile).toBeTruthy();
      expect(B.tokenFile).toBeTruthy();
      const dirA = dirname(A.tokenFile as string);
      const dirB = dirname(B.tokenFile as string);
      expect(dirA).not.toBe(dirB);
      expect(dirname(dirA)).toBe(dirname(dirB));
      expect(dirname(dirA).endsWith("identity")).toBe(true);
      const tokenA = readFileSync(A.tokenFile as string, "utf8").trim();
      const tokenB = readFileSync(B.tokenFile as string, "utf8").trim();
      expect(tokenA).not.toBe(tokenB);
      // A's setup token, presented to B, makes no Admin there.
      expect((await B.call("/api/setup", { token: tokenA, ...ADA })).status).not.toBe(200);
      expect((await A.call("/api/setup", { token: tokenA, ...ADA })).status).toBe(200);
      // A's credential signs in on A, and no one on B.
      expect((await A.call("/api/session", { email: ADA.email, password: PASSWORD })).status).toBe(
        200,
      );
      const onB = await B.call("/api/session", { email: ADA.email, password: PASSWORD });
      expect(onB.status).not.toBe(200);
      expect(onB.headers.get("set-cookie") ?? "").toBe("");
      // A's password hash is in A's store alone.
      const passwords = (dir: string) =>
        existsSync(join(dir, "credentials.json"))
          ? Object.keys(
              (
                JSON.parse(readFileSync(join(dir, "credentials.json"), "utf8")) as {
                  passwords?: Record<string, unknown>;
                }
              ).passwords ?? {},
            )
          : [];
      expect(passwords(dirA)).toHaveLength(1);
      expect(passwords(dirB)).toEqual([]);
    } finally {
      await A.s.stop();
      await B.s.stop();
    }
  }, 180_000);
});

describe("SEC-N14-2: a store at the old place moves once into its workspace's folder", () => {
  it("SEC-N14-2: another workspace's server leaves it; the server whose ledger names it moves it, modes kept, no entry lost; `sekhemet doctor` reports the move", async () => {
    const { p, a, b, env } = teamPlace();
    const first = await teamServe(p, a, env);
    const token = readFileSync(first.tokenFile as string, "utf8").trim();
    expect((await first.call("/api/setup", { token, ...ADA })).status).toBe(200);
    await first.s.stop();
    // As an older build kept it: one store at the identity root.
    const dirA = dirname(first.tokenFile as string);
    const root = dirname(dirA);
    const store = readFileSync(join(dirA, "credentials.json"), "utf8");
    renameSync(join(dirA, "credentials.json"), join(root, "credentials.json"));
    rmSync(dirA, { recursive: true, force: true });
    expect(statSync(join(root, "credentials.json")).mode & 0o777).toBe(0o600);

    // Another workspace's server starts first: its ledger names none of it.
    const other = await teamServe(p, b, env);
    await other.s.stop();
    expect(existsSync(join(root, "credentials.json"))).toBe(true);

    // The workspace that names it takes it, once, and Ada signs in again.
    const again = await teamServe(p, a, env);
    try {
      expect(existsSync(join(root, "credentials.json"))).toBe(false);
      const moved = join(dirA, "credentials.json");
      expect(readFileSync(moved, "utf8")).toBe(store);
      expect(statSync(moved).mode & 0o777).toBe(0o600);
      expect(
        (await again.call("/api/session", { email: ADA.email, password: PASSWORD })).status,
      ).toBe(200);
    } finally {
      await again.s.stop();
    }
    // Recorded once on the ledger, the one durable channel.
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(join(a, ".sekhemet", "events.db"), { readOnly: true });
    const movedRecords = db
      .prepare("SELECT payload FROM events WHERE type = 'credentials/store_moved'")
      .all() as { payload: string }[];
    db.close();
    expect(movedRecords).toHaveLength(1);
    expect(JSON.parse(movedRecords[0]?.payload ?? "{}")).toMatchObject({
      from: root,
      to: dirA,
      files: ["credentials.json"],
    });
    const doctor = await runCli(["doctor"], p, { cwd: a, env, timeoutMs: 90_000 });
    expect(doctor.out).toMatch(/moved|credential store/i);
    expect(doctor.out).toContain(dirA);
  }, 240_000);
});
