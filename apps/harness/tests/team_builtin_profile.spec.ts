import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseToml } from "@sekhemet/kernel";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { freePort, place, spawnCli } from "./support/cli_spawn.js";

/**
 * The Team image's two profiles (teams item 13a, NEW-teams-12; DESIGN_GAPS_C1
 * b9, FINDINGS_C1 INS-07) and the engines checked at the Team server's start
 * (models rule 26a, NEW-models-15, MD-N15-3; FINDINGS INS-01).
 *
 * TEAM-46: `compose.builtin.yaml` serves sign-in with built-in accounts and
 * no identity proxy — checked statically, then the configuration INSTALL
 * gives for it is the user configuration of a real `sekhemet serve`, driven
 * over HTTP to a first sign-in. TEAM-48: INSTALL documents both profiles
 * side by side, each to a first sign-in.
 */

const ROOT = resolve(import.meta.dirname, "../../..");
const BUILTIN = readFileSync(join(ROOT, "packaging/server/compose.builtin.yaml"), "utf8");
const PROXY = readFileSync(join(ROOT, "packaging/server/compose.yaml"), "utf8");
const INSTALL = readFileSync(join(ROOT, "docs/reference/INSTALL.md"), "utf8");

type Service = { image?: string; ports?: string[]; command?: unknown };
const services = (compose: string) =>
  (parse(compose) as { services: Record<string, Service> }).services;

/** What keeps a compose file from being the `builtin` profile of TEAM-46. */
function builtinProblems(compose: string): string[] {
  const out: string[] = [];
  const s = services(compose);
  for (const [name, svc] of Object.entries(s)) {
    if (/oauth2-proxy|caddy|traefik|nginx/i.test(svc.image ?? ""))
      out.push(`${name}: bundles a proxy (${svc.image})`);
    if (name === "identity-proxy") out.push("identity-proxy: an identity proxy");
    if (JSON.stringify(svc.command ?? "").includes("--provider=oidc"))
      out.push(`${name}: signs in through OIDC`);
  }
  const ports = s.sekhemet?.ports ?? [];
  if (ports.some((p) => !String(p).startsWith("127.0.0.1:")))
    out.push("sekhemet: published beyond the host's loopback");
  if (ports.length === 0) out.push("sekhemet: not published for the reverse proxy");
  return out;
}

/** The `[identity]`/`[team]` configuration INSTALL gives for a profile, as its first toml block. */
function installToml(heading: string): string {
  const at = INSTALL.indexOf(heading);
  expect(at, heading).toBeGreaterThan(-1);
  const block = /```toml\n([\s\S]*?)```/.exec(INSTALL.slice(at));
  return (block?.[1] ?? "").replace(/^ {3}/gm, "");
}

describe("TEAM-46: the builtin profile — built-in accounts, no OIDC, no identity proxy, no bundled reverse proxy", () => {
  it("TEAM-46: compose.builtin.yaml runs the harness and the engines only, published on the host's loopback for the admin's own TLS proxy", () => {
    expect(builtinProblems(BUILTIN)).toEqual([]);
    expect(Object.keys(services(BUILTIN)).sort()).toEqual([
      "engine-coding",
      "engine-planning",
      "engine-research",
      "sekhemet",
    ]);
    const toml = parseToml(installToml("### The `builtin` profile")) as {
      identity: { sources: string[]; oidc?: unknown };
      team: { mode: string };
    };
    expect(toml.team.mode).toBe("team");
    expect(toml.identity.sources).toEqual(["accounts", "passkeys"]);
    expect(toml.identity.oidc).toBeUndefined();
  });

  it("negative: the proxy profile, or a builtin profile published beyond loopback, fails", () => {
    expect(builtinProblems(PROXY)).toContain("identity-proxy: an identity proxy");
    const wide = BUILTIN.replace('"127.0.0.1:4040:4040"', '"4040:4040"');
    expect(wide).not.toBe(BUILTIN);
    expect(builtinProblems(wide)).toEqual(["sekhemet: published beyond the host's loopback"]);
  });

  // TEAM-48: INSTALL's builtin walk — its configuration, the setup token's
  // printed path, the first Admin — run as written against the built server.
  it("TEAM-46, TEAM-48: a `sekhemet serve` with INSTALL's builtin configuration reaches a first sign-in by account, and a proxy's user header signs no one in", async () => {
    const p = place("sek-builtin-");
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: p.repo });
    // INSTALL's configuration, its placeholders filled as an Admin would.
    const config = installToml("### The `builtin` profile")
      .replace("<your team's name>", "Northwind")
      .replace("https://<the address people open>", "https://sekhemet.northwind.test")
      .replace("<your Docker network's gateway, such as 172.17.0.1>", "127.0.0.1");
    expect(config).not.toMatch(/<[^>]+>/);
    const file = join(p.root, "config.toml");
    writeFileSync(file, config);
    const s = spawnCli(["serve", "--port", String(await freePort())], p, {
      env: { SEKHEMET_USER_CONFIG: file },
    });
    try {
      const [url] = (await s.until(/http:\/\/127\.0\.0\.1:\d+/, 60_000)) as RegExpMatchArray;
      const [, tokenFile] = (await s.until(/Setup token written to (\S+?setup-token)/)) as string[];
      const token = readFileSync(tokenFile as string, "utf8").trim();
      const post = (path: string, body: unknown) =>
        fetch(`${url}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", "X-Sekhemet-Action": "1" },
          body: JSON.stringify(body),
        });
      const ada = {
        name: "Ada Admin",
        email: "ada@northwind.test",
        password: "correct horse battery staple, kept",
      };
      // A proxy's header, from an address in trusted_proxies, is no sign-in here.
      const viaHeader = await fetch(`${url}/api/board`, {
        headers: { "X-Forwarded-Email": ada.email },
      });
      expect(viaHeader.status).toBe(401);
      expect((await post("/api/setup", { token, ...ada })).status).toBe(200);
      const session = await post("/api/session", { email: ada.email, password: ada.password });
      expect(session.status).toBe(200);
      const cookie = (session.headers.get("set-cookie") ?? "").split(";")[0] as string;
      expect(cookie).toMatch(/=/);
      const board = await fetch(`${url}/api/board`, { headers: { cookie } });
      expect(board.status).toBe(200);
      // MD-N15-3 (INS-01): the engines checked at the Team server's start, in
      // its output and on Configuration › Models (no engine runs here: the
      // test guard refuses the Coding and Planning ports).
      await s.until(/Team engines \(Configuration › Models shows them too\):/);
      expect(s.out()).toMatch(
        /Coding \(engine-coding, nail-mtp\): no engine answers on port 8098\./,
      );
      expect(s.out()).toMatch(/Review: unfilled/);
      const roles = (await (
        await fetch(`${url}/api/config/roles`, { headers: { cookie } })
      ).json()) as {
        roles: { role: string; engine?: { service: string; state: string; line: string } }[];
      };
      const worker = roles.roles.find((r) => r.role === "worker");
      expect(worker?.engine).toMatchObject({ service: "engine-coding", state: "no-engine" });
      expect(worker?.engine?.line).toMatch(/no engine answers on port 8098/);
    } finally {
      await s.stop();
    }
  }, 120_000);
});

describe("TEAM-48: INSTALL documents both profiles side by side, each to a first sign-in", () => {
  it("TEAM-48: each profile has its configuration, its build and start commands, and the setup-token step", () => {
    for (const [heading, file] of [
      ["### The `builtin` profile, to a first sign-in", "compose.builtin.yaml"],
      ["### The `proxy` profile, to a first sign-in", "compose.yaml"],
    ] as const) {
      const at = INSTALL.indexOf(heading);
      expect(at, heading).toBeGreaterThan(-1);
      const next = INSTALL.indexOf("\n### ", at + heading.length);
      const section = INSTALL.slice(at, next === -1 ? undefined : next);
      expect(section).toContain(`docker compose -f packaging/server/${file} up -d`);
      expect(section).toContain("docker build -f packaging/server/Dockerfile");
      expect(section).toMatch(/setup token/);
      expect(section).toMatch(/```toml/);
    }
    // Side by side: one table names both.
    expect(INSTALL).toMatch(
      /\| +\| The `builtin` profile: `compose\.builtin\.yaml` \| The `proxy` profile: `compose\.yaml` \|/,
    );
  });
});

/** A health check's command from the packaging, aimed at `port` instead of the image's 4040. */
function healthCommand(port: number): { dockerfile: string[]; compose: string[] } {
  const dockerfile = readFileSync(join(ROOT, "packaging/server/Dockerfile"), "utf8").replace(
    /\\\n/g,
    " ",
  );
  const cmd = /^HEALTHCHECK\b.*?CMD (\[.*\])\s*$/m.exec(dockerfile)?.[1] ?? "[]";
  const compose = services(BUILTIN).sekhemet as { healthcheck?: { test?: string[] } };
  const at = (args: string[]) => args.map((a) => a.replace("127.0.0.1:4040", `127.0.0.1:${port}`));
  return {
    dockerfile: at(JSON.parse(cmd) as string[]),
    compose: at((compose.healthcheck?.test ?? []).slice(1)),
  };
}

describe("RUN-73: the image's and the compose files' health checks, run against a real server", () => {
  it("RUN-73: each health check command exits 0 while `sekhemet serve` answers GET /healthz, and 1 once it has stopped", async () => {
    const p = place("sek-healthcheck-");
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: p.repo });
    const port = await freePort();
    const { dockerfile, compose } = healthCommand(port);
    expect(dockerfile[0]).toBe("node");
    expect(compose[0]).toBe("node");
    const run = (argv: string[]) =>
      spawnSync(process.execPath, argv.slice(1), { encoding: "utf8", timeout: 20_000 }).status;
    const s = spawnCli(["serve", "--port", String(port)], p);
    try {
      await s.until(new RegExp(`http://127\\.0\\.0\\.1:${port}`), 60_000);
      expect(run(dockerfile)).toBe(0);
      expect(run(compose)).toBe(0);
    } finally {
      await s.stop();
    }
    expect(run(dockerfile)).toBe(1);
    expect(run(compose)).toBe(1);
  }, 90_000);
});
