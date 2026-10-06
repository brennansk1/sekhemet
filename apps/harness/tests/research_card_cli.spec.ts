import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { installZod } from "./research_notes_fixture.js";
import { cli, g2Dirs, ledgerRows } from "./support/g2_cli.js";
import { SCRIPTED_MODEL, type Turn, recorded, scriptEnv } from "./support/g2_model.js";
import { type G2Project, g2Project, gatesToml } from "./support/g2_project.js";
import { webStub } from "./support/g2_web.js";

/**
 * A research card through the queue (design-stage §2.7.5, DS-N2-1, DS-N2-2,
 * DS-N2-3, DS-N2-7; gates rule 27a; FINISH_LINE_PLAN C2d): `sekhemet queue
 * --researcher` spawned as the built binary, the Researcher the recording
 * scripted model, its note, claims report and evidence the files and ledger
 * the binary wrote. With research off, nothing leaves the machine.
 *
 * The binary under test is `apps/harness/dist/index.js`, spawned by
 * `support/g2_cli.ts`.
 */

const CARD = {
  id: "r1",
  tier: "story" as const,
  title: "Which zod API validates an email?",
  spec: "Find the zod API that validates an email address.",
  acceptanceCriteria: ["names one API"],
  labels: ["research", "effort:quick"],
  status: "ready" as const,
};
const CLAIM_GATE = '\n[claims]\nreport = ".sekhemet/research/{card}.claims.json"\ntimeout_s = 20\n';
const HISTORY: Turn = [{ name: "git_history", arguments: { query: "seed" } }];

async function researchProject(claimGate: boolean): Promise<G2Project> {
  const p = await g2Project(g2Dirs(), {
    files: {
      "src/a.ts": "",
      "package.json": JSON.stringify({ name: "app" }),
      ".gitignore": "node_modules\n.sekhemet/*\n!.sekhemet/gates.toml\n",
      ".sekhemet/gates.toml": gatesToml(["-e", "process.exit(0)"]) + (claimGate ? CLAIM_GATE : ""),
    },
    cards: [CARD],
    qualifyAs: [{}, { role: "researcher" }],
  });
  installZod(p.repo);
  writeFileSync(
    join(p.repo, "node_modules/zod/lib/index.js"),
    "exports.z = { string: () => ({ email: () => ({ parse: (s) => { if (!/@/.test(s)) throw new Error('Invalid email'); return s; } }) }) };\n",
  );
  return p;
}

function run(p: G2Project, researcher: Turn[], env: Record<string, string> = {}) {
  return cli(["queue", "--worker", SCRIPTED_MODEL, "--researcher", SCRIPTED_MODEL], {
    cwd: p.repo,
    preload: p.preload,
    env: { ...p.env, ...scriptEnv(p.record, { researcher }), ...env },
    timeoutMs: 180_000,
  });
}

const claimsOf = (p: G2Project) =>
  JSON.parse(readFileSync(join(p.repo, ".sekhemet/research/r1.claims.json"), "utf8")) as {
    claims: {
      id: string;
      kind: string;
      text: string;
      unreproducible?: string;
      reproduce?: { code: string };
    }[];
  };
function evidenceOf(p: G2Project) {
  const dir = join(p.repo, ".sekhemet/evidence");
  const file = readdirSync(dir).find((f) => f.startsWith("ev_research_r1"));
  if (!file) throw new Error("no research evidence");
  return JSON.parse(readFileSync(join(dir, file), "utf8")) as {
    passed: boolean;
    rungResults: { gate: string; passed: boolean; detail?: string }[];
    gatesSha256?: string;
  };
}
const statuses = (p: G2Project) =>
  ledgerRows(p.repo)
    .filter((x) => x.type === "card/status_changed" && x.cardId === "r1")
    .map((x) => x.payload.toStatus);

describe("sekhemet queue: a research card's executable claims", () => {
  it("DS-N2-1, DS-N2-7: an executable claim that was not run is documented, not reproduced, with its reason, and the card reaches Review with no repair pass", async () => {
    const p = await researchProject(false);
    const r = await run(p, [
      HISTORY,
      "Use `zod` z.string().email(), which returns a ZodString that rejects strings without an at sign [1]. The history shows the seed commit only [1].",
    ]);
    expect(r.stdout, r.stderr).toMatch(/cited note ready for review/);
    const executable = claimsOf(p).claims.filter((c) => c.kind === "executable");
    expect(executable).toHaveLength(1);
    expect(executable[0]?.unreproducible).toMatch(
      /^documented, not reproduced: .+; stated by \[1\]/,
    );
    const claims = evidenceOf(p).rungResults.find((x) => x.gate === "claims");
    expect(claims).toMatchObject({ passed: true });
    expect(statuses(p)).toEqual(["in_progress", "verify", "review"]);
    // One question, one answer: no separate citation-repair pass.
    expect(recorded(p.record).filter((x) => x.role !== "worker")).toHaveLength(2);
  }, 240_000);

  it("DS-N2-2: with the claim gate declared in gates.toml, an executable claim with neither a reproduction nor a reason fails it, under the gate file's hash", async () => {
    const p = await researchProject(true);
    const r = await run(p, [
      HISTORY,
      "Use `zod` z.string().email(), which returns a ZodString for addresses. The history shows the seed commit only [1].",
    ]);
    expect(r.stdout, r.stderr).toMatch(/on hold: not settled/);
    const ev = evidenceOf(p);
    expect(ev.passed).toBe(false);
    expect(ev.rungResults.find((x) => x.gate === "claims")).toMatchObject({
      passed: false,
      detail: "[1] neither reproduced nor marked unreproducible with a reason",
    });
    expect(ev.gatesSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(statuses(p)).toEqual(["in_progress", "parked"]);
  }, 240_000);

  it("DS-N2-3: a claim's script is re-run by the claim gate confined: no write to the repository and no network", async () => {
    const p = await researchProject(true);
    const listener = await webStub({});
    const marker = join(p.repo, "claim-wrote.txt");
    const code = [
      "const fs = require('fs');",
      "let wrote = false;",
      `try { fs.writeFileSync(${JSON.stringify(marker)}, 'x'); wrote = true; } catch {}`,
      "const { z } = require('zod');",
      "let threw = false;",
      "try { z.string().email().parse('nope'); } catch { threw = true; }",
      `const s = require('net').connect(${listener.port}, '127.0.0.1');`,
      "s.on('connect', () => { console.log('network reached'); process.exit(1); });",
      "s.on('error', () => { console.log('refuses: ' + threw + ', wrote: ' + wrote); process.exit(threw && !wrote ? 0 : 1); });",
    ].join("\n");
    const r = await run(p, [
      [
        ...(HISTORY as { name: string }[]),
        {
          name: "probe",
          arguments: {
            package: "zod",
            language: "node",
            code,
            statement: "zod z.string().email() refuses an address without @",
          },
        },
      ],
      "Use `zod` z.string().email(), which rejects an address without an at sign [2]. The history shows the seed commit only [1].",
    ]);
    expect(r.stdout, r.stderr).toMatch(/cited note ready for review/);
    const reproduced = claimsOf(p).claims.find((c) => c.reproduce);
    expect(reproduced?.reproduce?.code).toContain(code);
    expect(evidenceOf(p).rungResults.find((x) => x.gate === "claims")).toMatchObject({
      passed: true,
      detail: "the claim check passed",
    });
    // Neither the probe nor the claim gate's re-run wrote to the repository or reached the network.
    expect(existsSync(marker)).toBe(false);
    expect(listener.requests).toEqual([]);
  }, 240_000);
});
