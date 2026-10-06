import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { installZod } from "./research_notes_fixture.js";
import { type LedgerRow, cli, g2Dirs, ledgerRows, pathWithoutGh } from "./support/g2_cli.js";
import { SCRIPTED_MODEL, type Turn, recorded, scriptEnv } from "./support/g2_model.js";
import { type G2Project, g2Project } from "./support/g2_project.js";
import { webStub } from "./support/g2_web.js";

/**
 * The research packet through `sekhemet plan` (design-stage §2.9, DS-N9-15,
 * DS-N9-11, DS-N9-16, DS-N9-19, DS-N9-20, DS-N9-22, DS-N9-23; DEC-59; FINISH_LINE_PLAN
 * C2d): the built binary spawned over a real repository with zod 3.23.8
 * installed as its release lays it out, the Planning model a scripted model
 * at the HTTP boundary writing the slices a model writes, the API names kept
 * whole. Every reference is checked against the installed package's files.
 *
 * The binary under test is `apps/harness/dist/index.js`, spawned by
 * `support/g2_cli.ts`.
 */

const SPEC = "a signup form that checks each address with `zod.email()` and `zod.ipv4()`";
const slice = (title: string, keywords: string[], behaviour: string) => ({
  kind: "path",
  title,
  keywords,
  rationale: "happy path",
  behaviour,
});
/** The Planning model's slices: two cards, each naming a zod member that is not where it says. */
const SLICES = JSON.stringify({
  slices: [
    slice(
      "Check each signup address",
      ["signup", "email"],
      "Given 'a@b.co', `zod.email()` accepts the address.",
    ),
    slice(
      "Refuse private network addresses",
      ["ipv4"],
      "Given '10.0.0.1', `zod.ipv4()` refuses the address.",
    ),
  ],
});
const TYPES = "node_modules/zod/lib/types.d.ts";

async function zodProject(qualify: { role?: "planner" | "researcher" }[] = []): Promise<G2Project> {
  const p = await g2Project(g2Dirs(), {
    files: {
      "src/schema.ts":
        'import { z } from "zod";\nexport const user = z.object({ name: z.string() });\n',
      ".gitignore": "node_modules\n.sekhemet/\n",
    },
    cards: [],
    qualifyAs: [{}, { role: "planner" }, ...qualify],
  });
  installZod(p.repo);
  return p;
}

function plan(p: G2Project, extra: string[] = [], env: Record<string, string> = {}) {
  return cli(["plan", SPEC, "--planner", SCRIPTED_MODEL, ...extra], {
    cwd: p.repo,
    preload: p.preload,
    env: { ...p.env, ...scriptEnv(p.record, { other: SLICES }), ...env },
    timeoutMs: 120_000,
  });
}

const ofType = (rows: LedgerRow[], type: string) => rows.filter((r) => r.type === type);
const noteId = (s: string) => `rn_${createHash("sha256").update(s).digest("hex").slice(0, 16)}`;

describe("sekhemet plan: the research packet, answered locally (research off)", () => {
  it("DS-N9-15, DS-N9-16, DS-N9-19, DS-N9-22: flags each unknown member without a model, answers it from the installed package, admits a cited note and feeds it to the card", async () => {
    const p = await zodProject();
    const r = await plan(p);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const rows = ledgerRows(p.repo);
    const cards = ofType(rows, "card/created")
      .map((x) => x.payload as { id: string; tier: string; title: string })
      .filter((c) => c.tier === "story");
    const email = cards.find((c) => c.title === "Check each signup address")?.id;
    const ipv4 = cards.find((c) => c.title === "Refuse private network addresses")?.id;
    if (!email || !ipv4) throw new Error(`cards not planned:\n${r.stdout}`);

    // DS-N9-15: one flag on each card, its symbol named; the Planning model
    // was asked once (the plan), never about a flag.
    const packets = ofType(rows, "research/packet");
    expect(packets.map((x) => [x.cardId, x.payload.flagged, x.private?.symbols])).toEqual([
      [email, 1, ["zod.email"]],
      [ipv4, 1, ["zod.ipv4"]],
    ]);
    expect(recorded(p.record).filter((x) => x.role === "researcher")).toEqual([]);

    // DS-N9-16: answered locally first — the member ZodString declares, with
    // its signature, cited to the file and line at the installed version —
    // and, with research off, the Research model not asked, saying why.
    const research = ofType(rows, "card/research");
    const onEmail = research.find((x) => x.cardId === email)?.payload as {
      text: string;
      sources?: string[];
    };
    expect(onEmail.text).toContain("email(message?: errorUtil.ErrMessage): ZodString;");
    expect(onEmail.sources).toEqual(["deps:npm:zod@3.23.8/lib/types.d.ts:7"]);
    expect(packets.map((x) => x.private?.notAsked)).toEqual([
      "research is off for this plan, so nothing was looked up",
      "research is off for this plan, so nothing was looked up",
    ]);
    expect(r.stdout).toMatch(
      /Research packet: 2 unknown API references in 2 issues; 1 answered from the installed packages, 0 from research notes, 0 by the Research model \(the Research model was not asked: research is off/,
    );
    // DS-N9-22: one entry per flag, at most 400 characters, with its source.
    for (const x of research) expect((x.payload.text as string).length).toBeLessThanOrEqual(400);

    // DS-N9-19: the grounded local answer is admitted as a note, by the
    // model-free check: its id from eco|pkg|ver|symbol, the cited file's hash.
    const [admitted] = ofType(rows, "research/note_admitted");
    const fileSha = createHash("sha256")
      .update(readFileSync(join(p.repo, TYPES)))
      .digest("hex");
    expect(admitted?.payload).toMatchObject({
      noteId: noteId("npm|zod|3.23.8|email"),
      symbol: "email",
      ecosystem: "npm",
      package: "zod",
      version: "3.23.8",
      citation: {
        kind: "local",
        ref: "deps:npm:zod@3.23.8/lib/types.d.ts:7",
        line: 7,
        fileSha256: fileSha,
      },
      check: { kind: "citation" },
      answeredBy: "local",
    });
    expect((admitted?.private?.excerpt as string).length).toBeLessThanOrEqual(600);
    expect(admitted?.private?.question).toMatch(
      /In zod@3\.23\.8 \(npm\), what is the API for `email`\?/,
    );
    expect(admitted?.private?.repo).toBe(p.repo);
    // DS-N9-22: the note's entry is followed by its feed to that card.
    const fed = ofType(rows, "research/note_fed");
    expect(fed.map((x) => x.payload)).toEqual([
      { noteId: admitted?.payload.noteId, cardId: email },
    ]);
    expect(fed[0]?.seq).toBeGreaterThan(research.find((x) => x.cardId === email)?.seq ?? 0);
  }, 180_000);

  it("DS-N9-20: a later plan's flag reuses the note after re-checking its source's hash; a changed source retires it and the flag is answered afresh", async () => {
    const p = await zodProject();
    await plan(p);
    const id = noteId("npm|zod|3.23.8|email");
    // A second plan, the source unchanged: the note is reused, nothing new admitted.
    const again = await plan(p);
    expect(again.stdout).toMatch(/1 from research notes/);
    let rows = ledgerRows(p.repo);
    expect(ofType(rows, "research/note_admitted")).toHaveLength(1);
    expect(ofType(rows, "research/note_fed").filter((x) => x.payload.noteId === id)).toHaveLength(
      2,
    );
    expect(ofType(rows, "research/packet").at(-2)?.payload).toMatchObject({ reused: 1 });
    // The installed file changes under the note: retired, answered afresh.
    writeFileSync(join(p.repo, TYPES), `${readFileSync(join(p.repo, TYPES), "utf8")}// patched\n`);
    const third = await plan(p);
    expect(third.status, third.stderr).toBe(0);
    rows = ledgerRows(p.repo);
    expect(ofType(rows, "research/note_retired").map((x) => x.payload)).toEqual([
      expect.objectContaining({ noteId: id, reason: "source_changed" }),
    ]);
    const admitted = ofType(rows, "research/note_admitted");
    expect(admitted).toHaveLength(2);
    expect(admitted[1]?.payload.noteId).toBe(id);
    expect((admitted[1]?.payload.citation as { fileSha256: string }).fileSha256).not.toBe(
      (admitted[0]?.payload.citation as { fileSha256: string }).fileSha256,
    );
  }, 240_000);
});

describe("sekhemet plan: a note retired when its version is no longer installed (DS-N9-21)", () => {
  it("DS-N9-21: after zod is bumped to 3.24.0, the next plan retires the 3.23.8 note as lockfile, naming the new version, and never feeds it", async () => {
    const p = await zodProject();
    expect((await plan(p)).status).toBe(0);
    const id = noteId("npm|zod|3.23.8|email");
    const fedBefore = ofType(ledgerRows(p.repo), "research/note_fed").length;
    installZod(p.repo, "3.24.0");
    const again = await plan(p);
    expect(again.status, again.stdout + again.stderr).toBe(0);
    const rows = ledgerRows(p.repo);
    const retired = ofType(rows, "research/note_retired");
    expect(retired.map((x) => x.payload)).toEqual([
      expect.objectContaining({ noteId: id, reason: "lockfile" }),
    ]);
    expect(String(retired[0]?.private?.detail)).toMatch(/3\.24\.0/);
    // The retired note feeds no card after it was retired.
    const fedAfter = ofType(rows, "research/note_fed").slice(fedBefore);
    expect(fedAfter.filter((x) => x.payload.noteId === id)).toEqual([]);
  }, 240_000);
});

describe("sekhemet plan: the packet's question to the Researcher (research on)", () => {
  it("DS-N9-11, DS-N9-16, DS-N9-23: asks only what nothing local answers, holding the identifier and pkg@ver alone, with the dependency tools and not the project's", async () => {
    const p = await zodProject([{ role: "researcher" }]);
    const stub = await webStub({});
    const user = join(p.home, "config.toml");
    writeFileSync(user, '[network]\nresearch = "yes"\nresearch_hosts = []\n');
    const researcher: Turn[] = [
      "Not settled: the sources read do not say.",
      "Not settled: nothing found.",
    ];
    const r = await plan(p, ["--researcher", SCRIPTED_MODEL], {
      SEKHEMET_USER_CONFIG: user,
      G2_STUB_PORT: String(stub.port),
      PATH: pathWithoutGh(p.home),
      ...scriptEnv(p.record, { other: SLICES, researcher }),
    });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const asked = recorded(p.record).filter((x) => x.role === "researcher");
    const packetAsks = asked.filter((x) =>
      x.body.messages.some((m) => /what is the API for `ipv4`/.test(m.content)),
    );
    expect(packetAsks.length, r.stdout + r.stderr).toBeGreaterThan(0);
    for (const x of packetAsks) {
      const question = x.body.messages.map((m) => m.content).join("\n");
      // DS-N9-23: the identifier and pkg@ver, templated; no other spec text.
      expect(question).toContain("zod@3.23.8");
      expect(question).not.toMatch(/signup|private network|10\.0\.0\.1/);
      // DS-N9-16: the dependency tools, never those that read the project.
      const tools = (x.body.tools ?? []).map(
        (t) =>
          (t as { function?: { name: string }; name?: string }).function?.name ??
          (t as { name: string }).name,
      );
      expect(tools).toEqual(expect.arrayContaining(["deps_source", "deps_grep", "probe"]));
      expect(tools).not.toContain("module_api");
      expect(tools).not.toContain("git_history");
    }
    // DS-N9-11: each question carried the project's pin of the dependency it names.
    const askedEvents = ledgerRows(p.repo).filter((x) => x.type === "research/asked");
    expect(askedEvents.length).toBeGreaterThan(0);
    for (const e of askedEvents) expect(e.payload.pins).toEqual(["npm:zod@3.23.8"]);
    // `email` was answered locally: never put to the Researcher.
    expect(asked.some((x) => x.body.messages.some((m) => /API for `email`/.test(m.content)))).toBe(
      false,
    );
  }, 240_000);
});

/**
 * A Python project with its virtual environment, laid out as pip lays it out
 * (DS-N9-2): requests 2.32.3 installed with a stub beside its source.
 */
async function requestsProject(): Promise<G2Project> {
  const p = await g2Project(g2Dirs(), {
    files: {
      "app.py": "import requests\n\nprint(requests.get)\n",
      "requirements.txt": "requests==2.32.3\n",
      ".gitignore": ".venv\n.sekhemet/\n",
    },
    cards: [],
    qualifyAs: [{}, { role: "planner" }],
  });
  execFileSync("python3", ["-m", "venv", "--without-pip", join(p.repo, ".venv")]);
  const lib = join(p.repo, ".venv", "lib");
  const site = join(lib, readdirSync(lib)[0] as string, "site-packages");
  const info = join(site, "requests-2.32.3.dist-info");
  mkdirSync(join(site, "requests"), { recursive: true });
  mkdirSync(info, { recursive: true });
  const files: Record<string, string> = {
    "requests/__init__.py":
      "from .api import get\nfrom .sessions import Session\n__all__ = ['get', 'Session']\n",
    "requests/api.py":
      'def get(url, params=None, **kwargs):\n    """Sends a GET request."""\n    return None\n',
    "requests/sessions.py":
      'class Session:\n    """A Requests session."""\n    def mount(self, prefix, adapter):\n        return None\n',
    // The stub is read before the source (DS-N9-2).
    "requests/sessions.pyi":
      "class Session:\n    def mount(self, prefix: str, adapter: HTTPAdapter) -> None: ...\n",
  };
  for (const [rel, text] of Object.entries(files)) writeFileSync(join(site, rel), text);
  writeFileSync(
    join(info, "METADATA"),
    "Metadata-Version: 2.1\nName: requests\nVersion: 2.32.3\nSummary: HTTP for Humans.\n",
  );
  writeFileSync(
    join(info, "RECORD"),
    `${[...Object.keys(files), "requests-2.32.3.dist-info/METADATA"].map((f) => `${f},,`).join("\n")}\n`,
  );
  writeFileSync(join(info, "top_level.txt"), "requests\n");
  return p;
}

const PY_SLICES = JSON.stringify({
  slices: [
    slice(
      "Fetch the rates page",
      ["rates"],
      "Given the rates URL, `requests.mount()` sets the retrying adapter and the script prints the page.",
    ),
  ],
});

describe("sekhemet plan: the research packet on a Python project (research off)", () => {
  it("DS-N9-2: answers a requests member that is not where the plan says from the virtual environment's distribution, its stub read before its source", async () => {
    const p = await requestsProject();
    const r = await cli(
      [
        "plan",
        "a script that fetches the rates page with `requests.get()`",
        "--planner",
        SCRIPTED_MODEL,
      ],
      {
        cwd: p.repo,
        preload: p.preload,
        env: { ...p.env, ...scriptEnv(p.record, { other: PY_SLICES }) },
        timeoutMs: 120_000,
      },
    );
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const rows = ledgerRows(p.repo);
    const research = ofType(rows, "card/research").map(
      (x) => x.payload as { text: string; sources?: string[] },
    );
    // One flag, answered from the installed distribution without a model:
    // the member is the class's, read from its stub before its source.
    const packets = ofType(rows, "research/packet");
    expect(
      packets.map((x) => [x.payload.flagged, x.payload.answeredLocally, x.private?.symbols]),
    ).toEqual([[1, 1, ["requests.mount"]]]);
    expect(research).toHaveLength(1);
    expect(research[0]?.text).toContain(
      "`def mount(self, prefix: str, adapter: HTTPAdapter) -> None: ...` (in Session,",
    );
    expect(research[0]?.sources).toEqual(["deps:python:requests@2.32.3/requests/sessions.pyi:2"]);
  }, 180_000);
});

/**
 * A Rust project whose Cargo.lock holds two serde_json versions, the project's
 * own package depending on the second, each unpacked under CARGO_HOME as cargo
 * unpacks it (DS-N9-4): `registry/src/<index>/<name>-<version>`.
 */
async function serdeProject(): Promise<{ p: G2Project; cargoHome: string }> {
  const p = await g2Project(g2Dirs(), {
    files: {
      "Cargo.toml":
        '[package]\nname = "app"\nversion = "0.1.0"\n\n[dependencies]\nserde_json = "1"\n',
      "Cargo.lock": [
        "version = 3",
        "",
        "[[package]]",
        'name = "app"',
        'version = "0.1.0"',
        'dependencies = [\n "serde_json 1.0.120",\n]',
        "",
        "[[package]]",
        'name = "serde_json"',
        'version = "1.0.100"',
        'source = "registry+https://github.com/rust-lang/crates.io-index"',
        "",
        "[[package]]",
        'name = "serde_json"',
        'version = "1.0.120"',
        'source = "registry+https://github.com/rust-lang/crates.io-index"',
        "",
      ].join("\n"),
      "src/main.rs": "fn main() {}\n",
      ".gitignore": "target\n.sekhemet/\n",
    },
    cards: [],
    qualifyAs: [{}, { role: "planner" }],
  });
  const cargoHome = join(p.home, "cargo");
  for (const version of ["1.0.100", "1.0.120"]) {
    const crate = join(
      cargoHome,
      "registry",
      "src",
      "index.crates.io-6f17d22bba15001f",
      `serde_json-${version}`,
    );
    mkdirSync(join(crate, "src", "value"), { recursive: true });
    writeFileSync(
      join(crate, "Cargo.toml"),
      `[package]\nname = "serde_json"\nversion = "${version}"\n`,
    );
    writeFileSync(join(crate, "src", "lib.rs"), "pub mod value;\npub use crate::value::Value;\n");
    writeFileSync(
      join(crate, "src", "value", "mod.rs"),
      [
        "pub enum Value {",
        "    Null,",
        "}",
        "",
        "impl Value {",
        `    pub fn as_str(&self) -> Option<&str> { None } // ${version}`,
        "}",
        "",
      ].join("\n"),
    );
  }
  return { p, cargoHome };
}

describe("sekhemet plan: the research packet on a Rust project (research off)", () => {
  it("DS-N9-4: answers a serde_json member from the registry source of the version the project's own package depends on, compiling and fetching nothing", async () => {
    const { p, cargoHome } = await serdeProject();
    const slices = JSON.stringify({
      slices: [
        slice(
          "Read the name field",
          ["name"],
          'Given {"name": "ada"}, `serde_json.as_str()` returns the name as text.',
        ),
      ],
    });
    const r = await cli(
      ["plan", "read the name field with `serde_json.as_str()`", "--planner", SCRIPTED_MODEL],
      {
        cwd: p.repo,
        preload: p.preload,
        env: { ...p.env, CARGO_HOME: cargoHome, ...scriptEnv(p.record, { other: slices }) },
        timeoutMs: 120_000,
      },
    );
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const rows = ledgerRows(p.repo);
    const research = ofType(rows, "card/research").map(
      (x) => x.payload as { text: string; sources?: string[] },
    );
    expect(research, r.stdout).toHaveLength(1);
    expect(research[0]?.sources).toEqual(["deps:rust:serde_json@1.0.120/src/value/mod.rs:6"]);
    expect(research[0]?.text).toContain("// 1.0.120");
    // Nothing compiled, nothing fetched: no target directory, no lockfile change.
    expect(readdirSync(p.repo)).not.toContain("target");
  }, 180_000);
});
