import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error: a plain ESM script, run by hand and by the capstone runner, checked here.
import * as cap from "../../../scripts/capstone/render_prompt.mjs";

/**
 * The capstone's frozen input (W2 G1, CAPSTONE_SELECTION "Protocol"): every
 * arm gets byte-identical prompt.md first and change_request.md at the fixed
 * point, both rendered from the brief, the stakeholder script and the
 * technical notes, and hash-checked through manifest.json. An arm that asks
 * gets only the script's answers, which are exactly the FAQ's.
 */

const ROOT = resolve(import.meta.dirname, "..", "..", "..");
const DIR = join(ROOT, "fixtures", "capstone", "timesheet");
const SCRIPT_PATH = join(ROOT, "scripts", "capstone", "render_prompt.mjs");

type Topic = { topic: string; question: string; keywords: string[]; answer: string };
type Phase = { id: string; file: string; opening: string; notes: string; topics: Topic[] };
type Script = { defaultAnswer: string; phases: Phase[]; changeRequest: { deliverAt: string } };

const read = (name: string) => readFileSync(join(DIR, name), "utf8");
const script = (): Script => JSON.parse(read("stakeholder_script.json"));
const phase = (id: string) => script().phases.find((p) => p.id === id) as Phase;

const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});
function copyOfFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "capstone-prompt-"));
  temps.push(dir);
  cpSync(DIR, dir, { recursive: true });
  return dir;
}

describe("the capstone's frozen prompts", () => {
  it("prompt.md and change_request.md are exactly what the sources render", () => {
    const rendered = cap.render(DIR) as Record<string, string>;
    expect(Object.keys(rendered).sort()).toEqual(["change_request.md", "prompt.md"]);
    expect(read("prompt.md")).toBe(rendered["prompt.md"]);
    expect(read("change_request.md")).toBe(rendered["change_request.md"]);
  });

  it("the manifest records the SHA-256 of both prompts and of every source, and they match", () => {
    const manifest = JSON.parse(read("manifest.json"));
    for (const name of ["prompt.md", "change_request.md"]) {
      expect(manifest.files[name].sha256).toBe(cap.sha256(read(name)));
      expect(manifest.files[name].bytes).toBe(Buffer.byteLength(read(name)));
    }
    for (const name of cap.SOURCES as string[]) {
      expect(manifest.sources[name]).toBe(cap.sha256(read(name)));
    }
    expect(cap.check(DIR)).toEqual([]);
  });

  it("the prompt's FAQ is exactly the release-1 answers, in order, and holds nothing from the change", () => {
    const prompt = read("prompt.md");
    const r1 = phase("release-1");
    let at = 0;
    for (const t of r1.topics) {
      const q = prompt.indexOf(`**${t.question}**\n\n${t.answer}\n`, at);
      expect(q, t.topic).toBeGreaterThan(at);
      at = q;
    }
    expect(prompt.match(/^\*\*.+\?\*\*$/gm)?.length).toBe(r1.topics.length);
    for (const t of phase("change-request").topics) expect(prompt).not.toContain(t.answer);
    for (const word of ["California", "Sacramento", "double time", "seventh"]) {
      expect(prompt).not.toContain(word);
    }
  });

  it("the change request carries the change's answers and technical notes, and repeats none of release 1's", () => {
    const change = read("change_request.md");
    const cr = phase("change-request");
    for (const t of cr.topics) expect(change).toContain(`**${t.question}**\n\n${t.answer}\n`);
    expect(change.match(/^\*\*.+\?\*\*$/gm)?.length).toBe(cr.topics.length);
    for (const t of phase("release-1").topics) expect(change).not.toContain(t.answer);
    expect(change).toContain(read("contract_change.md").trimEnd());
    expect(script().changeRequest.deliverAt).toBe("release-1-finished");
  });

  it("cites the two regulations the rules come from", () => {
    expect(read("prompt.md")).toContain("https://www.dol.gov/agencies/whd/overtime");
    expect(read("change_request.md")).toContain("https://www.dir.ca.gov/dlse/faq_overtime.htm");
  });

  it("nothing a contestant can see points at the hidden suite", () => {
    // Every file, the seed repository's included (W2 G2).
    const files = (readdirSync(DIR, { recursive: true }) as string[]).filter((name) =>
      statSync(join(DIR, name)).isFile(),
    );
    expect(files).toContain(join("seed", "package.json"));
    for (const name of files) {
      expect(readFileSync(join(DIR, name), "utf8"), name).not.toMatch(/capstone-hidden/);
    }
    expect(resolve(DIR).startsWith(join(homedir(), ".sekhemet"))).toBe(false);
  });
});

describe("answering an arm that asks", () => {
  it("gives the matching topic's answer word for word", () => {
    const s = script();
    const overnight = phase("release-1").topics.find(
      (t) => t.topic === "overnight_shifts",
    ) as Topic;
    expect(cap.answerFor(s, ["release-1"], "What about a shift that goes past midnight?")).toBe(
      overnight.answer,
    );
  });

  it("gives the default answer to a question the script does not cover", () => {
    const s = script();
    expect(cap.answerFor(s, ["release-1"], "Which font do you prefer?")).toBe(s.defaultAnswer);
  });

  it("never answers from the change request before it is given", () => {
    const s = script();
    const daily = phase("change-request").topics.find((t) => t.topic === "ca_daily") as Topic;
    const q = "How is double time paid?";
    expect(cap.answerFor(s, ["release-1"], q)).toBe(s.defaultAnswer);
    expect(cap.answerFor(s, ["release-1", "change-request"], q)).toContain(daily.answer);
  });

  it("returns only the script's own text: matching answers joined, or the default", () => {
    const s = script();
    const all = new Set(s.phases.flatMap((p) => p.topics.map((t) => t.answer)));
    for (const q of [
      "Do you round the clock times and the pay?",
      "Can employees see other people's pay rates?",
      "What goes in the CSV export?",
      "Tell me about the weather.",
    ]) {
      const a = cap.answerFor(s, ["release-1", "change-request"], q) as string;
      const parts = a === s.defaultAnswer ? [] : a.split("\n\n");
      for (const p of parts) expect(all.has(p), p).toBe(true);
    }
  });
});

describe("the render command", () => {
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [SCRIPT_PATH, ...args], { encoding: "utf8" });

  it("--check passes on the committed fixture", () => {
    const r = run("--check", DIR);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/unchanged/);
  });

  it("--check fails when a prompt was edited by hand, and names it", () => {
    const dir = copyOfFixture();
    writeFileSync(join(dir, "prompt.md"), `${readFileSync(join(dir, "prompt.md"), "utf8")}x`);
    const r = run("--check", dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("prompt.md");
  });

  it("--check fails when an answer changed without re-rendering; --write then re-freezes it", () => {
    const dir = copyOfFixture();
    const s = JSON.parse(readFileSync(join(dir, "stakeholder_script.json"), "utf8"));
    s.phases[0].topics[0].answer += " Changed.";
    writeFileSync(join(dir, "stakeholder_script.json"), `${JSON.stringify(s, null, 2)}\n`);
    expect(cap.check(dir).join("\n")).toMatch(/prompt\.md/);
    expect(cap.check(dir).join("\n")).toMatch(/stakeholder_script\.json/);
    expect(run("--check", dir).status).toBe(1);
    expect(run("--write", dir).status).toBe(0);
    expect(cap.check(dir)).toEqual([]);
    expect(readFileSync(join(dir, "prompt.md"), "utf8")).toContain(" Changed.");
    expect(readFileSync(join(dir, "change_request.md"), "utf8")).toBe(read("change_request.md"));
  });
});
