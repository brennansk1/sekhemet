# The second run: one Web-Bench project (W2 G4, 2026-09-29)

**The choice:** Web-Bench's **`projects/fastify`**, *Fastify E-commerce* (a small shop: pages, products, login, cart, orders, admin), at commit **`7b31ca2b786eef120dd49ce63dd03d0c0006046d`** (2026-04-30, "fix playwright test version mismatch (#133)") of [github.com/bytedance/web-bench](https://github.com/bytedance/web-bench). It is used unchanged.

- **Where it lives:** `~/.sekhemet/webbench-src`, outside this repository and outside every sandbox write root, directory mode 700. It is a shallow fetch of that one commit: 26 MB on disk, 4.9 MB of it git.
- **What this repository holds:** this file and `manifest.json` only. The manifest records the commit, the licence, each task's SHA-256 and level, and the SHA-256 of all 81 files a scored run reads: the project, its two test libraries and the lockfile. No test text and no reference solution are in this repository.
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
  - Nothing of Web-Bench is redistributed now; this repository holds only hashes.
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

## Proposed use in the grid (for G5 and the lead to decide)

- **Identical input:** every cell gets the same things, in the same order:
  - the same starting tree;
  - task 1 to task 20's texts from `--task`;
  - after a failed task, the same single retry carrying Playwright's error output, as Web-Bench's protocol gives it.
- **Reported:** pass@1 (comparable with the paper's Table 9) and pass@2 (comparable with the per-project table), each over 2–3 runs.
- **Departures from Web-Bench:**
  - The paper's per-project figure is best of five runs. Ours is 2–3 runs reported as they fall, so it is not directly comparable.
  - The error output reveals some test detail. That is Web-Bench's design, and every cell receives it equally.
- **The one-shot row:** one reply per task, with no tools. For Web-Bench, "one shot" means one request per task, not one for the whole project, because the tasks are given in sequence by design.
- **The harness row:** Sekhemet and Claude Code each get task n and are free to work. When the arm says the task is done, the scorer runs `npm test -- <n>` outside the contestant's reach.

## Keeping the tests hidden

The tests and the reference solution (`projects/fastify/src/`) are public on GitHub and are in the checkout on this machine. During a contestant's run:

- **No network path to them.** Deny `github.com/bytedance/web-bench`, `huggingface.co` and web search (Claude Code: disallow WebFetch and WebSearch).
- **No file path to them.** Mode 700 does not stop a process running as the same user. The checkout (and `~/.sekhemet/capstone-hidden`) must be unreadable by the contestant's process, for example:
  - a separate macOS user for contestants;
  - or the checkout kept on an encrypted disk image that is detached while contestants run.
- **Where the contestant's tree sits** (specified in the W2 fix round, 2026-09-29; the runner is not built yet):
  - during the run, alone in its own working directory under the runs root, started from a copy of `src-init/` only, with a `node_modules` holding the project's installed dependencies and nothing else (no `test/`, no `src/`, no `scripts/`);
  - for scoring task n, copied into a fresh copy of the project directory in the sealed scratch root, where `npm test -- <n>` runs; only the pass or fail and Playwright's error output for a failed task (Web-Bench's retry input) come back to the arm;
  - the runner's OS isolation check (`scripts/capstone/grid.mjs isolationProblems`) must pass first, as for the timesheet's agentic arms.
- **Not yet built:** the Web-Bench runner and scorer (the arms, the retry, pass@1 and pass@2). `webbench.mjs` only checks the checkout and hands out task texts. The protocol above (one request per task for the one-shot row, one retry with the error output) is proposed, for the lead to confirm before R11.

## What it needs that is not installed (approved downloads; none installed)

- **`@playwright/test` 1.57.0,** pinned by Web-Bench's lockfile, and the Chromium build it pins. Chromium builds 1208 to 1243 are cached on this machine. Whether 1.57.0's build is among them is unverified; probably not.
- **The project's packages,** from Web-Bench's lockfile (`common/config/rush/pnpm-lock.yaml`): fastify 5.3.3, @fastify/autoload 6.3.1, @fastify/cookie 11.0.2, @fastify/static 8.1.1, @fastify/view 11.0.0, ejs 3.1.10, fastify-plugin 5.0.1, jose 5.10.0, tsx 4.19.4, typescript 5.6.3 and sqlite3 5.1.7. sqlite3 is a native module and fetches a prebuilt binary when it is installed.
- **Node.js:** Web-Bench declares Node ≥ 22 and its Docker image uses Node 22. This machine runs 26.0.0, which is untested with this project.
