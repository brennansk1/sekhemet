# The second run: one Web-Bench project (W2 G4, 2026-09-29)

**The choice:** Web-Bench's **`projects/fastify`**, *Fastify E-commerce* (a small shop: pages, products, login, cart, orders, admin), at commit **`7b31ca2b786eef120dd49ce63dd03d0c0006046d`** (2026-04-30, "fix playwright test version mismatch (#133)") of [github.com/bytedance/web-bench](https://github.com/bytedance/web-bench). It is used unchanged.

- **Where it lives:** `~/.sekhemet/webbench-src`, outside this repository and outside every sandbox write root, directory mode 700. It is a shallow fetch of that one commit: 26 MB on disk, 4.9 MB of it git.
- **What this repository holds:** this file and `manifest.json`, plus the runner's port of Web-Bench's protocol code (see *The licence*). The manifest records the commit, the licence, each task's SHA-256 and level, and the SHA-256 of all 81 files a scored run reads: the project, its two test libraries and the lockfile. No test text and no reference solution are in this repository.
- **The check:** `node scripts/capstone/webbench.mjs --check` passes only if the checkout is at the pinned commit and every one of those 81 files is unchanged, with none added or removed. It ignores only `node_modules`, and it refuses a checkout inside this repository. Tests: `apps/harness/tests/capstone_webbench.spec.ts`, which uses real git.

## Why this project

| Requirement | `projects/fastify` |
|---|---|
| TypeScript | The starting tree is `index.ts` and a `tsconfig.json`. The reference solution is 12 `.ts` files plus EJS views and CSS. It runs through `tsx`. |
| 20 dependent tasks | `tasks.yml` has `task-1` to `task-20`: 5 easy, 5 moderate and 10 challenging. Each builds on the one before. Task n is scored by running the tests of tasks 1 to n, so a later task that breaks an earlier one fails. |
| Hidden Playwright tests | `test/task-1.spec.js` to `test/task-20.spec.js`. Contestants never see them (see *Keeping the tests hidden*). |
| Fits this machine | One Fastify process and a SQLite file. There is no database server, no Next.js or Vite dev server and no Docker, and one headless Chromium. It is the lightest of the TypeScript full-stack projects. |
| Not trivially memorised | This is only partly true, and no Web-Bench project fully meets it. The tasks (dated 2025-05-12) and the reference solution have been public since May 2025. A small Fastify shop with exact selectors and texts is less cloned than a React todo app, but that is an inference, not a measurement. This is why Web-Bench is the secondary result. |
| A published baseline | The paper (arXiv 2505.07473v1, Appendix A.1.3) gives Fastify's **pass@2, best of five**: Claude-3.7-Sonnet 40%, Claude-3.7-Sonnet thinking 40%, Doubao-1.5 thinking 45%, Doubao-1.5 15%, GPT-4o 20%, DeepSeek-R1 20%. Across all 50 projects (Table 9), Claude-3.7-Sonnet thinking has pass@1 25.11% and pass@2 35.33%. |
| Closest to the capstone | A Node server with server-rendered pages, a SQL store, login and an admin role: the same shape as the timesheet app. |

**Considered and not chosen:**
- `expressjs` has the same tasks, but it is JavaScript.
- `nextjs`, `lowdb` and `sequelize` run a Next.js dev server, which uses more memory next to a 13 GB model and compiles lazily. The paper names Next's unstable API as a confounder.
- `nosql` downloads and runs a MongoDB binary (`mongodb-memory-server`), and `prisma` downloads its engine binaries.
- `fastify-react` runs two servers. The paper reports it fails simple tasks on a React Router v7 breaking change.
- `nuxt` is a heavier Vue full-stack project.
- The UI-framework and state-management projects are front-end only, with no server.
- The web-standards projects are JavaScript.

## The licence

- **Code and data: Apache License 2.0.** This is `LICENSE.md` at the pinned commit (SHA-256 `58d1e17f…d8bd`, in the manifest). The README says the same. Source files carry "Copyright (c) 2025 Bytedance Ltd. and/or its affiliates" with the Apache header. There is no NOTICE file.
- **The paper: CC BY 4.0.** arXiv shows this for 2505.07473v1. It covers the paper's text, tables and figures, not the repository.
- **Which applies to what we do:**
  - Running its tasks and tests, and building on its starting tree, is use of the code: **Apache-2.0**.
  - Quoting the paper's baseline numbers is use of the paper: **CC BY 4.0**, which needs attribution (cite the paper).
- **Our duties:**
  - No test, task text or reference solution of Web-Bench is redistributed; for those, this repository holds only hashes.
  - Some of Web-Bench's code is redistributed (W2b G3): `scripts/capstone/webbench_agent.mjs` ports bench-agent's prompt and reply reading, and the evaluator's error cleaning and pass counts.
    - The file keeps the copyright and Apache header, and says which files it changes and how (§4(b), (c)).
    - It stays under Apache-2.0, not this repository's licence, and the licence text is beside it (`webbench_agent.LICENSE.md`, §4(a)).
  - If we later publish its tests, its task texts, or a contestant's tree (which contains the starting `index.ts`), each copy keeps the Apache licence text and the copyright headers, and changed files say they were changed (Apache-2.0 §4).
  - Screenshots of a contestant's running app carry no such duty.
- **Not checked:** the licence of the Hugging Face copy of the dataset. We do not use it.

## The tests: where they are and how they run

- **Where they are:**
  - the 20 spec files: `projects/fastify/test/`;
  - the Playwright configuration: `projects/fastify/playwright.config.js`;
  - two helper libraries: `libraries/test-util`, whose `test.sh` chooses the files, and `libraries/shop-test-util`, which logs in, registers and adds products through the app's own API;
  - the database scripts: `projects/fastify/scripts/`.
- **How one task is scored:** Web-Bench's evaluator runs `npm run test -- <n>` in the project directory, with these settings:
  - `EVAL_PROJECT_ROOT` = the contestant's tree;
  - `EVAL_PROJECT_PORT` = a free port;
  - `IS_EVAL_PRODUCTION=true`, so it never reuses a running server;
  - `MAX_TEST_WORKERS`, which caps the Chromium workers (set it to 1 while a model is loaded).
- **What that command does:**
  1. `test.sh` runs `npx playwright test test/task-1.spec … test/task-<n>.spec`.
  2. Playwright's `webServer` runs `scripts/init-db.js`, which recreates `<tree>/test.sqlite` from the contestant's `libs/setup.sql`.
  3. It then runs `scripts/dev.js`, which starts `npx tsx <tree>/index.ts` with `PORT` and `DB_HOST`.
  4. The tests run in Chromium (Desktop Chrome), with a 60-second timeout per test.
  5. Exit 0 means task n passes.
- **The contestant's tree:**
  - It starts as `src-init/`: `index.ts`, `readme.md` (the allowed libraries) and `tsconfig.json`.
  - **For scoring** it must sit inside a copy of the project directory, because `fastify` and the other packages resolve from the project's `node_modules`. Web-Bench's own evaluator does the same. **During a contestant's run it never does** (see *Keeping the tests hidden*): a copy of the project around the tree would put `test/*.spec.js` (the hidden tests) and `src/` (the reference solution) one `..` away.
  - The contestant cannot add packages; its `readme.md` lists the libraries it may use.
- **Web-Bench's own metrics** (`projects/readme.md`):
  - Each task gets a first attempt. If it fails, a second attempt is given the test's error output.
  - **pass@1** = the tasks passed on the first attempt before the first failure, divided by 20.
  - **pass@2** = all tasks passed, counting retries.
  - **error@1** = the first attempts that failed.
- **Handing out a task:** `node scripts/capstone/webbench.mjs --task <n>` prints task n's description, byte for byte, as Web-Bench's evaluator reads it from `tasks.yml`. This was checked against the `yaml` parser for all 20 tasks. It prints nothing unless the checkout passes its check and the text matches its recorded SHA-256.

## The run, as built (W2b G3, 2026-09-29)

`scripts/capstone/webbench.mjs` runs one grid cell on Web-Bench's protocol and scores it. The protocol parts are ported from Web-Bench's own evaluator and agent into `scripts/capstone/webbench_agent.mjs`, which keeps their Apache-2.0 notice and licence text (see *The licence*). Tests: `apps/harness/tests/capstone_webbench_runner.spec.ts`, on a tiny project shaped like `projects/fastify`, with real git, a real web server and `@playwright/test` running one spec that passes on the starting tree and one that fails until the arm fixes it.

- **Commands:**
  - `webbench.mjs --deps-package <dir>` writes the `package.json` of the contestant's packages: the project's own, from Web-Bench's lockfile, less the tests' (`@playwright/test` and the two workspace libraries). They are installed there once (`npm install`, an approved download not yet made). The directory is `~/.sekhemet/webbench-deps` by default (`SEKHEMET_WEBBENCH_DEPS`).
  - `webbench.mjs prepare --arm <id> --run <n>` makes the run's directory and starting tree. The Sekhemet arm needs it first, to start `sekhemet serve` on the tree.
  - `webbench.mjs run --arm <id> --run <n>` runs the cell. It takes `--base-url` for a local one-shot model and `--url` for the Sekhemet arm's dashboard. An agentic cell also needs `--attach <cmd>` and `--detach <cmd>`: the commands that make the sealed volume readable for scoring and unreadable again before the arm works.
  - `webbench.mjs stats` gives each arm's pass@1 and pass@2 per run, and their mean.
- **Where a run lives:** `<runs root>/webbench-<arm>/<run>/`, beside the capstone's runs and in the same format: `run.json` (the arm, the pinned commit, the starting tree, the packages, the protocol), `log.jsonl` (every task given, every request, reply, turn and test run, with hashes), `input/` (each request, reply and error text as given), `repo/` (the tree) and `score.json`.
- **The starting tree:** `src-init/` only, copied from the pinned checkout after its check passes, with the installed packages copied into its `node_modules`. It is a git repository with one commit; `node_modules/` and `test.sqlite` are excluded from git. A package list holding `@web-bench/*` or Playwright is refused, because it would put the tests' own libraries in the contestant's reach.
- **Each task:** tasks 1 to 20 in order. Each text is read from `tasks.yml` and checked against its SHA-256 when the run starts.
  - **Attempt 1:** the task is given.
  - **Scoring:** the tree is scored (below).
  - **Attempt 2:** if the task failed, one retry carries the cleaned test output.
  - **Stop:** if the retry fails too, the run stops there, as Web-Bench's sequential mode does. An arm that errors (a request that does not fit the window, a refused message) fails that attempt, and its error is the retry's input. Web-Bench does this for a failed request only after bench-agent's own three retries, and it never refuses a request for its size: it prunes it to fit (see *Departures*).
- **What each row is given, identical within the row:**
  - **One shot:** bench-agent's request, byte for byte, through the grid's asker (the product's adapter or `claude -p` with no tools; `runner.mjs`):
    - its system message;
    - every file of the tree as a code block, with the files Web-Bench's ignore patterns leave out not shown (`tsconfig.json`, `test.sqlite`, `node_modules`);
    - the task;
    - then its "code only" line, or on the retry its sentence carrying the error.
    
    The reply's named code blocks are written into the tree as bench-agent reads them, and committed. A name that leaves the tree is refused.
  - **With a harness:** task n's text byte for byte. On the retry: the same text, then one fixed sentence and the cleaned test output.
    - **Claude Code:** one session for the whole run, with the grid's pinned configuration.
    - **Sekhemet:** Seshat, then the board worked as the capstone's person works it (`sekhemet_arm.mjs`).
    
    A question either harness ends on gets one fixed answer: the task's text is all there is. It gets it at most 3 times per attempt, within 30 minutes per attempt. These two budgets are PROPOSED, for the owner to confirm before R11.
- **Scoring a task:** it runs outside the contestant's reach, with the sealed volume attached.
  - **The copy:** a fresh copy of the project goes in the sealed scratch root, without its reference solution `src/`, beside its two test libraries. The tree is copied in beside them, without its `node_modules`, git or symbolic links, so the pristine packages are used.
  - **The command:** Web-Bench's own `test.sh` runs the specs of tasks 1 to n, with Web-Bench's settings: `EVAL_PROJECT_ROOT`, a free `EVAL_PROJECT_PORT`, `IS_EVAL_PRODUCTION=true` and `MAX_TEST_WORKERS=1`. `CI` is unset, so there are no Playwright retries.
  - **The limits:** 10 minutes per test run, and up to three runs when the web server did not start, as Web-Bench does.
  - **The error:** exit 0 passes; Web-Bench's tester instead passes a run whose cleaned error is empty (see *Departures*). Otherwise the error is Playwright's output cleaned as Web-Bench cleans it: no colour, no progress lines, no `<` lines, no blank lines, and every scratch path replaced by `.`. The test checks that no absolute path reaches an arm.
  - **Afterwards:** the scratch copy is removed.
- **Isolation:** an agentic cell is refused unless the grid's OS isolation check (`grid.mjs isolationProblems`) passes before every attempt. The runner attaches the sealed volume only to read the checkout and to score, and detaches it before the arm works again. The test does this with directory permissions and checks, from inside a stand-in `claude`, that the checkout was unreadable on every turn.
- **No network path (W2b fix round):** before every attempt of an agentic cell, the runner also tries a TCP connection to each host that serves Web-Bench's tests and reference (`WEBBENCH_HOSTS`: `github.com`, `api.github.com`, `raw.githubusercontent.com`, `codeload.github.com`, `objects.githubusercontent.com`, `cdn.jsdelivr.net`, which mirrors GitHub, `huggingface.co` and `cdn-lfs.huggingface.co`). If any answers, the cell is refused, naming the host. The operator blocks them for the run, with a firewall rule or `/etc/hosts` entries to `0.0.0.0`; that also covers a Sekhemet card granted the network and Claude Code's Bash tool, which `--disallowedTools WebSearch WebFetch` does not.
  - **What it does not cover:** a mirror not on the list (a code-search site, an archive), and a host reached through a proxy the operator set up. The list is the known hosts, not a proof that no copy is reachable.
  - Tests: the refusal with a probe that finds `raw.githubusercontent.com` open, and the probe itself against a real local server, listening and then closed. No test touches the network.
- **Seshat idle before scoring:** the Sekhemet row's attempt ends only when Seshat is idle, so no answer is in progress while the sealed volume is attached. If Seshat is still answering 10 minutes after the work ended, the attempt fails, unscored, with that reason. `sekhemet serve` itself keeps running during scoring, outside the sandbox, as the same user; its routes read the run's repository and ledger, not the sealed paths.
- **Scored:** Web-Bench's pass@1, pass@2 and error@1 (`projects/readme.md`, and its report's own `getPassCounts`), as percentages of all 20 tasks: pass@1 is comparable with the paper's Table 9, pass@2 with its per-project table. Tokens, cost and minutes come from the log.
- **Departures from Web-Bench, all recorded in `run.json` (`protocol.departures`, `webbench.mjs` `DEPARTURES`):**
  - **Fitting a request (one shot):** bench-agent fits each request to the model's context, pruning the chat history and then the prompt from its top (`compileChatMessages`, `pruneChatHistory`, `pruneRawPromptFromTop`). Here a request over the grid's common window is not sent, as for every one-shot cell of the grid: the attempt fails with that reason, the retry is larger still, and the run stops at that task. On a large tree this ends a one-shot run earlier than Web-Bench would.
  - **Request retries (one shot):** bench-agent retries a failed model request 3 times. Here a request is sent once (retries 0, as the grid's one-shot cells), and a failed request fails the attempt.
  - **What passes:** Web-Bench's tester counts a test run as passed when its cleaned error text is empty. Here a run passes when `test.sh` exits 0, and a non-zero exit fails it whatever its output. The two differ only when Playwright exits non-zero with nothing left after cleaning, or exits 0 with error text.
  - **Playwright:** `@playwright/test` is this repository's 1.61.1 (Chromium build 1228, already cached here), not the 1.57.0 Web-Bench pins.
  - **The test command:** `test.sh` is run directly, not through `npm run test` and `npx @web-bench/test-util`, which only lead to it.
  - **One message:** bench-agent's message parts are joined into one message, separated by a blank line, because the grid's one-shot cells take one prompt string.
  - **No file validation:** Web-Bench's HTML file validation on write is not run; this project's views are EJS.
  - **Runs:** the paper's per-project figure is best of five runs. Ours is 2–3 runs, reported as they fall, so it is not directly comparable.
  - **The error output** reveals some test detail. That is Web-Bench's design, and every cell receives it equally.
- **How long a real run takes:** estimated, not measured.
  - **Scoring:** a test run for task n runs n spec files in one Chromium worker, with a fresh server start. At about 5–30 seconds per spec file, scoring all 20 tasks once is about 10–60 minutes of Playwright, and retries add up to half as much again.
  - **One-shot cells:** 20–40 requests.
  - **Harness cells:** up to 30 minutes per attempt, so up to 20 hours in the worst case. A typical run will be far shorter.
  - **Check first:** the first real run should measure these on task 1 to 3.

## Keeping the tests hidden

The tests and the reference solution (`projects/fastify/src/`) are public on GitHub and are in the checkout on this machine. During a contestant's run:

- **No network path to them.** GitHub, its mirror jsDelivr and Hugging Face are blocked for the run, and the runner refuses an agentic cell while any of them can be reached (*The run, as built*, "No network path"). Claude Code's WebFetch and WebSearch are also disallowed, which alone would not stop its Bash tool.
- **No file path to them.** Mode 700 does not stop a process running as the same user. The checkout (and `~/.sekhemet/capstone-hidden`) must be unreadable by the contestant's process, for example:
  - a separate macOS user for contestants;
  - or the checkout kept on an encrypted disk image that is detached while contestants run.
- **Where the contestant's tree sits** (specified in the W2 fix round, 2026-09-29; built by W2b G3, see *The run, as built*):
  - during the run, alone in its own working directory under the runs root, started from a copy of `src-init/` only, with a `node_modules` holding the project's installed dependencies and nothing else (no `test/`, no `src/`, no `scripts/`);
  - for scoring task n, copied into a fresh copy of the project directory in the sealed scratch root, where `npm test -- <n>` runs; only the pass or fail and Playwright's error output for a failed task (Web-Bench's retry input) come back to the arm;
  - the runner's OS isolation check (`scripts/capstone/grid.mjs isolationProblems`) must pass first, as for the timesheet's agentic arms.
- **Built (W2b G3):** the runner and scorer, as above. What it still needs is the sealed volume (G4's scripts) and the installed packages.

## What it needs that is not installed

- **`@playwright/test`:** this repository's 1.61.1 is used (DEC-47 O-4). Its Chromium build 1228 is cached on this machine, so no browser download is needed. Web-Bench's 1.57.0 is not installed, a departure named above.
- **The project's packages,** from Web-Bench's lockfile: fastify 5.3.3, @fastify/autoload 6.3.1, @fastify/cookie 11.0.2, @fastify/static 8.1.1, @fastify/view 11.0.0, ejs 3.1.10, fastify-plugin 5.0.1, jose 5.10.0, sqlite3 5.1.7, tsx 4.19.4, typescript 5.6.3 and @types/node 22.15.32.
  - `webbench.mjs --deps-package` writes this list, read from the pinned lockfile.
  - Installing it is one approved download, not yet made. sqlite3 is a native module and fetches a prebuilt binary when it is installed.
- **Node.js:** Web-Bench declares Node ≥ 22 and its Docker image uses Node 22. This machine runs 26.0.0, which is untested with this project.
