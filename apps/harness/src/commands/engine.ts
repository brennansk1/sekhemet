import { createInterface } from "node:readline/promises";
import {
  DownloadHashMismatch,
  EngineRefused,
  detectEnginePlatform,
  formatBytes,
} from "@sekhemet/models";
import { type EngineView, engineView, installEngine } from "../config_engine.js";
import type { CommandHandler } from "./registry.js";

/**
 * `sekhemet engine [status]` and `sekhemet engine get [--yes]` (models
 * rules 6a, 6b; NEW-models-16, NEW-models-19): the
 * terminal form of Configuration › Models's engine card, the same
 * implementation (`config_engine.ts`). `status` names the engine in use,
 * where it came from and its build against the floor, and exits 1 while
 * it is missing or below the floor. `get` first shows the pinned release,
 * file, size and licence and downloads only on the person's yes — `--yes`,
 * or an answer at a terminal; with neither, nothing is downloaded (exit 2).
 */

export function engineStatusLines(v: EngineView): string[] {
  const lines = [v.line];
  if (!v.meetsFloor) for (const f of v.fixes) lines.push(`  Fix: ${f}`);
  // The offer only where it is the fix: missing or below the floor.
  if (!v.meetsFloor) {
    if (v.offerText && !v.installed) lines.push(`Offered: ${v.offerText}`);
    else if (v.noAsset) lines.push(v.noAsset);
  }
  return lines;
}

export const engineCommand: CommandHandler = async (args, env) => {
  const sub = args.positionals[0] ?? "status";
  if (sub !== "status" && sub !== "get") {
    console.error("sekhemet: engine takes status or get: sekhemet engine [status | get [--yes]]");
    return 2;
  }
  const platform = detectEnginePlatform();
  const view = engineView({ platform });
  if (sub === "status") {
    for (const l of engineStatusLines(view)) console.log(l);
    return view.meetsFloor ? 0 : 1;
  }
  if (!view.offer) {
    console.log(view.noAsset ?? "Nothing is offered for this machine.");
    return 1;
  }
  if (view.installed) {
    console.log(`llama.cpp ${view.offer.release} is already installed. ${view.line}`);
    return 0;
  }
  console.log(view.offerText ?? "");
  let yes = args.values.yes === true;
  if (!yes) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      console.log(
        "No terminal to confirm in: nothing was downloaded. Run `sekhemet engine get --yes` to download it.",
      );
      return 2;
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      yes = /^y(es)?$/i.test((await rl.question("Download it? [y/N] ")).trim());
    } finally {
      rl.close();
    }
    if (!yes) {
      console.log("Nothing was downloaded.");
      return 2;
    }
  }
  const { log } = await env.kernel("read");
  let last = 0;
  try {
    const done = await installEngine(
      { repoPath: env.repoPath, log, platform },
      log.localPrincipal(),
      {
        onProgress: (p) => {
          if (p.state === "verifying") console.log("Verifying…");
          else if (p.state === "running" && p.bytes - last >= 4 * 1024 * 1024) {
            last = p.bytes;
            console.log(`  ${formatBytes(p.bytes)} of ${formatBytes(p.total)}`);
          }
        },
      },
    );
    console.log(
      `Installed llama.cpp ${done.release} (build ${done.build}) in ${done.dir}. Sekhemet uses it from now on unless SEKHEMET_LLAMA_SERVER names another.`,
    );
    return 0;
  } catch (err) {
    if (err instanceof EngineRefused || err instanceof DownloadHashMismatch) {
      console.log(err.message);
      return 1;
    }
    console.error(`sekhemet: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
};
