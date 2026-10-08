import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { userDir } from "./user_dir.js";

/**
 * Start at login (runtime item 5a, NEW-runtime-15, RUN-74..77; DEC-53 c10;
 * FINDINGS REL-14): the workspace's dashboard server registered with the
 * operating system's own per-user service manager, with no library — a
 * LaunchAgent in `~/Library/LaunchAgents/` on macOS, an enabled
 * `systemd --user` unit on Linux — running `sekhemet serve` in the workspace
 * folder at every login, on a port no other registered workspace uses.
 *
 * What was written is recorded in `<user dir>/at-login.json` (the folder,
 * its port, the unit's path and the SHA-256 of the unit as written), so
 * `daemon stop --at-login` removes only a unit this install wrote and
 * `daemon status --all` and `sekhemet uninstall` find them. The service
 * manager's own tool (`launchctl`, `systemctl`) is run through a runner the
 * caller may replace; it is found on `PATH`.
 */

export type ServiceManager = "launchd" | "systemd";

export interface AtLoginRecord {
  /** The workspace folder `serve` runs in. */
  folder: string;
  port: number;
  manager: ServiceManager;
  /** The LaunchAgent's label or the systemd unit's name. */
  label: string;
  /** The unit file's path. */
  unit: string;
  /** SHA-256 of the unit as this install wrote it: anything else is not removed (RUN-76). */
  sha256: string;
  at: string;
  /** The program the unit runs (`node` and the harness's entry), to check it still exists (RUN-77). */
  program?: string[];
}

export type ServiceRunner = (
  command: string,
  args: string[],
) => { status: number | null; stdout: string; stderr: string };

/**
 * The install's own fixed-argv process runner (no shell, a 15 s bound): the
 * service manager here, and `uninstall`'s `docker rm`, `git worktree prune`
 * and the inventory's `git ls-files` (SEC-18: the one importer of
 * node:child_process for the install's management).
 */
export const defaultRunner: ServiceRunner = (command, args) => {
  const r = spawnSync(command, args, { encoding: "utf8", timeout: 15_000 });
  return {
    status: r.error ? null : r.status,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? (r.error ? r.error.message : ""),
  };
};

/**
 * The first port a registration takes: just past the ports `serve` tries on
 * its own (4040 and the next `SERVE_PORT_TRIES - 1`, MD-N17-3), so a serve
 * that finds its port taken never moves onto a registered one (RUN-75).
 */
export const AT_LOGIN_PORT_BASE = 4050;
/** How many ports from the base a registration may take. */
export const AT_LOGIN_PORT_SPAN = 100;

export function atLoginPath(): string {
  return join(userDir(), "at-login.json");
}

export function readAtLogin(path = atLoginPath()): AtLoginRecord[] {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { registered?: unknown };
    return (Array.isArray(parsed.registered) ? parsed.registered : []).filter(
      (r): r is AtLoginRecord =>
        typeof r === "object" &&
        r !== null &&
        typeof (r as AtLoginRecord).folder === "string" &&
        typeof (r as AtLoginRecord).port === "number" &&
        typeof (r as AtLoginRecord).unit === "string",
    );
  } catch {
    return [];
  }
}

function writeAtLogin(list: AtLoginRecord[], path: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify({ registered: list }, null, 2)}\n`, { mode: 0o600 });
}

function realFolder(folder: string): string {
  try {
    return realpathSync(folder);
  } catch {
    return folder;
  }
}

/** The registration of this folder, if any. */
export function atLoginFor(folder: string, path = atLoginPath()): AtLoginRecord | undefined {
  const real = realFolder(folder);
  return readAtLogin(path).find((r) => realFolder(r.folder) === real);
}

/** Ports registered for other folders: `daemon start` does not take them either (RUN-75). */
export function portsRegisteredElsewhere(folder: string, path = atLoginPath()): Set<number> {
  const real = realFolder(folder);
  return new Set(
    readAtLogin(path)
      .filter((r) => realFolder(r.folder) !== real)
      .map((r) => r.port),
  );
}

export function serviceManagerFor(platform: NodeJS.Platform): ServiceManager | undefined {
  return platform === "darwin" ? "launchd" : platform === "linux" ? "systemd" : undefined;
}

/** Why this machine's service manager cannot be used now, or undefined when it can. */
export function serviceManagerRefusal(
  manager: ServiceManager | undefined,
  run: ServiceRunner,
): string | undefined {
  if (!manager)
    return `starting at login needs launchd (macOS) or systemd (Linux), and this is ${process.platform}`;
  if (manager === "launchd") {
    const r = run("launchctl", ["print", `gui/${userInfo().uid}`]);
    return r.status === 0
      ? undefined
      : "launchctl cannot reach this user's login session (gui domain), so no LaunchAgent can be loaded here — run it from a desktop session";
  }
  const r = run("systemctl", ["--user", "show-environment"]);
  return r.status === 0
    ? undefined
    : "this session has no systemd --user manager (a container, or a login without a user session), so no unit can be enabled here";
}

const hash12 = (folder: string) =>
  createHash("sha256").update(realFolder(folder)).digest("hex").slice(0, 12);

const xml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** One argument of a systemd command line, quoted (systemd.service, "Command lines"). */
const sdQuote = (s: string) =>
  `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%")}"`;

export interface UnitSpec {
  folder: string;
  port: number;
  /** `node` and the harness's entry: the command `serve` runs as. */
  program: string[];
  /** Environment the server needs: PATH, and the user directory when it is not the default. */
  env: Record<string, string>;
}

/** The argument list a registered server runs. */
export function serveArgs(spec: UnitSpec): string[] {
  return [...spec.program, "serve", "--repo", spec.folder, "--port", String(spec.port)];
}

export function launchAgentPlist(label: string, spec: UnitSpec): string {
  const log = join(spec.folder, ".sekhemet", "logs", "at-login.log");
  const env = Object.entries(spec.env)
    .map(([k, v]) => `    <key>${xml(k)}</key><string>${xml(v)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(label)}</string>
  <key>ProgramArguments</key>
  <array>
${serveArgs(spec)
  .map((a) => `    <string>${xml(a)}</string>`)
  .join("\n")}
  </array>
  <key>WorkingDirectory</key><string>${xml(spec.folder)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${env}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${xml(log)}</string>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
</dict>
</plist>
`;
}

export function systemdUnit(spec: UnitSpec): string {
  return `[Unit]
Description=Sekhemet dashboard for ${spec.folder.replace(/%/g, "%%")}

[Service]
Type=simple
WorkingDirectory=${spec.folder}
ExecStart=${serveArgs(spec).map(sdQuote).join(" ")}
${Object.entries(spec.env)
  .map(([k, v]) => `Environment=${sdQuote(`${k}=${v}`)}`)
  .join("\n")}

[Install]
WantedBy=default.target
`;
}

export interface AtLoginDeps {
  run?: ServiceRunner;
  platform?: NodeJS.Platform;
  /** The record file; `<user dir>/at-login.json` by default. */
  path?: string;
  /** Whether a loopback port is free now. */
  portFree?: (port: number) => Promise<boolean>;
  /** `node` and the harness's entry; this process's own by default. */
  program?: string[];
}

function program(deps: AtLoginDeps): string[] {
  if (deps.program) return deps.program;
  const entry = process.argv[1] ?? "";
  return [stableNode(), realFolder(entry)];
}

/**
 * The `node` a unit should run: the first `node` on PATH that is this very
 * binary (Homebrew's `/opt/homebrew/bin/node`, a link that follows upgrades),
 * not `process.execPath`, which names the versioned binary behind it and is
 * gone after the next `brew upgrade node`. This process's own path when PATH
 * holds no such link.
 */
export function stableNode(execPath = process.execPath, pathEnv = process.env.PATH ?? ""): string {
  let real: string;
  try {
    real = realpathSync(execPath);
  } catch {
    return execPath;
  }
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, "node");
    try {
      if (realpathSync(candidate) === real) return candidate;
    } catch {
      // Not there, or a broken link: the next folder.
    }
  }
  return execPath;
}

function serverEnv(): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    ...(process.env.SEKHEMET_CONFIG_DIR
      ? { SEKHEMET_CONFIG_DIR: process.env.SEKHEMET_CONFIG_DIR }
      : {}),
    ...(process.env.SEKHEMET_MODELS_DIR
      ? { SEKHEMET_MODELS_DIR: process.env.SEKHEMET_MODELS_DIR }
      : {}),
  };
}

function unitPlace(manager: ServiceManager, folder: string): { label: string; unit: string } {
  const h = hash12(folder);
  if (manager === "launchd") {
    const label = `sekhemet.serve.${h}`;
    return { label, unit: join(homedir(), "Library", "LaunchAgents", `${label}.plist`) };
  }
  const label = `sekhemet-serve-${h}.service`;
  const config = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return { label, unit: join(config, "systemd", "user", label) };
}

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

export type AtLoginResult =
  | { ok: true; message: string; record?: AtLoginRecord }
  | { ok: false; message: string };

/**
 * `daemon start --at-login` (RUN-74, RUN-75): write and load the unit, on a
 * port no other registration uses, and record it. Where the service manager
 * cannot be used, or loading fails, nothing stays written and the reason is said.
 */
export async function registerAtLogin(
  folder: string,
  deps: AtLoginDeps = {},
): Promise<AtLoginResult> {
  const run = deps.run ?? defaultRunner;
  const path = deps.path ?? atLoginPath();
  const existing = atLoginFor(folder, path);
  if (existing)
    return {
      ok: true,
      record: existing,
      message: `This workspace already starts at login, at http://127.0.0.1:${existing.port} (${existing.unit}); nothing was changed.`,
    };
  const manager = serviceManagerFor(deps.platform ?? process.platform);
  const refusal = serviceManagerRefusal(manager, run);
  if (refusal || !manager)
    return { ok: false, message: `Nothing was changed: ${refusal ?? "no service manager"}.` };
  const taken = portsRegisteredElsewhere(folder, path);
  const free = deps.portFree ?? (async () => true);
  let port: number | undefined;
  for (let p = AT_LOGIN_PORT_BASE; p < AT_LOGIN_PORT_BASE + AT_LOGIN_PORT_SPAN; p++) {
    if (!taken.has(p) && (await free(p))) {
      port = p;
      break;
    }
  }
  if (port === undefined)
    return {
      ok: false,
      message: `Nothing was changed: ports ${AT_LOGIN_PORT_BASE} to ${AT_LOGIN_PORT_BASE + AT_LOGIN_PORT_SPAN - 1} are all registered or in use.`,
    };
  const spec: UnitSpec = { folder, port, program: program(deps), env: serverEnv() };
  const { label, unit } = unitPlace(manager, folder);
  if (existsSync(unit))
    return {
      ok: false,
      message: `Nothing was changed: ${unit} exists and this install did not write it.`,
    };
  const text = manager === "launchd" ? launchAgentPlist(label, spec) : systemdUnit(spec);
  mkdirSync(dirname(unit), { recursive: true });
  mkdirSync(join(folder, ".sekhemet", "logs"), { recursive: true });
  writeFileSync(unit, text, { mode: 0o644 });
  const steps: [string, string[]][] =
    manager === "launchd"
      ? [["launchctl", ["bootstrap", `gui/${userInfo().uid}`, unit]]]
      : [
          ["systemctl", ["--user", "daemon-reload"]],
          ["systemctl", ["--user", "enable", label]],
          ["systemctl", ["--user", "start", label]],
        ];
  for (const [cmd, args] of steps) {
    const r = run(cmd, args);
    if (r.status !== 0) {
      rmSync(unit, { force: true });
      if (manager === "systemd") run("systemctl", ["--user", "daemon-reload"]);
      const why = (r.stderr || r.stdout).trim().split("\n")[0] || `exit ${r.status}`;
      return {
        ok: false,
        message: `Nothing was changed: \`${cmd} ${args.join(" ")}\` failed (${why}).`,
      };
    }
  }
  const record: AtLoginRecord = {
    folder,
    port,
    manager,
    label,
    unit,
    sha256: sha(text),
    at: new Date().toISOString(),
    program: spec.program,
  };
  writeAtLogin([...readAtLogin(path), record], path);
  const what = manager === "launchd" ? "a LaunchAgent" : "a systemd --user unit";
  return {
    ok: true,
    record,
    message: `Registered ${what} (${unit}): this workspace's dashboard starts at every login. Bookmark http://127.0.0.1:${port}`,
  };
}

/**
 * `daemon stop --at-login` (RUN-76): unload and remove the unit this install
 * wrote for the folder, and nothing else — a unit changed since it was
 * written is left where it is, and said so.
 */
export function unregisterAtLogin(folder: string, deps: AtLoginDeps = {}): AtLoginResult {
  const run = deps.run ?? defaultRunner;
  const path = deps.path ?? atLoginPath();
  const record = atLoginFor(folder, path);
  if (!record) return { ok: true, message: "This workspace does not start at login." };
  const rest = readAtLogin(path).filter((r) => r.unit !== record.unit);
  let current: string | undefined;
  try {
    current = readFileSync(record.unit, "utf8");
  } catch {
    current = undefined;
  }
  if (current !== undefined && sha(current) !== record.sha256)
    return {
      ok: false,
      message: `${record.unit} was changed after Sekhemet wrote it, so it was left in place; remove it yourself if you no longer want it.`,
    };
  if (current !== undefined) {
    if (record.manager === "launchd")
      run("launchctl", ["bootout", `gui/${userInfo().uid}`, record.unit]);
    else {
      run("systemctl", ["--user", "stop", record.label]);
      run("systemctl", ["--user", "disable", record.label]);
    }
    rmSync(record.unit, { force: true });
    if (record.manager === "systemd") run("systemctl", ["--user", "daemon-reload"]);
  }
  writeAtLogin(rest, path);
  return {
    ok: true,
    message: `This workspace no longer starts at login: removed ${record.unit}.`,
  };
}

/** `daemon status`'s line about starting at login (RUN-77). */
export function atLoginLine(folder: string, path = atLoginPath()): string {
  const r = atLoginFor(folder, path);
  if (!r) return "Starts at login: no (`sekhemet daemon start --at-login` registers it).";
  // A program the unit runs that is gone (Node upgraded or moved, the
  // checkout moved): the service manager would fail to start it at login.
  const missing = (r.program ?? []).find((f) => f.startsWith("/") && !existsSync(f));
  if (missing)
    return `Starts at login: registered, but ${missing} no longer exists (Node or Sekhemet was upgraded or moved), so it will not start. Run \`sekhemet daemon stop --at-login\` and then \`sekhemet daemon start --at-login\` to register it again.`;
  return `Starts at login: yes, at http://127.0.0.1:${r.port} (${r.unit}).`;
}
