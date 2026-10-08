import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cli, g2Dirs, ledgerRows } from "./support/g2_cli.js";
import { SCRIPTED_MODEL, type Turn, recorded, scriptEnv } from "./support/g2_model.js";
import { type G2Project, g2Project } from "./support/g2_project.js";
import { type StubPage, type WebStub, htmlPage, webStub } from "./support/g2_web.js";

/**
 * security items 26, 29a, 32 and 44 (SEC-13, SEC-14, SEC-41, SEC-43a, SEC-52a,
 * SEC-52b) at the door (C2d,
 * FINDINGS_C1 TST-01): the built command (`apps/harness/dist/index.js`)
 * spawned as `sekhemet queue` (a research card, and a card adding a
 * dependency), `sekhemet plan` and `sekhemet doctor` in a real repository,
 * the person's and the project's
 * `config.toml` real files. The Research model and the Worker are scripted
 * at the HTTP boundary (`g2_model.ts`), and every request for another host
 * — `fetch`, `node:http`, `node:https`, after the network policy decided — is
 * served by a local stub that records it (`g2_web.ts`). Nothing leaves the
 * machine; what the stub saw is what the product sent.
 */

const PARA =
  "Zod validates an email address with z.string().email(), which checks the string against its email pattern. ";
const GUIDE = "docs.lib.example.test/guide";
const ELSEWHERE = "blog.elsewhere.example.test/post";

/** A research card: the queue gives it to the Researcher, with the ledger (X7). */
const RESEARCH_CARD = {
  id: "r1",
  tier: "story" as const,
  title: "Which zod API validates an email?",
  spec: "Find the zod API that validates an email address.",
  acceptanceCriteria: ["names one API"],
  labels: ["research", "effort:quick"],
  status: "ready" as const,
};

interface Run {
  p: G2Project;
  stub: WebStub;
}

async function setup(opts: {
  user?: string;
  project?: string;
  files?: Record<string, string>;
  cards?: Parameters<typeof g2Project>[1]["cards"];
  /** More pages the stub serves. */
  pages?: Record<string, StubPage>;
}): Promise<Run> {
  const where = g2Dirs();
  const p = await g2Project(where, {
    ...(opts.files ? { files: opts.files } : {}),
    cards: opts.cards ?? [RESEARCH_CARD],
    qualifyAs: [{}, { role: "researcher" }],
  });
  const stub = await webStub({
    [GUIDE]: htmlPage("Guide", [PARA.repeat(4)]),
    [ELSEWHERE]: htmlPage("Post", [PARA.repeat(4)]),
    "registry.npmjs.org/left-pad": {
      type: "application/json",
      body: JSON.stringify({ name: "left-pad", time: { created: "2014-03-14T00:00:00.000Z" } }),
    },
    "api.npmjs.org/downloads/point/last-week/left-pad": {
      type: "application/json",
      body: JSON.stringify({ downloads: 2_000_000 }),
    },
    ...opts.pages,
  });
  if (opts.user !== undefined) {
    const userConfig = join(where.home, "config.toml");
    writeFileSync(userConfig, opts.user);
    p.env.SEKHEMET_USER_CONFIG = userConfig;
  }
  if (opts.project) writeFileSync(join(p.repo, ".sekhemet", "config.toml"), opts.project);
  return { p, stub };
}

const fetchCall = (url: string) => ({ name: "web_fetch", arguments: { url } });

/** `sekhemet queue --researcher`: the research card's Researcher plays `researcher`. */
function research(run: Run, researcher: Turn[]) {
  return cli(["queue", "--worker", SCRIPTED_MODEL, "--researcher", SCRIPTED_MODEL], {
    cwd: run.p.repo,
    preload: run.p.preload,
    env: {
      ...run.p.env,
      G2_STUB_PORT: String(run.stub.port),
      SEKHEMET_SEARXNG_URL: "http://search.example.test",
      ...scriptEnv(run.p.record, { researcher }),
    },
    timeoutMs: 180_000,
  });
}

interface Decision {
  host: string;
  allowed: boolean;
  purpose: string;
  reason?: string;
}

/** The network policy's decisions on the ledger (`harness/egress`), in order. */
const egress = (repo: string): Decision[] =>
  ledgerRows(repo)
    .filter((e) => e.type === "harness/egress")
    .map((e) => e.payload as unknown as Decision);

/** The Researcher was asked: the research card ran, so its silence on the web is the policy's. */
const researcherAsked = (run: Run) => recorded(run.p.record).some((x) => x.role === "researcher");

/** What the stub was asked for, robots.txt aside. */
const asked = (stub: WebStub) => stub.requests.filter((r) => !r.endsWith("robots.txt"));

/** `sekhemet research "<question>"`: the Researcher plays `researcher`. */
function researchCommand(run: Run, researcher: Turn[], args: string[] = []) {
  return cli(
    ["research", "Which zod API validates an email?", "--model", SCRIPTED_MODEL, ...args],
    {
      cwd: run.p.repo,
      preload: run.p.preload,
      env: {
        ...run.p.env,
        G2_STUB_PORT: String(run.stub.port),
        SEKHEMET_SEARXNG_URL: "http://search.example.test",
        ...scriptEnv(run.p.record, { researcher }),
      },
      timeoutMs: 180_000,
    },
  );
}

describe("SEC-52a, SEC-52b and DS-S8-7 through `sekhemet research` (C5)", () => {
  it('SEC-52b, DS-S8-7: `sekhemet research --web` with research = "yes" and a fetch_allow fetches only inside it, refuses the rest and records both on the ledger', async () => {
    const run = await setup({
      user: '[network]\nmode = "offline"\nresearch = "yes"\nfetch_allow = ["docs.lib.example.test"]\n',
    });
    const r = await researchCommand(
      run,
      [
        [fetchCall(`https://${GUIDE}`), fetchCall(`https://${ELSEWHERE}`)],
        "Use z.string().email() [1].",
      ],
      ["--web"],
    );
    expect(r.stdout + r.stderr).toMatch(/Sources: web on/);
    // Never asked: the stub saw only the allowlisted page.
    expect(asked(run.stub)).toEqual([GUIDE]);
    expect(egress(run.p.repo)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ host: "docs.lib.example.test", allowed: true }),
        expect.objectContaining({
          host: "blog.elsewhere.example.test",
          allowed: false,
          reason: expect.stringMatching(/fetch_allow/),
        }),
      ]),
    );
  }, 180_000);

  it('SEC-52a: `sekhemet research` with research = "yes" and mode unset fetches a public host through the policy, logged on the ledger', async () => {
    const run = await setup({ user: '[network]\nresearch = "yes"\n' });
    await researchCommand(run, [[fetchCall(`https://${GUIDE}`)], "Use z.string().email() [1]."]);
    expect(asked(run.stub)).toEqual([GUIDE]);
    expect(egress(run.p.repo)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ host: "docs.lib.example.test", allowed: true }),
      ]),
    );
  }, 180_000);
});

describe("SEC-52b: research is the one exception to mode, and only inside the allowlist", () => {
  it('SEC-52b: with research = "yes" and a fetch_allow, a fetch to a public host outside it is refused and recorded, whatever mode says', async () => {
    const run = await setup({
      user: '[network]\nmode = "offline"\nresearch = "yes"\nfetch_allow = ["docs.lib.example.test"]\n',
    });
    const r = await research(run, [
      [fetchCall(`https://${GUIDE}`), fetchCall(`https://${ELSEWHERE}`)],
      "Use z.string().email() [1].",
    ]);
    expect(r.stdout + r.stderr).toMatch(/r1/);
    // Never asked: the stub saw only the allowlisted page.
    expect(asked(run.stub)).toEqual([GUIDE]);
    const decided = egress(run.p.repo);
    expect(decided).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ host: "docs.lib.example.test", allowed: true }),
        expect.objectContaining({
          host: "blog.elsewhere.example.test",
          allowed: false,
          reason: expect.stringMatching(/fetch_allow/),
        }),
      ]),
    );
  }, 180_000);

  it('SEC-52b: a project\'s research = "no" makes no research request for that project', async () => {
    const run = await setup({
      user: '[network]\nmode = "open"\nresearch = "yes"\n',
      project: '[network]\nresearch = "no"\n',
    });
    await research(run, [[fetchCall(`https://${GUIDE}`)], "Nothing read."]);
    expect(researcherAsked(run)).toBe(true);
    expect(asked(run.stub)).toEqual([]);
    expect(egress(run.p.repo).filter((e) => e.allowed)).toEqual([]);
  }, 180_000);

  it('SEC-52b: a project\'s research = "yes" under the person\'s "no" is ignored, and `sekhemet doctor` names it', async () => {
    const run = await setup({
      user: '[network]\nresearch = "no"\n',
      project: '[network]\nresearch = "yes"\n',
    });
    await research(run, [[fetchCall(`https://${GUIDE}`)], "Nothing read."]);
    expect(researcherAsked(run)).toBe(true);
    expect(asked(run.stub)).toEqual([]);
    expect(egress(run.p.repo).filter((e) => e.allowed)).toEqual([]);
    const doctor = await cli(["doctor"], { cwd: run.p.repo, env: run.p.env, timeoutMs: 120_000 });
    expect(doctor.stdout + doctor.stderr).toMatch(
      /this project's config\.toml research = "yes" is ignored: your config\.toml says research = "no"/,
    );
  }, 180_000);
});

describe("DS-N4-4: a project's config.toml may only narrow the person's research network", () => {
  it("DS-N4-4: a project widening fetch_allow to another domain and mode to open fetches nothing from it, and `research` reports each widening ignored", async () => {
    const run = await setup({
      user: '[network]\nmode = "allowlist"\nresearch = "yes"\nfetch_allow = ["docs.lib.example.test"]\n',
      project:
        '[network]\nmode = "open"\nfetch_allow = ["docs.lib.example.test", "blog.elsewhere.example.test"]\n',
    });
    await research(run, [
      [fetchCall(`https://${GUIDE}`), fetchCall(`https://${ELSEWHERE}`)],
      "Use z.string().email() [1].",
    ]);
    expect(researcherAsked(run)).toBe(true);
    // The person's domain is read; the project's added one never is.
    expect(asked(run.stub)).toEqual([GUIDE]);
    expect(egress(run.p.repo)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ host: "blog.elsewhere.example.test", allowed: false }),
      ]),
    );
    // `sekhemet research` names its sources and each widening it ignored.
    const sources = await cli(
      ["research", "Which zod API validates an email?", "--model", SCRIPTED_MODEL],
      {
        cwd: run.p.repo,
        preload: run.p.preload,
        env: {
          ...run.p.env,
          G2_STUB_PORT: String(run.stub.port),
          ...scriptEnv(run.p.record, { researcher: ["Use z.string().email()."] }),
        },
        timeoutMs: 120_000,
      },
    );
    expect(sources.stdout).toMatch(
      /^Network: \S*config\.toml: mode = "open" ignored \(a project's file may only narrow\)$/m,
    );
    expect(sources.stdout).toMatch(
      /^Network: \S*config\.toml: fetch_allow "blog\.elsewhere\.example\.test" ignored \(a project's file may only narrow\)$/m,
    );
    expect(sources.stdout).not.toMatch(/fetch_allow "docs\.lib\.example\.test" ignored/);
  }, 180_000);
});

describe('DS-N4-4 without research = "yes": web reads keep the person\'s mode and allowlist', () => {
  it('DS-N4-4: `research --web` with the person\'s mode = "allowlist" reports a project\'s mode = "open" and extra fetch_allow host ignored, and fetches nothing from that host', async () => {
    const run = await setup({
      user: '[network]\nmode = "allowlist"\nfetch_allow = ["docs.lib.example.test"]\n',
      project:
        '[network]\nmode = "open"\nfetch_allow = ["docs.lib.example.test", "blog.elsewhere.example.test"]\n',
    });
    const r = await cli(
      ["research", "Which zod API validates an email?", "--model", SCRIPTED_MODEL, "--web"],
      {
        cwd: run.p.repo,
        preload: run.p.preload,
        env: {
          ...run.p.env,
          G2_STUB_PORT: String(run.stub.port),
          SEKHEMET_SEARXNG_URL: "http://search.example.test",
          ...scriptEnv(run.p.record, {
            researcher: [
              [fetchCall(`https://${GUIDE}`), fetchCall(`https://${ELSEWHERE}`)],
              "Use z.string().email() [1].",
            ],
          }),
        },
        timeoutMs: 120_000,
      },
    );
    expect(r.stdout).toMatch(/mode = "open" ignored \(a project's file may only narrow\)/);
    expect(r.stdout).toMatch(/fetch_allow "blog\.elsewhere\.example\.test" ignored/);
    // The person's host is read; the host only the project added never is.
    expect(asked(run.stub), r.stdout + r.stderr).toEqual([GUIDE]);
  }, 180_000);
});

describe("SEC-13: with neither [network] mode nor research set, research and plan are offline", () => {
  it("SEC-13: a research card in `sekhemet queue` sends nothing and records no outbound request", async () => {
    const run = await setup({ user: '[review]\nintegration_branch = "main"\n' });
    await research(run, [[fetchCall(`https://${GUIDE}`)], "Nothing read."]);
    expect(researcherAsked(run)).toBe(true);
    expect(asked(run.stub)).toEqual([]);
    expect(egress(run.p.repo).filter((e) => e.allowed)).toEqual([]);
  }, 180_000);

  it("SEC-13: `sekhemet plan` sends nothing and records no outbound request", async () => {
    const run = await setup({ user: '[review]\nintegration_branch = "main"\n' });
    const planned = await cli(
      ["plan", "Validate emails with zod on the sign-up form", "--planner", "none"],
      {
        cwd: run.p.repo,
        preload: run.p.preload,
        env: { ...run.p.env, G2_STUB_PORT: String(run.stub.port), ...scriptEnv(run.p.record) },
        timeoutMs: 120_000,
      },
    );
    expect(planned.status, planned.stdout + planned.stderr).toBe(0);
    expect(asked(run.stub)).toEqual([]);
    expect(egress(run.p.repo).filter((e) => e.allowed)).toEqual([]);
  }, 180_000);
});

describe("SEC-13, SEC-14: the supply-chain gate's registry lookups, through `sekhemet queue`", () => {
  const PKG = '{ "name": "app", "version": "1.0.0", "dependencies": {} }\n';
  const ADDED = '{ "name": "app", "version": "1.0.0", "dependencies": { "left-pad": "^1.3.0" } }\n';

  async function queue(user: string | undefined) {
    const run = await setup({
      ...(user !== undefined ? { user } : {}),
      files: {
        "package.json": PKG,
        // The worktree's own .npmrc points the registry somewhere else.
        ".npmrc": "registry=https://evil.mirror.example.test/\n",
        "src/a.ts": "export const a = 1;\n",
      },
      cards: [
        {
          id: "c1",
          tier: "story",
          title: "Pad the labels",
          kind: "implement",
          scopeFiles: ["package.json"],
          stepBudget: 3,
          spec: "Add left-pad",
        },
      ],
    });
    const worker: Turn[] = [
      [{ name: "read_file", arguments: { path: "package.json" } }],
      [
        { name: "write_file", arguments: { path: "package.json", content: ADDED } },
        { name: "finish_card" },
      ],
    ];
    const out = await cli(["queue", "--worker", SCRIPTED_MODEL], {
      cwd: run.p.repo,
      preload: run.p.preload,
      env: {
        ...run.p.env,
        G2_STUB_PORT: String(run.stub.port),
        ...scriptEnv(run.p.record, { worker }),
      },
      timeoutMs: 150_000,
    });
    return { run, out: out.stdout + out.stderr };
  }

  it("SEC-14: a new dependency is looked up at the registry through the network policy, recorded on the card, and the worktree's .npmrc is not read", async () => {
    const { run, out } = await queue(
      '[network]\nmode = "allowlist"\nfetch_allow = ["registry.npmjs.org", "api.npmjs.org"]\n',
    );
    expect(asked(run.stub), out).toContain("registry.npmjs.org/left-pad");
    expect(asked(run.stub).some((r) => r.includes("evil.mirror"))).toBe(false);
    const lookups = egress(run.p.repo).filter((e) => e.purpose === "supply-chain");
    expect(lookups, out).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ host: "registry.npmjs.org", allowed: true }),
      ]),
    );
    expect(lookups.some((e) => e.host.includes("evil"))).toBe(false);
  }, 200_000);

  it("SEC-13: with no [network] in the person's config, the supply-chain gate sends nothing and records no outbound request", async () => {
    const { run, out } = await queue('[review]\nintegration_branch = "main"\n');
    expect(out).toMatch(/turn: write_file/);
    expect(asked(run.stub)).toEqual([]);
    expect(egress(run.p.repo).filter((e) => e.allowed)).toEqual([]);
  }, 200_000);
});

/**
 * `sekhemet queue` on card c1, whose Worker reads `manifest`, runs `extra`
 * (one more turn of calls, when given) and writes `after` into it.
 */
async function addDependency(opts: {
  user: string;
  manifest: string;
  before: string;
  after: string;
  pages?: Record<string, StubPage>;
  extra?: Turn;
  /** Dependencies a person registered in the licence register (so the licence check passes). */
  registered?: string[];
}) {
  const run = await setup({
    user: opts.user,
    ...(opts.pages ? { pages: opts.pages } : {}),
    files: {
      [opts.manifest]: opts.before,
      "src/a.ts": "export const a = 1;\n",
      ...(opts.registered
        ? {
            "docs/reference/PROVENANCE.md": `## Licences\n\n| Component | Licence | Use |\n|---|---|---|\n${opts.registered.map((d) => `| ${d} | MIT | a dependency |`).join("\n")}\n`,
          }
        : {}),
    },
    cards: [
      {
        id: "c1",
        tier: "story",
        title: "Add a dependency",
        kind: "implement",
        scopeFiles: [opts.manifest],
        stepBudget: 4,
        spec: "Add the dependency",
      },
    ],
  });
  const worker: Turn[] = [
    [{ name: "read_file", arguments: { path: opts.manifest } }],
    ...(opts.extra ? [opts.extra] : []),
    [
      { name: "write_file", arguments: { path: opts.manifest, content: opts.after } },
      { name: "finish_card" },
    ],
  ];
  const out = await cli(["queue", "--worker", SCRIPTED_MODEL], {
    cwd: run.p.repo,
    preload: run.p.preload,
    env: {
      ...run.p.env,
      G2_STUB_PORT: String(run.stub.port),
      ...scriptEnv(run.p.record, { worker }),
    },
    timeoutMs: 150_000,
  });
  const dir = join(run.p.repo, ".sekhemet", "evidence");
  const evidence = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => readFileSync(join(dir, f), "utf8"))
    .join("\n");
  const status = ledgerRows(run.p.repo)
    .filter((e) => e.type === "card/status_changed" && e.cardId === "c1")
    .map((e) => e.payload.toStatus)
    .at(-1);
  return { run, out: out.stdout + out.stderr, evidence, status };
}

const OPEN_REGISTRIES =
  '[network]\nmode = "allowlist"\nfetch_allow = ["registry.npmjs.org", "api.npmjs.org", "pypi.org"]\n';

describe("SEC-41: the supply-chain gate refuses an absent, a new and a look-alike package", () => {
  it("SEC-41: a card adding a package the registry does not have, one first published two days ago and a one-edit typosquat of a popular package fails the gate, each named with its rule", async () => {
    const recent = new Date(Date.now() - 2 * 86_400_000).toISOString();
    const { out, evidence, status } = await addDependency({
      user: OPEN_REGISTRIES,
      manifest: "package.json",
      before: '{ "name": "app", "version": "1.0.0", "dependencies": {} }\n',
      after: `${JSON.stringify({
        name: "app",
        version: "1.0.0",
        dependencies: {
          "zzq-made-up-pkg": "^1.0.0",
          "brand-new-widget": "^0.1.0",
          expresss: "^4.0.0",
        },
      })}\n`,
      registered: ["zzq-made-up-pkg", "brand-new-widget", "expresss"],
      pages: {
        "registry.npmjs.org/brand-new-widget": {
          type: "application/json",
          body: JSON.stringify({ name: "brand-new-widget", time: { created: recent } }),
        },
      },
    });
    expect(evidence, out).toContain(
      'adds \\"zzq-made-up-pkg\\", which does not exist in the registry',
    );
    expect(evidence).toMatch(
      /adds \\"brand-new-widget\\", first published 2 day\(s\) ago \(under 30\)/,
    );
    expect(evidence).toContain('adds \\"expresss\\", one edit away from \\"express\\"');
    expect(status).not.toBe("review");
  }, 200_000);
});

describe("SEC-43a: a Python dependency is looked up on PyPI", () => {
  it("SEC-43a: requirements.txt adding a package is looked up on PyPI, never npm; under 100 weekly downloads it is an advisory with the number, and the gate passes", async () => {
    const { run, out, evidence, status } = await addDependency({
      user: OPEN_REGISTRIES,
      manifest: "requirements.txt",
      before: "requests==2.31.0\n",
      after: "requests==2.31.0\nquietlib==1.0.0\n",
      registered: ["quietlib"],
      pages: {
        "pypi.org/pypi/quietlib/json": {
          type: "application/json",
          body: JSON.stringify({
            info: { downloads: { last_week: 7 } },
            releases: { "1.0.0": [{ upload_time_iso_8601: "2021-05-01T00:00:00.000Z" }] },
          }),
        },
      },
    });
    expect(asked(run.stub), out).toContain("pypi.org/pypi/quietlib/json");
    expect(asked(run.stub).some((r) => r.startsWith("registry.npmjs.org"))).toBe(false);
    expect(evidence).toContain(
      "dependency quietlib (pypi): 7 recent download(s), under the 100 floor",
    );
    expect(status, out).toBe("review");
  }, 200_000);
});

describe('SEC-52a: research = "yes" with mode unset opens research and nothing else', () => {
  const RESEARCH_ONLY = '[network]\nresearch = "yes"\n';

  it("SEC-52a: the Researcher fetches a public host not in fetch_deny through the policy, logged on the ledger", async () => {
    const run = await setup({ user: RESEARCH_ONLY });
    await research(run, [[fetchCall(`https://${ELSEWHERE}`)], "Use z.string().email() [1]."]);
    expect(asked(run.stub)).toEqual([ELSEWHERE]);
    expect(egress(run.p.repo)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ host: "blog.elsewhere.example.test", allowed: true }),
      ]),
    );
  }, 180_000);

  it("SEC-52a: a card's command has no route out, and the supply-chain lookup stays offline", async () => {
    const { run, out } = await addDependency({
      user: RESEARCH_ONLY,
      manifest: "package.json",
      before: '{ "name": "app", "version": "1.0.0", "dependencies": {} }\n',
      after: '{ "name": "app", "version": "1.0.0", "dependencies": { "left-pad": "^1.3.0" } }\n',
      registered: ["left-pad"],
      // 192.0.2.1 is TEST-NET-1 (RFC 5737): nothing answers there even if a packet left.
      extra: [
        {
          name: "run_cmd",
          arguments: {
            command: "node",
            args: [
              "-e",
              "require('net').connect(80, '192.0.2.1').on('connect', () => { console.log('NET=connected'); process.exit(0); }).on('error', (e) => { console.log('NET=' + e.code); process.exit(0); }); setTimeout(() => { console.log('NET=timeout'); process.exit(0); }, 4000);",
            ],
          },
        },
      ],
    });
    const told = recorded(run.p.record)
      .filter((x) => x.role === "worker")
      .flatMap((x) => x.body.messages.map((m) => m.content))
      .join("\n");
    // Refused at the socket by the sandbox: not a connection, not a wait for one.
    expect(told, out).toMatch(/NET=E(PERM|ACCES)/);
    expect(asked(run.stub)).toEqual([]);
    expect(egress(run.p.repo).filter((e) => e.allowed)).toEqual([]);
  }, 200_000);
});
