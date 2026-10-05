import { rmSync } from "node:fs";
import { join } from "node:path";
import { MockInferenceAdapter } from "@sekhemet/models";
import { afterEach, describe, expect, it } from "vitest";
import { executeCard } from "../../src/execute.js";
import {
  MB,
  cleanUp,
  context,
  darwin,
  expectRecordedStop,
  fillVolume,
  finish,
  openLedger,
  projectRepo,
  readyCard,
  slowFaults,
  smallVolume,
  tempDir,
  write,
} from "./fault_fixture.js";

// C.6 fault 4: a full disk during a worktree write. The repository, and so
// the issue's worktree, sits on a real 64 MB disk image (`hdiutil`, macOS,
// no root); the Worker writes more than the volume holds and the operating
// system answers ENOSPC. Then the volume is filled to ENOSPC by another
// writer while the issue waits, and freed. Slow (an image is created and
// attached): run by `pnpm release-gate` (SEKHEMET_SLOW_FAULTS=1); the full
// disk's fast cases are `disk_low.spec.ts`'s, in `pnpm gate`. Linux needs
// root to attach an image, so there this fault is not run (stated in
// runtime's State row).

afterEach(cleanUp);

describe("C.6: a full disk during a worktree write", () => {
  it.runIf(darwin && slowFaults)(
    "ends in disk_low with the path, held in Ready at its checkpoint; resume continues once space is freed",
    async () => {
      const vol = smallVolume(64);
      const repo = projectRepo(vol.mount);
      // The ledger on the big volume: the worktree's volume is the one that fills.
      const state = tempDir("sek-fault-disk-state-");
      const l = openLedger(state);
      const card = await readyCard(l, "card_disk_full", ["src/a.ts", "src/data.txt"]);
      const ctx = context(repo, l, { workspaceFolder: state, freeSpaceFloorBytes: 8 * MB });
      const stopped = await executeCard(
        ctx,
        card,
        new MockInferenceAdapter("scripted", [
          write("src/a.ts", "export const a = 1;\n"),
          write("src/data.txt", "x".repeat(80 * MB)),
          finish(),
        ]),
      );
      expect(stopped.stopReason).toBe("disk_low");
      expect(stopped.evidence.stopDetail).toMatchObject({
        path: "src/data.txt",
        volume: vol.mount,
      });
      await expectRecordedStop(l, card.id, "disk_low");
      expect((await l.cardStore.getCard(card.id))?.status).toBe("ready");
      // Another writer fills the volume to ENOSPC meanwhile, then the person frees it.
      const filler = join(vol.mount, "filler.bin");
      expect(fillVolume(filler).code).toBe("ENOSPC");
      rmSync(filler);
      const resumed = await executeCard(
        ctx,
        (await l.cardStore.getCard(card.id)) as never,
        new MockInferenceAdapter("scripted", [finish()]),
      );
      expect(resumed.resumedFrom?.step).toBe(1);
      expect(resumed.passed).toBe(true);
      expect(l.cardStore.verifyLedger().valid).toBe(true);
      l.db.close();
    },
    180_000,
  );
});
