import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ledgerRows } from "./support/g2_cli.js";
import { startEngine } from "./support/g4_engine.js";
import { queueProject, runQueueOn } from "./support/g4_queue.js";

// The allowlist's warnings through their door (C2d, FINDINGS_C1 TST-01;
// security SEC-15b): the built `sekhemet queue` spawned over a real
// repository whose gates.toml lets its cards reach a wildcard host and an
// upload-capable one, under a user policy that admits them. The Worker is a
// scripted engine in its own process; no model is loaded and the card's
// commands reach nothing. Before C2d this was proved by calling
// allowlistWarnings in process (network_policy.spec.ts).

describe("a wildcard or upload-capable allowlist entry is warned on the card (SEC-15b)", () => {
  it("SEC-15b: a card run under *.example.com and github.com says so and records each warning on the card; registry.npmjs.org is not warned", async () => {
    const p = await queueProject({
      files: {
        "src/a.ts": "",
        "src/main.ts": 'import { a } from "./a.js";\nconsole.log(a);\n',
        ".sekhemet/gates.toml": `[project]\nnetwork_allow = ["*.example.com", "github.com", "registry.npmjs.org"]\n\n[[gate]]\nid = "unit"\nrung = "test"\ncommand = "node"\nargs = ["-e", "process.exit(0)"]\nparser = "generic"\ntimeout_s = 60\n`,
      },
      cards: [
        {
          id: "c1",
          tier: "story",
          title: "Write a",
          status: "ready",
          scopeFiles: ["src/a.ts"],
          stepBudget: 4,
        },
      ],
    });
    const userConfig = join(p.home, "user.toml");
    writeFileSync(userConfig, '[network]\nmode = "open"\n');
    const engine = await startEngine(p.home, [
      {
        calls: [
          { name: "write_file", arguments: { path: "src/a.ts", content: "export const a = 1;\n" } },
          { name: "finish_card" },
        ],
      },
    ]);
    const r = await runQueueOn(p, engine, { SEKHEMET_USER_CONFIG: userConfig });
    const out = `${r.stdout}\n${r.stderr}`;
    expect(out).toMatch(/network allowlist warning: \*\.example\.com — [^\n]*wildcard/);
    expect(out).toMatch(/network allowlist warning: github\.com — [^\n]*upload/);
    expect(out).not.toMatch(/network allowlist warning: registry\.npmjs\.org/);
    const recorded = ledgerRows(p.repo)
      .filter((e) => e.type === "card/egress_warning" && e.cardId === "c1")
      .map((e) => e.payload.host);
    expect(recorded.sort()).toEqual(["*.example.com", "github.com"]);
  }, 180_000);
});
