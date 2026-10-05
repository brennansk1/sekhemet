import { HttpInferenceAdapter } from "@sekhemet/models";
import { afterEach, describe, expect, it } from "vitest";
import { runResearchCard } from "../../src/research/cards.js";
import { ResearchService } from "../../src/research/service.js";
import { cleanUp, fakeEngine, openLedger, projectRepo, tempDir } from "./fault_fixture.js";

// C.6 fault 7: a network drop during research. The Research model is a
// local fake OpenAI-compatible server in its own process; the research
// card's question reaches it through the real HTTP adapter and the real
// ResearchService, and the connection drops mid-answer (the server kills
// itself with SIGKILL after the first chunk).

afterEach(cleanUp);

describe("C.6: a network drop during research", () => {
  it("ends the research issue in a recorded stop, held in Ready, and the next run continues", async () => {
    const repo = projectRepo(tempDir("sek-fault-research-"));
    const l = openLedger(repo);
    const card = await l.cardStore.createCard({
      id: "card_research",
      tier: "task",
      title: "Which CSV parser should we use?",
      spec: "Streaming, permissive licence.",
      acceptanceCriteria: ["names one library"],
      labels: ["research"],
      status: "ready",
    });
    const service = (url: string) =>
      new ResearchService({
        repoPath: repo,
        cardStore: l.cardStore,
        log: l.log,
        model: async () =>
          new HttpInferenceAdapter({
            modelId: "fault-researcher",
            baseUrl: url,
            apiFormat: "openai",
          }),
      });
    const dropping = await fakeEngine([
      { text: "Use csv-", die: true },
      { text: "x", die: true },
    ]);
    const err = await runResearchCard(
      card,
      (q, id) => service(dropping.url).ask(q, { deep: true, cardId: id }),
      l.cardStore,
      repo,
      l.boardService,
    ).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    if (dropping.proc.exitCode === null && dropping.proc.signalCode === null)
      await new Promise((r) => dropping.proc.once("exit", r));
    expect(dropping.proc.signalCode).toBe("SIGKILL");
    // The steady state: the ledger verifies, and the issue is not left In
    // Progress with nothing said: it is held in Ready with its stop recorded.
    expect(l.cardStore.verifyLedger().valid).toBe(true);
    const held = await l.cardStore.getCard(card.id);
    expect(held?.status).toBe("ready");
    expect(held?.stopReason).toBe("model_unavailable");
    const events = await l.cardStore.cardEvents(card.id, ["research/stopped"]);
    expect(events.at(-1)?.payload).toMatchObject({ stopReason: "model_unavailable" });
    // The Research model is back: the next run continues and ends recorded.
    const back = await fakeEngine([{ text: "Not settled: no source could be read." }]);
    const again = await runResearchCard(
      (await l.cardStore.getCard(card.id)) as never,
      (q, id) => service(back.url).ask(q, { deep: true, cardId: id }),
      l.cardStore,
      repo,
      l.boardService,
    );
    expect(again.notePath).toMatch(/card_research\.md$/);
    expect(["review", "parked"]).toContain((await l.cardStore.getCard(card.id))?.status);
    expect(l.cardStore.verifyLedger().valid).toBe(true);
    l.db.close();
  }, 90_000);
});
