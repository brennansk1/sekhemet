import { writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A preload that loads `g2_model.ts`'s scripted model and then holds the
 * Worker's `G3_WORKER_HOLD_AT`-th request (the first by default) for
 * `G3_WORKER_DELAY_MS`: a card stays running long enough for a person — or a
 * tracker — to act while it runs (integrations INT-11a, planner-pm PM-P2-7).
 * Every other request is answered as the scripted model answers it.
 * Returns the path to pass as the spawned binary's `--import`.
 */
export function slowWorkerPreload(home: string, g2Preload: string): string {
  const path = join(home, "g3_slow_worker.mjs");
  writeFileSync(
    path,
    `import ${JSON.stringify(g2Preload)};
const inner = globalThis.fetch;
const delay = Number(process.env.G3_WORKER_DELAY_MS || 0);
const at = Number(process.env.G3_WORKER_HOLD_AT || 1);
let seen = 0;
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith("http://127.0.0.1:11434/api/chat") && String(init?.body ?? "").includes('"finish_card"')) {
    seen++;
    if (delay > 0 && seen === at) await new Promise((r) => setTimeout(r, delay));
  }
  return inner(input, init);
};
`,
  );
  return path;
}
