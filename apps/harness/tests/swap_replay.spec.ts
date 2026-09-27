import type { EventRecord } from "@sekhemet/kernel";
import { DEFAULT_SWAP_POLICY, simulateDay } from "@sekhemet/models";
import { describe, expect, it } from "vitest";
import { replayDemand } from "../src/swap_replay.js";

/**
 * Live-test F15: the Configuration page's replay built a day only from the
 * cards' steps and status changes, with Seshat and presence always empty,
 * and the simulator had no researcher queue. The day now carries the chat
 * (a person's messages and Seshat's replies), research requests and
 * presence as the ledger recorded them.
 */
const T0 = Date.parse("2026-09-26T09:00:00Z");
const S = 1000;
const MIN = 60 * S;
let seq = 0;
function ev(type: string, at: number, payload: unknown, extra: Partial<EventRecord> = {}) {
  seq++;
  return {
    seq,
    id: `e${seq}`,
    actor: "harness",
    type,
    payload,
    payloadHash: "",
    hash: "",
    prevHash: "",
    createdAt: new Date(at).toISOString(),
    ...extra,
  } as EventRecord;
}

const ledger = (): EventRecord[] => [
  ev("card/status_changed", T0, { toStatus: "in_progress" }, { cardId: "c1" }),
  ev("card/step", T0 + 1 * MIN, {}, { cardId: "c1" }),
  ev("card/step", T0 + 2 * MIN, {}, { cardId: "c1" }),
  ev("card/status_changed", T0 + 3 * MIN, { toStatus: "review" }, { cardId: "c1" }),
  ev("session/active", T0 + 4 * MIN, {}),
  // A conversation: a question, its answer 40 s later, a follow-up 2 min after that.
  ev(
    "pm/message",
    T0 + 5 * MIN,
    { id: "m1", text: "x", createdAt: new Date(T0 + 5 * MIN).toISOString() },
    { actor: "human" },
  ),
  ev(
    "pm/reply",
    T0 + 5 * MIN + 40 * S,
    {
      id: "r1",
      replyTo: ["m1"],
      text: "y",
      createdAt: new Date(T0 + 5 * MIN + 40 * S).toISOString(),
    },
    { actor: "planner" },
  ),
  ev(
    "pm/message",
    T0 + 7 * MIN + 40 * S,
    { id: "m2", text: "x", createdAt: new Date(T0 + 7 * MIN + 40 * S).toISOString() },
    { actor: "human" },
  ),
  ev(
    "pm/reply",
    T0 + 8 * MIN,
    { id: "r2", replyTo: ["m2"], text: "y", createdAt: new Date(T0 + 8 * MIN).toISOString() },
    { actor: "planner" },
  ),
  // A Worker's question is not a person's chat.
  ev(
    "pm/message",
    T0 + 9 * MIN,
    { id: "m3", text: "q", createdAt: new Date(T0 + 9 * MIN).toISOString() },
    { actor: "executor" },
  ),
  // A research request that took 90 s, recorded when it finished.
  ev("research/asked", T0 + 12 * MIN, { ms: 90 * S, effort: "quick" }, { actor: "researcher" }),
];

describe("the replay's day comes from the whole ledger (live-test F15)", () => {
  it("includes a person's chat as sessions, research requests and presence", () => {
    const d = replayDemand(ledger());
    expect(d.start).toBe(T0);
    expect(d.cards).toHaveLength(1);
    expect(d.cards[0]).toMatchObject({ id: "c1", arrivesAt: T0 });
    expect(d.seshat).toEqual([
      {
        startAt: T0 + 5 * MIN,
        turns: [
          { thinkMs: 0, serviceMs: 40 * S },
          { thinkMs: 2 * MIN, serviceMs: 20 * S },
        ],
      },
    ]);
    expect(d.research).toEqual([{ at: T0 + 10 * MIN + 30 * S, serviceMs: 90 * S }]);
    expect(d.presence).toEqual([{ from: T0 + 4 * MIN, to: T0 + 14 * MIN }]);
  });

  it("replays through the simulator with the researcher queue", () => {
    const d = replayDemand(ledger());
    const run = simulateDay(
      { day: "replay", reserved: [], ...d },
      {
        params: DEFAULT_SWAP_POLICY,
        seed: 1,
        queues: { worker: "w", chat: "p", planner: "p", reviewer: "w", researcher: "r" },
        home: "w",
        weights: {
          w: { loadMs: [10 * S], unloadMs: [2 * S] },
          p: { loadMs: [9 * S], unloadMs: [2 * S] },
          r: { loadMs: [8 * S], unloadMs: [2 * S] },
        },
        memory: { models: 1 },
      },
    );
    expect(run.metrics.waits.interactive?.n).toBe(2);
    expect(run.metrics.waits.researcher?.n).toBe(1);
  });
});
