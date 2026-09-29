# Capstone selection: the showcase project and how it is compared (2026-09-28)

**Decision (owner, 2026-09-28):**
- **Capstone:** a private, freshly written **shift timesheet and overtime-rules app** with a manager web UI.
- **Second run:** **one Web-Bench project**, reused unchanged, as an external comparison.

Both are given to Sekhemet with a local Coding model and to Claude models (Claude Code with Opus, Sonnet and Haiku), comparing time to completion and quality. Only the choice is made here. The brief, the scripted stakeholder conversation and the hidden tests are written and frozen before any run.

## Why these

What makes a comparison credible:
- **Hidden, freshly written tests.** SWE-bench Verified was retired for contamination and flawed tests ([OpenAI](https://openai.com/index/why-we-no-longer-evaluate-swe-bench-verified/)). Models recall popular repositories' paths far better than others' (76% against 53%, [arXiv 2506.12286](https://arxiv.org/abs/2506.12286)).
- **Mergeability, not only test passes.** METR found 38% of agent pull requests passed the tests and none were mergeable ([METR](https://metr.org/blog/2025-08-12-research-update-towards-reconciling-slowdown-with-time-horizons/)).
- **Change requests with regression checks,** as in Vibe Code Bench 1-100 ([vals.ai](https://www.vals.ai/benchmarks/vcb-1-100)).
- **Integration realism.** Most failures in SaaSBench are at system integration ([arXiv 2605.17526](https://arxiv.org/abs/2605.17526)).
- **Harness-and-model pairs, not model names.** The harness alone moved tokens per solved task by up to 40× ([arXiv 2607.22585](https://arxiv.org/abs/2607.22585)). This is the claim the showcase tests: the harness is more than the sum of its parts.

To avoid:
- Widely cloned apps (todo, Tetris, URL shortener, Markdown parser). This is an inference: no study measures it for these apps.
- One-run comparisons scored by feel ([TechCrunch](https://techcrunch.com/2025/01/24/people-are-benchmarking-ai-by-having-it-make-balls-bounce-in-rotating-shapes)).

### The capstone: timesheets and overtime rules

- **Deterministic and hard to fake.** The money arithmetic is exact, and the rules are real and citable:
  - Release 1: US federal weekly overtime over 40 hours ([DOL](https://www.dol.gov/agencies/whd/overtime)).
  - **The mid-project change request:** California's daily overtime past 8 hours, double time past 12, and the seventh-day rule ([CA DIR](https://www.dir.ca.gov/dlse/faq_overtime.htm)).
- **Edge cases where the checks earn their keep:**
  - shifts crossing midnight;
  - daylight-saving days;
  - rounding;
  - correcting an approved timesheet;
  - stacked rules counting the same hours twice (the known trap for a small model).
- **It exercises the whole process:**
  - a stakeholder conversation with Seshat;
  - Must/Should/Could requirements and re-planning after the change;
  - two or three releases (a changed CSV export forces a major version);
  - a timesheet grid for the visual and accessibility checks;
  - manager and employee roles.
- **Size:** about 20–30 issues in TypeScript on Node, with no external services or secrets.

### The second run: one Web-Bench project

Web-Bench: 50 TypeScript/web projects of 20 dependent tasks each, hidden Playwright end-to-end tests, a published baseline (Claude 3.7 Sonnet at 25.1%), and a permissive licence. **The licence, checked (W2 G4, 2026-09-29):** the repository's `LICENSE.md` is Apache-2.0 and governs the code, tasks and tests we run; CC BY 4.0 is the paper's own licence and governs quoting its results, with attribution. Sources: [arXiv](https://arxiv.org/html/2505.07473), [GitHub](https://github.com/bytedance/web-bench).

- **It gives:** comparability outside our own spec.
- **Its limits:**
  - public since May 2025, so it may be contaminated;
  - its task-by-task prompts bypass Sekhemet's brief and PM stage;
  - no change requests.

  It is the secondary result, not the capstone.

### Considered and not chosen

- **Meeting-room booking with RFC 5545 recurrence.** Daylight-saving recurrence arithmetic is likely too hard for the local model to finish.
- **A community tool library.** A good fit, but its correctness edges are weaker than payroll's.
- **Existing benchmark specs as the capstone:**
  - Commit0: Python, with visible tests ([arXiv 2412.01769](https://arxiv.org/abs/2412.01769)).
  - ProjDevBench: mostly C++ ([arXiv 2602.01655](https://arxiv.org/abs/2602.01655)).
  - Vibe Code Bench: needs external services and is partly private.

## Protocol (to freeze before any run)

- **Frozen inputs:**
  - one written brief;
  - one scripted stakeholder conversation, including the California change at a fixed point;
  - one empty seed repository with a pinned toolchain.
- **A hidden acceptance suite,** written in advance, never shown to any contestant, and published only after every run.
- **Arms:**
  1. Sekhemet with the local Coding model;
  2. Claude Code alone on the same brief (Opus 5.5, Sonnet 5, Haiku 4.5);
  3. optionally, Claude Code given Sekhemet's planned backlog, which separates planning's value from coding's;
  4. **a one-shot row** (owner, 2026-09-29): every model (nail-mtp, Qwen3.8-27B as a dense local model, Opus, Sonnet and Haiku) gets the same prompt in one request, with no tools, and the change request as a second request.

  **Every arm gets byte-identical input** (owner, 2026-09-29): one frozen `prompt.md` (the brief, the stakeholder's answers as an FAQ, and the interface contract) and one frozen `change_request.md`, both hash-checked when given. An agentic arm that asks gets answers only from that FAQ. The result is a grid: rows are one shot or with its harness, columns are the models. Rows show the harness effect, columns the model effect.

  Report each as a harness-and-model pair. Run each arm 2–3 times: one trial at non-zero temperature is not a finding.
- **The frozen input, as built (W2 G1, 2026-09-29):** in `fixtures/capstone/timesheet/`.
  - `prompt.md` is the brief, the stakeholder's answers as an FAQ and the technical notes (the HTTP API, the payroll CSV, the pages the screenshots use). `change_request.md` is the California letter, its answers and the changed notes. Both are rendered by `scripts/capstone/render_prompt.mjs` from `brief.md`, `stakeholder_script.json`, `contract.md`, `change_letter.md` and `contract_change.md`, and their SHA-256 are in `manifest.json`.
  - The stakeholder is fictional: Marisol Hollis, who owns a bakery in Vancouver, Washington, and opens a second shop in Sacramento for the change. The brief is silent on midnight, daylight saving, rounding, the week's start, self-approval and two managers editing at once; the FAQ answers each.
  - **An arm that asks** gets, word for word, the answers whose keywords match its question, from the phases it has been given, or else the default answer ("pick what a sensible owner would want, and say what you picked"). Nothing reaches one arm that another does not get.
  - **The change request's fixed point:** when release 1 is finished, or when release 1's time budget ends, whichever comes first. The tree is tagged `release-1` first, for the regression count.
    - Sekhemet: the person-simulator accepts release 1.
    - Claude Code: a turn of its session ends without a question (a question it ends on is answered from the FAQ, as Seshat's are).
    - One shot: after its first reply.
    - **The budget, the same for every agentic arm** (`runner.mjs` `AGENTIC`, recorded in each run's `run.json`): 360 minutes of wall-clock for release 1 and 180 for the change, after which the run ends; at most 20 FAQ answers per phase. These values were set in the W2 fix round and are **proposed, for the owner to confirm** before the first agentic run.
  - **Departures from the plan above:**
    - The "scripted conversation" is an FAQ given to every arm up front, not turns given only when asked, because the owner required byte-identical input (2026-09-29).
    - So the brief's silence on the edge cases never reaches any arm: every arm reads the answers before it starts. **The capstone does not measure whether a PM asks the right questions.** Seshat's questions in the Sekhemet arm are answered from the same FAQ, and can add only what a matching topic already says.
    - The hidden suite may test only what `prompt.md` and `change_request.md` determine.
- **The seed repository, as built (W2 G2, 2026-09-29):** `fixtures/capstone/timesheet/seed/`, the same for every arm.
  - **What it holds:** `package.json` and `package-lock.json` pinning Node.js 26.0.0 (also `.nvmrc`; `.npmrc` sets `engine-strict` and `save-exact`), TypeScript 5.9.3 and `@types/node` 26.0.1; a strict `tsconfig.json` compiling `src/` to `dist/` as ES modules; a `.gitignore`; and a README stating only what the repository provides. No application code and no tests. Tests use Node's built-in runner, so the toolchain is two packages and installs offline from this machine's npm cache.
  - **The commands:** `npm run build` (`tsc`), `npm start` (`node dist/main.js`) and `npm test` (compile, then `node --test "dist/**/*.test.js"`), as the technical notes name them. A contestant may change them and add packages. On the seed alone the build fails, so the hidden suite scores it 0.
  - **The interface the hidden suite uses** is the technical notes' HTTP API, payroll CSV and pages, reached through `npm start` with `PORT` and `DATA_DIR`. It never imports a contestant's code, so it depends on none of its internals.
  - **One repository per run:** `node scripts/capstone/seed.mjs <dest> --record <file>` copies the seed and commits it with a fixed author, date and message and no global or system git configuration. It tags the commit `seed` on `main`, so every run starts at the same commit, `a11835e7…`. That hash, the tree and every file's SHA-256 are frozen in `seed.json`, and a repository that comes out at any other commit is refused and removed.
  - **Refusals:** it refuses a Node.js other than the pinned one, and a destination that is inside this repository, inside the hidden suite's directory, or not empty. `--check` reports any drift from `seed.json` (R0 item 4).
  - **For a one-shot cell:** `--render` gives the seed as text in the reply format (`### path`, then the whole file); its SHA-256 is in `seed.json`.
  - Tests: `apps/harness/tests/capstone_seed.spec.ts`, with real git and a real offline `npm ci`, build, test and start.
  - **Departures:**
    - the plan suggested the app might also export a calculation module at a fixed path, but the frozen technical notes define only HTTP, so the suite calls nothing else;
    - whether a one-shot cell is shown the seed's text is the runner's decision (G5), since that is a second input the agentic arms receive as files.
- **The hidden suite, as built (W2 G3, 2026-09-29):** sealed outside the repository (`SEKHEMET_CAPSTONE_HIDDEN`). The repository holds only its record, `fixtures/capstone/hidden.manifest.json`: every file's SHA-256, one hash over them, the counts and the latest proof. The record sits beside `fixtures/capstone/timesheet/` (what a contestant may see), never inside it.
  - **What it holds:** 112 tests over the technical notes' HTTP API, payroll CSV and pages: 75 Must, 32 Should and 5 Could; 84 for release 1 and 28 for the change request. They include the concurrent-edit case (C.10 V-9), the overtime-pay rounding cases (V-11), and midnight and daylight-saving cases (V-10). The comments cite the DOL and DLSE pages.
  - **Not run:** 5 browser checks are written down but not run, because no browser runner is approved for the suite. So WCAG and the 400-pixel layout have **no executed hidden check**. The screenshots' accessibility count is the only accessibility measure.
  - **The proof** (`prove.mjs`, re-run 2026-09-29 after the record moved):
    - the empty seed scores 0/84 and 0/111;
    - the reference solution scores 84/84 as release 1, and 111/111 after the change;
    - the release-1 reference passes 0 of the 28 change-request tests.
  - **Who wrote it, disclosed:**
    - One agent wrote both the suite and the reference solution that "proves" it: `claude-opus-5-5`, a model of the same family as three contestant columns.
    - So the executed-reference check is circular: it shows the suite and the reference agree, not that either is right.
    - measurement.md (labels are "a person's or executed … never a model's") and FINISH_LINE_PLAN K2 require a person's confirmation. **It is pending.** Until a person checks the expected values, the suite is not registered in `fixtures/eval_assets.json`, and the scorer publishes nothing.
    - The W2 review hand-checked the expected values in the California and federal-pay tests, the CSV money and the workflow totals against DOL/FLSA and the DLSE FAQ: daily 8 and 12 hours, the seventh day, no pyramiding into the weekly 40, half-up rounding, and the DST dates. All were correct. That review is by an agent, so it is not the K2 check.
  - **For the K2 check:** two cases go slightly beyond the frozen text.
    - `state: ""` is refused with 400, where the notes say only that `state` defaults to "WA".
    - A rate of 0 on `/rates` is refused with 400 (a Could), where the notes say "positive" only for `POST /api/people`.
    - The person decides whether to keep them. Removing either is a new version of the suite, with a new hash and a new proof.
  - **The discrimination proof is thin:** it covers only the seed, the reference and the release-1 reference. No partly correct variant (banker's rounding, no DST handling, CA overtime pyramided into the weekly 40) has been scored to show that the federal and California tests catch those faults. That is proposed as part of K2.
- **The second run, as chosen (W2 G4, 2026-09-29):** Web-Bench's `projects/fastify`, a small Fastify shop in TypeScript, at commit `7b31ca2b…` (full hash in `fixtures/capstone/webbench/manifest.json`). The reasons, the tests and the proposed use are in `fixtures/capstone/webbench/choice.md`.
  - **Why this one:**
    - 20 dependent tasks (5 easy, 5 moderate, 10 challenging), with a Playwright spec per task;
    - a Node server with server-rendered pages, SQLite and an admin role, the capstone's shape;
    - no database server and no dev-server framework, so it fits beside a loaded model;
    - a per-project baseline in the paper (Appendix A.1.3, pass@2 best of five): Claude-3.7-Sonnet 40%, GPT-4o 20%, DeepSeek-R1 20%.
  - **Where it lives:** `~/.sekhemet/webbench-src`, fetched at that one commit, outside this repository (26 MB). The repository holds only the SHA-256 of the 81 files a scored run reads.
  - **The script:** `scripts/capstone/webbench.mjs --check` refuses another commit or any changed, added or removed file. `--task <n>` prints task n's text byte for byte, hash-checked. Tests: `apps/harness/tests/capstone_webbench.spec.ts`.
  - **How a task is scored:** Web-Bench's own command, `npm test -- <n>`, runs the specs of tasks 1 to n against the contestant's tree. Metrics are Web-Bench's pass@1 and pass@2.
  - **Departures:**
    - Its tests and reference solution are public, so hiding them needs OS-level isolation and no network path to GitHub or Hugging Face during a run, not only a directory outside the repository.
    - The paper's per-project figure is best of five; ours is 2–3 runs, reported as they fall.
    - **No runner or scorer for it is built yet**: `webbench.mjs` only checks the checkout and hands out task texts. Where the contestant's tree sits during a run (alone, never inside a copy of the project, whose `test/` and `src/` would be one `..` away) and at scoring is specified in `choice.md`; the retry protocol and the arms are proposed there, for the lead to confirm before R11.
- **Metrics:**
  - hidden-test pass rate by Must/Should/Could;
  - regressions after the change request;
  - wall-clock time and the person's hands-on minutes;
  - tokens or cost;
  - mutation score of each contestant's own tests;
  - type, lint, security and accessibility findings;
  - requirements delivered;
  - releases tagged;
  - a blind review of mergeability.
- **Screenshots in the public repository** (owner, 2026-09-29): every arm's finished app is captured at the same fixed views with the same seeded data, and published in `docs/showcase/capstone/` beside its scores. An app that does not start is shown failing.
- **The runner, the scorer and the screenshots, as built (W2 G5, 2026-09-29):** in `scripts/capstone/`.
  - **The grid** (`grid.mjs`): nine cells.
    - One shot: `one-shot-nail-mtp`, `one-shot-qwen3.8-27b`, `one-shot-opus`, `one-shot-sonnet`, `one-shot-haiku`.
    - With its harness: `sekhemet-local`, `claude-code-opus`, `claude-code-sonnet`, `claude-code-haiku`.
    - The Claude models are `claude-opus-5-5`, `claude-sonnet-5` and `claude-haiku-4-5`.
  - **Where a run lives:** `~/capstone-runs/<arm>/<run>/` (`SEKHEMET_CAPSTONE_RUNS`), which the runner never reads the hidden suite from. It refuses a runs root inside this repository, the hidden suite's directory or `~/.sekhemet`: the last is a sibling of the sealed suite and of Web-Bench's checkout, and the product's Seatbelt profile denies it, so a Sekhemet run there could not read its own sources.
    - `repo/` is the contestant's working directory: a fresh seed repository per run (`seed.mjs`).
    - `input/` holds the exact texts given and the replies received.
    - `log.jsonl` records every step and every simulated decision.
    - A run is never repeated in place: the next trial takes the next run number.
  - **The frozen input:** each text is read and checked against `manifest.json` just before it is given. A changed file is refused, never sent.
  - **Isolation for an agentic run** (`grid.mjs` `isolationProblems`): permission rules inside a harness are not a boundary, so the OS is checked from the user the harness runs as. A Claude Code or Sekhemet run is refused unless:
    - the hidden suite's directory, its scratch directory (`<hidden>-scratch`) and Web-Bench's checkout are **unreadable to this user**, because their volume is detached or they belong to another user with mode 700;
    - **no other run** under the runs root is readable (a finished run is moved to the sealed volume first);
    - no scorer scratch copy is left in the shared temp directory.

    On this machine today all three sealed paths sit in `~/.sekhemet`, readable by the owner, so every agentic run is refused until they are moved to a detachable disk image or another user's directory.
  - **One shot** (`runner.mjs one-shot`): one request per phase, no tools, no retries.
    - **The first request** is `prompt.md` byte for byte, then a fixed heading and the seed as text (its listing checked against `seed.json`).
    - **The second request** carries the conversation so far as one message, the same for every model. It holds the first request as it was sent, the first reply unchanged, then `change_request.md` byte for byte and the tree as the first reply left it. So a one-shot cell sees the notes the change request says "still hold", as an agentic arm does. The log records the hashes of the first request and reply it carries, and where `change_request.md` starts.
    - **What every one-shot cell also gets:**
      - the same one-line system text;
      - the same output allowance, 32,768 tokens;
      - the same **common window**, 131,072 tokens. A request whose estimated prompt (the product's rule, 3.2 characters per token) plus the output allowance exceeds it is **not sent**, for a Claude model as for a local one, and is logged as such;
      - reasoning off: the adapter's switch for a local model, and `MAX_THINKING_TOKENS=0` for Claude;
      - the same 6-hour limit on one request.
    - **The reply** is read in the format the prompt states. Nothing is repaired: a section that cannot be read (no fence, an unclosed fence, a path outside the repository or into `.git`) is counted and logged, and its file is not written.
    - After the first reply the tree is committed under a neutral identity and tagged `release-1`. A failed request is logged, and the change request is still given over the tree.
    - **A local model** is asked through the product's `HttpInferenceAdapter`, against its llama-server started beforehand. The server must report at least the common window per request (`/props` `n_ctx`), and the value it reports is recorded. Sampling is the registry's; if the registry has none, the family's published defaults are used and the log says so. Retries are 0 and reasoning is off; both are recorded.
    - **A Claude model** is asked through `claude -p --tools "" --strict-mcp-config --safe-mode --no-session-persistence --system-prompt <the one-shot line> --output-format json`, with the message on standard input. A reply that took more than one turn is refused. With `--via print` a person gives the same text by hand, then lands the reply with `--reply`.
  - **Claude Code** (`runner.mjs claude-code --arm <id> --run <n>`), driven by the runner, with no person in the loop:
    - **The command:** each turn is `claude -p` in the run's working directory, with the message on standard input. The configuration is pinned, so the operator's own setup never reaches the arm:
      - `--safe-mode`, so no `CLAUDE.md`, skills, plugins, hooks or custom agents of the operator's are loaded;
      - `--strict-mcp-config` with no server;
      - `--setting-sources project` (the working directory's own settings only), plus the run's settings file;
      - `--permission-mode bypassPermissions` and `--permission-prompts none`, so nobody answers a prompt;
      - `--disallowedTools WebSearch WebFetch`;
      - `--effort high` (proposed);
      - `--no-chrome` and `--output-format stream-json`;
      - one session: `--session-id`, then `--resume`.
    - **The settings file** denies the web tools, and the file tools' access to the sealed directories and this repository, by absolute path (`Read(//…)`). It is defence in depth only; the boundary is the isolation check.
    - **Questions:** when a turn ends on a question, the runner answers it from the FAQ (`person.mjs` `replyTo`), as Seshat is answered. The answer is logged as a simulated decision, at zero hands-on minutes.
    - **The change point:** the release-1 phase ends when a turn ends without a question, at the reply cap, or at the budget. Then the runner commits any work left uncommitted, tags `release-1` and gives `change_request.md` in the same session.
    - **Tokens:** from each turn's `modelUsage`, which counts every model the turn called, subagents included. The input is every prompt token read, cached or not, as a local server with its cache off reads them all. The cached part is also given apart.
    - The whole stream of every turn is kept in `input/`.
  - **Sekhemet** (`runner.mjs sekhemet prepare`, then `sekhemet drive`; `person.mjs`): a person-simulator plays the stakeholder and the person who accepts the work.
    - She answers Seshat only with the FAQ's words (`answerFor`), and approves the plan she is sent.
    - She accepts exactly what all checks pass and, where an AI reviewer is configured, its review too; she sends everything else back. The Review role ships unfilled until RG-P8-13, so the checks alone decide, as for Claude Code, and the log says that no review ran.
    - Each decision is logged as simulated, with zero hands-on minutes.
    - Her first step logs the run's start, gives Seshat `prompt.md`, and stops the arm unless the thread holds it whole.
  - **The scorer** (`score.mjs run`):
    - **The hidden suite:** checked against `fixtures/capstone/hidden.manifest.json`, then run through its own `run.mjs`: phase release-1 on the tree at `release-1`, phase change-request on the final tree. It is checked again after scoring, and a suite that changed meanwhile voids the score.
    - **Where scoring works:** every copy (the tree at `release-1`, the suite's install, build and catalogue) goes in the sealed scratch root beside the suite (`<hidden>-scratch`, mode 700), never in the shared temp directory. The suite and the app it starts get a scratch `HOME` and `TMPDIR` there.
    - **Which runs count:** `runValidity` lets a run into the statistics only if its log shows:
      - a start and an end;
      - `prompt.md` and `change_request.md` given at their frozen hashes;
      - release 1 finished (agentic) or both replies landed (one shot);
      - no `stopped` event.

      Any other run is scored but kept out of the statistics, and the statistics list it with the reason.
    - **Regressions:** release-1 tests that passed at the tag and fail after the change.
    - **Effort:** wall-clock, hands-on minutes, tokens and cost, from the run's log.
    - **Findings:**
      - type errors (`tsc --noEmit`, the tree's own TypeScript);
      - lint (Biome's recommended rules, one configuration for every arm);
      - security (Sekhemet's built-in checks on the diff from the seed; osv-scanner and semgrep are reported as not run when they are not installed);
      - hygiene: debug output left in the code only (at most 5). Sekhemet's changelog and commit-trailer rules are its own process, and would count against every other arm, so they are not counted;
      - Sekhemet's own checks for the project: always its npm template, never a `gates.toml` a contestant wrote, so every arm faces the same set;
      - accessibility (the visual gate's WCAG subset, from the screenshots run);
      - the releases the contestant tagged.
    - **Mutation score:** NOT RUN until Stryker is added.
    - **What is written where:** the suite's per-test results stay in the sealed directory. `score.json` holds counts only.
    - **Publishing:** refused until the suite is registered in `fixtures/eval_assets.json` as `capstone-hidden-suite`, at its frozen hash, labelled by `person: <name>` (K2). Execution alone is not enough here, because the same agent wrote the suite and the reference. An invalid run is never published.
  - **Statistics** (`score.mjs stats`, measurement rules 4 and 10–12):
    - **Per arm:** each run's pass rate with its exact interval, and pass^k and pass@k over its runs.
    - **Rows** (the harness's effect on one model) and **columns** (the models' effect within a row) are compared on the same tests. The test is the exact McNemar test on pass^k outcomes, and each comparison states the smallest difference it could detect.
    - **Equal k:** two arms are compared over the same number of runs, the smaller arm's, taken in run order. So an arm with three runs never faces a stricter all-runs criterion than one with two. The runs left out are stated.
    - An unresolved comparison reads "no clear difference".
  - **The blind packet** (`score.mjs packet`):
    - Each run's final tree goes under a random name, without `.git`, installed packages, build output, data, or the files a harness leaves (`.claude/`, `CLAUDE.md`, `AGENTS.md`, `.sekhemet/`).
    - Every word naming an arm, a harness, a model or its maker is replaced with `[redacted]`.
    - The key is written outside the packet.
  - **Screenshots** (`screenshots.mjs`):
    - **The app:** each finished tree is copied, installed, built and started as the technical notes say.
    - **The data:** the same people, shifts and approvals are loaded through the HTTP API: a 44-hour week, a 38-hour week, and a California week with a 13-hour day and a seventh day.
    - **The views:** captured at 1440 and 400 pixels with the visual gate's Chromium (`CdpBrowser`, confined):
      - the manager's grid;
      - the employee's view;
      - federal overtime;
      - the California case;
      - the payroll CSV;
      - an error state (a week name that is not a Sunday).
    - **An app that does not install, build or start:** its failure and log excerpt are its error-state screenshot, and every other view is recorded as not captured.
    - **Output:** `docs/showcase/capstone/<arm>/<run>/`. `--readme` writes the comparison page.
  - **Proof:**
    - The scorer scores the empty seed 0/84 (release 1) and 0/111 (after the change).
    - It scores the reference solution 84/84 and 111/111, with 0 regressions over 83 comparable tests and 0 type errors. Lint finds 3 errors in its 8 files, all non-null assertions: the count is real, not a scan of nothing.
    - Against the reference, the seeding is accepted at every step and every view loads.
    - Tests: `apps/harness/tests/capstone_runner.spec.ts`, `capstone_score.spec.ts` and `capstone_screenshots.spec.ts`.
    - The sealed runs (the scorer on the seed and the reference, the screenshots of the reference) are heavy, and copy the sealed reference. They run only with `SEKHEMET_CAPSTONE_SEALED_TESTS=1`, never in every gate.
  - **Departures:**
    - **The Sekhemet arm cannot yet be given the frozen input.**
      - `POST /api/pm/messages` keeps the first 8,000 characters, and `prompt.md` is 18,392 bytes, so the driver stops the arm.
      - The driver covers only the conversation's first step. Driving the plan's approval, the queue and each acceptance through the person-simulator is not built yet.
      - The Sekhemet cell also needs a `release_1_finished` and a `change_given` event from its driver before its runs can count.
    - **No agentic run can start on this machine yet.** The isolation check refuses every one until the hidden suite, its scratch directory and Web-Bench's checkout are on a detachable volume or another user's (see *Isolation for an agentic run*).
    - **The Claude Code command has not been run against the real CLI.** It was checked against a stand-in that records its arguments. A dry run with a cheap model should confirm, before R10, that `--permission-mode bypassPermissions` with `--permission-prompts none` runs unattended, and that the deny rules load.
    - **`claude -p` may retry a failed API call itself.** The runner cannot turn that off; a one-shot reply that took more than one turn is refused.
    - **Input beyond `prompt.md`:** one-shot cells get the one-line system text, the same for every one-shot cell. Claude one-shot cells run through Claude Code's client, with thinking asked off (`MAX_THINKING_TOKENS=0`). Whether a model honours that is not visible in `claude -p`'s JSON output.
    - **Tokens are not the same kind of cost across rows.** Claude's cached prompt tokens are counted as read, like a local server's (whose cache is off). The cached part is reported apart, because the price differs.
    - **The Claude Code arm runs with full permissions** inside the isolation check, as the Sekhemet arm runs inside its sandbox. That is equal freedom, not an equal sandbox.
    - **A trailing newline** that Seshat strips from the frozen text is accepted and recorded as such. The runner gives Claude Code the frozen bytes itself, on standard input, and logs their hash.
    - **Mutation score:** NOT RUN, because Stryker is not added. `prompt.md` tells every arm that its own tests are measured by mutation testing, so either Stryker (approved, DEC-47 O-4) is added before the first run, or the report says the stated metric was not delivered.
    - **The blind packet keeps some fingerprints:** it drops `.git`, `CLAUDE.md` and `.sekhemet/`, but keeps a harness's working style: a Sekhemet-style `CHANGELOG`, card or requirement ids, and the PM's documents. So the reviewers are not blind in practice. Normalising those is not built.
    - **Requirements delivered** is not computed separately: the Must/Should/Could counts stand in for it.
    - **Statistics:** the hidden tests are not independent trials (many share a setup), so intervals over tests are indicative.
    - **Screenshots:**
      - The CSV is shown as the app returned it, on a neutral page, because a browser tab cannot send `X-User-Id`.
      - Images are capped at 2,400 pixels tall and not recompressed, because no PNG optimiser is approved.
      - The Chromium capture test runs only with `SEKHEMET_CAPSTONE_CHROMIUM=1`. It was not run in this workstream, because a live model run may be using the machine.
- **The capstone doubles as B4.11's milestone:** a team takes a project from a stakeholder's conversation to an accepted release.
  - **Departure:** teams.md §6 asks for five people at four levels on a Team install. That needs R12's scripted-actors driver, which W2 did not build. The Sekhemet arm here is Solo, with one simulated person.

## Not verified by the research

- DevBench's exact implementation pass rate.
- Whether ProjDevBench's tests are hidden.
- Which Vibe Code Bench split is public.
- App-Bench's grading method.
