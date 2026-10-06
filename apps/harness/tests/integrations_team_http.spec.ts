import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type Place, freePort, place, spawnCli, writeFile } from "./support/cli_spawn.js";

/**
 * People in the Team setup through `sekhemet serve` (integrations P9 item
 * 13; INT-21, INT-26; FINISH_LINE_PLAN C2d, FINDINGS_C1 TST-01): the built
 * binary spawned in the Team setup from the person's own configuration, a
 * repository whose `.sekhemet/config.toml` tries to set identity keys, and
 * the server probed over HTTP from this machine's loopback address as a
 * proxy's request would arrive. No model is loaded.
 */

const PASSWORD = "correct horse battery staple, kept";

function workspace(p: Place, repoConfig?: string): string {
  const git = (...a: string[]) =>
    execFileSync("git", ["-c", "user.email=e@x", "-c", "user.name=E", ...a], {
      cwd: p.repo,
      encoding: "utf8",
    });
  git("init", "-q", "-b", "main");
  writeFile(p.repo, "src/a.ts", "export const a = 0;\n");
  writeFile(p.repo, ".gitignore", ".sekhemet/\n");
  git("add", "-A");
  git("commit", "-q", "-m", "seed");
  if (repoConfig) writeFile(p.repo, ".sekhemet/config.toml", repoConfig);
  return p.repo;
}

/** A Team `serve` from `userToml`, its first Admin made with the setup token. */
async function teamServer(p: Place, userToml: string) {
  const user = join(p.root, "team.toml");
  writeFileSync(user, userToml);
  const s = spawnCli(["serve", "--port", String(await freePort())], p, {
    env: { SEKHEMET_USER_CONFIG: user },
  });
  const [url] = (await s.until(/http:\/\/127\.0\.0\.1:\d+/, 60_000)) as RegExpMatchArray;
  const tokenFile = (s.out().match(/Setup token written to (\S+?setup-token)/) ?? [])[1] as string;
  expect(tokenFile).toBeTruthy();
  const setup = await fetch(`${url}/api/setup`, {
    method: "POST",
    headers: { "content-type": "application/json", "X-Sekhemet-Action": "1" },
    body: JSON.stringify({
      token: readFileSync(tokenFile, "utf8").trim(),
      name: "Ada Admin",
      email: "ada@northwind.test",
      password: PASSWORD,
    }),
  });
  expect(setup.status).toBe(200);
  const cookie = (setup.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  return { url: url as string, cookie, stop: s.stop };
}

const HOSTILE = [
  "[team]",
  'workspace = "Evil"',
  "[identity]",
  'sources = ["accounts", "proxy"]',
  'trusted_proxies = ["127.0.0.1", "::1"]',
  'user_header = "x-evil"',
  "[sessions]",
  "idle_minutes = 99999",
  "[queue]",
  "agent_issues_per_person = 50",
  "",
].join("\n");

describe("a Team server's identity comes from the person's configuration only", () => {
  it(
    "INT-21, INT-26: a request carrying the proxy's user header from an address outside trusted_proxies is unauthenticated and answers 401; the repository's [identity], [team], [sessions] and [queue] keys are ignored",
    { timeout: 180_000 },
    async () => {
      const p = place("sek-int-team-");
      workspace(p, HOSTILE);
      const server = await teamServer(
        p,
        '[team]\nmode = "team"\nworkspace = "Northwind"\n[identity]\nsources = ["accounts", "proxy"]\ntrusted_proxies = ["10.8.0.1"]\n',
      );
      try {
        // The proxy's header naming the Admin, from loopback: not a trusted proxy.
        for (const header of ["x-forwarded-email", "x-evil"]) {
          const r = await fetch(`${server.url}/api/board`, {
            headers: { [header]: "ada@northwind.test" },
          });
          expect(r.status, header).toBe(401);
        }
        const anonymous = (await (
          await fetch(`${server.url}/api/session`, {
            headers: { "x-forwarded-email": "ada@northwind.test" },
          })
        ).json()) as { signedIn: boolean; sources: string[] };
        expect(anonymous.signedIn).toBe(false);
        // The person signed in is who they are; the workspace is the person's, not the repository's.
        const me = (await (
          await fetch(`${server.url}/api/session`, { headers: { Cookie: server.cookie } })
        ).json()) as { signedIn: boolean; workspace: string };
        expect(me).toMatchObject({ signedIn: true, workspace: "Northwind" });
        expect(
          (await fetch(`${server.url}/api/board`, { headers: { Cookie: server.cookie } })).status,
        ).toBe(200);
      } finally {
        await server.stop();
      }
    },
  );

  it(
    "INT-21: the same header from an address the person's configuration trusts is the person it names",
    { timeout: 180_000 },
    async () => {
      const p = place("sek-int-team-");
      workspace(p);
      const server = await teamServer(
        p,
        '[team]\nmode = "team"\nworkspace = "Northwind"\n[identity]\nsources = ["accounts", "proxy"]\ntrusted_proxies = ["127.0.0.1", "::1"]\n',
      );
      try {
        const r = await fetch(`${server.url}/api/session`, {
          headers: { "x-forwarded-email": "ada@northwind.test" },
        });
        expect(await r.json()).toMatchObject({ signedIn: true, via: "proxy", level: "admin" });
        expect(
          (
            await fetch(`${server.url}/api/board`, {
              headers: { "x-forwarded-email": "ada@northwind.test" },
            })
          ).status,
        ).toBe(200);
      } finally {
        await server.stop();
      }
    },
  );
});
