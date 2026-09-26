import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { historyGitEnv, historyPreflight, scanHistorySecrets } from "../src/history_secrets.js";
import { SECRET_RULES } from "../src/secrets.js";

/**
 * DS-TO-3, SEC-55 (security item 34c): a taken-over repository's whole
 * history is scanned for secrets offline — gitleaks when installed, else the
 * bundled rules of `secrets.ts` — after the item 21 preflight, with no
 * textconv or external diff run, and the secret recorded nowhere.
 */
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

// A fake token of the GitHub shape, built at run time so this file holds none.
const FAKE = `ghp_${"A1b2C3d4E5".repeat(4)}`;

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function repo(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hist-secrets-")));
  dirs.push(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "e@x");
  git(root, "config", "user.name", "E");
  return root;
}

function commit(root: string, files: Record<string, string | null>, message: string): string {
  for (const [rel, text] of Object.entries(files)) {
    const path = join(root, rel);
    if (text === null) rmSync(path);
    else {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
    }
  }
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", message);
  return git(root, "rev-parse", "HEAD");
}

describe("DS-TO-3, SEC-55: the offline history secret scan", () => {
  it("finds a secret in a commit whose file was later deleted, with commit, path and rule only", async () => {
    const root = repo();
    commit(root, { "README.md": "# app\n" }, "init");
    const leaked = commit(root, { "src/config.ts": `export const token = "${FAKE}";\n` }, "wire");
    commit(root, { "src/config.ts": null }, "remove the token");
    const scan = await scanHistorySecrets(root, { gitleaks: false });
    expect(scan.scanner).toBe("builtin");
    expect(scan.commits).toBe(3);
    expect(scan.notScanned).toBeUndefined();
    expect(scan.findings).toEqual([
      { commit: leaked, path: "src/config.ts", rule: "github-token" },
    ]);
    // The rule id is the bundled rule set's own (secrets.ts), shared with the diff gate.
    expect(SECRET_RULES.map((r) => r.id)).toContain(scan.findings[0]?.rule);
    // The secret is recorded nowhere, not even in part.
    expect(JSON.stringify(scan)).not.toContain(FAKE.slice(4, 14));
  });

  it("refuses when the repository config names a textconv driver: history not scanned, no driver runs", async () => {
    const root = repo();
    const marker = join(root, "..", `textconv-ran-${Date.now()}`);
    dirs.push(marker);
    const driver = join(root, ".evil-textconv.sh");
    writeFileSync(driver, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\ncat "$1"\n`);
    chmodSync(driver, 0o755);
    commit(
      root,
      { ".gitattributes": "*.txt diff=evil\n", "notes.txt": `token = "${FAKE}"\n` },
      "init",
    );
    git(root, "config", "diff.evil.textconv", driver);
    expect(historyPreflight(root)).toEqual(["repository config sets diff.evil.textconv"]);
    const scan = await scanHistorySecrets(root, { gitleaks: false });
    expect(scan.notScanned).toBe("preflight_refused");
    expect(scan.reason).toContain("diff.evil.textconv");
    expect(scan.findings).toEqual([]);
    expect(existsSync(marker)).toBe(false);
  });

  it("with gitleaks installed: runs it over the whole history with --no-ext-diff --no-textconv and keeps no secret", async () => {
    const root = repo();
    const leaked = commit(root, { "app.env": `TOKEN=${FAKE}\n` }, "init");
    const bin = realpathSync(mkdtempSync(join(tmpdir(), "fake-gitleaks-")));
    dirs.push(bin);
    const argsFile = join(root, ".gitleaks-args");
    const fake = join(bin, "gitleaks");
    // A stand-in with gitleaks' report shape: it writes its report where
    // --report-path says, with the commit, file, rule and the secret itself.
    writeFileSync(
      fake,
      [
        "#!/bin/sh",
        `for a in "$@"; do echo "$a" >> ${JSON.stringify(argsFile)}; done`,
        'report=""; prev=""',
        'for a in "$@"; do if [ "$prev" = "--report-path" ]; then report="$a"; fi; prev="$a"; done',
        `printf '[{"RuleID":"github-pat","Commit":"${leaked}","File":"app.env","Secret":"${FAKE}","Match":"TOKEN=${FAKE}"}]' > "$report"`,
        "exit 1",
        "",
      ].join("\n"),
    );
    chmodSync(fake, 0o755);
    const scan = await scanHistorySecrets(root, { gitleaks: fake });
    expect(scan.scanner).toBe("gitleaks");
    expect(scan.commits).toBe(1);
    expect(scan.findings).toEqual([{ commit: leaked, path: "app.env", rule: "github-pat" }]);
    expect(JSON.stringify(scan)).not.toContain(FAKE.slice(4, 14));
    const args = readFileSync(argsFile, "utf8").split("\n");
    const logOpts = args.find((a) => a.startsWith("--log-opts="));
    expect(logOpts).toContain("--all");
    expect(logOpts).toContain("--no-ext-diff");
    expect(logOpts).toContain("--no-textconv");
    expect(args).toContain("--redact");
  });

  // Lead ruling under DEC-42 on item 21's scope (security item 21, DS-TO-3):
  // the history scan only reads, and its git runs with hooks forced off, so
  // a repository whose only finding is Husky's `core.hooksPath` is scanned.
  it("scans a Husky repository (core.hooksPath its only finding): the scan's git forces hooks off", async () => {
    const root = repo();
    const hookRan = join(root, "..", `hook-ran-${Date.now()}`);
    dirs.push(hookRan);
    const leaked = commit(
      root,
      {
        ".husky/_/post-checkout": `#!/bin/sh\ntouch ${JSON.stringify(hookRan)}\n`,
        "src/config.ts": `export const token = "${FAKE}";\n`,
      },
      "init",
    );
    chmodSync(join(root, ".husky/_/post-checkout"), 0o755);
    git(root, "config", "core.hooksPath", ".husky/_");
    // The preflight still names the key; the scan alone lets it pass.
    expect(historyPreflight(root)).toEqual(["repository config sets core.hookspath"]);
    // The scan's guarded git environment overrides the repository's hooks path.
    const forced = execFileSync("git", ["config", "core.hooksPath"], {
      env: historyGitEnv(root),
      encoding: "utf8",
    }).trim();
    expect(forced).toBe("/dev/null");
    const scan = await scanHistorySecrets(root, { gitleaks: false });
    expect(scan.notScanned).toBeUndefined();
    expect(scan.findings).toEqual([
      { commit: leaked, path: "src/config.ts", rule: "github-token" },
    ]);
    expect(existsSync(hookRan)).toBe(false);
  });

  it("with gitleaks, a Husky repository's hooks path is overridden on the command level for every git gitleaks runs", async () => {
    const root = repo();
    const head = commit(root, { "README.md": "# app\n" }, "init");
    git(root, "config", "core.hooksPath", ".husky/_");
    const bin = realpathSync(mkdtempSync(join(tmpdir(), "fake-gitleaks-")));
    dirs.push(bin);
    const fake = join(bin, "gitleaks");
    // It asks git what gitleaks' own git calls see, and reports it as the
    // finding's path (the only place a confined stand-in can write to).
    writeFileSync(
      fake,
      [
        "#!/bin/sh",
        `seen=$(git -C ${JSON.stringify(root)} config core.hooksPath 2>/dev/null)`,
        'report=""; prev=""',
        'for a in "$@"; do if [ "$prev" = "--report-path" ]; then report="$a"; fi; prev="$a"; done',
        `printf '[{"RuleID":"probe","Commit":"${head}","File":"%s"}]' "$seen" > "$report"`,
        "exit 1",
        "",
      ].join("\n"),
    );
    chmodSync(fake, 0o755);
    const scan = await scanHistorySecrets(root, { gitleaks: fake });
    expect(scan.notScanned).toBeUndefined();
    expect(scan.scanner).toBe("gitleaks");
    expect(scan.findings).toEqual([{ commit: head, path: "/dev/null", rule: "probe" }]);
  });

  it("still refuses every other preflight finding: an fsmonitor repository is not scanned and its program never runs", async () => {
    const root = repo();
    const ran = join(root, "..", `fsmonitor-ran-${Date.now()}`);
    dirs.push(ran);
    const monitor = join(root, ".evil-fsmonitor.sh");
    writeFileSync(monitor, `#!/bin/sh\ntouch ${JSON.stringify(ran)}\n`);
    chmodSync(monitor, 0o755);
    commit(root, { "src/config.ts": `export const token = "${FAKE}";\n` }, "init");
    git(root, "config", "core.hooksPath", ".husky/_");
    git(root, "config", "core.fsmonitor", monitor);
    const scan = await scanHistorySecrets(root, { gitleaks: false });
    expect(scan.notScanned).toBe("preflight_refused");
    expect(scan.reason).toContain("core.fsmonitor");
    expect(scan.findings).toEqual([]);
    expect(existsSync(ran)).toBe(false);
  });

  it("an empty repository has nothing to scan and says so by its count", async () => {
    const root = repo();
    const scan = await scanHistorySecrets(root, { gitleaks: false });
    expect(scan).toMatchObject({ scanner: "builtin", commits: 0, findings: [] });
  });
});

// B4.1 half-A fix round (review B1, M3, minor): a scan that could not read
// the history is never reported as a clean one; gitleaks reads none of the
// repository's own configuration; SHA-256 repositories are scanned.
const AWS = () => `AKIA${"QX7ZR2PL5M".repeat(2).slice(0, 16)}`;

function fakeGitleaks(lines: string[]): string {
  const bin = realpathSync(mkdtempSync(join(tmpdir(), "fake-gitleaks-")));
  dirs.push(bin);
  const fake = join(bin, "gitleaks");
  writeFileSync(fake, ["#!/bin/sh", ...lines, ""].join("\n"));
  chmodSync(fake, 0o755);
  return fake;
}

describe("B1: a history git could not read is never a clean scan", () => {
  it("a dangling ref over a history holding an AWS key: scanner_failed with git's reason, never 0 findings as clean", async () => {
    const root = repo();
    commit(root, { "deploy.env": `AWS_ACCESS_KEY_ID=${AWS()}\n` }, "init");
    writeFileSync(join(root, ".git", "refs", "heads", "ghost"), `${"0".repeat(39)}1\n`);
    const scan = await scanHistorySecrets(root, { gitleaks: false });
    expect(scan.notScanned).toBe("scanner_failed");
    expect(scan.reason).toMatch(/git rev-list exited 128.*bad object/);
    expect(scan.findings).toEqual([]);
  });

  it("gitleaks failing and then git log failing (a missing blob): scanner_failed, naming both reasons", async () => {
    const root = repo();
    commit(root, { "deploy.env": `AWS_ACCESS_KEY_ID=${AWS()}\n` }, "init");
    const blob = git(root, "rev-parse", "HEAD:deploy.env");
    rmSync(join(root, ".git", "objects", blob.slice(0, 2), blob.slice(2)));
    const fake = fakeGitleaks(["echo boom >&2", "exit 2"]);
    const scan = await scanHistorySecrets(root, { gitleaks: fake });
    expect(scan.notScanned).toBe("scanner_failed");
    expect(scan.reason).toContain("gitleaks exited 2");
    expect(scan.reason).toMatch(/git log exited 128/);
    expect(scan.findings).toEqual([]);
  });
});

describe("M3: gitleaks reads none of the repository's own configuration", () => {
  it("passes a harness-owned --config (gitleaks' default rules) and an empty --gitleaks-ignore-path outside the repository", async () => {
    const root = repo();
    commit(
      root,
      {
        "app.env": `TOKEN=${FAKE}\n`,
        ".gitleaks.toml": '[allowlist]\npaths = [".*"]\n',
      },
      "init",
    );
    const argsFile = join(root, ".gitleaks-args");
    const fake = fakeGitleaks([
      `for a in "$@"; do echo "$a" >> ${JSON.stringify(argsFile)}; done`,
      'report=""; cfg=""; ign=""; prev=""',
      'for a in "$@"; do case "$prev" in --report-path) report="$a";; --config) cfg="$a";; --gitleaks-ignore-path) ign="$a";; esac; prev="$a"; done',
      `echo "CONFIG-BODY $(cat "$cfg" | tr '\\n' ' ')" >> ${JSON.stringify(argsFile)}`,
      `echo "IGNORE-DIR $(ls -A "$ign" | wc -l | tr -d ' ')" >> ${JSON.stringify(argsFile)}`,
      `printf '[]' > "$report"`,
      "exit 0",
    ]);
    const scan = await scanHistorySecrets(root, { gitleaks: fake });
    expect(scan.scanner).toBe("gitleaks");
    const args = readFileSync(argsFile, "utf8").split("\n");
    const config = args[args.indexOf("--config") + 1] ?? "";
    const ignore = args[args.indexOf("--gitleaks-ignore-path") + 1] ?? "";
    expect(args).toContain("--config");
    expect(args).toContain("--gitleaks-ignore-path");
    expect(config.startsWith(root)).toBe(false);
    expect(ignore.startsWith(root)).toBe(false);
    expect(args.find((a) => a.startsWith("CONFIG-BODY"))).toMatch(/\[extend\]\s+useDefault = true/);
    expect(args).toContain("IGNORE-DIR 0");
  });

  it("a repository shipping a .gitleaksignore is scanned by the bundled rules instead, and says why", async () => {
    const root = repo();
    const leaked = commit(
      root,
      { "src/config.ts": `export const token = "${FAKE}";\n`, ".gitleaksignore": "anything\n" },
      "init",
    );
    const fake = fakeGitleaks(["printf 'should not run' >&2", "exit 2"]);
    const scan = await scanHistorySecrets(root, { gitleaks: fake });
    expect(scan.scanner).toBe("builtin");
    expect(scan.reason).toMatch(/\.gitleaksignore/);
    expect(scan.findings).toEqual([
      { commit: leaked, path: "src/config.ts", rule: "github-token" },
    ]);
  });

  it("keeps a gitleaks finding on a SHA-256 commit (64 hex)", async () => {
    const root = repo();
    commit(root, { "README.md": "# app\n" }, "init");
    const sha256 = "c".repeat(64);
    const fake = fakeGitleaks([
      'report=""; prev=""',
      'for a in "$@"; do if [ "$prev" = "--report-path" ]; then report="$a"; fi; prev="$a"; done',
      `printf '[{"RuleID":"github-pat","Commit":"${sha256}","File":"app.env"}]' > "$report"`,
      "exit 1",
    ]);
    const scan = await scanHistorySecrets(root, { gitleaks: fake });
    expect(scan.findings).toEqual([{ commit: sha256, path: "app.env", rule: "github-pat" }]);
  });
});
