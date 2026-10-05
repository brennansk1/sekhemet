import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { MockInferenceAdapter } from "@sekhemet/models";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { airgapSelfTest } from "../src/airgap.js";
import { executeCard } from "../src/execute.js";
import { lostRecordsPath } from "../src/lost_records.js";
import { releaseUnreviewed } from "../src/review_flow.js";

// Runtime item 29a, NEW-runtime-19 (RUN-89, RUN-90; FINDINGS_C1 REL-03): a
// record that guards something stops it when it cannot be written, and the
// loss is in the lost-record log. The write fails for real, inside SQLite: a
// trigger aborts the one event type, as a full or failing disk would, with
// the rest of the ledger untouched (nothing in the code under test is mocked).

let home: string;
const saved = process.env.SEKHEMET_CONFIG_DIR;
const savedUser = process.env.SEKHEMET_USER_CONFIG;
const dirs: string[] = [];
beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "sek-lost-stop-")));
  dirs.push(home);
  process.env.SEKHEMET_CONFIG_DIR = join(home, ".sekhemet");
});
afterEach(() => {
  if (saved === undefined) Reflect.deleteProperty(process.env, "SEKHEMET_CONFIG_DIR");
  else process.env.SEKHEMET_CONFIG_DIR = saved;
  if (savedUser === undefined) Reflect.deleteProperty(process.env, "SEKHEMET_USER_CONFIG");
  else process.env.SEKHEMET_USER_CONFIG = savedUser;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Make every append of `type` fail inside SQLite, as a failing disk would. */
function failAppendsOf(db: DatabaseSync, type: string): void {
  db.exec(
    `CREATE TRIGGER fail_${type.replace(/\W/g, "_")} BEFORE INSERT ON events WHEN NEW.type = '${type}' BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END`,
  );
}

const lostKinds = (ws: string | undefined): string[] =>
  readFileSync(lostRecordsPath(ws), "utf8")
    .trim()
    .split("\n")
    .map((l) => (JSON.parse(l) as { kind: string }).kind);

async function repoWithLedger(gatesExtra = "") {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "sek-lost-repo-")));
  dirs.push(repo);
  mkdirSync(join(repo, "src"));
  mkdirSync(join(repo, ".sekhemet"));
  const git = (...a: string[]) => execFileSync("git", a, { cwd: repo, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@t.t");
  git("config", "user.name", "T");
  writeFileSync(join(repo, "src", "a.ts"), "");
  writeFileSync(
    join(repo, ".sekhemet", "gates.toml"),
    `[project]\nmax_files = 3\nmax_diff_lines = 200\n${gatesExtra}\n[[gate]]\nid = "unit"\nrung = "test"\nlayer = "functional"\ncommand = "node"\nargs = ["-e", "process.exit(0)"]\ntimeout_s = 30\nparser = "generic"\n`,
  );
  writeFileSync(join(repo, ".gitignore"), ".sekhemet/*\n!.sekhemet/gates.toml\n");
  git("add", "-A");
  git("commit", "-q", "-m", "seed");
  const db = new DatabaseSync(join(repo, ".sekhemet", "events.db"));
  initSchema(db);
  const log = new EventLog(db);
  const cardStore = new CardStore(db, log);
  const boardService = new BoardServiceImpl(cardStore);
  return { repo, db, log, cardStore, boardService };
}

const step = (name: string, args: Record<string, unknown>) => ({
  text: "",
  toolCalls: [{ id: name, name, arguments: args }],
  usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 },
});

describe("RUN-90: a guarding record that cannot be written stops what it guards", () => {
  it("a card whose egress allowlist warning cannot be recorded stops before its next step, with error naming the lost record", async () => {
    const r = await repoWithLedger('network_allow = ["*.example.com"]\n');
    const userConfig = join(home, "user-config.toml");
    writeFileSync(userConfig, '[network]\nmode = "open"\n');
    process.env.SEKHEMET_USER_CONFIG = userConfig;
    const card = await r.cardStore.createCard({
      id: "card_egress",
      tier: "task",
      title: "Write a",
      scopeFiles: ["src/a.ts"],
      stepBudget: 4,
      spec: "Write src/a.ts",
    });
    // Recorded once (the ledger's first event fixes the workspace id), then the type fails.
    failAppendsOf(r.db, "card/egress_warning");
    const result = await executeCard(
      {
        repoPath: r.repo,
        restrictedMode: false,
        cardStore: r.cardStore,
        boardService: r.boardService,
        log: () => {},
        headroomCheck: false,
        freeSpaceFloorBytes: 1,
      },
      card,
      new MockInferenceAdapter("scripted", [
        step("write_file", { path: "src/a.ts", content: "export const a = 1;\n" }),
        step("finish_card", {}),
      ]),
    );
    expect(result.stopReason).toBe("error");
    expect(result.passed).toBe(false);
    expect(result.turns).toHaveLength(1);
    expect(result.evidence.stopDetail).toMatchObject({ lostRecord: "card/egress_warning" });
    expect(lostKinds(r.cardStore.workspaceId())).toContain("card/egress_warning");
    r.db.close();
  }, 60_000);

  it("a card whose not-reviewed reason cannot be recorded stays in Verify, never in Review unexplained", async () => {
    const r = await repoWithLedger();
    const card = await r.cardStore.createCard({
      id: "card_nr",
      tier: "task",
      title: "x",
      scopeFiles: ["src/a.ts"],
    });
    await r.cardStore.updateCardStatus(card.id, "verify", "verified", "harness", {
      override: true,
    });
    failAppendsOf(r.db, "card/review");
    const ctx = { repoPath: r.repo, cardStore: r.cardStore, boardService: r.boardService };
    await releaseUnreviewed(ctx, card.id, new Error("the Review model could not load"));
    expect((await r.cardStore.getCard(card.id))?.status).toBe("verify");
    expect(lostKinds(r.cardStore.workspaceId())).toEqual(["review/not_reviewed"]);
    r.db.close();
  });

  it("an air-gap self-test whose record cannot be written fails, naming it", async () => {
    const r = await repoWithLedger();
    r.log.appendNow({ actor: "harness", type: "test/first", payload: {} });
    failAppendsOf(r.db, "airgap/selftest");
    const result = await airgapSelfTest(r.repo, { log: r.log });
    expect(result.ok).toBe(false);
    expect(result.checks.at(-1)).toMatchObject({
      name: "self-test recorded on the Activity log",
      ok: false,
    });
    expect(lostKinds(r.log.workspaceId())).toEqual(["airgap/selftest"]);
    r.db.close();
  }, 60_000);
});
