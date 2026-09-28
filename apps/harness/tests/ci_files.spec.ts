import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readCiSteps } from "../src/ci_files.js";
import { deriveGates } from "../src/init.js";
import { detectCommands } from "../src/onboard.js";

/**
 * CI files are read with a YAML parser (DEC-44: `yaml`), not a `run:`
 * regex, by the one reader the gate deriver, onboarding and a take-over's
 * recon share: GitHub Actions workflows and GitLab CI, block scalars,
 * flow-style steps and anchors included, each command with its line. A file
 * that is not YAML is named, never dropped silently (SUR-35).
 */
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "ci-files-"));
  dirs.push(root);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
}

const WORKFLOW = `name: ci
on: [push]
defaults: &shell
  run:
    shell: bash
jobs:
  checks:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Lint and types
        run: >-
          pnpm lint
      - { name: Unit, run: "pnpm test" }
      - name: Many
        run: |
          # comment lines are not commands
          pnpm build

          pnpm test:e2e \\
            --reporter=dot
          cargo clippy -- -D warnings
      - name: Keep
        run: &typecheck pnpm typecheck
  again:
    runs-on: ubuntu-latest
    services:
      redis:
        image: redis:7
    steps:
      - run: *typecheck
      - name: Secret
        env:
          TOKEN: \${{ secrets.NPM_TOKEN }}
        run: pnpm test:publish
`;

const GITLAB = `stages: [test]
variables:
  NODE_ENV: test
.node-template: &node
  image: node:22
  before_script:
    - pnpm install --frozen-lockfile
unit:
  <<: *node
  stage: test
  script:
    - pnpm test
    - pnpm lint
integration:
  stage: test
  services:
    - postgres:16
  script: |
    pnpm build
    pnpm test:db
`;

describe("DEC-44: CI files are read with a YAML parser", () => {
  it("reads every GitHub Actions command — folded, flow-style, block, continued, aliased — with its line", () => {
    const root = repo({ ".github/workflows/ci.yml": WORKFLOW });
    const steps = readCiSteps(root).map(
      (s) =>
        `${s.line}:${s.uses ?? s.command}${s.service ? " [service]" : ""}${s.secret ? " [secret]" : ""}`,
    );
    expect(steps).toEqual([
      "10:actions/checkout@v4",
      "13:pnpm lint",
      "14:pnpm test",
      "18:pnpm build",
      "20:pnpm test:e2e --reporter=dot",
      "22:cargo clippy -- -D warnings",
      "24:pnpm typecheck",
      "31:pnpm typecheck [service]",
      "35:pnpm test:publish [service] [secret]",
    ]);
  });

  it("reads GitLab CI jobs — merged templates, script lists and blocks, services — and skips hidden jobs", () => {
    const root = repo({ ".gitlab-ci.yml": GITLAB });
    const steps = readCiSteps(root).map(
      (s) => `${s.file}:${s.line}:${s.command}${s.service ? " [service]" : ""}`,
    );
    expect(steps).toEqual([
      ".gitlab-ci.yml:7:pnpm install --frozen-lockfile",
      ".gitlab-ci.yml:12:pnpm test",
      ".gitlab-ci.yml:13:pnpm lint",
      ".gitlab-ci.yml:19:pnpm build [service]",
      ".gitlab-ci.yml:20:pnpm test:db [service]",
    ]);
  });

  it("names a CI file that is not YAML instead of losing its checks silently", () => {
    const root = repo({ ".github/workflows/broken.yml": "jobs:\n  t:\n    steps: [\n" });
    const [step] = readCiSteps(root);
    expect(step).toMatchObject({ file: ".github/workflows/broken.yml" });
    expect(step?.error).toMatch(/\S/);
    const ci = deriveGates(root).ci;
    expect(ci).toEqual([
      expect.objectContaining({ file: ".github/workflows/broken.yml", reason: "unreadable" }),
    ]);
  });

  it("the deriver turns block and GitLab commands into checks", () => {
    const root = repo({
      "pnpm-lock.yaml": "",
      "package.json": JSON.stringify({ scripts: { test: "vitest run" } }),
      ".github/workflows/ci.yml": WORKFLOW,
      ".gitlab-ci.yml": GITLAB,
    });
    const d = deriveGates(root);
    expect(d.gates).toEqual(
      expect.arrayContaining([
        "ci-test-1: pnpm test:e2e --reporter=dot",
        "ci-lint-2: cargo clippy -- -D warnings",
      ]),
    );
    expect(d.ci.filter((s) => s.file === ".gitlab-ci.yml").map((s) => s.reason ?? s.gate)).toEqual([
      "setup",
      // The project's own test script's check.
      "unit",
      "ci-lint-1",
      // The integration job declares a service, so both its commands need it.
      "needs_service",
      "needs_service",
    ]);
  });

  it("onboarding's commands come from the same reader: multi-line blocks and GitLab included", () => {
    const root = repo({ ".github/workflows/ci.yml": WORKFLOW, ".gitlab-ci.yml": GITLAB });
    const found = detectCommands(root).map((c) => `${c.kind} ${c.command} (${c.source})`);
    expect(found).toEqual(
      expect.arrayContaining([
        "test pnpm test:e2e --reporter=dot (.github/workflows/ci.yml)",
        "lint cargo clippy -- -D warnings (.github/workflows/ci.yml)",
        "typecheck pnpm typecheck (.github/workflows/ci.yml)",
        "test pnpm test:db (.gitlab-ci.yml)",
      ]),
    );
    // A block indicator is never taken for a command.
    expect(found.some((c) => /^\w+ [|>]/.test(c))).toBe(false);
  });
});

// Fix review C2a: GitLab's `!reference` and `include:`, GitHub Actions'
// working directories and reusable workflows, and shell blocks that span
// lines. What the reader cannot follow is named, never lost silently.
const GITLAB_REUSE = `include:
  - local: ci/common.yml
  - template: Security/SAST.gitlab-ci.yml
.setup:
  script:
    - npm ci
    - npm run lint
test:
  script:
    - !reference [.setup, script]
    - npm test
other:
  script:
    - !reference [.missing, script]
`;

const GITHUB_CONTEXT = `on: [push]
defaults:
  run:
    working-directory: web
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: npm test
      - run: npm run lint
        working-directory: ./api
      - run: |
          if [ -f x ]; then
            npm test
          fi
          npm run typecheck
  reuse:
    uses: ./.github/workflows/other.yml
  remote:
    uses: org/repo/.github/workflows/ci.yml@v1
`;

describe("C2a: CI context the reader follows, or names as not read", () => {
  it("resolves GitLab's !reference to the template's own commands, and names includes and missing references", () => {
    const root = repo({ ".gitlab-ci.yml": GITLAB_REUSE });
    const steps = readCiSteps(root).map((s) => `${s.line}:${s.command ?? `not read: ${s.unread}`}`);
    expect(steps).toEqual([
      "2:not read: included CI file ci/common.yml (local)",
      "3:not read: included CI file Security/SAST.gitlab-ci.yml (template)",
      "6:npm ci",
      "7:npm run lint",
      "11:npm test",
      "14:not read: !reference [.missing, script]: .missing is not in this file (it may come from an included file)",
    ]);
    const d = deriveGates(repo({ "package-lock.json": "{}", ".gitlab-ci.yml": GITLAB_REUSE }));
    expect(d.ci.map((s) => s.gate ?? s.reason)).toEqual([
      "not_read",
      "not_read",
      "setup",
      "ci-lint-1",
      "ci-test-1",
      "not_read",
    ]);
    expect(d.gates).toContain("ci-lint-1: npm run lint");
  });

  it("keeps GitHub Actions' working directory, reads a shell block as one command, and names reusable workflows", () => {
    const root = repo({ ".github/workflows/ci.yml": GITHUB_CONTEXT });
    const steps = readCiSteps(root).map(
      (s) =>
        `${s.line}:${s.uses ?? s.command}${s.directory ? ` [in ${s.directory}]` : ""}${s.reusable ? " [reusable]" : ""}`,
    );
    expect(steps).toEqual([
      "9:npm test [in web]",
      "10:npm run lint [in api]",
      "13:if [ -f x ]; then npm test; fi [in web]",
      "16:npm run typecheck [in web]",
      "18:./.github/workflows/other.yml [reusable]",
      "20:org/repo/.github/workflows/ci.yml@v1 [reusable]",
    ]);
    const d = deriveGates(
      repo({
        "package-lock.json": "{}",
        "package.json": JSON.stringify({ scripts: { test: "vitest run" } }),
        ".github/workflows/ci.yml": GITHUB_CONTEXT,
      }),
    );
    // `npm test` in web/ is not the root's own test script's check.
    expect(d.ci.map((s) => s.gate ?? s.reason)).toEqual([
      "ci-test-1",
      "ci-lint-1",
      "shell_block",
      "ci-typecheck-1",
      "reusable_workflow",
      "reusable_workflow",
    ]);
    expect(d.gates).toEqual(
      expect.arrayContaining([
        "ci-test-1: sh -c cd web && npm test",
        "ci-lint-1: sh -c cd api && npm run lint",
        "ci-typecheck-1: sh -c cd web && npm run typecheck",
      ]),
    );
    expect(d.ci[0]).toMatchObject({ command: "npm test", directory: "web" });
    expect(d.ci[4]?.detail).toMatch(/read from \.github\/workflows\/other\.yml/);
    expect(d.ci[5]?.detail).toMatch(/another repository/);
    const found = detectCommands(root).map((c) => `${c.kind} ${c.command}`);
    expect(found).toEqual(expect.arrayContaining(["test cd web && npm test"]));
  });

  it("closes a shell function block, so the commands after it stay their own steps", () => {
    const wf = `on: [push]
jobs:
  t:
    runs-on: ubuntu-latest
    steps:
      - run: |
          setup() {
            npm ci
          }
          setup
          npm test
`;
    const steps = readCiSteps(repo({ ".github/workflows/ci.yml": wf })).map((s) => s.command);
    expect(steps).toEqual(["setup() { npm ci; }", "setup", "npm test"]);
  });

  it("names a working directory set by an expression instead of guessing it", () => {
    const wf = `on: [push]
jobs:
  t:
    runs-on: ubuntu-latest
    steps:
      - run: npm test
        working-directory: \${{ matrix.pkg }}
      - run: npm run lint
        working-directory: \${{ env.DIR }}
`;
    const d = deriveGates(repo({ "package-lock.json": "{}", ".github/workflows/ci.yml": wf }));
    expect(d.ci.map((s) => s.gate ?? s.reason)).toEqual(["matrix", "not_read"]);
    expect(d.ci[1]?.detail).toMatch(/working directory/);
  });
});
