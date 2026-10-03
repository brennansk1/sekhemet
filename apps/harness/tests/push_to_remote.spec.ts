import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeSettings } from "../src/integrations.js";
import { PUSH_SETTING, failedPushes, pushToRemote } from "../src/remote_push.js";
import { settingsPermissions } from "../src/team/access.js";
import { type ReleaseProject, releaseProject } from "./release_fixture.js";

/**
 * Push to remote after Accept and on release (C2b; review-git §2.6 item 8,
 * NEW-review-git-7, RG-N7-1..5; DEC-53 c6; FINDINGS_C1 PRC-08), against a
 * real repository, a real bare remote and a real ledger: off, nothing leaves
 * the server; on, each Accept pushes the integration branch without force; a
 * remote that refuses keeps the accept, records why, and is pushed again at
 * the next Accept; a host the network policy refuses is not pushed and the
 * reason names the setting; no credential reaches the ledger.
 */
let p: ReleaseProject;

const pushed = async () =>
  (await p.store.eventsOfType(["remote/pushed"])).map((e) => ({
    payload: e.payload,
    reason: (e.private as { reason?: string } | undefined)?.reason,
    cardId: e.cardId,
    principal: e.principal,
  }));
const turnOn = async (on = true) =>
  p.log.append({
    actor: "human",
    type: "project/settings_changed",
    principal: p.log.localPrincipal(),
    payload: { project: p.project, push_to_remote: on },
  });

beforeEach(async () => {
  p = await releaseProject();
});
afterEach(() => p.close());

describe("RG-N7-1: off, nothing is pushed; on, each Accept pushes the integration branch", () => {
  it("pushes nothing with the setting off, the default", async () => {
    const before = p.remoteGit("rev-parse", "main");
    await p.review("c1", "Record a day's hours");
    await p.accept("c1");
    expect(p.remoteGit("rev-parse", "main")).toBe(before);
    expect(await pushed()).toEqual([]);
  });

  it("pushes main, without force, after an Accept, recorded with the ref, sha, remote and result", async () => {
    await turnOn();
    await p.review("c1", "Record a day's hours");
    const sha = await p.accept("c1");
    const head = p.git("rev-parse", "main");
    expect(p.remoteGit("rev-parse", "main")).toBe(head);
    expect(p.git("merge-base", "--is-ancestor", sha, head)).toBe("");
    const [e] = await pushed();
    expect(e?.payload).toEqual({
      project: p.project,
      ref: "refs/heads/main",
      sha: head,
      remote: "origin",
      result: "pushed",
    });
    expect(e?.cardId).toBe("c1");
    expect(e?.principal).toBe(p.log.localPrincipal());
    expect(await failedPushes(p.store, p.project)).toEqual([]);
  });

  it("pushes a tag when one is pushed through it", async () => {
    await turnOn();
    p.git("tag", "-a", "v1.0.0", "-m", "Release v1.0.0");
    const sha = p.git("rev-parse", "v1.0.0^{commit}");
    const r = await pushToRemote(
      { repoPath: p.repo, cardStore: p.store },
      { project: p.project, ref: "refs/tags/v1.0.0", sha },
    );
    expect(r?.map((x) => x.result)).toEqual(["pushed"]);
    // The annotated tag itself, not a lightweight copy.
    expect(p.remoteGit("cat-file", "-t", "v1.0.0")).toBe("tag");
  });
});

describe("RG-N7-2: under pull-request-on-accept, the integration branch is not pushed", () => {
  it("pushes no branch", async () => {
    await turnOn();
    writeSettings(p.repo, { githubPrOnAccept: true });
    const r = await pushToRemote(
      { repoPath: p.repo, cardStore: p.store },
      { project: p.project, ref: "refs/heads/main", sha: p.git("rev-parse", "main") },
    );
    expect(r).toEqual([]);
    expect(await pushed()).toEqual([]);
    writeSettings(p.repo, { githubPrOnAccept: undefined });
  });
});

describe("RG-N7-3: a refusal keeps the accept, says why, and is pushed again at the next Accept", () => {
  it("records a remote's refusal and pushes again once the remote takes it", async () => {
    await turnOn();
    // Someone else pushed to the remote's main: it holds a commit main lacks.
    const other = mkdtempSync(join(tmpdir(), "sek-other-"));
    const og = (...a: string[]) =>
      execFileSync("git", a, { cwd: other, encoding: "utf8", stdio: "pipe" }).trim();
    og("clone", "-q", p.remote, ".");
    og("config", "user.name", "Other");
    og("config", "user.email", "o@example.com");
    writeFileSync(join(other, "theirs.txt"), "theirs\n");
    og("add", "-A");
    og("commit", "-q", "-m", "chore: theirs");
    og("push", "-q", "origin", "main");
    const theirs = og("rev-parse", "HEAD");

    await p.review("c1", "Record a day's hours");
    await p.accept("c1");
    expect((await p.store.getCard("c1"))?.status).toBe("done");
    expect(p.remoteGit("rev-parse", "main")).toBe(theirs);
    const [failed] = await failedPushes(p.store, p.project);
    expect(failed?.result).toBe("refused");
    expect(failed?.code).toBe("behind");
    expect(failed?.cardId).toBe("c1");
    expect(failed?.reason).toMatch(/rejected|fetch first|non-fast-forward/);

    // The remote's main is put back; the next Accept pushes again.
    p.remoteGit("update-ref", "refs/heads/main", p.git("rev-parse", "main~1"));
    await p.review("c2", "Flag hours past 40 as overtime");
    await p.accept("c2");
    expect(p.remoteGit("rev-parse", "main")).toBe(p.git("rev-parse", "main"));
    expect(await failedPushes(p.store, p.project)).toEqual([]);
    rmSync(other, { recursive: true, force: true });
  });

  it("pushes a refused tag again at the next push", async () => {
    await turnOn();
    p.git("tag", "-a", "v1.0.0", "-m", "Release v1.0.0");
    p.remoteGit("tag", "v1.0.0", p.remoteGit("rev-parse", "main"));
    // The remote holds a different v1.0.0: the tag is refused, never forced.
    p.git("commit", "-q", "--allow-empty", "-m", "fix: later");
    p.git("tag", "-f", "-a", "v1.0.0", "-m", "Release v1.0.0");
    const r = await pushToRemote(
      { repoPath: p.repo, cardStore: p.store },
      { project: p.project, ref: "refs/tags/v1.0.0", sha: p.git("rev-parse", "v1.0.0^{commit}") },
    );
    expect(r?.[0]?.result).toBe("refused");
    p.remoteGit("tag", "-d", "v1.0.0");
    await p.review("c1", "Record a day's hours");
    await p.accept("c1");
    expect(p.remoteGit("cat-file", "-t", "v1.0.0")).toBe("tag");
    expect(await failedPushes(p.store, p.project)).toEqual([]);
  });
});

describe("RG-N7-3, RG-N7-4: the network policy decides the remote's host; no credential is stored", () => {
  it("pushes nothing to a host the policy refuses, naming the setting, and keeps no credential", async () => {
    await turnOn();
    p.git("remote", "set-url", "origin", "https://jane:s3cr3t-token@example.invalid/team/app.git");
    await p.review("c1", "Record a day's hours");
    await p.accept("c1");
    expect((await p.store.getCard("c1"))?.status).toBe("done");
    const [e] = await pushed();
    expect(e?.payload).toMatchObject({ ref: "refs/heads/main", remote: "origin" });
    expect((e?.payload as { result: string }).result).toBe("not_allowed");
    expect((e?.payload as { code: string }).code).toBe("policy");
    expect(e?.reason).toContain(PUSH_SETTING);
    expect(e?.reason).toContain("example.invalid");
    expect(e?.reason).toMatch(/\[network\] mode/);
    const egress = (await p.store.eventsOfType(["harness/egress"])).at(-1);
    expect(egress?.payload).toMatchObject({
      host: "example.invalid",
      purpose: "remote:push",
      allowed: false,
    });
    // Nothing in the ledger's database holds the credential, in any table.
    const tables = p.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
      name: string;
    }[];
    expect(tables.length).toBeGreaterThan(3);
    for (const { name } of tables) {
      const rows = p.db.prepare(`SELECT * FROM "${name}"`).all();
      expect(JSON.stringify(rows), name).not.toContain("s3cr3t");
    }
  });
});

describe("RG-N7-5: the setting is a project setting", () => {
  it("needs the right to edit the project's settings", () => {
    expect(settingsPermissions({ push_to_remote: true })).toEqual(["project.settings"]);
  });
});
