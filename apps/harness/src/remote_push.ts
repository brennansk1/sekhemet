import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import type { CardStore, EventRecord } from "@sekhemet/kernel";
import { mergeNetworkConfigs, policyRefusal } from "@sekhemet/sandbox";
import { effectiveConfig, networkConfigs } from "./config_apply.js";
import { egressRecorder, networkHint, remoteDestination } from "./github_transport.js";

/**
 * Push to remote after Accept and on release (review-git §2.6 item 8,
 * NEW-review-git-7; DEC-53 c6; FINDINGS_C1 PRC-08). An opt-in project
 * setting (`push_to_remote`, recorded as `project/settings_changed`), off by
 * default. When it is on, an Accept that merged into the integration branch
 * here pushes that branch to the project's remote (`[review] remote`), and a
 * tagged release pushes its tag. Under pull-request-on-accept the branch is
 * not pushed: Accept already pushed the card branch, and the merge happens on
 * the host.
 *
 * The push is plain git with whatever credentials the server's account
 * already has for that remote — Sekhemet stores none, and never records the
 * remote's URL, only its name. Its host is decided by the one network policy
 * before it runs and recorded as `harness/egress`; a host the policy refuses
 * is not pushed, and the reason names the setting. It never forces, and it
 * never pulls or merges. A push the remote refuses changes nothing here: the
 * accept and the tag stand, the refusal is recorded, and the next Accept or
 * tag pushes the refused refs again. Every push, made or refused, is
 * `remote/pushed {project, ref, sha, remote, result}`, its reason private.
 */

/** The setting's name, as a person reads it on Configuration and in a refusal. */
export const PUSH_SETTING = "Push to remote after Accept and on release";

export type PushResultKind = "pushed" | "refused" | "not_allowed";
/** Why a push failed, as a code the issue's Activity can word (the reason itself is private). */
export type PushRefusalCode = "behind" | "exists" | "policy" | "no_remote" | "other";

export interface PushResult {
  ref: string;
  sha: string;
  remote: string;
  result: PushResultKind;
  code?: PushRefusalCode;
  reason?: string;
}

/** What a push needs of the harness: the project's repository and its ledger. */
export interface PushContext {
  repoPath: string;
  cardStore: CardStore;
}

const PUSHED = "remote/pushed";

/** Whether the project's push setting is on: the last `project/settings_changed` that set it. */
export async function pushSettingOn(cardStore: CardStore, project: string): Promise<boolean> {
  let on = false;
  for (const e of await cardStore.eventsOfType(["project/settings_changed"])) {
    const p = e.payload as { project?: string; push_to_remote?: unknown };
    if (p.project === project && typeof p.push_to_remote === "boolean") on = p.push_to_remote;
  }
  return on;
}

/** The project's pushes, oldest first. */
async function pushes(cardStore: CardStore, project: string): Promise<EventRecord[]> {
  return (await cardStore.eventsOfType([PUSHED])).filter(
    (e) => (e.payload as { project?: string }).project === project,
  );
}

/**
 * Each ref's latest push, failed ones only (RG-N7-3): what Status and the
 * issue say failed and why, until a later push of that ref succeeds. A
 * branch pushed since its failure is not failed, whatever sha it holds now.
 */
export async function failedPushes(
  cardStore: CardStore,
  project: string,
): Promise<(PushResult & { at: string; cardId?: string })[]> {
  const latest = new Map<string, EventRecord>();
  for (const e of await pushes(cardStore, project)) {
    latest.set(String((e.payload as { ref?: string }).ref), e);
  }
  return [...latest.values()]
    .filter((e) => (e.payload as { result?: string }).result !== "pushed")
    .map((e) => {
      const p = e.payload as Omit<PushResult, "reason">;
      const reason = (e.private as { reason?: unknown } | undefined)?.reason;
      return {
        ref: p.ref,
        sha: p.sha,
        remote: p.remote,
        result: p.result,
        ...(p.code ? { code: p.code } : {}),
        ...(typeof reason === "string" ? { reason } : {}),
        at: e.createdAt,
        ...(e.cardId ? { cardId: e.cardId } : {}),
      };
    });
}

/** Text the ledger may hold: a URL's user and password removed, one short paragraph. */
export function withoutCredentials(text: string): string {
  return text
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^@/\s]*@/gi, "$1")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 400);
}

/**
 * Why git refused the push, in words a person reads: the porcelain status's
 * rejection (`[rejected] (fetch first)`) explained, then the remote's own
 * `remote:` and `error:` lines, credentials removed.
 */
function refusalOf(err: unknown): { code: PushRefusalCode; reason: string } {
  const out = `${String((err as { stdout?: unknown }).stdout ?? "")}\n${String((err as { stderr?: unknown }).stderr ?? "")}`;
  const lines = out.split("\n").map((l) => l.trim());
  const why: string[] = [];
  let code: PushRefusalCode = "other";
  for (const l of lines) {
    const m = /^!\s+\S+\s+\[(?:remote )?rejected\]\s*\(([^)]*)\)/.exec(l);
    if (!m) continue;
    const said = m[1] ?? "";
    if (/fetch first|non-fast-forward/.test(said)) code = "behind";
    else if (/already exists/.test(said)) code = "exists";
    why.push(
      code === "behind"
        ? `rejected (${said}): the remote holds commits this branch does not have`
        : code === "exists"
          ? `rejected (${said}): the remote already has a different tag of that name`
          : `rejected (${said})`,
    );
  }
  why.push(
    ...lines.filter((l) => /^remote: \S/.test(l) || /^(?:fatal|error): (?!failed to push)/.test(l)),
  );
  const text = why.length
    ? why.join(" ")
    : err instanceof Error
      ? (err.message.split("\n")[0] ?? "")
      : String(err);
  return { code, reason: withoutCredentials(text || "the remote refused the push") };
}

const run = promisify(execFile);

/**
 * Push `ref` (a `refs/heads/…` or `refs/tags/…` name) at `sha`, with every
 * ref whose last push failed, when the project's setting is on. Undefined
 * when it is off: nothing is pushed and nothing recorded (RG-N7-1). A branch
 * is not pushed under pull-request-on-accept (RG-N7-2). Never throws for a
 * refusal: each result is recorded and returned.
 */
export async function pushToRemote(
  ctx: PushContext,
  input: {
    project: string;
    ref: string;
    sha: string;
    /** The person whose Accept or tag caused it. */
    principal?: string;
    /** The accepted issue, so its Activity shows the push. */
    cardId?: string;
  },
): Promise<PushResult[] | undefined> {
  if (!(await pushSettingOn(ctx.cardStore, input.project))) return undefined;
  if (input.ref.startsWith("refs/heads/")) {
    const { readSettings } = await import("./integrations.js");
    if (readSettings(ctx.repoPath).githubPrOnAccept) return [];
  }
  const remote = effectiveConfig(ctx.repoPath).config.review.remote || "origin";
  // The refs a refusal left behind are pushed again (RG-N7-3); a branch only once.
  const refs = new Map<string, { sha: string; cardId?: string }>([
    [input.ref, { sha: input.sha, ...(input.cardId ? { cardId: input.cardId } : {}) }],
  ]);
  for (const f of await failedPushes(ctx.cardStore, input.project)) {
    if (f.remote === remote && !refs.has(f.ref)) refs.set(f.ref, { sha: f.sha });
  }
  const record = async (r: PushResult, cardId: string | undefined) => {
    const event = {
      actor: "harness",
      type: PUSHED,
      payload: {
        project: input.project,
        ref: r.ref,
        sha: r.sha,
        remote: r.remote,
        result: r.result,
        ...(r.code ? { code: r.code } : {}),
      },
      ...(input.principal ? { principal: input.principal } : {}),
      ...(r.reason ? { private: { reason: r.reason } } : {}),
    };
    if (cardId) await ctx.cardStore.recordEvent({ ...event, cardId });
    else await ctx.cardStore.recordLedgerEvent(event);
  };
  const all = async (result: PushResultKind, code: PushRefusalCode, reason: string) => {
    const out: PushResult[] = [];
    for (const [ref, { sha, cardId }] of refs) {
      const r = { ref, sha, remote, result, code, reason };
      await record(r, cardId);
      out.push(r);
    }
    return out;
  };

  let url: string;
  try {
    url = (
      await run("git", ["remote", "get-url", remote], { cwd: ctx.repoPath, timeout: 10_000 })
    ).stdout.trim();
  } catch {
    return all(
      "refused",
      "no_remote",
      `${PUSH_SETTING} is on, but this repository has no remote named ${remote}: add it, or set [review] remote.`,
    );
  }
  // The one network policy decides the remote's host before anything is sent.
  const dest = remoteDestination(url);
  const n = networkConfigs(ctx.repoPath);
  const refused = policyRefusal(mergeNetworkConfigs(n.user, n.project), dest.host);
  const detail = `git push ${remote} ${[...refs.keys()].join(" ")}`;
  await egressRecorder(ctx.cardStore)({
    url: dest.url,
    host: dest.host,
    purpose: "remote:push",
    allowed: refused === undefined,
    ...(refused ? { reason: refused } : {}),
    payloadHash: createHash("sha256").update(detail).digest("hex"),
    at: new Date().toISOString(),
  });
  if (refused) {
    return all(
      "not_allowed",
      "policy",
      `${PUSH_SETTING} is on, but the network policy refused ${dest.host}: ${refused}. ${networkHint(refused, dest.host)}.`,
    );
  }
  const out: PushResult[] = [];
  for (const [ref, { sha, cardId }] of refs) {
    let r: PushResult;
    try {
      // Never forced: a remote that holds commits the ref lacks refuses it.
      // A branch is pushed at the accepted sha; a tag as the annotated tag itself.
      const src = ref.startsWith("refs/tags/") ? ref : sha;
      await run("git", ["push", "--porcelain", remote, `${src}:${ref}`], {
        cwd: ctx.repoPath,
        timeout: 120_000,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      });
      r = { ref, sha, remote, result: "pushed" };
    } catch (err) {
      r = { ref, sha, remote, result: "refused", ...refusalOf(err) };
    }
    await record(r, cardId);
    out.push(r);
  }
  return out;
}
