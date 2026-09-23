# S1 / S2 fix review (uncommitted diff, 2026-09-22)

Scope: `packages/sandbox/{seatbelt,bubblewrap,permissions}.ts`, `packages/sync/{git_hardening,git_adapter,index}.ts`, `apps/harness/src/index.ts` and their specs. Read-only review. I ran the four specs: 32/32 pass (containment runs for real under Seatbelt on this Mac; bubblewrap is checked on argv shape only).

## Verdicts

| Fix | Verdict | Why |
|---|---|---|
| S1a Seatbelt denies `<root>/.git` (literal + subpath, after the grants) | **Closes** for the root `.git` when the write comes from a sandboxed command | Rule order works (tested: rewriting the pointer and appending to `.git/config` both fail). Creating a `.git` where none exists is also denied, because the literal is denied whether or not the path exists. Not covered: `.git` at deeper levels, and (untested) case variants and hard links. |
| S1b bubblewrap `--ro-bind <root>/.git` after the writable binds | **Partially closes** | The mechanism is right (a bind mount also prevents unlink, rename and cross-mount hard links). But it applies only if `.git` exists at launch, it only protects the root, and bwrap never actually runs in tests. |
| S1c PermissionEngine `(^|/)\.git(/|$)`, case-insensitive | **Does not close against a Worker with a shell** | The pattern itself is fine: `.GIT`, `./.git`, `sub/.git` and a trailing slash all match, and backslashes and trailing dots are ordinary filename characters on POSIX. The problem is that it only sees the raw path (see G1). |
| S1d `GIT_CONFIG_COUNT` → `core.fsmonitor=false`, `core.hooksPath=/dev/null` | **Partially closes** | Correct precedence (env beats every file). Git applies it to submodule children too (I did not test this). But it neutralises only 2 of the many config keys that run programs. |
| S2 only `.vite-temp`, `.vite`, `.cache` writable under a linked `node_modules` | **Partially closes** | The dependency code is now read-only (tested with a real write attempt). The cache directories left writable still hold code the user later runs unconfined (G4). |

## Remaining gaps (ranked)

**G1 — High. A symlink alias gets around S1c.** `ToolExecutor.authorize` (packages/loop/src/tools.ts ~410–424) checks the raw `call.arguments.path`. The write itself goes to `resolveInWorktree(...)`, which resolves symlinks, and `atomicWrite` then renames onto that resolved target. A sandboxed command may create a symlink anywhere in the worktree, including one whose target is `.git`, because Seatbelt only denies writes *to* `.git`. A later `write_file` naming that alias passes the pattern check and replaces `<wt>/.git` from the unconfined harness process, where Seatbelt does not apply. After that, S1d is the only layer left, and it does not cover a gitdir the Worker wrote itself (G3). So S1 remains reachable end to end.
*Fix:* run the protected-path check on `relative(root, resolvedPath)` as well as on the raw string, or refuse writes whose path contains any symlink component (lstat each component). Stronger still: the harness pins `--git-dir`/`GIT_DIR` and `GIT_WORK_TREE` from its own record of `<main>/.git/worktrees/<name>`, and checks that the pointer's content matches before every git call. Then rewriting the pointer changes nothing.

**G2 — Medium–High (unverified). Nested repositories.** Only `<root>/.git` is protected, so a sandboxed command can create `sub/.git`. The harness's `git add -A` (integrity.ts:94/115, execute.ts:871, index.ts:745) then stages it as a gitlink. On later `status`/`diff` runs, git checks submodule dirtiness by running a child git inside `sub/`, using config the Worker wrote. S1d keeps fsmonitor and hooks off there, but clean/textconv filter drivers from that config still run.
*Fix:* add a Seatbelt deny for `.git` at any depth under each root. Use a `regex` anchored to the escaped root, with `[Gg][Ii][Tt]`. Also add `diff.ignoreSubmodules=all`, `submodule.recurse=false` and `safe.bareRepository=explicit` to `HARDENED_GIT_CONFIG`, and fail the card if the staged diff adds a mode-160000 entry.

**G3 — Medium. S1d is thin.** Other program-running settings are untouched: `filter.*.clean/smudge/process` selected by a Worker-writable `.gitattributes`, `diff.external` (the harness runs `git diff --cached` without `--no-ext-diff`), `diff.*.textconv` (git_history, `git show`), `gpg.program` with `commit.gpgSign` on harness commits, `core.sshCommand`/`credential.helper` on push (execute.ts:1540), and `include.path`. These only matter if config becomes untrusted (G1/G2), which is exactly the case S1d is meant to backstop. Separately, `hardenGitForProcess` skips itself whenever `SEKHEMET_GIT_HARDENED=1`, a flag that anyone can set in the environment.
*Fix:* pinned git-dir (G1). Pass `--no-ext-diff --no-textconv` on harness diff/show/log. Add the keys listed in G2. Decide "already hardened" by checking that the keys are actually present, not by trusting the flag.

**G4 — Medium. S2 cache poisoning.** `node_modules/.vite/deps` holds pre-bundled dependency code that the user's `vite dev`, SSR and vitest execute in the main checkout. `node_modules/.cache` holds transpiled output from babel-loader, terser and storybook that the user's builds reuse. Both are writable, and both are shared with concurrently running cards (card A can poison card B's gates). This is narrower than before but the same class of problem: code the user later runs unconfined.
*Fix:* give each worktree its own `node_modules` overlay: a real directory whose entries (`.pnpm`, `.bin`, packages, `.modules.yaml`) are symlinks into the main checkout. Caches are then created inside the worktree and deleted with it, and nothing outside the worktree needs a write grant.

**G5 — Low–Medium (unverified). Seatbelt path canonicalisation.** Two cases are untested: a case variant of `.git` on case-insensitive APFS, and a hard link to the pointer file (or, when the root is a main checkout as in airgap.ts:425 and doctor.ts:130, to files inside `.git/`) followed by an in-place write. Matching on existing vnodes probably uses the stored name, but that should be tested rather than assumed.
*Fix:* add both cases to containment.spec. If either write gets through, also deny hard-link creation whose source is in the protected set.

**G6 — Low. Linux asymmetry.** bubblewrap protects `.git` only if it exists at launch. For a root without one (scratchDir, a greenfield project directory), the Worker can create one on Linux, whereas macOS denies it. *Fix:* the harness refuses to run git in a root whose `.git` it did not create itself.

**Note — Low–Medium.** Worker-editable tracked files that tools run implicitly are not protected in the sandbox: `.githooks/` (this repo's `core.hooksPath`), `.husky/`, `.pre-commit-config.yaml`, `.gitattributes`, `.gitmodules`. They execute on the user's next commit after an accept. The accept review should flag diffs to these paths explicitly.

## Breakage risks

- **Hooks are off for every harness git call, including the accept merge into main** (git_adapter.ts:538). That skips the user's pre-commit and commit-msg hooks (husky, lefthook, the pre-commit framework, and **secret scanners such as gitleaks**), overrides a global/corporate `core.hooksPath`, and skips this repo's own `.githooks/commit-msg` (trailer_gate covers that one). **git-lfs:** the harness `git push` no longer runs LFS's pre-push hook, so LFS objects are not uploaded and the remote ends up with dangling pointers. Post-checkout/post-merge lock handling is skipped too.
- **Product choice:** disabling hooks is right. Hook scripts are often tracked files the Worker could have edited, so running them at accept means running Worker code unconfined. Recommended approach:
  - Run the user's hooks as sandboxed **gates**, taken from the base branch's version of the hook files.
  - Detect LFS and run `git lfs push` before pushing.
  - Document it in the README security section and in `doctor` output: "Sekhemet's own git commands never run git hooks or fsmonitor. Put pre-commit checks in gates. LFS: …".
- `core.fsmonitor=false`: slower status on very large repos that rely on the fsmonitor daemon. Harmless otherwise.
- **S2 / `.venv`:** `.venv` is now fully read-only, because the cache helper keeps only `node_modules` targets. Installs from pip, uv or poetry fail, which is intended. Failed `__pycache__` writes are ignored silently. Pytest, mypy and ruff caches live in the worktree, so they are fine.
- **Toolchains that now break:**
  - create-vite templates put `tsBuildInfoFile` in `node_modules/.tmp/` (`tsc -b` fails with EPERM).
  - `prisma generate` (writes to `node_modules/.prisma`, `@prisma/client`).
  - `patch-package` and codegen that writes into node_modules.

  These still work:
  - Prettier, babel and storybook caches (`.cache`) and vitest (`.vite`, `.vite-temp`).
  - The ESLint cache (`.eslintcache` in the cwd) and jest (its cache is in `os.tmpdir`, i.e. the scratchDir).

  The overlay in G4 fixes the breakages without reopening the hole.
- `bubblewrapArgv` looks like a pure function but now runs `mkdirSync` inside the user's main `node_modules`, and the unit test runs it too. Minor.

## Test assessment

- **containment.spec (darwin):** these are genuine attempts from inside Seatbelt. Each test verifies the exit code *and* that the file content is unchanged, and there is a positive control showing caches stay writable. Good. Missing: `.GIT`, symlink and hard-link aliases, rename-over or delete of the pointer, creating `.git` where none exists, `sub/.git`, and creating a *new* file inside the dependency tree.
- **bubblewrap.spec:** the reversal is correctly the stricter assertion. It now asserts that no `--bind` ends in `node_modules` and that the `.vite-temp` bind is present. The `.git` test checks ordering only, with a directory `.git`, never the pointer-file case. Nothing runs under a real bwrap, so this is structural confidence only. Add a Linux CI job that runs the containment cases under bwrap.
- **permissions.spec:** positives and negatives are sound (`.gitignore` and `.github/` stay allowed). But it tests raw strings only, so it cannot catch G1. Add a symlink-alias case at the ToolExecutor level.
- **git_hardening.spec:** the fsmonitor test has a non-vacuous control. Good. Hooks are only asserted as keys being present; no hook ever runs. It never exercises `hardenGitForProcess` or the flag short-circuit, never checks that the adapter and loop call sites are hardened, and never checks submodule propagation. Add a marker test with a pre-commit hook, run with and without the env.
