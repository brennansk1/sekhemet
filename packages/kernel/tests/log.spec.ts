import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { EventLog } from "../src/log.js";
import { initSchema } from "../src/schema.js";

describe("@sekhemet/kernel EventLog", () => {
  let db: DatabaseSync;
  let log: EventLog;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    initSchema(db);
    log = new EventLog(db);
  });

  it("appends events with strictly monotonic sequence and valid SHA-256 hash chain", async () => {
    const e1 = await log.append({
      actor: "system",
      type: "project/init",
      payload: { name: "Sekhemet" },
    });
    const e2 = await log.append({
      actor: "planner",
      type: "card/create",
      payload: { title: "Spike Reliability Arm", tier: "task" },
    });

    expect(e1.seq).toBe(1);
    expect(e2.seq).toBe(2);
    expect(e2.prevHash).toBe(e1.hash);
    expect(e1.prevHash).toBe("0000000000000000000000000000000000000000000000000000000000000000");

    const verification = await log.verifyHashChain();
    expect(verification.valid).toBe(true);
    expect(verification.totalEvents).toBe(2);
  });

  it("detects tampering when an event payload in the hash chain is modified", async () => {
    await log.append({ actor: "user", type: "msg/1", payload: { text: "hello" } });
    await log.append({ actor: "user", type: "msg/2", payload: { text: "world" } });
    await log.append({ actor: "user", type: "msg/3", payload: { text: "end" } });

    // Directly tamper with seq 2 payload behind the event log's back
    db.prepare("UPDATE events SET payload = ? WHERE seq = 2").run(
      JSON.stringify({ text: "tampered" }),
    );

    const verification = await log.verifyHashChain();
    expect(verification.valid).toBe(false);
    expect(verification.corruptedSeq).toBe(2);
    expect(verification.reason).toContain("Hash mismatch at seq 2");
  });

  it("retrieves events chronologically", async () => {
    await log.append({ actor: "agent", type: "step/1", payload: { step: 1 } });
    await log.append({ actor: "agent", type: "step/2", payload: { step: 2 } });

    const events = await log.getEvents();
    expect(events.length).toBe(2);
    expect(events[0]?.type).toBe("step/1");
    expect(events[1]?.type).toBe("step/2");

    const last = await log.getLastEvent();
    expect(last?.type).toBe("step/2");
  });
});
