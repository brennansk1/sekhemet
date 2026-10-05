import { MockInferenceAdapter } from "@sekhemet/models";
import { afterEach, describe, expect, it } from "vitest";
import { executeCard } from "../../src/execute.js";
import {
  cleanUp,
  context,
  expectRecordedStop,
  finish,
  openLedger,
  projectRepo,
  readyCard,
  tempDir,
  write,
} from "./fault_fixture.js";

// C.6 fault 6: a clock jump. The system clock is moved while an issue runs —
// three hours forward (an NTP correction after a long sleep, a person setting
// the time) or one hour back. The wall clock is the environment here: it is
// moved where every caller reads it (`Date.now`, `new Date()`), while the
// monotonic clock (`performance.now`, `process.hrtime`) goes on as it does
// when an operating system's clock is stepped.

afterEach(cleanUp);

const realNow = Date.now;
const RealDate = Date;
function jumpClock(ms: number): () => void {
  const shift = (t: number) => t + ms;
  class Shifted extends RealDate {
    constructor(...args: ConstructorParameters<DateConstructor> | []) {
      if (args.length === 0) super(shift(realNow()));
      else super(...(args as ConstructorParameters<DateConstructor>));
    }
    static override now(): number {
      return shift(realNow());
    }
  }
  globalThis.Date = Shifted as DateConstructor;
  return () => {
    globalThis.Date = RealDate;
  };
}

describe("C.6: a clock jump", () => {
  for (const [label, ms] of [
    ["three hours forward", 3 * 3_600_000],
    ["one hour back", -3_600_000],
  ] as const) {
    it(`${label} mid-issue: the time budget is not charged the jump, the issue ends in its recorded stop, and the ledger verifies`, async () => {
      const repo = projectRepo(tempDir("sek-fault-clock-"));
      const l = openLedger(repo);
      const card = await readyCard(l, "card_clock", ["src/a.ts"], 6);
      let restore = () => {};
      const model = new MockInferenceAdapter("scripted", [
        write("src/a.ts", "export const a = 1;\n"),
        write("src/a.ts", "export const a = 2;\n"),
        finish(),
      ]);
      const generate = model.generate.bind(model);
      let calls = 0;
      model.generate = async (req) => {
        // The clock is stepped while the second step is generating.
        if (++calls === 2) restore = jumpClock(ms);
        return generate(req);
      };
      try {
        const result = await executeCard(context(repo, l), card, model);
        expect(result.stopReason).toBe("gate_passed");
        expect(result.passed).toBe(true);
        await expectRecordedStop(l, card.id, "gate_passed");
        expect((await l.cardStore.getCard(card.id))?.status).toBe("review");
      } finally {
        restore();
      }
      expect(l.cardStore.verifyLedger().valid).toBe(true);
      l.db.close();
    }, 60_000);
  }
});
