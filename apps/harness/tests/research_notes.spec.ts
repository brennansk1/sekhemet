import { createHash } from "node:crypto";
import { join } from "node:path";
import { dependencyRuntime } from "@sekhemet/loop";
import { ProcessSandbox } from "@sekhemet/sandbox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  NOTE_EVENTS,
  admitLocalNote,
  admitResearchNote,
  isReproducedProbe,
  noteId,
  readNotes,
  recordNoteFed,
  retireStale,
  reuseNote,
} from "../src/research/notes.js";
import {
  type PacketFlag,
  answerLocally,
  finishPacket,
  flagCard,
  preparePacket,
} from "../src/research/packet.js";
import { ResearchCache } from "../src/research/polite.js";
import { runResearchProbe } from "../src/research/probe.js";
import {
  EMAIL_LINE,
  type Fixture,
  ZOD_TYPES,
  fixture,
  installZod,
  story,
  writeFiles,
} from "./research_notes_fixture.js";

/**
 * design-stage DS-N9-19 to -22: research notes are ledger events on a real
 * SQLite ledger, admitted model-free, reused by eco, package, version and
 * symbol after a hash re-check, and retired on a lockfile change or a fed
 * card's failure that names them. No model is loaded and nothing is fetched.
 */

const confines = new ProcessSandbox({ engine: "native" }).confinement !== "none";

let f: Fixture;
beforeEach(() => {
  f = fixture();
  vi.stubEnv("SEKHEMET_CONFIG_DIR", join(f.root, "user"));
  vi.stubEnv("SEKHEMET_RESEARCH_CACHE", f.cacheDir);
});
afterEach(() => {
  vi.unstubAllEnvs();
  f.close();
});

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

async function emailFlag(): Promise<PacketFlag> {
  await story(f, "c1", "Validate the signup address with `zod.email()` before saving.");
  const flags = await flagCard(f.repo, (await f.cardStore.getCard("c1")) as never);
  const flag = flags.find((x) => x.symbol === "email");
  if (!flag) throw new Error(`zod.email not flagged: ${JSON.stringify(flags)}`);
  return flag;
}

async function emailNote() {
  const flag = await emailFlag();
  const local = await answerLocally(f.repo, flag);
  const member = local.members[0];
  if (!member) throw new Error("no local member");
  const note = await admitLocalNote(f.repo, f.log, { flag, member });
  if (!note) throw new Error("not admitted");
  return { flag, note };
}

describe("DS-N9-19: a note is admitted only with a grounded, model-free check", () => {
  it("admits the local answer whose cited line holds the name and whose file hash matches", async () => {
    const { flag, note } = await emailNote();
    expect(note.noteId).toBe(noteId("npm", "zod", "3.23.8", "email"));
    expect(note.noteId).toMatch(/^rn_[0-9a-f]{16}$/);
    expect(note.citation).toMatchObject({
      kind: "local",
      ref: `deps:npm:zod@3.23.8/lib/types.d.ts:${EMAIL_LINE}`,
      fileSha256: sha256(ZOD_TYPES),
    });
    expect(note.check).toEqual({
      kind: "citation",
      detail: "symbol present in excerpt; hash matches source",
    });
    expect(note.answeredBy).toBe("local");
    expect(note.excerpt).toContain("email(message?: errorUtil.ErrMessage): ZodString;");
    expect(note.excerpt.length).toBeLessThanOrEqual(600);
    expect(flag.written).toBe("zod.email");

    const [event] = await f.log.getEventsByTypes([NOTE_EVENTS.admitted]);
    const payload = event?.payload as Record<string, unknown>;
    expect(payload).toMatchObject({
      noteId: note.noteId,
      symbol: "email",
      ecosystem: "npm",
      package: "zod",
      version: "3.23.8",
      answeredBy: "local",
    });
    // The excerpt, the question and the repository stay in the erasable part.
    expect(JSON.stringify(payload)).not.toContain("errorUtil");
    expect(payload.question).toBeUndefined();
    expect(event?.private).toMatchObject({ repo: expect.any(String) });
    expect(String((event?.private as Record<string, unknown>).excerpt)).toContain("email(");
    expect(String((event?.private as Record<string, unknown>).question)).toMatch(
      /zod@3\.23\.8.*`email`/,
    );
  });

  it("refuses a local answer whose file changed since it was read, or whose line lacks the name", async () => {
    const flag = await emailFlag();
    const member = (await answerLocally(f.repo, flag)).members[0];
    if (!member) throw new Error("no member");
    writeFiles(f.repo, { "node_modules/zod/lib/types.d.ts": `${ZOD_TYPES}// edited\n` });
    expect(await admitLocalNote(f.repo, f.log, { flag, member })).toBeUndefined();

    installZod(f.repo);
    const typo: PacketFlag = { ...flag, symbol: "emial", missing: "emial", written: "zod.emial" };
    const near = (await answerLocally(f.repo, typo)).members;
    expect(near.map((m) => m.name)).toContain("email");
    for (const m of near)
      expect(await admitLocalNote(f.repo, f.log, { flag: typo, member: m })).toBeUndefined();
    expect(await f.log.getEventsByTypes([NOTE_EVENTS.admitted])).toHaveLength(0);
  });

  it("the payload registry refuses an excerpt in the hashed payload", async () => {
    await expect(
      f.log.append({
        actor: "harness",
        type: NOTE_EVENTS.admitted,
        payload: { noteId: "rn_0123456789abcdef", excerpt: "free text" },
      }),
    ).rejects.toThrow(/research\/note_admitted/);
  });

  it("admits a Researcher's web answer whose excerpt holds the name and whose chunk is cut from the cached page", async () => {
    const flag: PacketFlag = {
      cardId: "c1",
      kind: "member",
      written: "zod.ipv4",
      eco: "npm",
      pkg: "zod",
      version: "3.23.8",
      symbol: "ipv4",
      missing: "ipv4",
    };
    const url = "https://unpkg.com/zod@3.23.8/README.md";
    const page = [
      "# Zod",
      "",
      "Intro text about schemas.",
      "",
      "## IP addresses",
      "",
      'There is no `z.ipv4()` in 3.23.8: use `z.string().ip({ version: "v4" })`.',
      "",
    ].join("\n");
    new ResearchCache(f.cacheDir).set(url, 200, "text/markdown", page);
    const note = await admitResearchNote(f.repo, f.log, {
      flag,
      model: "apodex-32b",
      answer: {
        answer: 'Use z.string().ip({ version: "v4" }) [1].',
        sources: [url],
        grounded: true,
        evidence: [{ kind: "documentation", ref: url, excerpt: "There is no `z.ipv4()`" }],
      },
    });
    expect(note?.citation).toMatchObject({
      kind: "web",
      ref: `${url}#ip-addresses`,
      pageSha256: sha256(page),
    });
    expect(note?.answeredBy).toBe("researcher");
    expect(note?.model).toBe("apodex-32b");
    expect(note?.excerpt).toContain("z.ipv4()");

    // A page that never names it, or one not in the cache, admits nothing.
    const other = "https://unpkg.com/zod@3.23.8/llms.txt";
    new ResearchCache(f.cacheDir).set(other, 200, "text/plain", "# Zod\n\nNothing relevant.\n");
    const plain = await admitResearchNote(f.repo, f.log, {
      flag: { ...flag, symbol: "cidr4", missing: "cidr4", written: "zod.cidr4" },
      model: "apodex-32b",
      answer: {
        answer: "Use z.string().cidr() [1].",
        sources: [other, "https://zod.dev/never-fetched"],
        grounded: true,
        evidence: [
          { kind: "documentation", ref: other },
          { kind: "documentation", ref: "https://zod.dev/never-fetched", excerpt: "cidr4" },
        ],
      },
    });
    expect(plain).toBeUndefined();
  });

  it("reads D's probe verdict through a narrow guard: only a probe that exited 0 at this pkg@ver and names it admits", async () => {
    const flag: PacketFlag = {
      cardId: "c1",
      kind: "member",
      written: "zod.email",
      eco: "npm",
      pkg: "zod",
      version: "3.23.8",
      symbol: "email",
      missing: "email",
    };
    const ran = {
      id: "probe_0123456789ab",
      kind: "executable",
      text: "z.string().email() accepts a@b.co (reproduced at zod@3.23.8)",
      reproduce: { language: "node", code: 'const { z } = require("zod");\nz.string().email();\n' },
    };
    const documented = {
      id: "probe_ba9876543210",
      kind: "executable",
      text: "email exists",
      unreproducible: "documented, not reproduced: no probe runner for go in this version",
    };
    const elsewhere = { ...ran, text: "email works (reproduced at zod@3.22.0)" };
    expect(isReproducedProbe(ran)).toBe(true);
    for (const c of [documented, { ...ran, reproduce: undefined }, "probe", null, { id: 1 }])
      expect(isReproducedProbe(c)).toBe(false);

    const answer = (probeClaims: unknown[]) => ({
      answer: "It is a ZodString check.",
      sources: [],
      grounded: false,
      evidence: [],
      probeClaims,
    });
    expect(
      await admitResearchNote(f.repo, f.log, { flag, model: "m", answer: answer([documented]) }),
    ).toBeUndefined();
    expect(
      await admitResearchNote(f.repo, f.log, { flag, model: "m", answer: answer([elsewhere]) }),
    ).toBeUndefined();
    // A claim whose program the probe runner did not write (no harness
    // prelude) is not a probe that ran here: it admits nothing.
    expect(
      await admitResearchNote(f.repo, f.log, { flag, model: "m", answer: answer([ran]) }),
    ).toBeUndefined();
  });

  it("admits a web citation only from a page that documents the pinned version by its URL (DS-N9-24)", async () => {
    const flag: PacketFlag = {
      cardId: "c1",
      kind: "member",
      written: "zod.ipv4",
      eco: "npm",
      pkg: "zod",
      version: "3.23.8",
      symbol: "ipv4",
      missing: "ipv4",
    };
    const page = "# Zod\n\n## IP addresses\n\nUse `z.ipv4()` to accept an IPv4 address.\n";
    const urls = [
      "https://zod.dev/",
      "https://unpkg.com/zod@3.22.0/README.md",
      "https://unpkg.com/zod@latest/README.md",
      "https://github.com/colinhacks/zod/issues/1234",
      "https://blog.example.org/zod-ipv4",
    ];
    for (const url of urls) new ResearchCache(f.cacheDir).set(url, 200, "text/markdown", page);
    const note = await admitResearchNote(f.repo, f.log, {
      flag,
      model: "m",
      answer: {
        answer: "Use z.ipv4() [1].",
        sources: urls,
        grounded: true,
        evidence: urls.map((ref) => ({ kind: "documentation", ref })),
      },
    });
    expect(note).toBeUndefined();
    expect(await f.log.getEventsByTypes([NOTE_EVENTS.admitted])).toEqual([]);
  });
});

/**
 * DS-N9-19, -25: a probe admits a note only when the Researcher's own code
 * names the missing identifier as code, and the harness's own existence
 * check of that identifier, run in the packet's sandbox, exits 0. Each probe
 * here really runs.
 */
describe.runIf(confines)(
  "DS-N9-19, -25: a probe's note is grounded by the harness's own check",
  () => {
    const ipv4: PacketFlag = {
      cardId: "c1",
      kind: "member",
      written: "zod.ipv4",
      eco: "npm",
      pkg: "zod",
      version: "3.23.8",
      symbol: "ipv4",
      missing: "ipv4",
    };
    beforeEach(() => {
      // zod's runtime has `ipv4`, which its declarations lack.
      writeFiles(f.repo, {
        "node_modules/zod/lib/index.js":
          "exports.ipv4 = (s) => /^\\d+(\\.\\d+){3}$/.test(s);\nexports.string = () => ({});\n",
      });
    });
    const ranProbe = async (code: string, flag: PacketFlag = ipv4) => {
      const r = await runResearchProbe(
        {
          language: "node",
          code,
          target: { eco: "npm", name: flag.pkg, version: flag.version },
          statement: `${flag.symbol} works`,
        },
        { repoPath: f.repo, runtime: dependencyRuntime(f.repo, "npm"), scope: "dependencies" },
      );
      if (r.status !== "ran" || !r.claim)
        throw new Error(`probe did not exit 0: ${JSON.stringify(r)}`);
      return r.claim;
    };
    const admitWith = (claim: unknown, flag: PacketFlag = ipv4) =>
      admitResearchNote(f.repo, f.log, {
        flag,
        model: "m",
        answer: { answer: "x", sources: [], grounded: false, evidence: [], probeClaims: [claim] },
      });

    it("admits a probe that calls the member, after the harness finds it at runtime", async () => {
      const claim = await ranProbe(
        'const z = require("zod");\nif (!z.ipv4("1.2.3.4")) process.exit(1);\nconsole.log("ok");',
      );
      const note = await admitWith(claim);
      expect(note?.check).toMatchObject({ kind: "probe", language: "node", exitCode: 0 });
      expect(note?.citation.kind).toBe("probe");
      expect(note?.excerpt).toContain("z.ipv4(");
      expect(note?.excerpt).not.toContain("__sekhemet");
    }, 60_000);

    it("refuses a probe that names it only in a string or a comment", async () => {
      expect(await admitWith(await ranProbe('console.log("ipv4");'))).toBeUndefined();
      expect(await admitWith(await ranProbe("// ipv4\nconsole.log(1);"))).toBeUndefined();
    }, 60_000);

    it("refuses a probe whose only mention is the harness's prelude", async () => {
      const resolve: PacketFlag = {
        ...ipv4,
        written: "zod.resolve",
        symbol: "resolve",
        missing: "resolve",
      };
      expect(await admitWith(await ranProbe("console.log(1);", resolve), resolve)).toBeUndefined();
    }, 60_000);

    it("refuses a probe that names a member the package lacks, though it exited 0", async () => {
      const emale: PacketFlag = {
        ...ipv4,
        written: "zod.emale",
        symbol: "emale",
        missing: "emale",
      };
      const claim = await ranProbe('console.log(typeof require("zod").emale);', emale);
      expect(await admitWith(claim, emale)).toBeUndefined();
      expect(await f.log.getEventsByTypes([NOTE_EVENTS.admitted])).toEqual([]);
    }, 60_000);
  },
);

describe("DS-N9-20: reuse after a hash re-check", () => {
  it("finds the note by eco, package, version and symbol", async () => {
    const { note } = await emailNote();
    const fold = await readNotes(f.log);
    const found = await reuseNote(f.repo, f.log, fold, {
      eco: "npm",
      pkg: "zod",
      version: "3.23.8",
      symbol: "email",
    });
    expect(found?.noteId).toBe(note.noteId);
    expect(
      await reuseNote(f.repo, f.log, fold, {
        eco: "npm",
        pkg: "zod",
        version: "3.24.0",
        symbol: "email",
      }),
    ).toBeUndefined();
  });

  it("an erased note is retired as a gap, never fed, and the flag is answered afresh", async () => {
    const { note } = await emailNote();
    const [admitted] = await f.log.getEventsByTypes([NOTE_EVENTS.admitted]);
    await f.log.erase({
      eventIds: [admitted?.id as string],
      reason: "erasure",
      principal: f.log.localPrincipal(),
    });
    await story(f, "c2", "Check the address with `zod.email()`.");
    const k = { repoPath: f.repo, log: f.log, cardStore: f.cardStore };
    const prepared = await preparePacket(k, ["c2"]);
    await finishPacket(k, prepared, { notAsked: "research is off" });
    const retired = (await f.log.getEventsByTypes([NOTE_EVENTS.retired])).map((e) => e.payload);
    expect(retired).toEqual([{ noteId: note.noteId, reason: "erased" }]);
    const entries = (await f.cardStore.getDossier("c2")).research;
    expect(entries.map((e) => e.text).join("\n")).not.toContain("[erased]");
    expect(entries[0]?.text).toContain("email(message?");
    // A fresh note under the same id, whole again, and fed.
    const fold = await readNotes(f.log);
    expect(fold.live.get(note.noteId)?.erased).toBe(false);
    const fed = (await f.log.getEventsByTypes([NOTE_EVENTS.fed])).map((e) => e.payload);
    expect(fed).toEqual([{ noteId: note.noteId, cardId: "c2" }]);
  });

  it("a changed source file retires the note as source_changed", async () => {
    const { note } = await emailNote();
    writeFiles(f.repo, { "node_modules/zod/lib/types.d.ts": `// patched\n${ZOD_TYPES}` });
    const fold = await readNotes(f.log);
    const key = { eco: "npm" as const, pkg: "zod", version: "3.23.8", symbol: "email" };
    expect(await reuseNote(f.repo, f.log, fold, key)).toBeUndefined();
    const [retired] = await f.log.getEventsByTypes([NOTE_EVENTS.retired]);
    expect(retired?.payload).toEqual({ noteId: note.noteId, reason: "source_changed" });
    expect((await readNotes(f.log)).live.has(note.noteId)).toBe(false);
  });
});

describe("DS-N9-21: retirement, evaluated when the fold is read", () => {
  it("a lockfile bump retires the note", async () => {
    const { note } = await emailNote();
    installZod(f.repo, "3.24.0");
    const retired = await retireStale(f.repo, f.log, await readNotes(f.log));
    expect(retired).toEqual([expect.objectContaining({ noteId: note.noteId, reason: "lockfile" })]);
    const [event] = await f.log.getEventsByTypes([NOTE_EVENTS.retired]);
    expect(event?.payload).toEqual({ noteId: note.noteId, reason: "lockfile" });
    expect(String((event?.private as Record<string, unknown>).detail)).toMatch(/3\.24\.0/);
    expect((await readNotes(f.log)).live.size).toBe(0);
    // Evaluated once: a second read records nothing more.
    await retireStale(f.repo, f.log, await readNotes(f.log));
    expect(await f.log.getEventsByTypes([NOTE_EVENTS.retired])).toHaveLength(1);
  });

  it("a fed card failing with TS2339 on the symbol retires it; a failure naming something else does not", async () => {
    const { note } = await emailNote();
    const gateFailure = async (cardId: string, excerpt: string) => {
      const attempt = await f.cardStore.runs.startAttempt({
        cardId,
        attemptNumber: 1,
        modelId: "worker",
      });
      await f.cardStore.runs.recordGateResult({
        attemptId: attempt.id,
        cardId,
        gate: "typecheck",
        layer: "static",
        passed: false,
        exitCode: 2,
        durationMs: 10,
        failures: [{ gate: "typecheck", errorExcerpt: excerpt }],
        source: "local",
      });
    };
    // A failure before the note fed the card counts for nothing.
    await gateFailure("c1", "src/a.ts(3,9): error TS2339: Property 'email' does not exist.");
    await recordNoteFed(f.log, note.noteId, "c1");
    expect(await retireStale(f.repo, f.log, await readNotes(f.log))).toEqual([]);

    await gateFailure("c1", "src/a.ts(4,1): error TS2339: Property 'parse' does not exist.");
    expect(await retireStale(f.repo, f.log, await readNotes(f.log))).toEqual([]);

    await gateFailure(
      "c1",
      `src/signup.ts(12,20): error TS2339: Property 'email' does not exist on type 'typeof import("zod")'.`,
    );
    const retired = await retireStale(f.repo, f.log, await readNotes(f.log));
    expect(retired).toEqual([
      expect.objectContaining({ noteId: note.noteId, reason: "card_failed", cardId: "c1" }),
    ]);
    const [event] = await f.log.getEventsByTypes([NOTE_EVENTS.retired]);
    expect(event?.payload).toEqual({ noteId: note.noteId, reason: "card_failed", cardId: "c1" });
  });
});
