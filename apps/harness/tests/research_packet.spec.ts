import { existsSync } from "node:fs";
import { join } from "node:path";
import { MockInferenceAdapter } from "@sekhemet/models";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NOTE_EVENTS, readNotes } from "../src/research/notes.js";
import {
  PACKET_EVENT,
  PACKET_MAX_QUESTIONS,
  type PacketAnswer,
  type PlanResearcherBatch,
  askable,
  finishPacket,
  flagCard,
  preparePacket,
} from "../src/research/packet.js";
import { ResearchCache } from "../src/research/polite.js";
import { acquireRunnerLease } from "../src/runner_lease.js";
import { planCommand } from "../src/wave2.js";
import { EMAIL_LINE, type Fixture, fixture, story, writeFiles } from "./research_notes_fixture.js";

/**
 * design-stage DS-N9-15, -16, -20, -22: the research packet flags, without a
 * model, the members and packages a card names that the installed
 * dependencies do not have, answers each locally first, asks the Researcher
 * only in the plan's one Researcher load, and records each answer as one
 * cited `card/research` entry. A real ledger and a real installed zod; the
 * Researcher is a recorded answer, so no model loads and nothing is fetched.
 */

let f: Fixture;
let fetches: string[];
beforeEach(() => {
  f = fixture();
  vi.stubEnv("SEKHEMET_CONFIG_DIR", join(f.root, "user"));
  vi.stubEnv("SEKHEMET_RESEARCH_CACHE", f.cacheDir);
  vi.stubEnv("SEKHEMET_OFFLINE", undefined as unknown as string);
  fetches = [];
  vi.stubGlobal("fetch", async (input: string | URL) => {
    fetches.push(String(input));
    return new Response("{}", { status: 200 });
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  f.close();
});

const card = async (id: string) => (await f.cardStore.getCard(id)) as never;
const k = () => ({ repoPath: f.repo, log: f.log, cardStore: f.cardStore });

async function research(cardId: string) {
  return (await f.cardStore.getDossier(cardId)).research;
}

async function packets() {
  return (await f.log.getEventsByTypes([PACKET_EVENT])).map((e) => e.payload);
}

describe("DS-N9-15: unknown members and packages are flagged without a model", () => {
  it("flags a fabricated `zod.email()` against the installed zod", async () => {
    await story(f, "c1", "Validate the signup address with `zod.email()` before saving.");
    const flags = await flagCard(f.repo, await card("c1"));
    expect(flags).toEqual([
      expect.objectContaining({
        cardId: "c1",
        kind: "member",
        written: "zod.email",
        eco: "npm",
        pkg: "zod",
        version: "3.23.8",
        symbol: "email",
        missing: "email",
      }),
    ]);
  });

  it("flags nothing that exists, nothing the card builds, and no member it cannot list", async () => {
    await story(
      f,
      "c1",
      [
        "Build `validateEmail` in src/validate.ts with `zod.string()` and `zod.object()`.",
        "Call `utils.formatDate` and `user.name`, then `z.string().email()` and `z.anything()`.",
        "Read `schema.ts`, `ZodString.email` and `zod.ZodString`.",
      ].join(" "),
      ["`zod.number()` parses the age", "The `zod` library stays at its version"],
    );
    expect(await flagCard(f.repo, await card("c1"))).toEqual([]);
  });

  it("follows the repository's import aliases: a namespace against the exports, a named type against its members", async () => {
    writeFiles(f.repo, {
      "src/a.ts":
        'import * as zz from "zod";\nimport { ZodString as S } from "zod";\nzz.string();\n',
    });
    await story(f, "c1", "Use `zz.emale()` and `S.emale()`; `zz.string()` and `S.email()` exist.");
    const flags = await flagCard(f.repo, await card("c1"));
    expect(flags.map((x) => [x.written, x.symbol, x.missing])).toEqual([
      ["zz.emale", "emale", "emale"],
      ["S.emale", "ZodString.emale", "emale"],
    ]);
  });

  it("never flags a name the repository itself declares: a workspace package or its own code (DS-N9-15)", async () => {
    writeFiles(f.repo, {
      "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n',
      "packages/core/package.json": JSON.stringify({ name: "@app/core", version: "1.0.0" }),
      "packages/core/src/index.ts": "export const core = 1;\n",
      "src/fmt.ts": "export function formatter(s: string): string {\n  return s;\n}\n",
    });
    await story(
      f,
      "c1",
      "Use the `@app/core` package and the `formatter` library; the `email-validator` package is new.",
    );
    const flags = await flagCard(f.repo, await card("c1"));
    expect(flags.map((x) => x.written)).toEqual(["email-validator"]);
  });

  it("flags a backticked package that is not installed, and no more than four per card", async () => {
    await story(
      f,
      "c1",
      "Check addresses with the `email-validator` package, `@acme/mailcheck` and the `zod` library.",
      ["`zod.a1()`", "`zod.b2()`", "`zod.c3()`", "`zod.d4()`"],
    );
    const flags = await flagCard(f.repo, await card("c1"));
    expect(flags).toHaveLength(4);
    expect(flags.slice(0, 2).map((x) => [x.kind, x.written])).toEqual([
      ["package", "email-validator"],
      ["package", "@acme/mailcheck"],
    ]);
  });
});

describe("DS-N9-15: the adapters' own declarations, in every ecosystem", () => {
  it("never flags a Rust `#[macro_export]` macro, and answers a misspelt one from it", async () => {
    const home = join(f.root, "cargo");
    vi.stubEnv("CARGO_HOME", home);
    const crate = join(
      home,
      "registry",
      "src",
      "index.crates.io-6f17d22bba15001f",
      "anyhow-1.0.86",
    );
    writeFiles(crate, {
      "Cargo.toml": '[package]\nname = "anyhow"\nversion = "1.0.86"\n',
      "src/lib.rs": "#[macro_use]\nmod macros;\npub struct Error;\n",
      "src/macros.rs":
        "/// Return early with an error.\n#[macro_export]\nmacro_rules! bail {\n    ($msg:literal) => { return Err(anyhow!($msg)) };\n}\n",
    });
    writeFiles(f.repo, {
      "Cargo.toml": '[package]\nname = "app"\nversion = "0.1.0"\n\n[dependencies]\nanyhow = "1"\n',
      "Cargo.lock": [
        "version = 3",
        "",
        "[[package]]",
        'name = "anyhow"',
        'version = "1.0.86"',
        'source = "registry+https://github.com/rust-lang/crates.io-index"',
        "",
      ].join("\n"),
    });
    await story(f, "c1", 'Stop with `anyhow::bail!("missing file")` when the file is gone.');
    expect(await flagCard(f.repo, await card("c1"))).toEqual([]);
    await story(f, "c2", 'Stop with `anyhow::bial!("missing file")` when the file is gone.');
    const prepared = await preparePacket(k(), ["c2"]);
    expect(prepared.cards[0]?.flags[0]?.flag).toMatchObject({ pkg: "anyhow", missing: "bial" });
    expect(prepared.questions).toEqual([]);
    await finishPacket(k(), prepared, { notAsked: "research is off" });
    const [entry] = await research("c2");
    expect(entry?.text).toContain("macro_rules! bail");
    expect(entry?.sources).toEqual(["deps:rust:anyhow@1.0.86/src/macros.rs:3"]);
  });
});

describe("DS-N9-16: the plan asks the Researcher at most eight packet questions", () => {
  it("answers past the cap locally, and says how many were not asked", async () => {
    const names = Array.from(
      { length: 12 },
      (_, i) => `zod.qq${String.fromCharCode(97 + i)}${i}x()`,
    );
    for (let c = 0; c < 3; c++)
      await story(
        f,
        `c${c}`,
        "Use these.",
        names.slice(c * 4, c * 4 + 4).map((n) => `\`${n}\``),
      );
    const prepared = await preparePacket(k(), ["c0", "c1", "c2"]);
    expect(prepared.questions).toHaveLength(PACKET_MAX_QUESTIONS);
    expect(PACKET_MAX_QUESTIONS).toBe(8);
    expect(prepared.unasked).toBe(4);
    await finishPacket(k(), prepared, { answers: [], notAsked: undefined });
    const all = (await packets()) as { flagged: number }[];
    expect(all.reduce((n, p) => n + p.flagged, 0)).toBe(12);
  });
});

describe("DS-N9-16, -22: answered locally first, recorded as one cited entry", () => {
  it("answers `zod.email()` from the installed declarations and feeds the note to the card", async () => {
    await story(f, "c1", "Validate the signup address with `zod.email()` before saving.");
    const prepared = await preparePacket(k(), ["c1"]);
    expect(prepared.questions).toEqual([]);
    await finishPacket(k(), prepared, { notAsked: "research is off" });
    expect(await packets()).toEqual([
      { card: "c1", flagged: 1, answeredLocally: 1, askedResearcher: 0, reused: 0 },
    ]);
    const [entry] = await research("c1");
    expect(entry?.text.length).toBeLessThanOrEqual(400);
    expect(entry?.text).toContain("zod.email");
    expect(entry?.text).toContain("email(message?: errorUtil.ErrMessage): ZodString;");
    expect(entry?.text).toContain("ZodString");
    expect(entry?.sources).toEqual([`deps:npm:zod@3.23.8/lib/types.d.ts:${EMAIL_LINE}`]);
    const fed = await f.log.getEventsByTypes([NOTE_EVENTS.fed]);
    expect(fed.map((e) => e.payload)).toEqual([
      { noteId: expect.stringMatching(/^rn_/), cardId: "c1" },
    ]);
  });

  it("asks only a flag in identifier form: never a phrase (DS-N9-23)", () => {
    const base = {
      cardId: "c1",
      kind: "member" as const,
      eco: "npm" as const,
      pkg: "zod",
      version: "3.23.8",
    };
    const flag = (symbol: string) => ({
      ...base,
      written: `zod.${symbol}`,
      symbol,
      missing: symbol,
    });
    expect(askable(flag("ipv4"))).toBe(true);
    expect(askable(flag("ZodString.emale"))).toBe(true);
    expect(askable({ ...flag("x"), kind: "package", pkg: "@acme/mailcheck" })).toBe(true);
    expect(askable(flag("charge acme customer"))).toBe(false);
    expect(askable(flag("a".repeat(121)))).toBe(false);
  });

  it("asks the Researcher only what nothing local answers, with the symbol and pkg@ver alone", async () => {
    await story(
      f,
      "c1",
      "Reject private networks in the acme billing signup with `zod.ipv4()`; `zod.email()` checks the address.",
    );
    const prepared = await preparePacket(k(), ["c1"]);
    expect(prepared.questions).toHaveLength(1);
    const q = prepared.questions[0]?.question ?? "";
    expect(q).toContain("`ipv4`");
    expect(q).toContain("zod@3.23.8");
    for (const word of ["acme", "billing", "signup", "private", "Reject"])
      expect(q).not.toContain(word);
  });

  it("a second card reuses the note with no Researcher call", async () => {
    const url = "https://unpkg.com/zod@3.23.8/README.md";
    new ResearchCache(f.cacheDir).set(
      url,
      200,
      "text/markdown",
      '# Zod\n\n## IP addresses\n\nThere is no `z.ipv4()` in 3.23.8: use `z.string().ip({ version: "v4" })`.\n',
    );
    const asked: string[][] = [];
    const batch: PlanResearcherBatch = async ({ packet }) => {
      asked.push([...packet]);
      return {
        packet: packet.map(
          (): PacketAnswer => ({
            answer: 'Use z.string().ip({ version: "v4" }) [1].',
            sources: [url],
            grounded: true,
            evidence: [{ kind: "documentation", ref: url, excerpt: "no `z.ipv4()`" }],
          }),
        ),
      };
    };
    await story(f, "c1", "Accept IPv4 addresses with `zod.ipv4()`.");
    const first = await preparePacket(k(), ["c1"]);
    const out = await batch({ packet: first.questions.map((q) => q.question) });
    await finishPacket(k(), first, { answers: out.packet, model: "apodex-32b" });
    expect(asked).toHaveLength(1);
    const [noteEvent] = await f.log.getEventsByTypes([NOTE_EVENTS.admitted]);
    expect(noteEvent?.payload).toMatchObject({ answeredBy: "researcher", model: "apodex-32b" });

    await story(f, "c2", "Log the client address checked by `zod.ipv4()`.");
    const second = await preparePacket(k(), ["c2"]);
    expect(second.questions).toEqual([]);
    await finishPacket(k(), second, {});
    expect(asked).toHaveLength(1);
    expect((await packets())[1]).toEqual({
      card: "c2",
      flagged: 1,
      answeredLocally: 0,
      askedResearcher: 0,
      reused: 1,
    });
    const [entry] = await research("c2");
    expect(entry?.text).toContain("z.ipv4()");
    expect(entry?.sources?.[0]).toBe(`${url}#ip-addresses`);
    const fed = (await f.log.getEventsByTypes([NOTE_EVENTS.fed])).map((e) => e.payload);
    expect(fed).toEqual([
      { noteId: expect.any(String), cardId: "c1" },
      { noteId: expect.any(String), cardId: "c2" },
    ]);
  });

  it("a Researcher answer with no grounded check reaches the dossier as plain research, never a note", async () => {
    await story(f, "c1", "Accept IPv4 addresses with `zod.ipv4()`.");
    const prepared = await preparePacket(k(), ["c1"]);
    await finishPacket(k(), prepared, {
      answers: [{ answer: "Probably z.ip().", sources: [], grounded: false, evidence: [] }],
      model: "m",
    });
    expect(await f.log.getEventsByTypes([NOTE_EVENTS.admitted])).toHaveLength(0);
    expect((await readNotes(f.log)).live.size).toBe(0);
    const [entry] = await research("c1");
    expect(entry?.text).toContain("Probably z.ip()");
    expect((await packets())[0]).toMatchObject({ askedResearcher: 1, answeredLocally: 0 });
  });
});

describe("the packet inside `plan` (DS-N9-16, DS-P7-10)", () => {
  const SPEC = "a signup form that checks each address with `zod.email()` and `zod.ipv4()`";
  const usage = { promptTokens: 1, completionTokens: 1, durationMs: 1 };
  const slice = (title: string, keywords: string[], behaviour: string) => ({
    kind: "path",
    title,
    keywords,
    rationale: "happy path",
    behaviour,
  });
  /** The Planning model's slices, as a model writes them: the API names kept whole. */
  const sketcher = () =>
    new MockInferenceAdapter("planner", [
      {
        text: JSON.stringify({
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
        }),
        toolCalls: [],
        usage,
      },
    ]);

  async function planned(): Promise<string[]> {
    return (await f.cardStore.listCards()).filter((c) => c.tier !== "epic").map((c) => c.id);
  }

  it("research off still gets local answers and makes no request", async () => {
    await planCommand(k(), SPEC, {
      print: () => undefined,
      sketcher: sketcher(),
      deep: { skipped: "research is off for this plan, so nothing was looked up" },
    });
    expect(fetches).toEqual([]);
    const cards = await planned();
    const entries = (await Promise.all(cards.map(research))).flat();
    expect(entries.some((e) => e.text.includes("email(message?"))).toBe(true);
    const counts = (await packets()) as { askedResearcher: number; answeredLocally: number }[];
    expect(counts.length).toBeGreaterThan(0);
    expect(counts.every((p) => p.askedResearcher === 0)).toBe(true);
    expect(counts.some((p) => p.answeredLocally > 0)).toBe(true);
    expect(existsSync(join(f.root, "user", "research", "memory.jsonl"))).toBe(false);
  });

  it("asks the deep question and the packet's questions in one Researcher load", async () => {
    const loads: { deep?: string; packet: readonly string[] }[] = [];
    let singles = 0;
    await planCommand(k(), SPEC, {
      print: () => undefined,
      sketcher: sketcher(),
      deep: {
        run: async () => {
          singles++;
          return { answer: "x", sources: ["https://x.test"], grounded: true };
        },
        batch: async (q) => {
          loads.push(q);
          return {
            ...(q.deep !== undefined
              ? {
                  deep: {
                    answer: "Teams use hosted form validators.",
                    sources: ["https://example.org/forms"],
                    grounded: true,
                  },
                }
              : {}),
            packet: q.packet.map(() => ({
              answer: "No such API.",
              sources: [],
              grounded: false,
              evidence: [],
            })),
          };
        },
      },
    });
    expect(singles).toBe(0);
    expect(loads).toHaveLength(1);
    expect(loads[0]?.deep).toBeDefined();
    expect(loads[0]?.packet.some((q) => q.includes("`ipv4`"))).toBe(true);
    const brief = await import("node:fs").then((fs) =>
      fs.readFileSync(join(f.repo, ".sekhemet", "brief.md"), "utf8"),
    );
    expect(brief).toContain("hosted form validators");
  });

  it("loads no Researcher for the packet alone: a plan that asks no deep question answers locally (DS-N9-16)", async () => {
    writeFiles(f.repo, { ".sekhemet/brief.md": "# Brief\n\nAlready written.\n" });
    let loads = 0;
    const lines: string[] = [];
    await planCommand(k(), SPEC, {
      print: (l: string) => lines.push(l),
      sketcher: sketcher(),
      deep: {
        run: async () => ({ answer: "x", sources: [], grounded: true }),
        batch: async (q) => {
          loads++;
          return { packet: q.packet.map(() => ({ failed: "unused" })) };
        },
      },
    });
    expect(loads).toBe(0);
    const counts = (await packets()) as { askedResearcher: number }[];
    expect(counts.length).toBeGreaterThan(0);
    expect(counts.every((p) => p.askedResearcher === 0)).toBe(true);
    expect(lines.join("\n")).toMatch(/Research model was not asked: .*deep question/);
  });

  it("a running card keeps the Researcher unloaded: local answers only", async () => {
    let loads = 0;
    const lease = acquireRunnerLease(f.repo, { kind: "run", cardId: "c-9" });
    try {
      const { deepPriorArtFor } = await import("../src/research/plan_research.js");
      const deep = deepPriorArtFor({
        repoPath: f.repo,
        allowed: true,
        offline: false,
        researcher: "apodex",
        ask: async () => ({ answer: "a", sources: ["s"], grounded: true }),
        batch: async () => {
          loads++;
          return { packet: [] };
        },
      });
      await planCommand(k(), SPEC, { print: () => undefined, sketcher: sketcher(), deep });
    } finally {
      if ("release" in lease) lease.release();
    }
    expect(loads).toBe(0);
    const counts = (await packets()) as { askedResearcher: number; answeredLocally: number }[];
    expect(counts.length).toBeGreaterThan(0);
    expect(counts.every((p) => p.askedResearcher === 0)).toBe(true);
    expect(counts.some((p) => p.answeredLocally > 0)).toBe(true);
  });
});
