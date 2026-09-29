/**
 * B3 — a person safely accepts, undoes and sends back issues on a real
 * repository, and the ledger survives a crash and an upgrade.
 *
 * 1. Accept, undo, send back: three issues are built on a real git
 *    repository by the product's Worker loop against the stand-in model
 *    (no model loads), then a person works them from the terminal with this
 *    build's CLI — `review`, `accept`, `revert`, `send-back` — and the runner
 *    checks the integration branch, the person's untouched checkout, the
 *    trailers, the board and the ledger (`sekhemet log`).
 * 2. Crash: `--trials` (5) real SIGKILLs of a process writing to the WAL
 *    ledger, each checked on restart by `sekhemet log` (chain and projections).
 * 3. Upgrade: an older commit (`--old-commit`, default 5937e83, the
 *    baseline's) is extracted with `git archive`, installed offline and
 *    built; its CLI makes a ledger; this build opens it, and the runner
 *    checks the backup, the schema version, every old row's type and hash,
 *    every payload, the projections and a write afterwards.
 *
 * Flags: --only accept|crash|upgrade, --trials N, --old-commit <sha>,
 * --old-build <dir> (a built checkout of that commit, reused), --keep.
 */
import { execFileSync, execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ORIGINAL_ENV, ROOT, built, check, isolatedEnv, runCli, useIsolatedEnv } from "./core.mjs";
import {
  chainRows,
  compareChains,
  crashTrial,
  readLogVerdict,
  unreadablePayloads,
} from "./ledger.mjs";
import { buildCards, makeRepo, startFakeModel } from "./stand_in.mjs";

const flag = (flags, name, fallback) => {
  const i = flags.indexOf(name);
  return i >= 0 ? flags[i + 1] : fallback;
};

const statuses = (repo) => {
  const db = new DatabaseSync(join(repo, ".sekhemet", "events.db"), { readOnly: true });
  try {
    return Object.fromEntries(
      db
        .prepare("SELECT id, status FROM cards")
        .all()
        .map((r) => [r.id, r.status]),
    );
  } finally {
    db.close();
  }
};

// Each issue's module is an entry point by position (src/<name>/index.ts), so
// the reachability gate counts its export as a public surface (GT-T2-1).

/** Every byte of the person's checkout that Accept must not touch (review-git RG-S5-1). */
function checkout(repo) {
  const out = {
    HEAD: readFileSync(join(repo, ".git", "HEAD"), "utf8"),
    index: readFileSync(join(repo, ".git", "index")).toString("base64"),
  };
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (name === ".git" || name === ".sekhemet") continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else out[relative(repo, p)] = readFileSync(p).toString("base64");
    }
  };
  walk(repo);
  return JSON.stringify(out);
}

const CARDS = {
  card_b3_greet: {
    title: "Greet a person by name",
    path: "src/greet/index.ts",
    content: "export const greet = (name: string): string => `Hello, ${name}`;\n",
  },
  card_b3_farewell: {
    title: "Say goodbye to a person",
    path: "src/farewell/index.ts",
    content: "export const farewell = (name: string): string => `Goodbye, ${name}`;\n",
  },
  card_b3_count: {
    title: "Count the people greeted",
    path: "src/count/index.ts",
    content: "export const count = (names: string[]): number => names.length;\n",
  },
};

async function acceptUndoSendBack(base) {
  const checks = [];
  const env = isolatedEnv(join(base, "accept"));
  useIsolatedEnv(env);
  const repo = join(base, "accept", "repo");
  mkdirSync(repo, { recursive: true });
  makeRepo(repo);
  const git = (...a) =>
    execFileSync("git", a, {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const plan = Object.fromEntries(
    Object.entries(CARDS).map(([id, c]) => [id, { ...c, usage: [900, 120] }]),
  );
  const fake = await startFakeModel(plan);
  try {
    const cards = Object.entries(CARDS).map(([id, c]) => ({
      id,
      title: c.title,
      scopeFiles: [c.path],
    }));
    const builtCards = await buildCards({ repo, modelUrl: fake.url, cards });
    checks.push(
      check(
        "three issues built on a real repository and waiting in Review",
        builtCards.every((b) => b.passed && b.status === "review"),
        builtCards.map((b) => `${b.id} ${b.status}`).join(", "),
      ),
    );

    // Accept: squashed onto main with plumbing; the person's checkout untouched.
    const before = checkout(repo);
    const mainBefore = git("rev-parse", "main");
    const shown = runCli(["review", "card_b3_greet", "--repo", repo], { env });
    const accept = runCli(["accept", "card_b3_greet", "--repo", repo], { env });
    const mainAfter = git("rev-parse", "main");
    const message = git("log", "-1", "--format=%B", "main");
    const greet = (() => {
      try {
        return git("show", "main:src/greet/index.ts");
      } catch {
        return undefined;
      }
    })();
    checks.push(
      check(
        "accept: squashed onto main with its trailers, the issue Done",
        shown.code === 0 &&
          accept.code === 0 &&
          mainAfter !== mainBefore &&
          greet === CARDS.card_b3_greet.content.trimEnd() &&
          /^Card: card_b3_greet$/m.test(message) &&
          /^Ledger-Head: \d+:[0-9a-f]{64}$/m.test(message) &&
          statuses(repo).card_b3_greet === "done",
        accept.code === 0
          ? `main ${mainBefore.slice(0, 8)} -> ${mainAfter.slice(0, 8)}; ${accept.stdout
              .split("\n")
              .find((l) => l.startsWith("Accepted"))
              ?.trim()}`
          : `exit ${accept.code}: ${accept.stderr.trim() || accept.stdout.trim()}`,
      ),
    );
    checks.push(
      check(
        "accept: the person's checkout (files, HEAD, index) untouched",
        checkout(repo) === before,
        checkout(repo) === before ? "byte for byte" : "the checkout changed",
      ),
    );

    // Undo: the accept reverted on main, the issue back in Ready.
    const revert = runCli(
      ["revert", "card_b3_greet", "the greeting must name the product", "--repo", repo],
      { env },
    );
    const gone = (() => {
      try {
        git("cat-file", "-e", "main:src/greet/index.ts");
        return false;
      } catch {
        return true;
      }
    })();
    const revertMessage = git("log", "-1", "--format=%B", "main");
    checks.push(
      check(
        "undo: the accept reverted on main, the issue back in Ready",
        revert.code === 0 &&
          gone &&
          /^Card: card_b3_greet$/m.test(revertMessage) &&
          /^Reverted-by: /m.test(revertMessage) &&
          statuses(repo).card_b3_greet === "ready",
        revert.code === 0
          ? revert.stdout.trim().split("\n").at(-1)
          : `exit ${revert.code}: ${revert.stderr.trim() || revert.stdout.trim()}`,
      ),
    );

    // Send back: the reason is what the next attempt is told.
    const reason = "export it by name, as greet is";
    runCli(["review", "card_b3_farewell", "--repo", repo], { env });
    const back = runCli(["send-back", "card_b3_farewell", reason, "--repo", repo], { env });
    const afterBack = statuses(repo).card_b3_farewell;
    const seen = fake.requests.length;
    const again = await buildCards({
      repo,
      modelUrl: fake.url,
      cards: [{ id: "card_b3_farewell", title: CARDS.card_b3_farewell.title }],
    });
    const told = fake.requests.slice(seen).some((r) => r.text.includes(reason));
    checks.push(
      check(
        "send back: the issue back in Ready, and its next attempt told why",
        back.code === 0 && afterBack === "ready" && told && again[0]?.status === "review",
        `after send-back: ${afterBack}; next attempt ${told ? "was told the reason" : "was not told the reason"} and ended in ${again[0]?.status}`,
      ),
    );

    // A second accept stands; the ledger verifies with its Ledger-Head anchor.
    runCli(["review", "card_b3_count", "--repo", repo], { env });
    const second = runCli(["accept", "card_b3_count", "--repo", repo], { env });
    const log = readLogVerdict(runCli(["log", "--repo", repo], { env }));
    checks.push(
      check(
        "the ledger: chain valid, projections identical, Ledger-Head anchor matches",
        second.code === 0 &&
          log.exit === 0 &&
          log.chainValid &&
          log.projectionsIdentical &&
          log.anchor === "matches",
        `second accept exit ${second.code}; log exit ${log.exit}, chain ${log.chainValid ? "valid" : "INVALID"}, projections ${log.projectionsIdentical ? "identical" : "drifted"}, anchor ${log.anchor}`,
      ),
    );
    return {
      checks,
      details: { repo, statuses: statuses(repo), modelRequests: fake.requests.length },
    };
  } finally {
    await fake.close();
  }
}

async function crashes(base, trials) {
  const results = [];
  for (let i = 0; i < trials; i++) {
    const dir = join(base, `crash-${i}`);
    const repo = join(dir, "repo");
    mkdirSync(repo, { recursive: true });
    const killAfterEvents = 20 + Math.floor(Math.random() * 180);
    results.push({
      killAfterEvents,
      ...(await crashTrial({ repo, killAfterEvents, env: isolatedEnv(dir) })),
    });
  }
  const ok = results.every(
    (r) => r.killedBy === "SIGKILL" && r.chainValid && r.projectionsIdentical && r.appendedAfter,
  );
  return {
    checks: [
      check(
        "crash: kill -9 mid-write on a WAL ledger, then the chain verifies on restart",
        ok,
        `${results.filter((r) => r.chainValid && r.projectionsIdentical).length}/${trials} kills recovered (killed after ${results.map((r) => r.writtenBeforeKill).join(", ")} events; WAL present at ${results.filter((r) => r.walAtKill).length} of them); a write lands after each restart: ${results.filter((r) => r.appendedAfter).length}/${trials}`,
      ),
    ],
    details: { crashes: results },
  };
}

/** An older commit, extracted, installed offline and built — or one given. */
function olderBuild(base, commit, given) {
  if (given) return given;
  const dir = join(base, `old-${commit}`);
  mkdirSync(dir, { recursive: true });
  // The person's own environment: pnpm's store is under their HOME.
  const env = ORIGINAL_ENV;
  execSync(`git archive ${commit} | tar -x -C "${dir}"`, { cwd: ROOT, stdio: "ignore", env });
  execFileSync("pnpm", ["install", "--offline", "--frozen-lockfile"], {
    cwd: dir,
    env,
    stdio: "ignore",
    timeout: 10 * 60_000,
  });
  execFileSync(join(dir, "node_modules", ".bin", "tsc"), ["-b"], {
    cwd: dir,
    env,
    stdio: "ignore",
    timeout: 20 * 60_000,
  });
  return dir;
}

async function upgrade(base, commit, given) {
  const checks = [];
  let old;
  try {
    old = olderBuild(base, commit, given);
  } catch (err) {
    return {
      checks: [
        check(
          "upgrade: an older build's ledger opened by this build",
          null,
          `could not build ${commit} offline: ${err instanceof Error ? err.message.split("\n")[0] : err}`,
        ),
      ],
      details: {},
    };
  }
  const oldCli = join(old, "apps", "harness", "dist", "index.js");
  const env = isolatedEnv(join(base, "upgrade"));
  const repo = join(base, "upgrade", "repo");
  mkdirSync(repo, { recursive: true });
  makeRepo(repo);
  // The older build makes the ledger: its own seed script and CLI.
  execFileSync(
    process.execPath,
    [join(old, "scripts", "seed_project.mjs"), join(old, "fixtures", "onyx"), repo],
    { env, cwd: repo, stdio: "ignore" },
  );
  // An issue built, reviewed and accepted by the older build: its Worker
  // loop against the stand-in, then its own CLI.
  useIsolatedEnv(env);
  const fake = await startFakeModel({
    card_up_hello: {
      path: "src/hello/index.ts",
      content: "export const hello = (): string => 'hello';\n",
      usage: [800, 100],
    },
  });
  let oldBuilt;
  try {
    oldBuilt = await buildCards({
      repo,
      modelUrl: fake.url,
      root: old,
      cards: [{ id: "card_up_hello", title: "Say hello", scopeFiles: ["src/hello/index.ts"] }],
    });
  } catch (err) {
    oldBuilt = [{ id: "card_up_hello", error: err instanceof Error ? err.message : String(err) }];
  } finally {
    await fake.close();
  }
  const oldSteps = [
    ["park", "card_onyx_4_vault", "waiting on the vault design"],
    ["park", "card_onyx_7_cli", "after the scanner"],
    ["unpark", "card_onyx_4_vault"],
    ["review", "card_up_hello"],
    ["accept", "card_up_hello"],
    ["log"],
  ].map((a) => ({ args: a.join(" "), ...runCli([...a, "--repo", repo], { env, cli: oldCli }) }));
  const db = join(repo, ".sekhemet", "events.db");
  const before = chainRows(db);
  const versionOf = () => {
    const d = new DatabaseSync(db, { readOnly: true });
    try {
      return d.prepare("PRAGMA user_version").get().user_version;
    } finally {
      d.close();
    }
  };
  const oldVersion = versionOf();
  checks.push(
    check(
      `upgrade: ${commit}'s build made a ledger with its own CLI`,
      before.length > 0 && oldBuilt[0]?.status === "review" && oldSteps.every((s) => s.code === 0),
      `${before.length} events of ${new Set(before.map((r) => r.type)).size} types at schema version ${oldVersion}: 8 issues seeded, card_up_hello built by its Worker loop (${oldBuilt[0]?.status ?? oldBuilt[0]?.error}); ${oldSteps.map((s) => `${s.args} → ${s.code}`).join(", ")}`,
    ),
  );

  // This build opens it: migrated after a backup, the chain checked.
  const opened = readLogVerdict(runCli(["log", "--repo", repo], { env }));
  const { SCHEMA_VERSION } = await built("packages/kernel/dist/index.js");
  const after = chainRows(db);
  const cmp = compareChains(before, after);
  const backups = existsSync(join(repo, ".sekhemet", "backups"))
    ? readdirSync(join(repo, ".sekhemet", "backups")).filter((f) =>
        f.startsWith(`pre-migration-v${oldVersion}-to-v${SCHEMA_VERSION}-`),
      )
    : [];
  const bad = unreadablePayloads(db);
  const newVersion = versionOf();
  checks.push(
    check(
      "upgrade: migrated by this build after a backup, to its schema version",
      opened.exit === 0 && newVersion === SCHEMA_VERSION && backups.length === 1,
      `schema ${oldVersion} -> ${newVersion} (this build's ${SCHEMA_VERSION}); backup ${backups[0] ?? "missing"}`,
    ),
  );
  checks.push(
    check(
      "upgrade: the hash chain intact and every event readable",
      cmp.intact &&
        opened.chainValid &&
        opened.projectionsIdentical &&
        bad.length === 0 &&
        statuses(repo).card_up_hello === "done",
      `${cmp.kept}/${before.length} old events kept with their type and hash${cmp.added ? `, ${cmp.added} added on opening` : ""}; chain ${opened.chainValid ? "valid" : "INVALID"}; projections rebuilt ${opened.projectionsIdentical ? "identical" : "DRIFTED"}; ${bad.length} unreadable payloads; the older build's accepted issue reads ${statuses(repo).card_up_hello}${cmp.problems.length ? `; ${cmp.problems.slice(0, 3).join("; ")}` : ""}`,
    ),
  );
  const write = runCli(["park", "card_onyx_8_e2e", "after the upgrade", "--repo", repo], { env });
  const again = readLogVerdict(runCli(["log", "--repo", repo], { env }));
  checks.push(
    check(
      "upgrade: this build writes to the upgraded ledger and it verifies",
      write.code === 0 && again.exit === 0 && again.chainValid && again.projectionsIdentical,
      `park exit ${write.code}; log exit ${again.exit}`,
    ),
  );
  return {
    checks,
    details: {
      oldCommit: commit,
      oldBuild: given ? old : "extracted with git archive, pnpm install --offline, tsc -b",
      eventsBefore: before.length,
      eventsAfter: after.length,
      typesBefore: [...new Set(before.map((r) => r.type))].sort(),
    },
  };
}

export async function run(flags = []) {
  const only = flag(flags, "--only");
  const trials = Number(flag(flags, "--trials", "5"));
  const commit = flag(flags, "--old-commit", "5937e83");
  const oldBuild = flag(flags, "--old-build");
  const base = mkdtempSync(join(tmpdir(), "milestone-b3-"));
  const checks = [];
  const details = {};
  try {
    for (const [part, fn] of [
      ["accept", () => acceptUndoSendBack(base)],
      ["crash", () => crashes(base, trials)],
      ["upgrade", () => upgrade(base, commit, oldBuild)],
    ]) {
      if (only && only !== part) continue;
      const r = await fn();
      checks.push(...r.checks);
      details[part] = r.details;
    }
  } finally {
    if (!flags.includes("--keep")) rmSync(base, { recursive: true, force: true });
    else details.kept = base;
  }
  return { checks, details };
}
