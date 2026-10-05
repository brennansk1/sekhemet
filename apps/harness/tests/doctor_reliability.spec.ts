import { type ChildProcess, spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { leaseProcessStart } from "@sekhemet/models";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeBackupSet } from "../src/backup_sets.js";
import {
  backupCheck,
  credentialStoreCheck,
  freeSpaceCheck,
  linuxPowerSource,
  lostRecordsCheck,
  modelLeaseCheck,
  parsePmsetBatt,
  powerCheck,
  stayAwakeCheck,
} from "../src/doctor.js";
import { openLocalLedger } from "../src/ledger_cmds.js";
import { reportLostRecord } from "../src/lost_records.js";

/**
 * Surface item 20e, NEW-surface-12 (SUR-83 to SUR-88): the rows C4's runtime,
 * security and models changes owe `doctor`. Real ledgers, backup sets,
 * processes and volumes; the battery is read from recorded `pmset` output
 * and a sysfs-shaped folder, since a test machine's power cannot be switched.
 */

const dirs: string[] = [];
const kids: ChildProcess[] = [];
let home: string;
beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "sek-doc-rel-home-")));
  dirs.push(home);
  vi.stubEnv("SEKHEMET_CONFIG_DIR", join(home, ".sekhemet"));
});
afterEach(() => {
  vi.unstubAllEnvs();
  for (const k of kids.splice(0)) if (k.exitCode === null) k.kill("SIGKILL");
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(d);
  return d;
}

/** A workspace folder with a ledger that has recorded events. */
async function workspace() {
  const folder = tempDir("sek-doc-ws-");
  const { db, log } = openLocalLedger(folder);
  await log.append({ type: "test/noted", actor: "harness", payload: { n: 1 } });
  return { folder, db, log, wsId: log.workspaceId() as string };
}

describe("Backup (SUR-83, RUN-63)", () => {
  it("warns with no set while the ledger has events; shows a fresh set's age; warns past 48 h with events since", async () => {
    const w = await workspace();
    const none = backupCheck(w.folder);
    expect(none.status).toBe("warn");
    expect(none.detail).toMatch(/no backup .*Do: run `sekhemet backup`/i);
    const t0 = new Date();
    const set = await writeBackupSet({ workspaceFolder: w.folder, db: w.db, log: w.log, now: t0 });
    const fresh = backupCheck(w.folder, new Date(t0.getTime() + 2 * 3_600_000));
    expect(fresh.status).toBe("pass");
    expect(fresh.detail).toContain(set.path);
    expect(fresh.detail).toMatch(/2 hours old/);
    // 49 hours later and nothing recorded since: still a pass.
    const quiet = backupCheck(w.folder, new Date(t0.getTime() + 49 * 3_600_000));
    expect(quiet.status).toBe("pass");
    // An event after the set: past 48 hours it warns.
    await w.log.append({ type: "test/noted", actor: "harness", payload: { n: 2 } });
    const stale = backupCheck(w.folder, new Date(t0.getTime() + 49 * 3_600_000));
    expect(stale.status).toBe("warn");
    expect(stale.detail).toMatch(/49 hours old.*recorded since.*Do: run `sekhemet backup`/);
    w.db.close();
  });

  it("passes in a folder with no Activity log", () => {
    expect(backupCheck(tempDir("sek-doc-empty-")).status).toBe("pass");
  });
});

describe("Staying awake and power (SUR-84, RUN-66, RUN-68)", () => {
  it("names the tool on PATH, or warns that none is found", () => {
    const bin = tempDir("sek-doc-bin-");
    const tool = join(bin, "caffeinate");
    writeFileSync(tool, "#!/bin/sh\nexit 0\n");
    chmodSync(tool, 0o755);
    const found = stayAwakeCheck("darwin", bin);
    expect(found.status).toBe("pass");
    expect(found.detail).toContain(tool);
    const missing = stayAwakeCheck("linux", tempDir("sek-doc-nobin-"));
    expect(missing.status).toBe("warn");
    expect(missing.detail).toMatch(/systemd-inhibit/);
    expect(missing.detail).toMatch(/may stop when the machine sleeps/);
  });

  it("RUN-66: a tool on PATH that refuses (polkit in a headless session) warns, with what it said", () => {
    const bin = tempDir("sek-doc-bin-");
    const tool = join(bin, "systemd-inhibit");
    writeFileSync(tool, "#!/bin/sh\necho 'Failed to inhibit: Access denied' >&2\nexit 1\n");
    chmodSync(tool, 0o755);
    const refused = stayAwakeCheck("linux", bin);
    expect(refused.status).toBe("warn");
    expect(refused.detail).toContain(tool);
    expect(refused.detail).toMatch(/Failed to inhibit: Access denied/);
    expect(refused.detail).toMatch(/may stop when the machine sleeps/);
  });

  it("reads the power source from pmset's output and from a sysfs folder", () => {
    expect(
      parsePmsetBatt(
        "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1234)\t87%; discharging; 5:12 remaining present: true\n",
      ),
    ).toBe("battery");
    expect(
      parsePmsetBatt(
        "Now drawing from 'AC Power'\n -InternalBattery-0 (id=1234)\t100%; charged; 0:00 remaining present: true\n",
      ),
    ).toBe("ac");
    expect(parsePmsetBatt("Now drawing from 'AC Power'\n")).toBe("none");
    const sys = tempDir("sek-doc-sys-");
    const supply = (name: string, files: Record<string, string>) => {
      mkdirSync(join(sys, name));
      for (const [f, v] of Object.entries(files)) writeFileSync(join(sys, name, f), `${v}\n`);
    };
    supply("AC", { type: "Mains", online: "0" });
    supply("BAT0", { type: "Battery", status: "Discharging" });
    expect(linuxPowerSource(sys)).toBe("battery");
    writeFileSync(join(sys, "AC", "online"), "1\n");
    expect(linuxPowerSource(sys)).toBe("ac");
    expect(linuxPowerSource(join(sys, "absent"))).toBe("unknown");
  });

  it("warns on battery only while an overnight window is set in a config.toml", () => {
    const repo = tempDir("sek-doc-power-");
    const userPath = join(home, "user.toml");
    expect(powerCheck(repo, "battery", userPath).status).toBe("pass");
    writeFileSync(userPath, '[machine]\nreserved_hours = "08:00-18:00 Mon-Fri"\n');
    const warned = powerCheck(repo, "battery", userPath);
    expect(warned.status).toBe("warn");
    expect(warned.detail).toMatch(/closed lid or a sleep the battery forces stops the night/);
    expect(powerCheck(repo, "ac", userPath).status).toBe("pass");
    expect(powerCheck(repo, "unknown", userPath).detail).toMatch(/could not be read/);
  });
});

describe("Free space (SUR-85, RUN-71)", () => {
  it("shows the repository's and the models' volumes against the floor; fails below it on the repository's, warns on the models'", () => {
    const repo = tempDir("sek-doc-free-");
    const models = tempDir("sek-doc-models-");
    const ok = freeSpaceCheck(repo, repo, models, { floorBytes: 1 });
    expect(ok.status).toBe("pass");
    expect(ok.detail).toMatch(/free of a .* floor/);
    expect(ok.detail).toMatch(/models/);
    const short = freeSpaceCheck(repo, repo, models, { floorBytes: Number.MAX_SAFE_INTEGER });
    expect(short.status).toBe("fail");
    expect(short.detail).toMatch(/no issue starts/);
    // Only the models' volume short: a warning.
    const modelsOnly = freeSpaceCheck(repo, repo, models, {
      floorBytes: 1,
      modelsFloorBytes: Number.MAX_SAFE_INTEGER,
    });
    expect(modelsOnly.status).toBe("warn");
    const gone = freeSpaceCheck(repo, repo, join(models, "nope"), { floorBytes: 1 });
    expect(gone.detail).toMatch(/models folder .*nope does not exist/);
  });
});

describe("Credential store (SUR-86, SEC-N14-2)", () => {
  it("names the workspace's store, reports the move the ledger records, and warns on a store left at the old place", async () => {
    const w = await workspace();
    const ws = w.wsId;
    const root = join(home, ".sekhemet", "identity");
    mkdirSync(join(root, ws), { recursive: true });
    expect(credentialStoreCheck(ws, w.folder).detail).toContain(join(root, ws));
    expect(credentialStoreCheck(ws, w.folder).detail).not.toMatch(/moved/);
    // The move is the ledger's record (the spine), not a file beside the store.
    w.log.appendNow({
      actor: "system",
      type: "credentials/store_moved",
      payload: { workspaceId: ws, from: root, to: join(root, ws), files: ["credentials.json"] },
    });
    const moved = credentialStoreCheck(ws, w.folder);
    expect(moved.status).toBe("pass");
    expect(moved.detail).toMatch(
      new RegExp(
        `moved credentials\\.json from ${root} to ${join(root, ws)} on \\d{4}-\\d{2}-\\d{2}`,
      ),
    );
    writeFileSync(join(root, "credentials.json"), "{}", { mode: 0o600 });
    const left = credentialStoreCheck(ws, w.folder);
    expect(left.status).toBe("warn");
    expect(left.detail).toContain(join(root, "credentials.json"));
    w.db.close();
  });
});

describe("Model lease (SUR-87, MD-N17-1)", () => {
  it("is free; a live holder warns, named; a holder that is gone is stale and passes", async () => {
    const lockPath = join(home, "model.lock");
    expect(modelLeaseCheck(lockPath).detail).toMatch(/free/);
    const holder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    kids.push(holder);
    await new Promise((r) => setTimeout(r, 200));
    const pid = holder.pid as number;
    writeFileSync(
      lockPath,
      JSON.stringify({
        pid,
        processStart: leaseProcessStart(pid),
        token: "t",
        since: "2026-10-05T08:00:00.000Z",
        workspace: "ws_alpha",
        project: "/work/alpha",
        models: [{ model: "coder-a", port: 8098 }],
      }),
    );
    const held = modelLeaseCheck(lockPath);
    expect(held.status).toBe("warn");
    expect(held.detail).toMatch(
      /project \/work\/alpha \(workspace ws_alpha\) holds coder-a on port 8098 \(pid \d+/,
    );
    holder.kill("SIGKILL");
    await new Promise((r) => holder.once("exit", r));
    const stale = modelLeaseCheck(lockPath);
    expect(stale.status).toBe("pass");
    expect(stale.detail).toMatch(/stale/);
  });
});

describe("Lost records (SUR-88, RUN-89)", () => {
  it("counts the workspace's lost records and names the file", () => {
    const ws = "ws_00000000beef";
    expect(lostRecordsCheck(ws).status).toBe("pass");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    reportLostRecord("step 3", new Error("database or disk is full"), { workspaceId: ws });
    reportLostRecord("step 4", new Error("database or disk is full"), { workspaceId: ws });
    warn.mockRestore();
    const c = lostRecordsCheck(ws);
    expect(c.status).toBe("warn");
    expect(c.detail).toMatch(/^2 records could not be written/);
    expect(c.detail).toContain(join(home, ".sekhemet", "logs", ws, "lost-records.ndjson"));
  });
});
