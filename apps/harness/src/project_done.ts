import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isAbsolute, join } from "node:path";
import {
  type DepthProfile,
  DeterministicGateRunner,
  STRENGTH_TABLE,
  type TestStrengthRecord,
  loadGatesConfig,
  runAcceptanceTests,
} from "@sekhemet/gates";
import type { RequirementRevision } from "@sekhemet/kernel";
import {
  type AppetiteAsk,
  type BriefInput,
  type MainCheck,
  type MainTestResult,
  type PlannerLedger,
  type ReleaseReport,
  type StoryMap,
  acceptBrief,
  acceptSlice,
  defaultRequirementProject,
  enforceAppetite,
  holdSuspectCards,
  latestMainCheck,
  linkStagedTests,
  proposeSliceRelease,
  recordMainCheck,
  releaseReport,
  reviseRequirement,
  sliceCards,
  sliceStatus,
  storyMap,
} from "@sekhemet/planner";
import { type ProcessSandbox, confinedSandbox } from "@sekhemet/sandbox";
import {
  type Bump,
  NodeGitSyncAdapter,
  compareVersions,
  gitEnvFor,
  keepAChangelogSection,
  nextVersion,
  planRelease,
} from "@sekhemet/sync";
import { integrationBranch } from "./accept.js";
import { latestLedgerEvidence } from "./ledger_evidence.js";
import { changeRoute, setupFor } from "./planner_live.js";
import { changeCardSummary } from "./pm/pm_copy.js";
import { PmStore } from "./pm/store.js";
import {
  applyDocumentProposal,
  exportProjectDocuments,
  renderedDocuments,
} from "./project_docs.js";
import type { Kernel } from "./wave2.js";

/**
 * Project done, computed (planner-pm §2.15, P13) — the harness side: the
 * result on `main` (the project gates and every linked acceptance test run in
 * a scratch checkout of the integration branch, each test's strength judged
 * from its card's evidence against the depth profile's rule), a slice's
 * acceptance with its release, a revision with its change cards, the
 * appetite asked through Seshat, the `sekhemet release` sub-commands and the
 * story map's REST routes. The decisions are the planner's
 * (`requirement_graph.ts`); this module runs processes and writes files.
 */

const ledgerOf = (k: Kernel): PlannerLedger => ({
  store: k.cardStore,
  log: k.log,
  ...(k.boardService ? { board: k.boardService } : {}),
});

/** The integration branch's head, or undefined when it has no commit. */
export function mainHead(repoPath: string): { branch: string; sha?: string } {
  const branch = integrationBranch(repoPath);
  try {
    const sha = execFileSync("git", ["rev-parse", "--verify", "-q", `${branch}^{commit}`], {
      cwd: repoPath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: gitEnvFor(repoPath),
    }).trim();
    return { branch, ...(sha ? { sha } : {}) };
  } catch {
    return { branch };
  }
}

/**
 * Whether a test-strength record meets the profile's rule (§2.15.5, gates
 * rule 32a): every check the profile makes blocking passed. A check that
 * could not judge leaves it unmeasured, never met. The profile is the one
 * recorded for the card's project (design-stage DS-P14-1), never assumed.
 */
export function strengthVerdict(
  record: TestStrengthRecord | undefined,
  profile: DepthProfile,
): MainTestResult["strength"] {
  if (!record) return "unmeasured";
  const rules = STRENGTH_TABLE[profile];
  let unmeasured = false;
  let unmet = false;
  if (rules.redAtAssertion === "blocking") {
    if (record.redAtAssertion.status === "not_judged") unmeasured = true;
    else if (record.redAtAssertion.status !== "red") unmet = true;
  }
  if (rules.stubKill === "blocking") {
    if (record.stubKill.status === "not_judged") unmeasured = true;
    else if (record.stubKill.status === "survived") unmet = true;
  }
  if (rules.smellLint === "blocking" && record.smells.length > 0) unmet = true;
  return unmet ? "unmet" : unmeasured ? "unmeasured" : "met";
}

/** The test-strength record in the card's latest evidence bundle, read and checked against its SHA-256. */
export async function cardStrength(
  k: Kernel,
  cardId: string,
): Promise<TestStrengthRecord | undefined> {
  const record = await latestLedgerEvidence(k.cardStore, cardId);
  if (!record) return undefined;
  try {
    const body = readFileSync(
      isAbsolute(record.path) ? record.path : join(k.repoPath, record.path),
      "utf8",
    );
    if (createHash("sha256").update(body).digest("hex") !== record.sha256) return undefined;
    return (JSON.parse(body) as { testStrength?: TestStrengthRecord }).testStrength;
  } catch {
    return undefined;
  }
}

/**
 * Run the project gates and every linked acceptance test on the integration
 * branch's head (PM-P13-4, -5) and record `requirement/main_checked`. Skipped
 * when nothing is to be proven, when the branch has no commit, or when the
 * head was checked already (unless `force`, e.g. after a new evidence bundle).
 */
export async function checkMain(
  k: Kernel,
  options: { sandbox?: ProcessSandbox; force?: boolean; restricted?: boolean } = {},
): Promise<{ check?: MainCheck; skipped?: string }> {
  const ledger = ledgerOf(k);
  const reqs = (await k.cardStore.requirements.list()).filter((r) => !r.cut);
  if (reqs.length === 0) return { skipped: "no requirement is recorded" };
  const { branch, sha } = mainHead(k.repoPath);
  if (!sha) return { skipped: `${branch} has no commit` };
  const last = await latestMainCheck(ledger);
  if (last?.sha === sha && !options.force) return { check: last, skipped: "main was checked" };

  // Test → requirement links from each traced card's staged tests (§2.15.2).
  const cardIds = new Set<string>();
  for (const r of reqs) {
    for (const l of k.cardStore.requirements.links(r.id)) if (l.from === "card") cardIds.add(l.ref);
  }
  const fileCard = new Map<string, string>();
  for (const id of [...cardIds].sort()) {
    await linkStagedTests(ledger, id);
    for (const s of k.cardStore.stagedTests.staged(id)) fileCard.set(s.path, id);
  }
  const refs = [
    ...new Set(
      reqs.flatMap((r) =>
        k.cardStore.requirements
          .links(r.id)
          .filter((l) => l.from === "test")
          .map((l) => l.ref),
      ),
    ),
  ];
  const fileOf = (ref: string) => ref.split(" > ")[0] as string;
  const files = [...new Set(refs.map(fileOf))];
  // DS-P14-1: the depth profile recorded for the project (the one reader,
  // `depthProfiles.of`); each card's strength is judged against its own
  // project's profile, and the check records the brief's project's.
  const profile = k.cardStore.depthProfiles.of(await defaultRequirementProject(ledger)).profile;
  const strengthByCard = new Map<string, MainTestResult["strength"]>();
  for (const id of new Set(fileCard.values())) {
    const card = await k.cardStore.getCard(id);
    const own = k.cardStore.depthProfiles.of(card?.projectId ?? undefined).profile;
    strengthByCard.set(id, strengthVerdict(await cardStrength(k, id), own));
  }

  const gatesConfig = loadGatesConfig(k.repoPath);
  const sandbox = options.sandbox ?? confinedSandbox(options.restricted ?? false);
  const rungs = [...new Set(gatesConfig.gates.filter((g) => g.blocking).map((g) => g.rung))];
  const testGate = gatesConfig.gates.find((g) => g.rung === "test" && g.blocking);
  const { gates, results, failures } = await new NodeGitSyncAdapter(k.repoPath).withScratchCheckout(
    sha,
    async (cwd) => {
      const gateResult = await new DeterministicGateRunner(sandbox, {
        repoRoot: k.repoPath,
        expectedConfigSha256: gatesConfig.sha256,
      }).runGates(rungs, cwd);
      const run =
        testGate && files.length > 0
          ? await runAcceptanceTests(sandbox, cwd, testGate, files)
          : { unavailable: "no blocking test check" };
      return {
        gates: gateResult,
        results: "results" in run ? run.results : [],
        failures: [
          ...gateResult.failures.map(
            (f) => `[${f.gate ?? f.rung}] ${f.errorExcerpt.split("\n")[0] ?? ""}`,
          ),
          ...("unavailable" in run && files.length > 0 ? [`tests: ${run.unavailable}`] : []),
        ],
      };
    },
  );
  const tests: Record<string, MainTestResult> = {};
  for (const ref of refs) {
    const file = fileOf(ref);
    const own = ref.includes(" > ")
      ? results.filter((r) => r.test === ref)
      : results.filter((r) => r.file === file);
    const result: MainTestResult["result"] =
      own.length === 0 ? "missing" : own.every((r) => r.kind === "passed") ? "passed" : "failed";
    const card = fileCard.get(file);
    tests[ref] = {
      result,
      strength: card ? (strengthByCard.get(card) ?? "unmeasured") : "unmeasured",
    };
  }
  await recordMainCheck(
    ledger,
    { sha, branch, gatesPassed: gates.passed, tests, profile },
    failures,
  );
  return { check: (await latestMainCheck(ledger)) as MainCheck };
}

/** The story map of a project (the default one when omitted), judged against main's head now. */
export async function projectStoryMap(
  k: Kernel,
  projectId?: string,
): Promise<StoryMap | undefined> {
  const ledger = ledgerOf(k);
  const id = projectId ?? (await defaultRequirementProject(ledger));
  if (!id || !k.cardStore.getProject(id)) return undefined;
  return storyMap(ledger, { projectId: id, mainSha: mainHead(k.repoPath).sha });
}

/**
 * A person accepts a proven slice (PM-P13-7), then its release is proposed
 * (PM-P13-13): the version and Keep a Changelog grouping from the
 * integration branch's Conventional-Commit squashes, never below a version
 * already proposed in the project, and the notes from its proven
 * requirements in the brief's words. `changelog` is the section proposed for
 * the top of CHANGELOG.md (design-stage DS-N3-8); it and the release notes
 * are committed when the release is confirmed, before the tag.
 */
export async function acceptSliceAndRelease(
  k: Kernel,
  sliceId: string,
  principal: string,
): Promise<{
  completesProject: boolean;
  release?: { version: string; notes: string; changelog: string };
  releaseRefused?: string;
  report: ReleaseReport;
}> {
  const ledger = ledgerOf(k);
  const { branch, sha } = mainHead(k.repoPath);
  const { completesProject } = await acceptSlice(ledger, sliceId, principal, sha);
  const slice = await k.cardStore.slices.get(sliceId);
  const plan = planRelease(k.repoPath, { ref: branch });
  const proposed = [];
  for (const s of await k.cardStore.slices.list(slice?.projectId)) {
    proposed.push(...(await k.cardStore.slices.releases(s.id)).map((r) => r.version));
  }
  const version = sliceReleaseVersion(plan, proposed);
  try {
    const r = await proposeSliceRelease(ledger, {
      sliceId,
      version,
      changelog: plan.categories,
      mainSha: sha,
    });
    // The kernel's `release/proposed` (payload_registry.ts) has no field for
    // the sha proven at proposal time — a `v.strictObject` refuses any extra
    // one, in the payload or the private part, so it cannot be kept there
    // without a kernel change (out of this workstream's files; reported).
    // Recorded here instead, as `release/tagged` already is: an event type
    // the registry does not know, so it is not checked there (its own
    // comment: "its writer validates it"), and this is that writer.
    // `--confirm` reads it back to tag the proven sha, never a later head
    // main may have moved to (finding 5, B4.3).
    if (sha) {
      await k.log.append({
        actor: "planner",
        type: "release/proven",
        payload: { sliceId, version: r.version, sha },
      });
    }
    return {
      completesProject,
      release: {
        version: r.version,
        notes: r.notes ?? "",
        changelog: keepAChangelogSection(
          r.version,
          new Date().toISOString().slice(0, 10),
          plan.categories,
        ),
      },
      report: r.report,
    };
  } catch (err) {
    const map = await projectStoryMap(k, slice?.projectId);
    return {
      completesProject,
      releaseRefused: err instanceof Error ? err.message : String(err),
      report: releaseReport(map as StoryMap, sliceId),
    };
  }
}

/**
 * PM-P13-9: extend is offered only when every remaining card has red tests
 * and no requirement in the slice is unplanned — the same condition the
 * queue prelude's ask computes (`enforceAppetite`). The REST route is
 * refused on the same terms, not only the offer that led to it.
 */
export async function extendRefusal(k: Kernel, sliceId: string): Promise<string | undefined> {
  const ledger = ledgerOf(k);
  const status = await sliceStatus(ledger, sliceId, mainHead(k.repoPath).sha);
  if (!status) return `No release ${sliceId}`;
  const open = (await sliceCards(ledger, sliceId)).filter((c) => c.status !== "done");
  const unred = open.filter(
    (c) =>
      c.status !== "in_progress" &&
      k.cardStore.stagedTests.staged(c.id).length === 0 &&
      !c.acceptanceTests?.length,
  );
  const unplanned = (status.slice.requirements ?? []).filter((r) => r.state === "unplanned");
  if (unplanned.length) {
    return `${unplanned.map((r) => r.id).join(", ")} ${unplanned.length === 1 ? "has" : "have"} no issue; extending is not offered`;
  }
  if (unred.length) {
    return `${unred.map((c) => c.id).join(", ")} ${unred.length === 1 ? "has" : "have"} no red test yet; extending is not offered`;
  }
  return undefined;
}

/**
 * A slice's release version, without the `v` (RG-N4-1, PM-P13-13): the one
 * the squashes give, or, when a release at or above it was already proposed
 * in the project, the next after the latest of those by the same bump, so
 * two slices never share a version. SemVer's rules come from `semver`
 * (DEC-44) through `nextVersion` and `compareVersions`: a breaking change
 * bumps minor while the version is 0.y.z, and a prerelease sorts before its
 * release.
 */
export function sliceReleaseVersion(
  plan: { nextVersion: string; bump: Bump },
  proposed: readonly string[],
): string {
  const latest = [...proposed].sort(compareVersions).at(-1);
  const planned = plan.nextVersion.replace(/^v/, "");
  if (!latest || compareVersions(planned, latest) > 0) return planned;
  return nextVersion(latest, plan.bump === "none" ? "patch" : plan.bump).replace(/^v/, "");
}

/**
 * Revise a requirement (PM-P13-11): hold its open cards, and have Seshat
 * propose one change card per suspect done card, each carrying the link it
 * resolves once accepted (PM-P13-12).
 */
export async function reviseAndPropose(
  k: Kernel,
  requirementId: string,
  revision: RequirementRevision,
  principal: string,
): Promise<Awaited<ReturnType<typeof reviseRequirement>>> {
  // PM-N9-9: an open card someone else owns is held only when its owner applies the hold.
  const setup = setupFor(k.repoPath);
  const out = await reviseRequirement(ledgerOf(k), requirementId, revision, principal, {
    route: (card) => changeRoute(card, setup, principal),
  });
  if (out.changeCards.length > 0) {
    await new PmStore(k.log).appendReply({
      replyTo: [],
      text: `${requirementId} was revised to version ${out.version}. ${out.changeCards.length === 1 ? "One done issue was" : `${out.changeCards.length} done issues were`} built against the earlier version; suggested: a change issue for each. Why: until one is accepted, or you re-confirm the link, ${requirementId} is suspect and its release not done.${out.held.length ? ` Held in Planning: ${out.held.join(", ")}.` : ""}${out.running.length ? ` Running, re-checked when it stops: ${out.running.join(", ")}.` : ""}`,
      proposals: out.changeCards.map((c) => ({
        kind: "create_card" as const,
        summary: changeCardSummary(c.cardId, c.requirementId, c.version),
        cards: [
          {
            title: c.title,
            spec: c.spec,
            traces: [{ requirementId: c.requirementId, changeFor: c.cardId }],
          },
        ],
      })),
      model: "planner",
    });
  }
  return out;
}

/**
 * The queue prelude's part (PM-P13-4, -9, -11): check main when it moved,
 * hold cards whose link went suspect, and stop the slices at their appetite
 * — each newly reached one asked through Seshat. Returns the cards not to
 * schedule and the lines to print.
 */
export async function projectDonePass(
  k: Kernel,
): Promise<{ held: Set<string>; lines: string[]; asks: AppetiteAsk[] }> {
  const lines: string[] = [];
  if ((await k.cardStore.slices.list()).length === 0) {
    return { held: new Set(), lines, asks: [] };
  }
  const ledger = ledgerOf(k);
  try {
    const r = await checkMain(k);
    if (r.check && !r.skipped) {
      lines.push(
        `Checked main at ${r.check.sha.slice(0, 7)}: checks ${r.check.gatesPassed ? "pass" : "fail"}, ${Object.values(r.check.tests).filter((t) => t.result === "passed").length} of ${Object.keys(r.check.tests).length} linked tests pass.`,
      );
    }
  } catch (err) {
    lines.push(`Main not checked: ${err instanceof Error ? err.message : String(err)}`);
  }
  // A scheduled pass: nobody asked, so an owned card's hold is its owner's to apply (PM-N9-9).
  const setup = setupFor(k.repoPath);
  const suspect = await holdSuspectCards(ledger, { route: (card) => changeRoute(card, setup) });
  for (const id of suspect) {
    lines.push(`${id} held in Planning: a requirement it traces to was revised.`);
  }
  const { held, asks } = await enforceAppetite(ledger, { mainSha: mainHead(k.repoPath).sha });
  for (const id of suspect) held.add(id);
  for (const a of asks) {
    lines.push(a.text);
    await new PmStore(k.log).appendReply({ replyTo: [], text: a.text, model: "ledger" });
  }
  return { held, lines, asks };
}

// --- `sekhemet release <sub-command>` ------------------------------------------------

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function flagValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

function printMap(map: StoryMap, print: (l: string) => void): void {
  print(
    `Project ${map.projectId}: ${map.provenLine}.${map.projectDone ? " The project is done." : ""}`,
  );
  if (map.main) {
    print(
      `Main ${map.main.sha.slice(0, 7)} (${map.main.branch}): checks ${map.main.gatesPassed ? "pass" : "fail"}${map.main.stale ? "; main moved since, run `sekhemet release check`" : ""}.`,
    );
  } else print("Main has not been checked yet: `sekhemet release check`.");
  for (const s of map.slices) {
    print(
      `${s.id}${s.title ? ` ${s.title}` : ""}: ${s.state}, ${s.provenLine}${s.appetiteReached ? ", appetite reached" : ""}.`,
    );
    for (const r of s.requirements) {
      print(
        `  ${r.id} v${r.version} ${r.mustHave ? "Must have" : "Could have"} ${r.title ?? ""}: ${r.state === "proven" ? "done" : r.state.replace(/_/g, " ")}. ${r.why}`,
      );
    }
  }
  if (map.unplanned.length)
    print(`Unplanned Must have requirements: ${map.unplanned.map((r) => r.id).join(", ")}.`);
}

/**
 * `sekhemet release` when the project has slices: `status`, `check`,
 * `brief <file.json>`, `accept <SLICE>`, `cut <REQ> [--reason …]`,
 * `extend <SLICE> [--cards N] [--hours H]`, `revise <REQ> <file.json>`,
 * `confirm <REQ> <card|test> <ref>`, `report <SLICE>`, `docs …` (the
 * project documents, DS-N3). Undefined when the
 * arguments are not one of these, so the caller keeps the commit-only path.
 */
export async function releaseSubcommand(
  k: Kernel,
  args: string[],
  print: (l: string) => void,
): Promise<number | undefined> {
  const [sub, a, b, c] = args;
  const principal = k.cardStore.localPrincipal();
  const ledger = ledgerOf(k);
  const fail = (message: string) => {
    print(message);
    return 1;
  };
  try {
    switch (sub) {
      case "status": {
        const map = await projectStoryMap(k, a);
        if (!map) return fail("No accepted brief: nothing to report.");
        printMap(map, print);
        return 0;
      }
      case "check": {
        const r = await checkMain(k, { force: true });
        if (!r.check) return fail(`Main not checked: ${r.skipped}.`);
        print(
          `Main ${r.check.sha.slice(0, 7)}: checks ${r.check.gatesPassed ? "pass" : "fail"}; ${
            Object.entries(r.check.tests)
              .map(([ref, t]) => `${ref} ${t.result}, strength ${t.strength}`)
              .join("; ") || "no linked test"
          }.`,
        );
        return 0;
      }
      case "brief": {
        if (!a) return fail("Usage: sekhemet release brief <brief.json>");
        const body = readJson(a) as unknown as Omit<BriefInput, "projectId"> & {
          projectId?: string;
        };
        const projectId =
          body.projectId ??
          (await k.cardStore.ensureProject({ rootPath: k.repoPath, name: k.repoPath })).id;
        const r = await acceptBrief(ledger, { ...body, projectId }, principal);
        print(`Accepted: ${r.sliceIds.join(", ")} with ${r.requirementIds.join(", ")}.`);
        await exportAfter(k, principal, "brief", print);
        return 0;
      }
      case "accept": {
        if (!a) return fail("Usage: sekhemet release accept <SLICE>");
        const r = await acceptSliceAndRelease(k, a, principal);
        print(`${a} accepted${r.completesProject ? "; the project is done" : ""}.`);
        if (r.release) {
          print(
            `Proposed release ${r.release.version}. Tag it with: sekhemet release --confirm ${a}`,
          );
          print(r.release.notes);
          print(r.release.changelog);
        } else print(`No release proposed: ${r.releaseRefused}`);
        print(r.report.text);
        return 0;
      }
      case "cut": {
        if (!a) return fail("Usage: sekhemet release cut <REQ> [--reason text]");
        const reason = flagValue(args, "--reason");
        await k.cardStore.slices.cut(
          { requirementId: a, ...(reason ? { reason } : {}) },
          principal,
        );
        print(`${a} cut.`);
        return 0;
      }
      case "extend": {
        if (!a) return fail("Usage: sekhemet release extend <SLICE> [--cards N] [--hours H]");
        const cards = flagValue(args, "--cards");
        const hours = flagValue(args, "--hours");
        await k.cardStore.slices.extend(
          {
            sliceId: a,
            appetite: {
              ...(cards ? { cards: Number(cards) } : {}),
              ...(hours ? { hours: Number(hours) } : {}),
            },
          },
          principal,
        );
        print(`${a} extended; its issues are scheduled again.`);
        return 0;
      }
      case "revise": {
        if (!a || !b) return fail("Usage: sekhemet release revise <REQ> <revision.json>");
        const r = await reviseAndPropose(k, a, readJson(b) as RequirementRevision, principal);
        print(
          `${a} is now version ${r.version}.${r.held.length ? ` Held in Planning: ${r.held.join(", ")}.` : ""}${r.changeCards.length ? ` Seshat proposes change issues for ${r.changeCards.map((x) => x.cardId).join(", ")}.` : ""}`,
        );
        await exportAfter(k, principal, a, print);
        return 0;
      }
      case "confirm": {
        if (!a || (b !== "card" && b !== "test") || !c) {
          return fail("Usage: sekhemet release confirm <REQ> <card|test> <ref>");
        }
        await k.cardStore.requirements.confirm(
          { requirementId: a, from: b, ref: args.slice(3).join(" ") },
          principal,
        );
        print(`${b} ${args.slice(3).join(" ")} re-confirmed against ${a}'s current version.`);
        return 0;
      }
      case "docs":
        return await docsSubcommand(k, args.slice(1), principal, print);
      case "report": {
        if (!a) return fail("Usage: sekhemet release report <SLICE>");
        const s = await sliceStatus(ledger, a, mainHead(k.repoPath).sha);
        if (!s) return fail(`No release ${a}`);
        print(releaseReport(s.map, a).text);
        return 0;
      }
      default:
        return undefined;
    }
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

/** The sha proven for a slice's release, from `release/proven` (recorded at proposal time). */
async function provenSha(k: Kernel, sliceId: string, version: string): Promise<string | undefined> {
  const events = await k.log.getEventsByTypes(["release/proven"]);
  const match = events.filter((e) => {
    const p = e.payload as { sliceId?: string; version?: string };
    return p.sliceId === sliceId && p.version === version;
  });
  return (match.at(-1)?.payload as { sha?: string } | undefined)?.sha;
}

/**
 * Whether `docsSha` is a documents commit on `provenSha` (its first parent)
 * that changed only paths the export recorded (DS-N3-8): the files it
 * changed are compared with `exported`, and every other path is named.
 */
export function documentsOnlyCommit(
  repoPath: string,
  provenSha: string,
  docsSha: string,
  exported: readonly string[],
): { ok: boolean; others: string[] } {
  const git = (...a: string[]) =>
    execFileSync("git", a, { cwd: repoPath, encoding: "utf8", env: gitEnvFor(repoPath) }).trim();
  let parent: string;
  let changed: string[];
  try {
    parent = git("rev-parse", `${docsSha}^1`);
    // Plumbing: no rename detection, so a path moved away is named too.
    changed = git("diff-tree", "-r", "--name-only", provenSha, docsSha).split("\n").filter(Boolean);
  } catch {
    return { ok: false, others: [] };
  }
  const allowed = new Set(exported);
  const others = changed.filter((p) => !allowed.has(p));
  return { ok: parent === provenSha && others.length === 0, others };
}

/**
 * `sekhemet release --confirm <SLICE>`: a person's confirmation tags the sha
 * that was proven when the release was proposed (finding 5, B4.3) — never
 * whatever main's head happens to be now, which may hold work the release
 * never covered. The release's CHANGELOG.md section and notes are committed
 * on that sha first (design-stage DS-N3-8) and the tag names that commit —
 * only when that commit changed nothing but the paths the export recorded
 * (`documentsOnlyCommit`); otherwise the tag names the proven sha and why is said.
 * Records `release/tagged { sliceId, tag, sha, proven }` — `sha` the tagged
 * commit, `proven` the sha it was proven at — with the principal (§2.15.8). Refused when main moved since and the slice was not
 * re-proven at the new head (re-running `release accept` records a fresh
 * `release/proven` there). Sekhemet never deploys.
 */
export async function confirmSliceRelease(
  k: Kernel,
  sliceId: string,
): Promise<{ tag: string; sha: string; notice?: string }> {
  const release = (await k.cardStore.slices.releases(sliceId)).at(-1);
  if (!release) throw new Error(`No release is proposed for ${sliceId}`);
  const { sha: headSha } = mainHead(k.repoPath);
  if (!headSha) throw new Error("The integration branch has no commit");
  const proven = await provenSha(k, sliceId, release.version);
  // No recorded proof (older data, from before this was tracked): fall back
  // to main's head, as before.
  const sha = proven ?? headSha;
  if (proven && proven !== headSha) {
    throw new Error(
      `Main has moved to ${headSha.slice(0, 7)} since ${release.version} was proven at ${proven.slice(0, 7)}; run \`sekhemet release accept ${sliceId}\` again to re-prove it before confirming.`,
    );
  }
  const tag = `v${release.version}`;
  const principal = k.cardStore.localPrincipal();
  // DS-N3-8: the release's CHANGELOG.md section and notes (with the other
  // project documents) are committed on the proven sha before the tag, which
  // then names that commit: its only change from the proven sha is documents.
  const docs = await exportProjectDocuments(k, {
    principal,
    card: sliceId,
    release: { sliceId, version: release.version },
    expectedHead: sha,
  });
  // The documents commit is tagged only when it changed nothing but the
  // documents the export recorded; otherwise the proven sha is (DS-N3-8).
  let tagged = sha;
  let refused: string | undefined;
  if (docs.sha) {
    const recorded =
      k.cardStore.documents
        .exports()
        .at(-1)
        ?.files.map((f) => f.path) ?? [];
    const check = documentsOnlyCommit(k.repoPath, sha, docs.sha, recorded);
    if (check.ok) tagged = docs.sha;
    else
      refused = `The documents commit ${docs.sha.slice(0, 7)} changed ${check.others.length ? check.others.join(", ") : "more than"} the exported documents, so ${tag} names the proven ${sha.slice(0, 7)} instead.`;
  }
  execFileSync("git", ["tag", "-a", tag, "-m", `Release ${tag}`, tagged], {
    cwd: k.repoPath,
    env: gitEnvFor(k.repoPath),
    stdio: "ignore",
  });
  await k.log.append({
    actor: "human",
    type: "release/tagged",
    payload: { sliceId, projectId: release.projectId, tag, sha: tagged, proven: sha },
    principal,
  });
  const notice = [refused, docs.notice].filter(Boolean).join("\n");
  return { tag, sha: tagged, ...(notice ? { notice } : {}) };
}

/**
 * After a person's act on the brief or a requirement (DS-N3-1): the project
 * documents are regenerated and committed. The act stands whatever happens
 * here; a failure is said in Seshat's thread, never swallowed.
 */
async function exportAfter(
  k: Kernel,
  principal: string,
  card: string,
  print?: (line: string) => void,
): Promise<void> {
  try {
    const r = await exportProjectDocuments(k, { principal, card });
    // RG-S5-2: a checkout on the integration branch is told how to catch up.
    if (r.notice) print?.(r.notice);
  } catch (err) {
    await new PmStore(k.log).appendReply({
      replyTo: [],
      text: `The project documents were not updated: ${err instanceof Error ? err.message : String(err)}`,
      model: "ledger",
      error: true,
    });
  }
}

/**
 * `sekhemet release docs [--no-names]` exports the project documents now;
 * `docs show` prints them as the ledger would write them; `docs proposals`
 * lists the open proposals from merged edits; `docs apply|dismiss <DOCP-n>`
 * is a person's decision on one (design-stage DS-N3-1, -2, -3).
 */
async function docsSubcommand(
  k: Kernel,
  args: string[],
  principal: string,
  print: (l: string) => void,
): Promise<number> {
  const [verb, id] = args;
  const noNames = args.includes("--no-names");
  if (verb === "show") {
    for (const d of await renderedDocuments(k, { noNames })) print(`--- ${d.path}\n${d.text}`);
    return 0;
  }
  if (verb === "proposals") {
    const open = await k.cardStore.documents.openProposals();
    if (open.length === 0) print("No open document proposals.");
    for (const p of open) {
      print(
        `${p.id} ${p.kind} ${p.target}${p.targetId ? ` ${p.targetId}` : ""}${p.field ? ` ${p.field.replace(/_/g, " ")}` : ""} in ${p.path} (${p.commit.slice(0, 7)})${p.proposed !== undefined ? `: ${p.proposed}` : ""}`,
      );
    }
    return 0;
  }
  if (verb === "apply" || verb === "dismiss") {
    if (!id) {
      print(`Usage: sekhemet release docs ${verb} <DOCP-n>`);
      return 1;
    }
    if (verb === "dismiss") {
      await k.cardStore.documents.dismissProposal(id, principal);
      print(`${id} dismissed.`);
      return 0;
    }
    const done = await applyDocumentProposal(k, id, principal, (requirementId, revision) =>
      reviseAndPropose(k, requirementId, revision, principal),
    );
    print(`${id} applied: ${done}.`);
    return 0;
  }
  if (verb !== undefined && verb !== "--no-names" && verb !== "export") {
    print(
      "Usage: sekhemet release docs [export] [--no-names] | show | proposals | apply <DOCP-n> | dismiss <DOCP-n>",
    );
    return 1;
  }
  const r = await exportProjectDocuments(k, { principal, noNames, card: "docs" });
  if (r.skipped) {
    print(`No documents exported: ${r.skipped}.`);
    return 0;
  }
  print(
    r.sha
      ? `Committed ${r.written.join(", ")} onto ${r.branch} as ${r.sha.slice(0, 10)} (ledger seq ${r.seq}).`
      : "The project documents on the integration branch are up to date.",
  );
  if (r.notice) print(r.notice);
  if (r.proposals.length)
    print(
      `Edits merged since the last export: ${r.proposals.join(", ")} (see \`sekhemet release docs proposals\`).`,
    );
  if (r.held.length)
    print(`Not overwritten while proposals on them are open: ${r.held.join(", ")}.`);
  if (r.left.length) print(`Yours, left as they are (no generated header): ${r.left.join(", ")}.`);
  if (r.offers.length) print(`Offered, never written: ${r.offers.join(", ")} (see Seshat).`);
  return 0;
}

/** The slice of the latest proposed release no `release/tagged` has followed, or undefined. */
export async function latestUntaggedRelease(k: Kernel): Promise<string | undefined> {
  const events = await k.log.getEventsByTypes(["release/proposed", "release/tagged"]);
  const tagged = new Set(
    events
      .filter((e) => e.type === "release/tagged")
      .map((e) => String((e.payload as { sliceId: string }).sliceId)),
  );
  const last = events
    .filter((e) => e.type === "release/proposed")
    .map((e) => String((e.payload as { sliceId: string }).sliceId))
    .filter((id) => !tagged.has(id))
    .at(-1);
  return last;
}

// --- REST (PM_CONTRACT §3, "Story map and releases") ------------------------------------

export interface ProjectDoneRouteContext {
  repoPath: string;
  kernel: Kernel;
  json: (res: ServerResponse, status: number, body: unknown) => void;
  isTrustedMutation: (req: IncomingMessage) => boolean;
  readJsonBody: (req: IncomingMessage) => Promise<Record<string, unknown>>;
  principalOf?: ((req: IncomingMessage) => string) | undefined;
  /** Whether the request's person can see a project (PM-N9-8); omitted, every project. */
  canSee?: ((req: IncomingMessage, projectId: string | undefined) => boolean) | undefined;
}

/**
 * `GET /api/story-map[/<project>]`, `GET /api/slices/<id>/report`, and the
 * person's acts: `POST /api/brief/accept`, `/api/slices/<id>/accept`,
 * `/api/slices/<id>/extend`, `/api/requirements/<id>/cut`, `…/revise`,
 * `…/confirm`. Every act is the dashboard's, under the request's principal.
 */
export async function handleProjectDoneRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: string,
  ctx: ProjectDoneRouteContext,
): Promise<boolean> {
  const { json, kernel: k } = ctx;
  // PM-N9-8: a project the person cannot see answers exactly as a missing one.
  const visible = (projectId: string | undefined) => ctx.canSee?.(req, projectId) ?? true;
  const map = /^\/api\/story-map(?:\/([\w.-]+))?$/.exec(url);
  if (map && req.method === "GET") {
    const m = await projectStoryMap(k, map[1]);
    const shown = m && visible(m.projectId) ? m : undefined;
    json(res, shown ? 200 : 404, shown ?? { error: "No accepted brief for that project" });
    return true;
  }
  const report = /^\/api\/slices\/([\w.-]+)\/report$/.exec(url);
  if (report && req.method === "GET") {
    const slice = await k.cardStore.slices.get(report[1] as string);
    const s =
      slice && visible(slice.projectId)
        ? await sliceStatus(ledgerOf(k), report[1] as string, mainHead(k.repoPath).sha)
        : undefined;
    if (!s) json(res, 404, { error: `No release ${report[1]}` });
    else json(res, 200, releaseReport(s.map, report[1] as string));
    return true;
  }
  const act =
    url === "/api/brief/accept"
      ? { kind: "brief" as const, id: "" }
      : (() => {
          const m =
            /^\/api\/(slices|requirements)\/([\w.-]+)\/(accept|extend|cut|revise|confirm)$/.exec(
              url,
            );
          return m ? { kind: `${m[1]}/${m[3]}` as const, id: m[2] as string } : undefined;
        })();
  if (!act || req.method !== "POST") return false;
  if (!ctx.isTrustedMutation(req)) {
    json(res, 403, { error: "A person acts from the dashboard itself" });
    return true;
  }
  const principal = ctx.principalOf?.(req) ?? k.cardStore.localPrincipal();
  try {
    const body = await ctx.readJsonBody(req);
    switch (act.kind) {
      case "brief": {
        const projectId =
          typeof body.projectId === "string"
            ? body.projectId
            : (await k.cardStore.ensureProject({ rootPath: ctx.repoPath, name: ctx.repoPath })).id;
        const accepted = await acceptBrief(
          ledgerOf(k),
          { ...(body as unknown as BriefInput), projectId },
          principal,
        );
        await exportAfter(k, principal, "brief");
        json(res, 200, accepted);
        return true;
      }
      case "slices/accept":
        json(res, 200, await acceptSliceAndRelease(k, act.id, principal));
        return true;
      case "slices/extend": {
        const refusal = await extendRefusal(k, act.id);
        if (refusal) {
          json(res, 409, { error: refusal });
          return true;
        }
        await k.cardStore.slices.extend(
          {
            sliceId: act.id,
            appetite: {
              ...(typeof body.cards === "number" ? { cards: body.cards } : {}),
              ...(typeof body.hours === "number" ? { hours: body.hours } : {}),
            },
          },
          principal,
        );
        json(res, 200, { extended: act.id });
        return true;
      }
      case "requirements/cut":
        await k.cardStore.slices.cut(
          {
            requirementId: act.id,
            ...(typeof body.reason === "string" ? { reason: body.reason } : {}),
          },
          principal,
        );
        json(res, 200, { cut: act.id });
        return true;
      case "requirements/revise": {
        const revised = await reviseAndPropose(k, act.id, body as RequirementRevision, principal);
        await exportAfter(k, principal, act.id);
        json(res, 200, revised);
        return true;
      }
      case "requirements/confirm":
        if ((body.from !== "card" && body.from !== "test") || typeof body.ref !== "string") {
          json(res, 400, { error: "confirm needs from (issue or test) and ref" });
          return true;
        }
        await k.cardStore.requirements.confirm(
          { requirementId: act.id, from: body.from, ref: body.ref },
          principal,
        );
        json(res, 200, { confirmed: { requirementId: act.id, from: body.from, ref: body.ref } });
        return true;
      default:
        return false;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // A brief naming a project that does not exist is not a conflict to
    // resolve; it is a 404, like the story map's and a slice report's.
    const status = /^No project /.test(message) ? 404 : 409;
    json(res, status, { error: message });
    return true;
  }
}
