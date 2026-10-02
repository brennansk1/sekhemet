import type { BoardState } from "@sekhemet/board";
import type { CardRecord, CardStatus } from "@sekhemet/kernel";
import { describe, expect, it } from "vitest";
import { terminalBoardLines } from "../src/terminal_board.js";

/**
 * surface NEW-surface-2, SUR-27: `board --terminal` in the board's words —
 * NAMING.md's columns and state names, a WIP limit only where one is set.
 */
const card = (id: string, status: CardStatus, title = `Card ${id}`): CardRecord =>
  ({ id, status, title, tier: "story", stepsUsed: 0, stepBudget: 30 }) as unknown as CardRecord;

const LIMITS: Record<CardStatus, number> = {
  backlog: 500,
  ready: 50,
  planning: 3,
  in_progress: 5,
  verify: 5,
  review: 3,
  done: 10000,
  rejected: 10000,
  parked: 10000,
};

function board(cards: CardRecord[], backpressureActive = false): BoardState {
  return { cards, wipLimits: LIMITS, backpressureActive };
}

describe("SUR-27: the terminal board speaks NAMING.md", () => {
  it("shows the board's columns with the stored states' names, never internal ids", () => {
    const text = terminalBoardLines(
      board([
        card("b1", "backlog"),
        card("r1", "ready"),
        card("p1", "planning"),
        card("w1", "in_progress"),
        card("v1", "verify"),
        card("rv1", "review"),
        card("d1", "done"),
        card("x1", "rejected"),
      ]),
    ).join("\n");
    const headings = text
      .split("\n")
      .filter((l) => l && !l.startsWith(" "))
      .map((l) => l.replace(/\s+\d.*$/, ""));
    expect(headings).toEqual(["Backlog", "To do", "In progress", "In review", "Done"]);
    // A card in a column that holds two states names its state.
    expect(text).toMatch(/v1 .*Verify/);
    expect(text).toMatch(/p1 .*Planning/);
    for (const internal of ["DUAL-AXIS", "IN_PROGRESS", "BACKLOG", "in_progress", "REVIEW WIP"]) {
      expect(text).not.toContain(internal);
    }
    // Won't do is a filter, not a column; its card is not listed.
    expect(text).not.toContain("x1");
  });

  it("shows a WIP limit only where one is set, and On hold only when a card is parked", () => {
    const lines = terminalBoardLines(board([card("rv1", "review"), card("w1", "in_progress")]));
    const heading = (name: string) => lines.find((l) => l.startsWith(name)) ?? "";
    expect(heading("In review")).toMatch(/1\/3/);
    expect(heading("In progress")).toMatch(/In progress 1\/5/);
    expect(heading("Backlog")).not.toMatch(/\//);
    expect(heading("Done")).not.toMatch(/\//);
    expect(heading("To do")).not.toMatch(/Ready \d+\/50/);
    expect(lines.some((l) => l.startsWith("On hold"))).toBe(false);
    const held = terminalBoardLines(board([card("k1", "parked")]));
    expect(held.some((l) => l.startsWith("On hold"))).toBe(true);
  });

  it("says in plain words when In review is full", () => {
    const text = terminalBoardLines(board([], true)).join("\n");
    expect(text).toMatch(
      /In review is full: finished issues wait until you accept one, request changes, or put one on hold\./,
    );
  });
});
