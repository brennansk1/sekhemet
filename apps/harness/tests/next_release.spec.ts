import { acceptBrief } from "@sekhemet/planner";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { releaseSubcommand } from "../src/project_done.js";
import { startDashboardServer } from "../src/server.js";
import { pageWriteHeaders } from "./page_headers.js";
import { type ReleaseProject, releaseProject } from "./release_fixture.js";

type Issue = { id: string; title: string; category: string };
type Next = {
  project: string;
  lastTag: { tag: string; sha: string } | null;
  issues: Issue[];
  proposed: {
    version: string;
    tag: string;
    issues: string[];
    notes: string;
    changelog: string;
    sha: string;
  } | null;
  push: { on: boolean; remote: string; failed: { ref: string; reason?: string }[] };
};

/**
 * Maintenance releases and the open *Next release* (C2b; planner-pm §2.15
 * item 8a, NEW-planner-pm-12, PM-N12-1..4; DEC-53 c8; FINDINGS_C1 PRC-07),
 * over HTTP against a real server, repository, remote and ledger (DoD §2A):
 * every issue accepted since the last tag that traces to no requirement of an
 * open release collects in Next release; *Propose release* computes the
 * version from the issues' squashes (fix-only work is a patch), the
 * changelog in Keep a Changelog's categories and the notes from the issues'
 * titles, recorded as `release/proposed` with no slice; a person's Tag
 * writes the tag on the integration branch, records `release/tagged`, pushes
 * it when the project's push setting is on and opens an empty Next release;
 * with nothing accepted, nothing is offered and nothing changes. No model.
 */
let p: ReleaseProject;
let server: { port: number; close: () => Promise<void> };
let base: string;

const send = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(await pageWriteHeaders(base)) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: r.status, data: (await r.json()) as Record<string, unknown> };
};
const next = async () =>
  (await send("GET", `/api/projects/${p.project}/releases/next`)).data.next as Next;
const count = () =>
  Number((p.db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number | bigint }).n);

beforeEach(async () => {
  p = await releaseProject();
  server = await startDashboardServer({
    db: p.db,
    log: p.log,
    boardService: p.board,
    cardStore: p.store,
    repoPath: p.repo,
    port: 0,
    streamIntervalMs: 10_000,
  });
  base = `http://127.0.0.1:${server.port}`;
});
afterEach(async () => {
  await server.close();
  p.close();
});

describe("PM-N12-4: with nothing accepted since the last tag, nothing is offered and nothing changes", () => {
  it("shows an empty Next release and refuses to propose, over HTTP and from the CLI", async () => {
    const empty = await next();
    expect(empty.issues).toEqual([]);
    expect(empty.proposed).toBeNull();
    const before = count();
    const r = await send("POST", `/api/projects/${p.project}/releases/next/propose`, {});
    expect(r.status).toBe(409);
    expect(String(r.data.error)).toBe(
      "Nothing was accepted since the last tag, so there is no release to propose.",
    );
    const lines: string[] = [];
    const code = await releaseSubcommand(
      { repoPath: p.repo, cardStore: p.store, log: p.log },
      ["propose"],
      (l) => lines.push(l),
    );
    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("Nothing was accepted since the last tag");
    expect(count()).toBe(before);
    expect(p.git("tag", "--list")).toBe("");
  });
});

describe("PM-N12-1..3: Next release, Propose release and Tag release", () => {
  it("collects accepted issues, proposes a patch for fixes, tags only on a person's Tag and opens an empty Next release", async () => {
    // A version tagged before Sekhemet (a taken-over repository's last release).
    p.git("tag", "-a", "v1.2.3", "-m", "Release v1.2.3");
    await p.review("c1", "Fix the overtime total on a short week");
    await p.review("c2", "Fix the CSV export's header");
    await p.accept("c1");
    await p.accept("c2");

    // PM-N12-1: both issues, by title, in Next release.
    const open = await next();
    expect(open.issues.map((i) => [i.id, i.title, i.category])).toEqual([
      ["c1", "Fix the overtime total on a short week", "Fixed"],
      ["c2", "Fix the CSV export's header", "Fixed"],
    ]);
    expect(open.push).toEqual({ on: false, remote: "origin", failed: [] });

    // PM-N12-2: the version from the squashes — fixes only, a patch.
    const proposed = await send("POST", `/api/projects/${p.project}/releases/next/propose`, {});
    expect(proposed.status).toBe(200);
    const rel = (await next()).proposed;
    expect(rel?.version).toBe("1.2.4");
    expect(rel?.tag).toBe("v1.2.4");
    expect(rel?.issues).toEqual(["c1", "c2"]);
    expect(rel?.changelog).toMatch(/^## \[1\.2\.4\] - \d{4}-\d{2}-\d{2}\n\n### Fixed\n\n- /);
    expect(rel?.notes).toBe(
      "Fixed\n- Fix the overtime total on a short week\n- Fix the CSV export's header",
    );
    const [ev] = await p.log.getEventsByTypes(["release/proposed"]);
    expect(ev?.payload).toEqual({
      projectId: p.project,
      version: "1.2.4",
      requirementIds: [],
      issues: ["c1", "c2"],
      sha: p.git("rev-parse", "main"),
    });
    expect(ev?.actor).toBe("human");
    expect(ev?.principal).toBe(p.log.localPrincipal());
    // Not confirmed: no tag is written.
    expect(p.git("tag", "--list")).toBe("v1.2.3");

    // An issue accepted after the proposal stays for the release after it.
    await p.review("c3", "Add a weekly total row");
    await p.accept("c3");

    // PM-N12-3: a person's Tag writes the tag at the proposed sha.
    const tagged = await send("POST", `/api/projects/${p.project}/releases/next/tag`, {});
    expect(tagged.status).toBe(200);
    expect(tagged.data.tag).toBe("v1.2.4");
    expect(p.git("rev-parse", "v1.2.4^{commit}")).toBe(rel?.sha);
    expect(p.git("cat-file", "-t", "v1.2.4")).toBe("tag");
    const [t] = await p.log.getEventsByTypes(["release/tagged"]);
    expect(t?.payload).toEqual({
      projectId: p.project,
      tag: "v1.2.4",
      sha: rel?.sha,
      proven: rel?.sha,
    });
    expect(t?.principal).toBe(p.log.localPrincipal());
    // PM-N12-2, DS-N3-8: main moved since the proposal, so the tag names the
    // proposed sha and the changelog section and notes follow onto main.
    expect(p.git("show", "main:CHANGELOG.md")).toContain("## [1.2.4] - ");
    expect(p.git("show", "main:CHANGELOG.md")).toMatch(
      /## \[1\.2\.4\] - [\d-]+\n\n### Fixed\n\n- /,
    );
    expect(p.git("show", "main:docs/product/releases/1.2.4.md")).toContain("# Release 1.2.4");
    // The push setting is off: the tag stays here, and the answer says so.
    expect(String(tagged.data.notice)).toContain("stays in this server's repository");
    expect(p.remoteGit("tag", "--list")).toBe("");

    // A new Next release opens, holding only what was accepted after the proposal.
    const after = await next();
    expect(after.lastTag?.tag).toBe("v1.2.4");
    expect(after.proposed).toBeNull();
    expect(after.issues.map((i) => [i.id, i.category])).toEqual([["c3", "Added"]]);
    // A second Tag has nothing to tag.
    expect((await send("POST", `/api/projects/${p.project}/releases/next/tag`, {})).status).toBe(
      409,
    );
  });

  it("PM-N12-2, DS-N3-8: the changelog section and the release notes are committed on the proposed sha, and the tag names that commit", async () => {
    await p.review("c1", "Fix the overtime total on a short week");
    await p.accept("c1");
    expect(
      (await send("POST", `/api/projects/${p.project}/releases/next/propose`, {})).status,
    ).toBe(200);
    const rel = (await next()).proposed;
    const tagged = await send("POST", `/api/projects/${p.project}/releases/next/tag`, {});
    expect(tagged.status).toBe(200);
    const tag = String(tagged.data.tag);
    const commit = p.git("rev-parse", `${tag}^{commit}`);
    // The tagged commit is the documents commit on the proposed sha, and only documents.
    expect(p.git("rev-parse", `${commit}^`)).toBe(rel?.sha);
    expect(p.git("rev-parse", "main")).toBe(commit);
    const changelog = p.git("show", `${tag}:CHANGELOG.md`);
    expect(changelog).toContain(`## [${rel?.version}] - `);
    expect(changelog).toContain("### Fixed\n\n- ");
    const notes = p.git("show", `${tag}:docs/product/releases/${rel?.version}.md`);
    expect(notes).toContain(`# Release ${rel?.version}`);
    expect(notes).toContain("Fix the overtime total on a short week");
    const [t] = await p.log.getEventsByTypes(["release/tagged"]);
    expect(t?.payload).toEqual({ projectId: p.project, tag, sha: commit, proven: rel?.sha });
    // The documents commit is not an issue: the Next release is empty.
    expect((await next()).issues).toEqual([]);
  });

  it("leaves out an issue that traces to a requirement of an open release", async () => {
    const brief = await acceptBrief(
      { store: p.store, log: p.log },
      {
        projectId: p.project,
        baseline: "Hours live in a spreadsheet",
        slices: [
          {
            title: "Walking skeleton",
            appetite: { cards: 6 },
            requirements: [{ key: "record", title: "Record a day's hours" }],
          },
        ],
      },
      p.store.localPrincipal(),
    );
    await p.review("c1", "Record a day's hours");
    await p.store.requirements.link({
      requirementId: brief.requirementIds[0] as string,
      from: "card",
      ref: "c1",
    });
    await p.review("c2", "Fix a typo on the week view");
    await p.accept("c1");
    await p.accept("c2");
    expect((await next()).issues.map((i) => i.id)).toEqual(["c2"]);
  });

  it("pushes the tag with the project's push setting on (RG-N7-1), from the CLI's propose and confirm", async () => {
    await send("PATCH", `/api/projects/${p.project}/settings`, { push_to_remote: true });
    await p.review("c1", "Add a weekly total row");
    await p.accept("c1");
    const lines: string[] = [];
    const k = { repoPath: p.repo, cardStore: p.store, log: p.log };
    expect(await releaseSubcommand(k, ["propose"], (l) => lines.push(l))).toBe(0);
    expect(lines[0]).toBe("Proposed release 0.1.0. Tag it with: sekhemet release --confirm next");
    expect(p.git("tag", "--list")).toBe("");
    expect(await releaseSubcommand(k, ["--confirm", "next"], (l) => lines.push(l))).toBe(0);
    expect(lines.at(-2)).toMatch(/^Tagged v0\.1\.0 at [0-9a-f]{7}\.$/);
    expect(lines.at(-1)).toBe("v0.1.0 was pushed to origin.");
    expect(p.remoteGit("cat-file", "-t", "v0.1.0")).toBe("tag");
    const pushed = (await p.log.getEventsByTypes(["remote/pushed"])).map((e) => e.payload);
    expect(pushed.at(-1)).toMatchObject({ ref: "refs/tags/v0.1.0", result: "pushed" });
  });
});
