import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ResearchInbox, grade, lookup } from "../src/research/desk.js";

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "inbox-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: { widget: "^2.0.0" } }));
  const pkg = join(root, "node_modules", "widget");
  mkdirSync(join(pkg, "dist"), { recursive: true });
  writeFileSync(
    join(pkg, "package.json"),
    JSON.stringify({ name: "widget", version: "2.3.1", license: "MIT", types: "dist/index.d.ts" }),
  );
  writeFileSync(
    join(pkg, "dist", "index.d.ts"),
    "export declare function spin(n: number): void;\nexport declare const VERSION: string;\n",
  );
  return root;
}

describe("grading a question before spending on it", () => {
  const root = project();

  it("answers a version question from the project, with no model", () => {
    const g = grade(root, "what version of `widget` is installed?");
    expect(g.grade).toBe("lookup");
    expect(g.answer).toContain("2.3.1");
  });

  it("answers a licence question from the installed package.json", () => {
    expect(lookup(root, "what licence does `widget` use?")).toContain("MIT");
  });

  it("finds a symbol in the package's own declarations", () => {
    const answer = lookup(root, "what is the signature of `spin` in `widget`?");
    expect(answer).toContain("spin");
  });

  it("promotes an open-ended question to a research card instead of blocking", () => {
    expect(grade(root, "should we migrate from widget to something else?").grade).toBe("deep");
    expect(grade(root, "compare widget and its alternatives for streaming").grade).toBe("deep");
  });

  it("treats a single answerable question as a short loop", () => {
    expect(grade(root, "does widget handle backpressure when piped?").grade).toBe("question");
  });

  it("declines rather than guessing when the package is not installed", () => {
    expect(lookup(root, "what version of `nonexistent` is installed?")).toBeUndefined();
  });
});

describe("the research inbox", () => {
  it("returns at once, records the question, and answers a lookup immediately", async () => {
    const root = project();
    const events: { type: string; payload: Record<string, unknown> }[] = [];
    const inbox = new ResearchInbox(root, {
      append: (e) => void events.push({ type: e.type, payload: e.payload }),
    });

    const item = await inbox.post("card_1", "executor", "what version of `widget` is installed?");
    expect(item.grade).toBe("lookup");
    expect(item.answer).toContain("2.3.1");
    expect(events[0]?.type).toBe("research/asked");
    expect(events[0]?.payload.grade).toBe("lookup");
    // Already answered, so nothing is pending for the Researcher to pick up.
    expect(inbox.pending()).toHaveLength(0);
  });

  it("holds a real question until it is answered, then delivers it once", async () => {
    const root = project();
    const inbox = new ResearchInbox(root);

    const item = await inbox.post("card_2", "executor", "does widget handle backpressure?");
    expect(inbox.pending().map((i) => i.id)).toEqual([item.id]);
    expect(inbox.take("card_2")).toHaveLength(0);

    await inbox.answer(item.id, "Yes: the stream pauses on a full buffer [1].");
    expect(inbox.pending()).toHaveLength(0);

    const delivered = inbox.take("card_2");
    expect(delivered).toHaveLength(1);
    expect(ResearchInbox.inject(delivered)).toContain("backpressure");
    // Injected once, not on every turn.
    expect(inbox.take("card_2")).toHaveLength(0);
  });

  it("keeps one card's answers away from another", async () => {
    const root = project();
    const inbox = new ResearchInbox(root);
    const a = await inbox.post("card_a", "executor", "does widget support streams?");
    await inbox.answer(a.id, "Yes [1].");
    expect(inbox.take("card_b")).toHaveLength(0);
    expect(inbox.take("card_a")).toHaveLength(1);
  });

  it("survives a restart, because the queue is on disk", async () => {
    const root = project();
    const first = new ResearchInbox(root);
    const item = await first.post("card_3", "executor", "does widget retry on failure?");
    const second = new ResearchInbox(root);
    expect(second.pending().map((i) => i.id)).toEqual([item.id]);
  });

  it("injects nothing when nothing has come back", () => {
    expect(ResearchInbox.inject([])).toBe("");
  });
});
