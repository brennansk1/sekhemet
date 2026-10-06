import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ledgerRows, until } from "./support/g2_cli.js";
import { type EngineTurn, startEngine, workerRequests } from "./support/g4_engine.js";
import { queueProject, runQueueOn } from "./support/g4_queue.js";

// The memory watchdog through its door (C2d, FINDINGS_C1 TST-01; runtime
// RUN-18): the built `sekhemet queue` spawned over a real repository with two
// Ready cards and a scripted Worker in its own process. The host's swap is
// read from `sysctl -n vm.swapusage` (models/src/memory.ts); a stand-in
// `sysctl` first on PATH reports swap grown by 900 MB while a flag file
// exists, and passes every other question to the real one. macOS only: Linux
// reads /proc, which no test can fake. Before C2d this was proved by calling
// mayStartCard in process (night.spec.ts).

const write = (path: string, content: string) => [
  { name: "write_file", arguments: { path, content } },
  { name: "finish_card" },
];

describe.runIf(process.platform === "darwin")("the watchdog holds the queue (RUN-18)", () => {
  it("RUN-18: while swap has grown past the watchdog's line, the queue starts no new card; once it falls, the next card starts", async () => {
    const p = await queueProject({
      files: {
        "src/a.ts": "",
        "src/b.ts": "",
        "src/main.ts":
          'import { a } from "./a.js";\nimport { b } from "./b.js";\nconsole.log(a, b);\n',
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
        {
          id: "c2",
          tier: "story",
          title: "Write b",
          status: "ready",
          scopeFiles: ["src/b.ts"],
          stepBudget: 4,
        },
      ],
    });
    const bin = join(p.home, "bin");
    mkdirSync(bin, { recursive: true });
    const pressure = join(p.home, "pressure");
    writeFileSync(
      join(bin, "sysctl"),
      `#!/bin/sh
case "$*" in
  *vm.swapusage*)
    if [ -f "${pressure}" ]; then echo "total = 4096.00M  used = 900.00M  free = 3196.00M  (encrypted)";
    else echo "total = 4096.00M  used = 0.00M  free = 4096.00M  (encrypted)"; fi ;;
  *kern.memorystatus_vm_pressure_level*) echo 1 ;;
  *) exec /usr/sbin/sysctl "$@" ;;
esac
`,
    );
    chmodSync(join(bin, "sysctl"), 0o755);
    const go = join(p.home, "go");
    const turns: EngineTurn[] = [
      // c1's first step waits until swap has grown under it.
      { waitFor: go, calls: write("src/a.ts", "export const a = 1;\n") },
      { calls: write("src/b.ts", "export const b = 1;\n") },
    ];
    const engine = await startEngine(p.home, turns);
    const running = runQueueOn(p, engine, { PATH: `${bin}:${process.env.PATH ?? ""}` });
    await until(() => workerRequests(engine).length >= 1, 60_000);
    // Swap grows while c1 runs; the watchdog samples every 2 s.
    writeFileSync(pressure, "");
    await new Promise((r) => setTimeout(r, 5000));
    writeFileSync(go, "");
    // c1 finishes its run …
    await until(
      () =>
        ledgerRows(p.repo).some(
          (e) => e.type === "attempt/finished" && (e.cardId ?? e.payload.cardId) === "c1",
        ),
      60_000,
    );
    // … and no new card starts while the pressure lasts.
    await new Promise((r) => setTimeout(r, 8000));
    expect(workerRequests(engine)).toHaveLength(1);
    expect(
      ledgerRows(p.repo).some(
        (e) =>
          e.type === "card/status_changed" &&
          e.cardId === "c2" &&
          e.payload.toStatus === "in_progress",
      ),
    ).toBe(false);
    // The pressure falls: the queue starts c2.
    rmSync(pressure);
    const r = await running;
    expect(r.stdout, r.stderr).toMatch(
      /waiting: the memory watchdog asks to stop new worktrees \(elevated/,
    );
    expect(workerRequests(engine)).toHaveLength(2);
    expect(r.stdout).toMatch(/c2[\s\S]*PASSED \(gate_passed\)/);
  }, 180_000);
});
