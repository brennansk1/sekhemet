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
    - Its tests and reference solution are public, so hiding them needs OS-level isolation and no network path to GitHub or Hugging Face during a run, not only a directory outside the repository. The runner refuses an agentic cell while any host that serves them can be reached (`webbench.mjs` `WEBBENCH_HOSTS`, a TCP connection tried before every attempt); the operator blocks them for the run. A mirror not on the list is not covered (`choice.md`, *No network path*).
    - The paper's per-project figure is best of five; ours is 2–3 runs, reported as they fall.
    - **The runner and scorer (W2b G3):** `webbench.mjs prepare`, `run` and `stats`, described in `choice.md` (*The run, as built*).
      - **Each task:** task n is given to a grid cell. The one-shot row gets bench-agent's request, byte for byte. The harness row gets the task's text, and Claude Code or Seshat then works on it.
      - **Scoring:** each task is scored by Web-Bench's own `test.sh` against a copy of the tree in the sealed scratch root.
      - **The retry:** one retry carries the cleaned test output. The run stops after a task fails both attempts.
      - **Results:** pass@1, pass@2 and error@1 go to `score.json` in `<runs root>/webbench-<arm>/<run>/`, beside the capstone's runs.
      - **Isolation:** an agentic cell is refused unless the OS isolation check passes, and no Web-Bench host can be reached, before every attempt. The sealed volume is attached only to read the checkout and to score, and the Sekhemet row's attempt ends only once Seshat is idle.
      - **Departures,** recorded in each `run.json` (`protocol.departures`) and in `choice.md`: a one-shot request over the common window is not sent where bench-agent prunes it to fit, and it is sent once where bench-agent retries three times; a test run passes on exit 0 where Web-Bench's tester passes an empty cleaned error; Playwright 1.61.1 in place of 1.57.0; `test.sh` run directly; bench-agent's message parts joined into one message; no HTML file validation.
      - **Not yet run on the real project:** its packages are not installed (one approved download), and the agentic budgets (30 minutes and 3 answers per attempt) are proposed.
      - Tests: `apps/harness/tests/capstone_webbench_runner.spec.ts`.
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
    - no scorer scratch copy is left in the shared temp directory;
    - the vault holding the sealed material, when there is one, is **not attached anywhere** (`hdiutil info`; W2b G4). If `hdiutil` cannot say, the run is refused.

    On this machine today all three sealed paths sit in `~/.sekhemet`, readable by the owner, so every agentic run is refused until they are migrated into the vault (below). The migration is the lead's step; it has not been run.
  - **The vault, as built (W2b G4, 2026-09-29; `scripts/capstone/vault.mjs`):** the sealed material in an encrypted disk image, mounted only to migrate and to score.
    - **The image:** a sparse APFS disk image made with the system's `hdiutil`, AES-256, beside the hidden suite (`~/.sekhemet/capstone-vault.sparseimage`, or `SEKHEMET_CAPSTONE_VAULT`). It holds `capstone-hidden`, `capstone-hidden-scratch` and `webbench-src`, each mode 700 on a mode-700 volume. It is mounted only at `~/.sekhemet/capstone-vault`, hidden from Finder (`-nobrowse`), and nowhere else: attached elsewhere, mounting is refused.
    - **The passphrase:** 32 random bytes, handed to `hdiutil` and `security` on standard input only, never in a process's arguments. It is kept only in the keychain (the login keychain, or `SEKHEMET_CAPSTONE_VAULT_KEYCHAIN`), as the item "Sekhemet capstone vault", whose access list trusts **no application**: every read shows the person a dialog. It is never written to a file, a log, the ledger or the repository, never printed, and scrubbed from any error text. The person chooses **Allow**, never *Always Allow*, which would add `security` to the list. `status` checks the list (`security dump-keychain -a`, which reads access lists, not secrets) and says when an application has been let in.
    - **The sealed paths stay where the runner and scorer look** (`~/.sekhemet/capstone-hidden` and the rest), as links into the mount point. Detached, the links lead nowhere, so they are unreadable, and the isolation check can pass.
    - **Commands:** `create [--size 4g]` (refused when an image or a stored passphrase already exists: a second would orphan the first), `migrate`, `mount`, `unmount` (forced when something holds the volume open; an error if it is still attached), `status`, and `restore`, the rollback.
    - **`migrate`:** each sealed directory is copied in with `ditto` (links, modes and extended attributes kept), checked entry by entry (path, kind, permission bits, content hash, link target), then replaced by a link, and **the original is deleted**. A missing one is made empty in the vault. A path already linked is left alone, so it can be run again. The vault is unmounted afterwards, whatever happened.
    - **`restore`:** copies each directory back out, checked the same way, in place of its link, mode 700. The vault keeps its copy.
    - **Scoring** (`score.mjs run` and `stats`): `withVault` mounts the vault (the person is asked), scores, and unmounts it in a `finally` block. If scoring succeeded but the vault will not unmount, the command fails, because the next agentic run would be refused. When the sealed material is not in a vault, scoring runs as before.
    - **Tests** (`capstone_vault.spec.ts`, macOS only): real `hdiutil` and `security`, a 64 MB image and a keychain file of the test's own, never the login keychain, both removed afterwards. They cover: the image is encrypted, AES-256 under the stored passphrase; the access list's decrypt entry trusts no application after `create` from the command line; a second `create` is refused; `migrate` leaves links that are unreadable while detached and identical trees while mounted; the isolation check passes only while the vault is unmounted; the passphrase is in no file under the test's directories; `restore` brings back identical trees; `withVault` unmounts when the work fails; and the scorer mounts to score and unmounts after a refusal.
    - **Departures:**
      - **The dialog itself is not tested.** A test cannot answer it, so the tests that mount give their own keychain's item one trusted application, `/usr/bin/security` (`createVault`'s `trustedApps`, not offered on the command line). The first test checks that the command line's `create` trusts none. A person's first `mount` is the check that the dialog appears.
      - **While the vault is mounted, the contestant's app runs inside the scorer** with the suite readable to it, as before the vault. The suite is checked against its manifest after scoring, so a change is caught; a read is not. No agentic run may be in progress while scoring: the runner checks isolation before each attempt, not during one. On Web-Bench the Sekhemet row's attempt ends only once Seshat is idle (at most 10 minutes after its work ends, or the attempt fails unscored); its `sekhemet serve` keeps running during scoring, unsandboxed, as the same user, and could read the mounted vault, though none of its routes reads the sealed paths.
      - **The dialog is the only barrier, and it can be worn down by habit.** A Web-Bench agentic cell mounts about 40 times, and an agent that runs `security find-generic-password -s sekhemet-capstone-vault -w` raises the same dialog; the keychain is reachable from inside the sandbox (security.md, still open). So every mount first prints a line saying the dialog that follows is the runner's (`vault.mjs` `MOUNT_NOTICE`). **The person chooses Allow only when that line has just appeared and no arm is working, and Deny at any other time.**
      - **An interrupted move leaves a copy in the clear.** `migrate` puts the original aside (`<path>.moving-to-vault`) before it links and deletes it, and `restore` copies to `<path>.restoring`. A crash or a failed delete leaves that copy readable while the sealed path is already a link, so the isolation check refuses every agentic run while either is readable, and says to check the vault and delete it (`capstone_runner.spec.ts`).
      - **macOS only.** On Linux, the sealed paths are made another user's, mode 700, as the isolation check already allows.
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
  - **Sekhemet** (`runner.mjs sekhemet prepare`, then `sekhemet drive`; `sekhemet_arm.mjs`, its decisions in `person.mjs`; W2b G2, 2026-09-29): a person-simulator plays the stakeholder and the person who accepts the work, against a running `sekhemet serve` (Solo) on the run's repository. She does only what a person can do on the dashboard or at a terminal:
    1. **The brief:** `prompt.md`, hash-checked, as her first message (`POST /api/pm/messages`). The arm stops unless the thread holds it whole; a long message's committed document is checked against `prompt.md`'s own SHA-256, the bytes sent, final newline and all.
    2. **The conversation:** every proposal in Seshat's reply is applied (`planDecision`: she approves the plan she is sent, as drafted; the plan's own questions are left to their defaults, recorded by the product as assumptions). A question is answered only with the FAQ's words (`replyTo`), at most `maxReplies` (20) answers a phase. The conversation ends when a reply asks nothing, at the reply cap, on a failed reply or at the budget.
    3. **The criteria:** each issue waiting in Planning for a person's approval is approved as shown (`GET`, then `POST /api/cards/:id/approve` with the hash she saw). An issue the product still holds (its criteria refused by the lint, say) stays held, with the product's reason logged.
    4. **The queue:** `sekhemet queue --repo <repo>`, as a person runs it in a terminal, its output kept in `input/`. At the phase's budget it gets Ctrl+C (stop after the current turn), a second after 60 seconds, then a kill after 30 more.
    5. **Review** (`acceptDecision`), once per evidence bundle, on the latest evidence's checks (every rung that ran) and the AI review (`GET /api/cards/:id/review` `findings` since that evidence):
       - a verdict on the criteria means the review ran; it passed only when every verdict is `met` (`unmet`, `unclear` and Seshat's older `likely_send_back` do not pass);
       - `not_reviewed` in the product's own words for no Review model (`REVIEW_DESK_COPY.noReviewer`) means no reviewer is configured, so the checks decide alone and the log says no review ran;
       - any other case (a review that failed, or none recorded) is treated as a reviewer configured with no review, so the issue is sent back: nothing is accepted unreviewed.

       Accepted: the files Accept requires are opened (`POST …/opened`), then Accept, acknowledging the findings shown. Otherwise it is sent back (`POST …/return`) with the rule's reason and the review's own words.
    6. **The next issue:** when nothing is Ready, she moves the next Backlog issue of the phase, in the board's order, with the product's own `/ready <issue>` in Seshat's composer ("Move an issue to Ready.", `pm/slash.ts`; the move is the person's on the ledger). Each issue is tried once for a given board; the product's answer is logged (`move to Ready`, with `moved` and the reply), and a refusal (it waits on an issue not done, say) moves on to the next. During release 1 she does not move an issue of a later release (the story map's later slices).
    7. Steps 3 to 6 repeat. The phase ends when every issue it holds is done (release 1: every issue not in a later release) or at its budget. **A stall is not an end:** when nothing is Ready or in Review and nothing can be moved, or a queue pass moves nothing, what waits is logged with the product's reasons (`no_ready_issue`) and the board is looked at again every minute until the budget ends. So the fixed point is always "release 1 finished" or "its budget ended", as above.
    8. **The fixed point:** she accepts release 1 on the product (`POST /api/slices/<id>/accept`), and when the product proposes its release she tags it (`sekhemet release --confirm <id>`). A refusal is logged with the product's reason. Then the runner tags the integration branch `release-1` and logs `release_1_finished`.
    9. **The change:** `change_request.md`, hash-checked, as her next message (`change_given`), then steps 2 to 7 for the change phase, then `end`.

    Accept moves the integration branch by plumbing and leaves a checkout on it behind (RG-S5-2). After every act that moves the branch she runs the command the product's notice gives (`git read-tree -m -u <old> main`), so the tree scored is what was accepted.

    Each decision is logged as simulated, with its basis and zero hands-on minutes. The budgets (`AGENTIC`: 360 and 180 minutes, 20 answers) are in `run.json` and the log's `start`.

    **Tokens:** every role's, per phase, from the product's ledger ([measurement](../design/specs/measurement.md) rule 4a, fix round F2): the Coding model's from its card steps (`card/step`), Seshat's and the Planning, Review and Research models' from `model/usage`. Each `usage` event names every role's share (`byRole`: input, output and cache-read tokens and requests) and marks nothing as not counted, so the Sekhemet arm's tokens are compared with the other arms'; the scorer totals each role over the run (`effort.tokensByRole`). Input tokens include those the server reused from its cache (`cacheReadTokens` is that share). The W2b note that tokens were not compared until every role was recorded is closed by this.

    **Tests:** `capstone_sekhemet_arm.spec.ts`: a real dashboard server on the run's own seed repository, real git and SQLite, Seshat scripted in-process and the Worker loop against the milestone runners' stand-in model server (`stand_in.mjs`, whose `buildCards` now takes the queue's review hook). The test covers:
    - the whole run, a send-back on a failed AI review and the rebuilt issue accepted, the next issue moved with `/ready`, and the stall waited out to the budget before the change is given;
    - a stall on its own: one `/ready` per board, refused, then waiting until the budget ends;
    - the reply cap;
    - the queue's command and its Ctrl+C at the budget;
    - the checkout brought up to the branch;
    - the product's `release --confirm`, run for real.

    `runValidity` accepts the run.
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
    - **The Sekhemet arm's frozen input (W2b G1, 2026-09-29):** Seshat now keeps a message whole (planner-pm NEW-planner-pm-10), so `POST /api/pm/messages` takes `prompt.md`'s 18,392 bytes and the thread holds the text sent, its surrounding whitespace trimmed, which the driver accepts and records (`pm_long_message.spec.ts`, a real server; the driver itself against a real server in `capstone_sekhemet_arm.spec.ts`). Because the message is longer than 8,000 characters, it is also:
      - **committed** in the arm's repository at `docs/product/inputs/<day>-what-i-need-timesheets-and-overtime-for-hollis-bakery.md`, byte for byte (the bytes sent, final newline and all, so its SHA-256 is `prompt.md`'s), in one documenter commit on the integration branch. The arm's own repository therefore holds its frozen input as a file, which the other arms' repositories do not, so the blind packet drops `docs/product/inputs/` (`score.mjs` `HARNESS_FILES`; `capstone_score.spec.ts`).
      - **read in parts** when Seshat's window cannot hold it beside the prompt: at the default 8,192-token window it does not fit with Seshat's standing text, so Seshat reads it in one or more parts, each within the window, before its first reply, and answers from its notes. When the notes themselves are too long to sit beside the prompt, they are read again in parts (notes on the notes, at most three rounds), and a reply made without them does not cite the document and says so. The arm's first reply is therefore made from notes on the whole text, not the text itself; a Planning model with a larger window reads it whole. The window and any condensing are recorded in `pm/document_read` and `pm/prompt_fitted`.
      - **named, not repeated**, on later turns: the conversation carries the document's path, and a `start_project` Seshat drafts plans from Seshat's sentence, not the document (NEW-planner-pm-10's *Not yet*).
    - **The Sekhemet arm's driver (W2b G2):** built end to end, as above. What it shows and what it cannot do:
      - **Not run against a live model yet.** The first live run is the check.
      - **Issues after card zero wait in Backlog until a person moves them.** The product does not promote an issue when its dependency is done; a person does, and Seshat's composer on the dashboard offers the move (`/ready <issue>`). She makes it as step 6 says, one issue at a time in the board's order. (An earlier version of this note said no person could make that move; that was wrong, and the driver stopped after card zero because of it.)
      - **Issues held in Planning stay held.** When the lint refuses an issue's criteria, no act open to her releases it (she may only say the FAQ's words, and editing criteria is a judgement), so the phase waits on it until its budget ends. In the stand-in test the planner's criteria, written without a model, are all held this way, so release 1 there ends at its (shortened) budget.
      - **Release acceptance may be refused.** The product refuses a release whose must-haves are not proven. In the stand-in test it refused, because the planner's criteria without a model were held by the lint. The fixed point is then still recorded and tagged `release-1`, and the product's own tag is absent.
      - **Tokens:** Seshat's, the Planning model's and the Review model's tokens are not in the product's ledger, so the Sekhemet arm's count is the Coding model's only. The log says so on every `usage` event, and the scorer and the comparison page keep that count out of any comparison across arms (step "Tokens" above). The Claude Code arm's count includes every model.
      - **The plan's own questions** (at most two, as choices) are left to their defaults, not answered from the FAQ. The FAQ's answers are text, and mapping them to one of the plan's choices would be a judgement.
      - **The stakeholder approves every proposal Seshat sends,** including ones that park or reorder issues, because she approves the plan she is sent.
      - **A review that failed to run sends the issue back** (nothing is accepted unreviewed), which costs the arm a rebuild.
    - **No agentic run can start on this machine yet.** The vault is built (W2b G4, *The vault, as built*), but the sealed material has not been migrated into it, so the isolation check still refuses every agentic run. The lead runs `node scripts/capstone/vault.mjs create`, then `migrate`, then `status`.
    - **The Claude Code command has not been run against the real CLI.** It was checked against a stand-in that records its arguments. A dry run with a cheap model should confirm, before R10, that `--permission-mode bypassPermissions` with `--permission-prompts none` runs unattended, and that the deny rules load.
    - **`claude -p` may retry a failed API call itself.** The runner cannot turn that off; a one-shot reply that took more than one turn is refused.
    - **Input beyond `prompt.md`:** one-shot cells get the one-line system text, the same for every one-shot cell. Claude one-shot cells run through Claude Code's client, with thinking asked off (`MAX_THINKING_TOKENS=0`). Whether a model honours that is not visible in `claude -p`'s JSON output.
    - **Tokens are not the same kind of cost across rows.** Claude's cached prompt tokens are counted as read, like a local server's (whose cache is off). The cached part is reported apart, because the price differs.
    - **The Claude Code arm runs with full permissions** inside the isolation check, as the Sekhemet arm runs inside its sandbox. That is equal freedom, not an equal sandbox.
    - **A trailing newline** that Seshat strips from the frozen text in the thread is accepted and recorded as such; the committed document keeps it. The runner gives Claude Code the frozen bytes itself, on standard input, and logs their hash.
    - **Mutation score:** NOT RUN, because Stryker is not added. `prompt.md` tells every arm that its own tests are measured by mutation testing, so either Stryker (approved, DEC-47 O-4) is added before the first run, or the report says the stated metric was not delivered.
    - **The blind packet keeps some fingerprints:** it drops `.git`, `CLAUDE.md`, `.sekhemet/` and `docs/product/inputs/`, but keeps a harness's working style: a Sekhemet-style `CHANGELOG`, card or requirement ids, and the PM's documents. So the reviewers are not blind in practice. Normalising those is not built.
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
