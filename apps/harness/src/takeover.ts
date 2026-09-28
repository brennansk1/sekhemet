import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  BASELINE_EVENT,
  GATES_CONFIG_RELATIVE_PATH,
  type GateRung,
  type HalfDoneKind,
  type HistorySecretScan,
  type UnfinishedKind,
  gatesConfigFromBytes,
  loadGatesConfig,
  redactSecrets,
  scanHalfDone,
  scanHistorySecrets,
  scanUnfinished,
  verificationRungs,
} from "@sekhemet/gates";
import type { CardStore, EventLog } from "@sekhemet/kernel";
import { runConfined } from "@sekhemet/sandbox";
import { deriveGates, installGates, packageManagerOf } from "./init.js";
import { recordOnboardingBaseline } from "./onboard.js";
import {
  type IssueTracker,
  type TakeoverPlan,
  planTakeover,
  readInheritedIssues,
} from "./takeover_backlog.js";
import { type Recon, declaredSubmodules, repoFiles, runRecon } from "./takeover_recon.js";
import { agentConfigFiles, isAgentConfigApproved, isWorkspaceTrusted } from "./workspace_trust.js";

/**
 * Take over a project, B4.1's half (design-stage §2.10 steps 1–3,
 * NEW-design-stage-6 DS-TO-1 to DS-TO-8; DEC-43): trust first, recon without
 * a model, then — only once the person trusts the repository — prove what
 * works by running it, confined. Each step's result is an event, so a
 * take-over replays:
 *
 * 1. **Trust first.** Before trust only files and git objects are read. The
 *    repository's agent configuration is inert and listed (SEC-54); the whole
 *    history is scanned for secrets offline (`takeover/secrets_scanned`,
 *    SEC-55); submodules are listed with their path and URL, never cloned.
 * 2. **Recon without a model** (`takeover_recon.ts`).
 * 3. **After trust:** install with lifecycle scripts off, build, then the
 *    suite twice as the onboarding baseline (`project/baseline`), all
 *    confined with no network; an install or build that fails is a
 *    *could not build* finding with its reason, and the take-over goes on.
 *    Half-done work is found deterministically, before or after trust.
 *
 * The as-built inventory is one `takeover/inventory` event: the findings'
 * ids, kinds, paths, lines and commits structural; the recon and each
 * finding's reason and command private (repository text is untrusted,
 * security item 42).
 *
 * 4–6. **Once trusted, and given the card store** (B4.4, DS-TO-9 to
 *    DS-TO-14, `takeover_backlog.ts`): the connected tracker's open issues
 *    are read before the inventory (recon's `issues` says what was read),
 *    then the brief as found, the reconciliation of those issues, one batch
 *    of questions and the evidenced backlog are recorded. Nothing is created
 *    and no default applied until a person approves the plan
 *    (`approveTakeoverPlan`).
 */
export interface TakeoverFinding {
  id: string;
  /** The detector's lower_snake_case code. */
  kind: string;
  path?: string;
  line?: number;
  commit?: string;
  /** Free text: private on the ledger. */
  reason?: string;
  command?: string;
}

export interface TakeoverRun {
  step: "install" | "build";
  command: string;
  exitCode: number;
  ok: boolean;
}

export interface TakeoverReport {
  trusted: boolean;
  secrets: HistorySecretScan;
  recon: Recon;
  findings: TakeoverFinding[];
  /** Exactly what trusting the repository would run, each confined (§2.10 step 1). */
  wouldRun: string[];
  runs: TakeoverRun[];
  baselineSeq: number;
  /** Steps 4–6, when they ran: trusted, with the card store. */
  plan?: TakeoverPlan;
}

export interface TakeoverOptions {
  /** Where the events go: the card store's ledger (its `recordLedgerEvent`). */
  store: {
    recordLedgerEvent(params: {
      type: string;
      actor: string;
      payload: unknown;
      principal?: string;
      private?: Record<string, unknown>;
    }): Promise<{ seq: number }>;
  };
  /** The event log the baseline is appended to (the store's ledger); without it the baseline is only written to a file. */
  log?: EventLog;
  principal: string;
  /** Trusted to run repository code; default: the user directory's record. */
  trusted?: boolean;
  gitleaks?: string | false;
  osvScanner?: string | false;
  researchAllowed?: boolean;
  restricted?: boolean;
  timeoutMs?: number;
  say?: (line: string) => void;
  /**
   * The tracker whose open issues the take-over reconciles (DS-TO-13);
   * `false` reads none. Default: the repository's connected tracker
   * (`connectedTracker`), read only once the repository is trusted.
   */
  tracker?: IssueTracker | false;
}

/** The card store itself, which steps 4–6 record through. */
function cardStoreOf(store: TakeoverOptions["store"]): CardStore | undefined {
  const s = store as Partial<CardStore>;
  return typeof s.takeover?.recordBriefAsFound === "function" &&
    typeof s.reconciliation?.propose === "function"
    ? (store as CardStore)
    : undefined;
}

const HALF_DONE_KIND: Record<HalfDoneKind, string> = {
  stub: "stub",
  skip: "skipped_test",
  todo: "todo_test",
  only: "focused_test",
};
const UNFINISHED_KIND: Record<UnfinishedKind, string> = {
  no_handler: "no_handler",
  missing_import: "missing_import",
  no_migration: "no_migration",
};

/** The install and build a trusted take-over runs (§2.10 step 3), as argument lists; the gates are `baselineGates`'. */
export function asBuiltCommands(root: string): {
  install?: [string, string[]];
  build?: [string, string[]];
} {
  if (existsSync(join(root, "package.json"))) {
    let pkg: { scripts?: Record<string, string>; packageManager?: string } = {};
    try {
      pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    } catch {
      pkg = {};
    }
    const pm = packageManagerOf(root, pkg);
    // Lifecycle scripts off, from the local store: no network in the confinement.
    const install: [string, string[]] =
      pm === "npm"
        ? [
            "npm",
            [
              existsSync(join(root, "package-lock.json")) ? "ci" : "install",
              "--ignore-scripts",
              "--offline",
              "--no-audit",
              "--no-fund",
            ],
          ]
        : pm === "pnpm"
          ? ["pnpm", ["install", "--ignore-scripts", "--offline"]]
          : pm === "yarn"
            ? ["yarn", ["install", "--ignore-scripts", "--offline"]]
            : ["bun", ["install", "--ignore-scripts"]];
    const build = pkg.scripts?.build ? ([pm, ["run", "build"]] as [string, string[]]) : undefined;
    return { install, ...(build ? { build } : {}) };
  }
  if (existsSync(join(root, "Cargo.toml"))) {
    return { build: ["cargo", ["build", "--offline"]] };
  }
  if (existsSync(join(root, "go.mod"))) return { build: ["go", ["build", "./..."]] };
  return {};
}

const line = (c: [string, string[]]) => [c[0], ...c[1]].join(" ");

/** The rungs the onboarding baseline runs: these once, the test rung twice (`captureBaseline`). */
const BASELINE_STATIC: ReadonlySet<GateRung> = new Set(["parse", "typecheck", "lint"]);

/**
 * The gates the onboarding baseline will run once the repository is trusted,
 * read from the same source it loads (review M2): a `.sekhemet/gates.toml`
 * already in the repository is kept (SUR-7) and run as it is, so it is what
 * is listed, named as the repository's; otherwise the one deriver's proposal,
 * which is what gets written.
 */
export function baselineGates(
  root: string,
  restricted = false,
): {
  source: "repository" | "derived";
  gates: { id: string; rung: GateRung; command: string; twice: boolean }[];
  error?: string;
} {
  const live = join(root, GATES_CONFIG_RELATIVE_PATH);
  const source = existsSync(live) ? "repository" : "derived";
  let config: ReturnType<typeof loadGatesConfig>;
  try {
    config =
      source === "repository"
        ? loadGatesConfig(root)
        : gatesConfigFromBytes(Buffer.from(deriveGates(root).toml), live, root);
  } catch (err) {
    return { source, gates: [], error: err instanceof Error ? err.message : String(err) };
  }
  const rungs = new Set(
    verificationRungs(config.gates, restricted).filter(
      (r) => r === "test" || BASELINE_STATIC.has(r),
    ),
  );
  return {
    source,
    gates: config.gates
      .filter((g) => rungs.has(g.rung))
      .map((g) => ({
        id: g.id,
        rung: g.rung,
        command: [g.command, ...g.args].join(" "),
        twice: g.rung === "test",
      })),
  };
}

/**
 * Exactly what trusting `root` would run, confined, in the order it runs:
 * the install, the build, then the baseline's gates (§2.10 step 1; `sekhemet
 * dev trust` and the take-over show these same lines).
 */
export function trustPlanLines(root: string, restricted = false): string[] {
  const plan = asBuiltCommands(root);
  const gates = baselineGates(root, restricted);
  return [
    ...(plan.install ? [`install: ${line(plan.install)}`] : []),
    ...(plan.build ? [`build: ${line(plan.build)}`] : []),
    ...(gates.source === "repository"
      ? [
          `checks from the repository's own .sekhemet/gates.toml, kept as it ships (not derived by Sekhemet; read it before you trust it)${gates.error ? `: it could not be read (${gates.error}), so nothing of it runs` : ":"}`,
        ]
      : []),
    ...gates.gates.map((g) => `${g.twice ? `${g.rung} (twice)` : g.rung}: ${g.command}`),
  ];
}

/**
 * `value` with every string in it passed through `redactSecrets` (review B2,
 * SEC-55, SEC-22): recon, reasons and commands are repository text, and a
 * secret in them is redacted before anything is stored or returned.
 */
function redactDeep<T>(value: T): T {
  if (typeof value === "string") return redactSecrets(value) as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, redactDeep(v)]),
    ) as T;
  }
  return value;
}

/** The reason a failed command gives, in its last lines (private on the ledger). */
function failureReason(exitCode: number, stderr: string, stdout: string): string {
  const tail = `${stderr}\n${stdout}`
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-3)
    .join(" / ");
  return `exited ${exitCode}${tail ? `: ${tail.slice(0, 400)}` : ""}`;
}

/** Take over `root` (DS-TO-1 to DS-TO-8). Loads no model. */
export async function runTakeover(root: string, options: TakeoverOptions): Promise<TakeoverReport> {
  const say = options.say ?? ((l: string) => console.log(l));
  const trusted = options.trusted ?? isWorkspaceTrusted(root);
  const findings: TakeoverFinding[] = [];
  // Every finding's free text is redacted as it is made (review B2).
  const add = (f: Omit<TakeoverFinding, "id">) =>
    findings.push({
      id: `f${findings.length + 1}`,
      ...f,
      ...(f.reason ? { reason: redactSecrets(f.reason) } : {}),
      ...(f.command ? { command: redactSecrets(f.command) } : {}),
    });

  // 1. Trust first: the history scan, offline (DS-TO-3, SEC-55).
  const secrets = await scanHistorySecrets(root, {
    ...(options.gitleaks !== undefined ? { gitleaks: options.gitleaks } : {}),
    ...(options.restricted ? { restricted: true } : {}),
  });
  await options.store.recordLedgerEvent({
    type: "takeover/secrets_scanned",
    actor: "system",
    principal: options.principal,
    payload: {
      scanner: secrets.scanner,
      commits: secrets.commits,
      findings: secrets.findings,
      ...(secrets.notScanned ? { notScanned: secrets.notScanned } : {}),
    },
  });
  if (secrets.notScanned) {
    add({ kind: "history_not_scanned", reason: secrets.reason ?? secrets.notScanned });
  }
  for (const s of secrets.findings) {
    add({ kind: "secret", path: s.path, commit: s.commit, reason: `rotate it: ${s.rule}` });
  }
  // A scan that could not run is said so, never "0 to rotate" (review B1).
  say(
    secrets.notScanned
      ? `1. History not scanned for secrets (${secrets.notScanned.replace(/_/g, " ")}): ${redactSecrets(secrets.reason ?? "")}. Treat every commit as unscanned.`
      : `1. History: ${secrets.commits} commit(s) scanned for secrets with ${secrets.scanner}; ${secrets.findings.length} to rotate.${secrets.reason ? ` (${redactSecrets(secrets.reason)})` : ""}`,
  );
  // The repository's agent configuration: inert, listed (DS-TO-2, SEC-54).
  for (const path of agentConfigFiles(root)) {
    add({
      kind: "agent_config",
      path,
      reason: isAgentConfigApproved(root, path)
        ? "approved by its SHA-256"
        : "inert: never run, read only as untrusted text until a person approves it",
    });
  }
  // Submodules, listed and never cloned (DS-TO-4).
  for (const sub of declaredSubmodules(root)) {
    add({ kind: "submodule", path: sub.path, reason: `not initialised: ${sub.url}` });
  }

  // 2. Recon without a model (DS-TO-5).
  const recon = redactDeep(
    await runRecon(root, {
      ...(options.osvScanner !== undefined ? { osvScanner: options.osvScanner } : {}),
      ...(options.researchAllowed ? { researchAllowed: true } : {}),
    }),
  );
  say(
    `2. Recon: ${recon.manifests.length} manifest(s), ${recon.commits.length} recent commit(s), ${recon.branches.length} unmerged branch(es), ${recon.todos.length} TODO/FIXME; dependency age ${recon.dependencyAge}; vulnerabilities ${recon.vulnerabilities}.`,
  );

  // Half-done work, deterministically (DS-TO-8): files only, before or after trust.
  const files = repoFiles(root);
  for (const h of scanHalfDone(root, files)) {
    add({ kind: HALF_DONE_KIND[h.kind], path: h.file, line: h.line, reason: h.text });
  }
  for (const u of scanUnfinished(root, files)) {
    add({ kind: UNFINISHED_KIND[u.kind], path: u.file, line: u.line, reason: u.detail });
  }

  // 3. Prove what works by running it — only once trusted (DS-TO-1, DS-TO-6).
  const plan = asBuiltCommands(root);
  const wouldRun = trustPlanLines(root, options.restricted === true);
  const runs: TakeoverRun[] = [];
  let baselineSeq = 0;
  if (!trusted) {
    say("3. Nothing runs yet: the repository is not trusted. Trusting it would run, confined:");
    for (const w of wouldRun) say(`   ${w}`);
  } else {
    const timeoutMs = options.timeoutMs ?? 900_000;
    const cache = join(root, ".sekhemet", "cache");
    mkdirSync(cache, { recursive: true });
    for (const [step, cmd] of [
      ["install", plan.install],
      ["build", plan.build],
    ] as const) {
      if (!cmd) continue;
      const r = await runConfined(cmd[0], cmd[1], {
        root,
        timeoutMs,
        env: { npm_config_cache: join(cache, "npm") },
        ...(options.restricted ? { restricted: true } : {}),
      });
      runs.push({ step, command: line(cmd), exitCode: r.exitCode, ok: r.exitCode === 0 });
      say(`3. ${step}: ${line(cmd)} → exit ${r.exitCode}`);
      if (r.exitCode !== 0) {
        // DS-TO-7: a first-class finding, never a stall.
        add({
          kind: "could_not_build",
          command: line(cmd),
          reason: failureReason(r.exitCode, r.stderr, r.stdout),
        });
      }
    }
    // The suite twice, confined, with no network: the onboarding baseline
    // (DS-TO-6, SUR-38), on the live gates — the one deriver's proposal when
    // the repository has none (a different live file is kept, SUR-7).
    const derived = deriveGates(root);
    const dir = join(root, ".sekhemet", "onboard");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "gates.proposed.toml"), derived.toml);
    const installed = installGates(root, derived.toml, false);
    if (installed.state === "written")
      say("3. Checks: wrote .sekhemet/gates.toml from the project.");
    const log = options.log;
    const baseline = await recordOnboardingBaseline(root, dir, log, options.restricted === true);
    if (log) {
      const [latest] = (await log.getEventsByTypes([BASELINE_EVENT])).slice(-1);
      baselineSeq = latest?.seq ?? 0;
    }
    say(
      `3. Baseline: ${baseline.entries} pre-existing finding(s), ${baseline.flaky} flaky test(s), the suite run twice.`,
    );
  }

  // The connected tracker's open issues (DS-TO-13), read once trusted.
  const cardStore = cardStoreOf(options.store);
  let issues: Awaited<ReturnType<typeof readInheritedIssues>>["items"] = [];
  if (trusted && cardStore) {
    let tracker: IssueTracker | undefined;
    let why = "no tracker connected";
    if (options.tracker === undefined) {
      const { connectedTracker } = await import("./integrations.js");
      const found = await connectedTracker(root, options.log);
      tracker = found.tracker;
      why = found.reason;
    } else if (options.tracker) {
      tracker = options.tracker;
    }
    const read = await readInheritedIssues(tracker, why);
    issues = read.items;
    recon.issues = read.note;
  } else if (!trusted) {
    recon.issues = "not read: the take-over reads the tracker once the repository is trusted";
  }
  say(`2. Issues: ${recon.issues}.`);

  // The as-built inventory (DS-TO-5, DS-TO-7, DS-TO-8).
  await options.store.recordLedgerEvent({
    type: "takeover/inventory",
    actor: "system",
    principal: options.principal,
    payload: {
      baselineSeq,
      findings: findings.map((f) => ({
        id: f.id,
        kind: f.kind,
        ...(f.path ? { path: f.path } : {}),
        ...(f.line ? { line: f.line } : {}),
        ...(f.commit ? { commit: f.commit } : {}),
      })),
    },
    private: {
      recon: JSON.stringify(redactDeep({ ...recon, runs })),
      findingDetails: findings
        .filter((f) => f.reason || f.command)
        .map((f) => ({
          id: f.id,
          ...(f.reason ? { reason: f.reason } : {}),
          ...(f.command ? { command: f.command } : {}),
        })),
    },
  });
  const counts = new Map<string, number>();
  for (const f of findings) counts.set(f.kind, (counts.get(f.kind) ?? 0) + 1);
  say(
    `Inventory: ${[...counts].map(([k, n]) => `${n} ${k.replace(/_/g, " ")}`).join(", ") || "nothing found"}.`,
  );

  // 4–6. The brief as found, the issues, the questions and the backlog (B4.4).
  let planned: TakeoverPlan | undefined;
  if (trusted && cardStore) {
    const plan = await planTakeover(root, {
      store: cardStore,
      findings,
      runs,
      baselineSeq,
      docs: recon.docs,
      files,
      issues,
    });
    const labels = new Map<string, number>();
    for (const c of plan.claims) labels.set(c.label, (labels.get(c.label) ?? 0) + 1);
    say(
      `4. Brief as found: ${plan.claims.length} claim(s): ${labels.get("proven") ?? 0} proven, ${labels.get("claimed_unproven") ?? 0} claimed but unproven, ${labels.get("contradicted") ?? 0} contradicted.`,
    );
    if (plan.reconciliation) {
      say(
        `   Inherited issues: ${plan.reconciliation.issues.length} proposed as done, duplicate, stale or valid (${plan.reconciliation.id}); nothing changes on the tracker until you apply it.`,
      );
    }
    say(
      `5. Questions: ${plan.questions.length}, each with a safe default, waiting in your decisions.`,
    );
    say(
      plan.proposalId
        ? `6. Backlog proposed as ${plan.proposalId}; nothing is created until you approve it.`
        : "6. Nothing to propose.",
    );
    planned = plan;
  }
  return {
    trusted,
    secrets,
    recon,
    findings,
    wouldRun,
    runs,
    baselineSeq,
    ...(planned ? { plan: planned } : {}),
  };
}
