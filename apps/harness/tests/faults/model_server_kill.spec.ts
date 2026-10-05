import { HttpInferenceAdapter } from "@sekhemet/models";
import { afterEach, describe, expect, it } from "vitest";
import { executeCard } from "../../src/execute.js";
import {
  cleanUp,
  context,
  expectRecordedStop,
  fakeEngine,
  openLedger,
  projectRepo,
  readyCard,
  tempDir,
} from "./fault_fixture.js";

// C.6 fault 1: `kill -9` of the model server mid-step. The engine is a real
// OpenAI-compatible server in its own process; it kills itself with SIGKILL
// while it streams the second step's reply.

afterEach(cleanUp);

const adapter = (url: string) =>
  new HttpInferenceAdapter({ modelId: "fault-coder", baseUrl: url, apiFormat: "openai" });

describe("C.6: kill -9 of the model server mid-step", () => {
  it("ends in model_unavailable, held in Ready at its checkpoint, and resume continues from it", async () => {
    const repo = projectRepo(tempDir("sek-fault-model-"));
    const l = openLedger(repo);
    const card = await readyCard(l, "card_model_kill");
    const engine = await fakeEngine([
      { path: "src/a.ts", content: "export const a = 1;\n" },
      { die: true },
    ]);
    const stopped = await executeCard(context(repo, l), card, adapter(engine.url));
    expect(engine.proc.signalCode).toBe("SIGKILL");
    expect(stopped.stopReason).toBe("model_unavailable");
    await expectRecordedStop(l, card.id, "model_unavailable");
    expect((await l.cardStore.getCard(card.id))?.status).toBe("ready");
    // The engine is started again: resume continues from the checkpoint.
    const again = await fakeEngine([{ finish: true }]);
    const resumed = await executeCard(
      context(repo, l),
      (await l.cardStore.getCard(card.id)) as never,
      adapter(again.url),
    );
    expect(resumed.resumedFrom?.step).toBe(1);
    expect(resumed.passed).toBe(true);
    expect(l.cardStore.verifyLedger().valid).toBe(true);
    l.db.close();
  }, 60_000);
});
