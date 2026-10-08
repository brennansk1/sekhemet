import { daemonStart, daemonStatus, daemonStatusAll, daemonStop, portFree } from "../daemon.js";
import { atLoginLine, registerAtLogin, unregisterAtLogin } from "../login_service.js";
import { DEFAULT_DASHBOARD_PORT } from "../server.js";
import type { CommandHandler } from "./registry.js";

/**
 * `sekhemet daemon start|stop|status [--port N]` (runtime item 5, H1): the
 * dashboard in the background; `daemon status --all` (MD-N17-3) every
 * workspace's server and the model lease; `--at-login` (item 5a,
 * NEW-runtime-15, RUN-74..77) registers or removes the workspace's server
 * with the operating system's per-user service manager. Moved from `main`
 * into the registry in C5 (strangler fig).
 */
export const daemonCommand: CommandHandler = async (args, env) => {
  const action = args.positionals[0] ?? "status";
  if (!["start", "stop", "status"].includes(action)) {
    console.error(
      `sekhemet: daemon takes start, stop or status, not ${action}: sekhemet daemon start|stop|status [--at-login] [--all]`,
    );
    return 2;
  }
  const atLogin = args.values["at-login"] === true;
  if (args.values.all === true) {
    if (action !== "status") {
      console.error("sekhemet: --all goes with `daemon status`: sekhemet daemon status --all");
      return 2;
    }
    console.log(await daemonStatusAll());
    return 0;
  }
  if (action === "start" && atLogin) {
    const r = await registerAtLogin(env.repoPath, { portFree });
    console.log(r.message);
    return r.ok ? 0 : 1;
  }
  if (action === "stop" && atLogin) {
    const r = unregisterAtLogin(env.repoPath);
    console.log(r.message);
    return r.ok ? 0 : 1;
  }
  if (action === "start") {
    const asked =
      typeof args.values.port === "string" ? Number.parseInt(args.values.port, 10) : Number.NaN;
    const r = await daemonStart(env.repoPath, Number.isNaN(asked) ? DEFAULT_DASHBOARD_PORT : asked);
    console.log(r.message);
    return !r.started && !r.message.startsWith("Already") ? 1 : 0;
  }
  if (action === "stop") {
    console.log(await daemonStop(env.repoPath));
    return 0;
  }
  console.log(await daemonStatus(env.repoPath));
  console.log(atLoginLine(env.repoPath));
  return 0;
};
