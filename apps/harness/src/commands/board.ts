import { spawn } from "node:child_process";
import { DEFAULT_DASHBOARD_PORT, startDashboardServer } from "../server.js";
import { automaticBackup } from "../supervisor.js";
import { terminalBoardLines } from "../terminal_board.js";
import { userPaths } from "../user_dir.js";
import { runningServerFor } from "../workspaces.js";
import type { CommandHandler } from "./registry.js";

/** Where the next `board` opens (surface item 5b): the board, or Configuration while no model is set up. */
let homePage: "board" | "configuration" = "board";

/** The bare `sekhemet` says where its board opens (surface items 5b, 7). */
export function setHomePage(page: "board" | "configuration"): void {
  homePage = page;
}

/**
 * `sekhemet board [--terminal] [--port <n>] [--yes]`: the board is the
 * dashboard — start it and open the browser; the text board remains for a
 * terminal without one (`--terminal`, surface item 20). Moved into the
 * command registry from `main` in C5 (surface item 19a; strangler fig), the
 * body unchanged.
 */
export const boardCommand: CommandHandler = async (args, env) => {
  const { db, log, cardStore, boardService } = await env.kernel("write");
  if (args.values.terminal === true) {
    // NEW-surface-2 (SUR-27): the board's columns and state names, not internal ids.
    console.log(`\n${terminalBoardLines(await boardService.getBoardState()).join("\n")}`);
    return 0;
  }
  // SUR-76: `sekhemet` where the workspace is already served names that server.
  const running = await runningServerFor(userPaths().workspaces, {
    folder: env.workspaceFolder,
    id: log.workspaceId(),
  });
  if (running) {
    console.log(`Sekhemet board: ${running}/#/${homePage}  (already running for this workspace)`);
    db.close();
    return 0;
  }
  const asked =
    typeof args.values.port === "string" ? Number.parseInt(args.values.port, 10) : Number.NaN;
  const server = await startDashboardServer({
    db,
    log,
    boardService,
    cardStore,
    repoPath: env.repoPath,
    port: Number.isNaN(asked) ? DEFAULT_DASHBOARD_PORT : asked,
  });
  const url = `${server.address}/#/${homePage}`;
  // RUN-59: the board is the dashboard server: its day's first start backs up.
  const boardBackup = await automaticBackup({ workspaceFolder: env.workspaceFolder, db, log });
  if (boardBackup) console.log(boardBackup);
  console.log(
    homePage === "configuration"
      ? `Sekhemet Configuration: ${url}  (no model is set up yet; Ctrl+C to stop)`
      : `Sekhemet board: ${url}  (Ctrl+C to stop; --terminal for the text board)`,
  );
  // Surface item 7: --yes prints the address and never opens a browser.
  if (args.values.yes === true) return 0;
  const opener =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  spawn(opener, [url], { stdio: "ignore", detached: true })
    .on("error", () => {
      console.log("Could not open a browser; open the URL above.");
    })
    .unref();
  return 0;
};
