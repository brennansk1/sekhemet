import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { afterEach, describe, expect, it } from "vitest";
import {
  cronMatches,
  fireTrigger,
  nextRun,
  parseCron,
  recurringCommand,
  scheduleCard,
  scheduleOf,
  tickRecurring,
} from "../src/recurring.js";
import { runOvernight } from "../src/overnight.js";
import { handleWave2Route, startRecurringTicker } from "../src/wave2_server.js";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function ledger() {
  const db = new DatabaseSync(":memory:");
  initSchema(db);
  const log = new EventLog(db);
  return { log, store: new CardStore(db, log) };
}

function repo(): { root: string; commit: (rel: string) => void } {
  const root = mkdtempSync(join(tmpdir(), "sek-recur-"));
  dirs.push(root);
  const git = (...a: string[]) => execFileSync("git", a, { cwd: root, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "e@x");
  git("config", "user.name", "E");
  const commit = (rel: string) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), `${rel} ${Math.random()}\n`);
    git("add", rel);
    git("commit", "-q", "-m", rel);
  };
  commit("README.md");
  return { root, commit };
}

// Local times, so "reserved hours" read the same way the scheduler does.
const at = (d: string) => new Date(d);

describe("X16: cron expressions", () => {
  it("parses fields, ranges, steps, lists, names and macros", () => {
    expect(cronMatches("0 3 * * 1", at("2026-09-21T03:00:00"))).toBe(true); // a Monday
    expect(cronMatches("0 3 * * 1", at("2026-09-22T03:00:00"))).toBe(false);
    expect(cronMatches("*/15 9-17 * * mon-fri", at("2026-09-21T09:45:00"))).toBe(true);
    expect(cronMatches("*/15 9-17 * * mon-fri", at("2026-09-20T09:45:00"))).toBe(false);
    expect(cronMatches("@daily", at("2026-09-20T00:00:00"))).toBe(true);
    expect(cronMatches("0 0 1,15 * *", at("2026-10-15T00:00:00"))).toBe(true);
    expect(nextRun("30 2 * * *", at("2026-09-20T03:00:00"))?.toString()).toBe(
      at("2026-09-21T02:30:00").toString(),
    );
    expect(() => parseCron("61 * * * *")).toThrow(/minute/);
  });
});

describe("X16: scheduled and recurring cards", () => {
  it("a cron template clones into Ready cards that inherit its gates, one open clone at a time", async () => {
    const { root } = repo();
    const { store, log } = ledger();
    const t = await store.createCard({
      tier: "task",
      title: "Refresh the fixtures",
      spec: "Regenerate the golden files.",
      acceptanceCriteria: ["golden files match"],
      acceptanceTests: ["tests/golden.spec.ts"],
      scopeFiles: ["tests/golden"],
      labels: ["chore"],
    });
    await scheduleCard(store, t.id, { cron: "0 3 * * 1" }, { now: at("2026-09-19T12:00:00") });
    const template = await store.getCard(t.id);
    expect(template?.status).toBe("backlog");
    expect(scheduleOf(template as never)).toMatchObject({ cron: "0 3 * * 1", urgent: false });

    const quiet = await tickRecurring(root, store, log, { now: at("2026-09-20T12:00:00") });
    expect(quiet.fired).toEqual([]);
    const r = await tickRecurring(root, store, log, { now: at("2026-09-21T03:05:00") });
    expect(r.fired).toHaveLength(1);
    const clone = await store.getCard(r.fired[0]?.cloneId as string);
    expect(clone).toMatchObject({
      status: "ready",
      spec: "Regenerate the golden files.",
      acceptanceCriteria: ["golden files match"],
      acceptanceTests: ["tests/golden.spec.ts"],
      scopeFiles: ["tests/golden"],
    });
    expect(clone?.labels).toEqual(["chore", `recurring:${t.id}`]);
    // The next Monday, while the first clone is still open: skipped.
    const busy = await tickRecurring(root, store, log, { now: at("2026-09-28T03:05:00") });
    expect(busy.fired).toEqual([]);
    expect(busy.skipped[0]?.why).toMatch(/still open/);
    await store.updateCardStatus(clone?.id as string, "done");
    const again = await tickRecurring(root, store, log, { now: at("2026-09-28T03:06:00") });
    expect(again.fired).toHaveLength(1);
  });

  it("wake-ups wait for free hours unless the card is urgent", async () => {
    const { root } = repo();
    const { store, log } = ledger();
    const calm = await store.createCard({ tier: "task", title: "calm" });
    const hot = await store.createCard({ tier: "task", title: "hot" });
    const now = { now: at("2026-09-21T10:00:00") };
    await scheduleCard(store, calm.id, { cron: "*/5 * * * *" }, { now: at("2026-09-21T09:00:00") });
    await scheduleCard(
      store,
      hot.id,
      { cron: "*/5 * * * *", urgent: true },
      { now: at("2026-09-21T09:00:00") },
    );
    const r = await tickRecurring(root, store, log, { ...now, hours: "08:00-18:00" });
    expect(r.fired.map((f) => f.template)).toEqual([hot.id]);
    expect(r.deferred.map((d) => d.template)).toEqual([calm.id]);
    const evening = await tickRecurring(root, store, log, {
      now: at("2026-09-21T19:00:00"),
      hours: "08:00-18:00",
    });
    expect(evening.fired.map((f) => f.template)).toEqual([calm.id]);
  });

  it("file-change, dependency-release and webhook triggers", async () => {
    const { root, commit } = repo();
    const { store, log } = ledger();
    const onFile = await store.createCard({ tier: "task", title: "re-index the schema" });
    const onRelease = await store.createCard({ tier: "task", title: "try the new vitest" });
    const onHook = await store.createCard({ tier: "task", title: "rebuild the docs" });
    const t0 = { now: at("2026-09-21T20:00:00") };
    await scheduleCard(store, onFile.id, { trigger: "file:src/db/**" }, t0);
    await scheduleCard(store, onRelease.id, { trigger: "release:npm:vitest" }, t0);
    await scheduleCard(store, onHook.id, { trigger: "webhook:docs-changed" }, t0);
    let version = "3.2.7";
    const opts = { now: at("2026-09-21T20:01:00"), latestVersion: async () => version };
    // The first tick records baselines and fires nothing.
    expect((await tickRecurring(root, store, log, opts)).fired).toEqual([]);
    commit("docs/readme.md");
    expect((await tickRecurring(root, store, log, opts)).fired).toEqual([]);
    commit("src/db/schema.ts");
    version = "3.3.0";
    await fireTrigger(log, "docs-changed", { by: "test" });
    const r = await tickRecurring(root, store, log, { ...opts, now: at("2026-09-21T20:02:00") });
    expect(r.fired.map((f) => `${f.template}:${f.reason}`).sort()).toEqual(
      [
        `${onFile.id}:file change: src/db/schema.ts`,
        `${onRelease.id}:release npm:vitest 3.3.0`,
        `${onHook.id}:webhook docs-changed`,
      ].sort(),
    );
    // Consumed: nothing fires twice.
    for (const f of r.fired) await store.updateCardStatus(f.cloneId, "done");
    const after = await tickRecurring(root, store, log, {
      ...opts,
      now: at("2026-09-21T20:03:00"),
    });
    expect(after.fired).toEqual([]);
  });
});

describe("X16: production paths", () => {
  it("the CLI adds and lists templates; overnight clones due ones before counting Ready cards", async () => {
    const { root } = repo();
    const { store, log } = ledger();
    const t = await store.createCard({ tier: "task", title: "nightly sweep" });
    const lines: string[] = [];
    const print = (l: string) => lines.push(l);
    expect(
      await recurringCommand(root, ["add", t.id, "--on", "webhook:nightly"], { store, log, print }),
    ).toBe(0);
    await recurringCommand(root, ["list"], { store, log, print });
    expect(lines.at(-1)).toContain("on webhook:nightly");
    await recurringCommand(root, ["trigger", "nightly"], { store, log, print });
    const rounds: string[][] = [];
    const summary = await runOvernight({
      repoPath: root,
      log,
      cardStore: store,
      hours: "none",
      limits: { kwhPerDay: 0, maxConsecutiveFailures: 3 },
      queueArgs: [],
      maxRounds: 1,
      say: () => undefined,
      runQueue: async (args) => {
        rounds.push(args);
        return 0;
      },
    });
    expect(summary.rounds).toBe(1);
    const clones = (await store.listCards()).filter((c) =>
      (c.labels ?? []).includes(`recurring:${t.id}`),
    );
    expect(clones).toHaveLength(1);
  });

  it("the dashboard server ticks templates and accepts token-authorised triggers", async () => {
    const { root } = repo();
    const { store, log } = ledger();
    const t = await store.createCard({ tier: "task", title: "docs rebuild" });
    await scheduleCard(store, t.id, { trigger: "webhook:docs" });
    process.env.SEKHEMET_TRIGGER_TOKEN = "s3cret";
    const json = (res: { statusCode?: number; body?: unknown }, status: number, body: unknown) => {
      res.statusCode = status;
      res.body = body;
    };
    const res: { statusCode?: number; body?: unknown } = {};
    const handled = await handleWave2Route(
      { method: "POST", headers: { authorization: "Bearer s3cret" } } as never,
      res as never,
      "/api/recurring/trigger/docs",
      {
        repoPath: root,
        cardStore: store,
        log,
        json: json as never,
        isTrustedMutation: () => false,
        readJsonBody: async () => ({}),
      },
    );
    Reflect.deleteProperty(process.env, "SEKHEMET_TRIGGER_TOKEN");
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(202);
    const stop = startRecurringTicker(root, store, log, { everyMs: 20 });
    for (let i = 0; i < 50; i++) {
      if ((await store.listCards()).some((c) => (c.labels ?? []).includes(`recurring:${t.id}`)))
        break;
      await new Promise((r) => setTimeout(r, 20));
    }
    stop();
    expect(
      (await store.listCards()).filter((c) => (c.labels ?? []).includes(`recurring:${t.id}`)),
    ).toHaveLength(1);
  });
});
