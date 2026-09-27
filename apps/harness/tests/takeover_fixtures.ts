import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import type { ExternalItem, SyncAdapter } from "@sekhemet/sync";
import { FAKE_TOKEN } from "./takeover_fixture.js";

/**
 * The take-over fixtures of DS-TO-15 (`fixtures/takeover/`), each built as a
 * real git repository in a temporary directory: the files under `repo/` are
 * the first commit, and `fixture.json` adds the later commits — a file
 * written, a file removed, or a fake secret committed (generated here, so
 * no secret is stored in this repository) — and the tracker issues the
 * repository inherits.
 */
export const TAKEOVER_FIXTURES = [
  "half-built-ts",
  "broken-build",
  "python-stubs",
  "committed-secret",
  "inherited-issues",
] as const;

export type TakeoverFixtureName = (typeof TAKEOVER_FIXTURES)[number];

export const FIXTURES_DIR = join(import.meta.dirname, "..", "..", "..", "fixtures", "takeover");

interface FixtureSpec {
  commits: {
    message: string;
    write?: Record<string, string>;
    remove?: string[];
    secret?: string;
  }[];
  issues?: { number: number; title: string; body: string; state: "open" | "closed" }[];
}

export interface BuiltFixture {
  root: string;
  /** Each commit, oldest first. */
  commits: string[];
  /** The commit that added the secret, when the fixture has one. */
  leakCommit?: string;
  /** The tracker issues the repository inherits, as the adapter reads them. */
  issues: ExternalItem[];
}

export function buildTakeoverFixture(name: TakeoverFixtureName): BuiltFixture {
  const source = join(FIXTURES_DIR, name);
  const spec = JSON.parse(readFileSync(join(source, "fixture.json"), "utf8")) as FixtureSpec;
  const root = realpathSync(mkdtempSync(join(tmpdir(), `takeover-${name}-`)));
  cpSync(join(source, "repo"), root, { recursive: true });
  const git = (...a: string[]) =>
    execFileSync("git", a, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "prev@example.invalid");
  git("config", "user.name", "Previous Dev");
  git("config", "core.hooksPath", "/dev/null");
  git("add", "-A");
  git("commit", "-q", "-m", "Initial commit");
  const commits = [git("rev-parse", "HEAD")];
  let leakCommit: string | undefined;
  for (const c of spec.commits) {
    for (const [path, text] of Object.entries(c.write ?? {})) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    if (c.secret) {
      mkdirSync(dirname(join(root, c.secret)), { recursive: true });
      writeFileSync(join(root, c.secret), `export const githubToken = "${FAKE_TOKEN()}";\n`);
    }
    for (const path of c.remove ?? []) rmSync(join(root, path));
    git("add", "-A");
    git("commit", "-q", "-m", c.message);
    commits.push(git("rev-parse", "HEAD"));
    if (c.secret) leakCommit = commits.at(-1);
  }
  const issues: ExternalItem[] = (spec.issues ?? []).map((i) => ({
    ref: {
      system: "github",
      id: `prev/${name}#${i.number}`,
      url: `https://github.invalid/prev/${name}/issues/${i.number}`,
    },
    title: i.title,
    body: i.body,
    labels: [],
    state: i.state,
    updatedAt: "2026-01-01T00:00:00Z",
  }));
  return { root, commits, ...(leakCommit ? { leakCommit } : {}), issues };
}

/** A tracker over fixed issues that records every write it is asked for (INT-43). */
export function fakeTracker(issues: ExternalItem[]): SyncAdapter & {
  writes: { kind: "update" | "comment"; id: string; body: unknown }[];
} {
  const writes: { kind: "update" | "comment"; id: string; body: unknown }[] = [];
  return {
    system: "github",
    capabilities: { hierarchy: false, dependencies: false, webhooks: false, maxDepth: 1 },
    writes,
    pull: async () => issues.map((i) => ({ ...i, labels: [...i.labels] })),
    push: async () => {
      throw new Error("a take-over never creates an issue");
    },
    update: async (ref, patch) => {
      writes.push({ kind: "update", id: ref.id, body: patch });
    },
    comment: async (ref, body) => {
      writes.push({ kind: "comment", id: ref.id, body });
    },
  };
}

/** Every file of a fixture's source folder with its bytes, to show none was edited. */
export function fixtureSnapshot(): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string) => {
    for (const n of readdirSync(dir).sort()) {
      const p = join(dir, n);
      if (statSync(p).isDirectory()) walk(p);
      else out.set(relative(FIXTURES_DIR, p), readFileSync(p, "utf8"));
    }
  };
  walk(FIXTURES_DIR);
  return out;
}
