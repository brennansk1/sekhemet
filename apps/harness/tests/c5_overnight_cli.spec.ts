import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ModelRegistry } from "@sekhemet/models";
import { describe, expect, it } from "vitest";
import { cliStart, until } from "./support/g2_cli.js";
import { startEngine } from "./support/g4_engine.js";
import { queueProject } from "./support/g4_queue.js";

/**
 * An overnight round that starts nothing (runtime RUN-11a; C2d G4 finding
 * routed to C5): `sekhemet overnight` spawned as the built binary
 * (`apps/harness/dist/index.js`, `support/g2_cli.ts`) over a real repository
 * and ledger, inside the person's `[machine] reserved_hours`, so each round's
 * queue starts no routine issue. The Worker is a scripted engine
 * (`support/g4_engine.ts`); no model is loaded.
 */

describe("an overnight round that started nothing waits (RUN-11a)", () => {
  it("RUN-11a: inside reserved hours the round starts no issue, the night says so and waits, and no second round follows at once", async () => {
    const p = await queueProject({
      files: { "src/a.ts": "", "src/main.ts": 'import { a } from "./a.js";\nconsole.log(a);\n' },
      cards: [
        {
          id: "c1",
          tier: "story",
          title: "Write a",
          scopeFiles: ["src/a.ts"],
          stepBudget: 3,
          priority: 3,
        },
      ],
    });
    // The Worker's quantisation registered, and its injection-fixture pass (SEC-37b).
    new ModelRegistry(p.env.SEKHEMET_MODEL_REGISTRY).upsert("scripted-worker:latest", {
      quant: "Q4_K_M",
    });
    mkdirSync(join(p.home, ".sekhemet"), { recursive: true });
    writeFileSync(
      join(p.home, ".sekhemet", "injection_fixtures.json"),
      JSON.stringify([
        { modelId: "scripted-worker:latest", quant: "Q4_K_M", passedAt: new Date().toISOString() },
      ]),
    );
    const engine = await startEngine(p.home, [{ calls: [{ name: "finish_card" }] }]);
    const userConfig = join(p.home, "user-config.toml");
    writeFileSync(userConfig, '[machine]\nreserved_hours = "00:00-23:59"\n');
    const night = cliStart(["overnight", "--worker", "scripted-worker:latest", "--idle-min", "0"], {
      cwd: p.repo,
      env: {
        ...p.env,
        ...engine.env,
        SEKHEMET_USER_CONFIG: userConfig,
        NODE_OPTIONS: `--import=${engine.preload}`,
      },
    });
    try {
      await until(() => /Round 1 started no issue/.test(night.output()), 120_000);
      const out = night.output();
      expect(out).toMatch(/c1 not started: it is inside the reserved hours/);
      expect(out).toMatch(/Round 1 started no issue[^\n]*; waiting 10 min/);
      // The night waits: no second round within the next few seconds.
      await new Promise((r) => setTimeout(r, 4000));
      expect(night.output()).not.toMatch(/Round 2: /);
      expect(night.output()).not.toMatch(/round limit/);
    } finally {
      await night.stop();
    }
  }, 180_000);
});
