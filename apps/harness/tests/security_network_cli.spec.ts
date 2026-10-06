import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type Turn, WORKER, scriptedTurnsProject } from "./support/g6_models.js";
import { BIN, type G6Repo, g6Repo, write } from "./support/g6_review.js";

/**
 * security §2 items 26 to 30 (the network policy) at the door (C2d,
 * FINDINGS_C1 TST-01): a spawned `sekhemet queue` runs card `c1`, whose
 * scripted Worker asks curl for a URL; the card's egress proxy decides by
 * the user's `config.toml`, the repository's `gates.toml` and the project's
 * own config, and every request is recorded on the ledger as `card/egress`.
 * Every URL is on this machine (port 80 or 443 of a loopback, private or
 * metadata address), and every one is refused before a connection is made,
 * so nothing leaves.
 *
 * The binary under test is `apps/harness/dist/index.js`, spawned through
 * `support/g6_review.ts` (`BIN`).
 */

const finish = { name: "finish_card", arguments: {} };
const curl = (url: string): Turn[] => [
  {
    calls: [
      {
        name: "run_cmd",
        arguments: { command: "sh", args: ["-c", `curl -s --max-time 5 ${url}; echo CURL=$?`] },
      },
    ],
  },
  {
    calls: [
      { name: "write_file", arguments: { path: "src/a.ts", content: "export const a = 2;\n" } },
      finish,
    ],
  },
];

const GATES = (allow: string[]) =>
  `[project]\nmax_files = 3\nmax_diff_lines = 200\nnetwork_allow = ${JSON.stringify(allow)}\n\n[[gate]]\nid = "unit"\nrung = "test"\nlayer = "functional"\ncommand = "node"\nargs = ["-e", "process.exit(0)"]\ntimeout_s = 30\nparser = "generic"\n`;

/** `sekhemet queue`, run without blocking this process; the card's egress records after it. */
async function queue(
  turns: Turn[],
  setup: { userConfig?: string; networkAllow: string[]; projectConfig?: string },
) {
  const r: G6Repo = g6Repo();
  const project = await scriptedTurnsProject(r, turns, { stepBudget: 3 });
  write(r.repo, ".sekhemet/gates.toml", GATES(setup.networkAllow));
  if (setup.projectConfig) write(r.repo, ".sekhemet/config.toml", setup.projectConfig);
  if (setup.userConfig) r.userConfig(setup.userConfig);
  const child = spawn(process.execPath, [...project.nodeArgs, BIN, "queue", "--worker", WORKER], {
    cwd: r.repo,
    env: r.env({ env: project.env }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout?.on("data", (d) => {
    out += String(d);
  });
  child.stderr?.on("data", (d) => {
    out += String(d);
  });
  await new Promise((ok) => child.once("close", ok));
  const egress = await r.ledger(async ({ store }) =>
    (await store.cardEvents("c1", ["card/egress"])).map(
      (e) => e.payload as { host: string; allowed: boolean; reason?: string },
    ),
  );
  return { r, out, egress };
}

describe("SEC-9: an allowlisted name that resolves to a local address is refused at the proxy", () => {
  for (const [what, url, host, range] of [
    ["a loopback address", "http://127.0.0.1/ping", "127.0.0.1", /loopback/],
    ["a private address", "http://10.1.2.3/ping", "10.1.2.3", /private/],
    [
      "the metadata address",
      "http://169.254.169.254/latest/meta-data/",
      "169.254.169.254",
      /linkLocal/,
    ],
  ] as const) {
    it(`SEC-9: ${what} on both allowlists is refused and recorded allowed: false`, async () => {
      const { out, egress } = await queue(curl(url), {
        userConfig: `[network]\nmode = "allowlist"\nfetch_allow = ["${host}"]\n`,
        networkAllow: [host],
      });
      expect(egress, out).toEqual([
        expect.objectContaining({ host, allowed: false, reason: expect.stringMatching(range) }),
      ]);
    }, 150_000);
  }

  it("SEC-9: a name on both allowlists that resolves to loopback (localhost) is refused and recorded", async () => {
    const { out, egress } = await queue(curl("http://localhost/ping"), {
      userConfig: '[network]\nmode = "allowlist"\nfetch_allow = ["localhost"]\n',
      networkAllow: ["localhost"],
    });
    expect(egress, out).toEqual([
      expect.objectContaining({
        host: "localhost",
        allowed: false,
        reason: expect.stringMatching(/loopback/),
      }),
    ]);
  }, 150_000);
});

describe("SEC-12, SEC-12a: the repository and the project narrow the user's policy, never widen it", () => {
  it("SEC-12: a host the repository's gates.toml lists but the user's config.toml does not permit is not reached", async () => {
    const { out, egress } = await queue(curl("http://127.0.0.1/ping"), {
      // docs.example.com is on both lists, so the card has a proxy; 127.0.0.1 only on the repository's.
      userConfig: '[network]\nmode = "allowlist"\nfetch_allow = ["docs.example.com"]\n',
      networkAllow: ["127.0.0.1", "docs.example.com"],
    });
    expect(egress, out).toEqual([
      expect.objectContaining({
        host: "127.0.0.1",
        allowed: false,
        reason: "127.0.0.1 is not on this project's network allowlist",
      }),
    ]);
  }, 150_000);

  it("SEC-12a: a host in the user's fetch_allow and the repository's network_allow but in the project's fetch_deny is refused at the proxy", async () => {
    const { out, egress } = await queue(curl("http://127.0.0.1/ping"), {
      userConfig:
        '[network]\nmode = "allowlist"\nfetch_allow = ["127.0.0.1", "docs.example.com"]\n',
      networkAllow: ["127.0.0.1", "docs.example.com"],
      projectConfig: '[network]\nfetch_deny = ["127.0.0.1"]\n',
    });
    expect(egress, out).toEqual([
      expect.objectContaining({
        host: "127.0.0.1",
        allowed: false,
        reason: "127.0.0.1 is in fetch_deny",
      }),
    ]);
  }, 150_000);
});
