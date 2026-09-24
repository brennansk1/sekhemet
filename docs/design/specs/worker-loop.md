---
spec: worker-loop
status: partial
audiences: [developer]
code:
  - packages/loop/src/session.ts
  - packages/loop/src/card_runner.ts
  - packages/loop/src/tools.ts
  - packages/loop/src/tool_catalog.ts
  - packages/loop/src/detector.ts
  - packages/loop/src/ladder.ts
  - packages/loop/src/write_contract.ts
  - packages/loop/src/paths.ts
  - packages/loop/src/budget.ts
  - packages/loop/src/observation.ts
  - packages/loop/src/manager.ts
  - packages/context/src/lsp.ts
  - packages/models/src/reasoning.ts
  - apps/harness/src/execute.ts
tests:
  - packages/loop/tests/loop.spec.ts
  - packages/loop/tests/c_integration.spec.ts
  - packages/loop/tests/ladder.spec.ts
  - packages/loop/tests/session_depth.spec.ts
  - packages/loop/tests/runner_depth.spec.ts
  - packages/loop/tests/tools.spec.ts
  - packages/loop/tests/tool_executor.spec.ts
  - packages/loop/tests/paths.spec.ts
  - packages/loop/tests/pass_at_k.spec.ts
  - packages/loop/tests/restricted.spec.ts
  - packages/loop/tests/budget.spec.ts
  - packages/context/tests/context_units.spec.ts
  - apps/harness/tests/runner_wiring.spec.ts
changes: [M1, M2, M3, T3, NEW-worker-loop-1, NEW-worker-loop-2, NEW-worker-loop-3, NEW-worker-loop-4, NEW-worker-loop-5, NEW-worker-loop-6, NEW-worker-loop-7, NEW-worker-loop-8, NEW-worker-loop-9]
---

# The Worker loop

## 1. Purpose

The Worker loop is how a small local model turns one card into a verified diff: it gives the model a small set of exact tools, refuses what would break the card, stops it when it repeats itself, and drives repair from the gates' typed failures. It serves the spine rule **gates decide completion; the model never certifies its own work** — the loop may report that the Worker thinks it is done, never that the card is — and it is the place where a professional engineer's habits are made structural for a model that does not follow prose.

## 2. Behaviour

### Principles

1. **Every habit is enforced by structure** — what a tool does, what the loop refuses, where thinking happens — never by a sentence in the prompt. A mechanism that changes what the model may do ships behind a switch and is admitted by the frozen suite ([measurement.md](measurement.md)); a habit that does not raise the pass rate is not kept.
2. **No reply is a dead end.** If a call cannot do what was asked, the reply names the call that can. **A remedy is completable in one step:** where an action would send the model to look something up, the reply carries what it would have found.
3. **No self-critique as a quality mechanism.** Extra compute goes to repeated sampling with gate selection, never to asking the model to review its own output. Multi-agent debate is rejected for the same reason.
4. One Worker session runs one card, in the card's own git worktree, as the only writer there.

### The step

5. A card run is one **attempt**: the runner prepares the worktree, stages the card's acceptance tests, checks they fail at an assertion (red-first, [gates.md](gates.md)), reads the card's dossier, then runs one **sample**, or up to k under pass@k; each sample is a sequence of **steps**. A step is: assemble the prompt ([context.md](context.md)), decide the reasoning level, call the model, dispatch its tool calls, record observations, and verify when the loop calls for it. The words *attempt*, *sample* and *step* have the meanings in §3 and no others; the code's *step* is a synonym of step and is not used in this specification.
5a. **The dossier reaches every attempt.** Before the first sample the runner reads the card's dossier ([kernel.md](kernel.md) rule 20) and gives its lines to the session: lessons from earlier attempts, the Worker's notes and questions with the answers threaded under them, research findings, the Reviewer's findings and a person's send-back note (`card_runner.ts:896-906`). A dossier read that fails costs context, never the card. During the attempt, every `note`, question and answer is written to the dossier the moment it happens (`card_runner.ts:960-1000`), so an assumption the Worker records ("Assumed: …") reaches the Reviewer and Seshat through the ledger, not through memory.
6. **Phases.** Every step is in one phase, computed by a pure function `phaseOf(state)` from the steps taken, the files written, the last check's verdict, whether anything was written since that check, and the last gate failures:
   - **find** — before the first write: reading the test, the scope files and the interfaces they import;
   - **edit** — writing inside the scope;
   - **verify** — a check or gate run is due or running;
   - **repair** — the last check or gate failed and nothing has been written since.

   The phase is recorded on every step result and in the evidence bundle. What a phase *changes* is a switch admitted by the suite. The first candidates are: a **repair** phase that offers only the write tools plus `read_file` and `read_symbol`, with thinking on; and a **find** budget — a share of the step budget for reading before the first write, after which the reply to a read nudges the Worker to write (53% of a small model's failures hit the step limit while still localising, before any edit).
7. **Automatic re-check.** After any write while a failure stands, the loop re-runs the check on the current files before the next step. A passing re-check stops the sample with `gate_passed` evidence; a failing one feeds the ladder and counts as a failed check for thinking and method purposes.
8. **Forced verification.** When the Worker stalls with every scope file written, the loop verifies instead of discarding the work.
9. **One verification controller** owns the re-check, forced verification, the ladder and the single "on pass" reset (finished, failures cleared, ladder reset). Gate composition belongs to the gate pipeline ([gates.md](gates.md), T1), not to the session.

### Tools

10. The Worker's tools and their argument schemas are declared once, in `TOOL_CATALOG` (`tool_catalog.ts`, 28 tools). A card's class selects its set through `CLASS_TOOLS` ([models.md](models.md) defines `cardClass`); no class falls through to the full catalog. The sets follow one rule — the fewer tools a role needs, the fewer it gets: a `review` card gets `read_file`, `grep_search`, `find_files`, `list_dir`, `note`, `recall`, `check` and `finish_card` (read, search, list — no writing); a `research` card gets `read_file`, `grep_search`, `find_files`, `docs`, `note`, `recall`, `browse` and `finish_card` (read and fetch); a `spike` gets the read-only set plus `run_script`; an `implement` card adds the write tools and `run_cmd` to the read set, its exact list decided by M2 (`tool_catalog.ts:430-480`).
10a. **Schemas are flat.** Every tool's arguments are scalars, enumerations or a flat array of strings — no nested objects and no unions. The set is deliberately small and flat, the shape a small model's tool calls are measured on ([models.md](models.md) tool-arm qualification).
11. **A fixed tool set per card.** The tools array sent to the model is byte-identical on every step of an attempt, as native schemas. Tools are never added by editing that array mid-card. Whether the `implement` class uses a fixed set of at most twelve tools or progressive loading through `tool_search` is decided by the M2 A/B; until it is decided, the CLI path uses progressive loading with five core tools (`read_file`, `edit`, `write_file`, `check`, `finish_card`).
11a. **Many tools without their prefill cost.** A role other than the Worker that is offered more than about ten tools — the Planner or Seshat with a project's MCP servers ([extensibility.md](extensibility.md)) — sees them as a one-line index and loads a tool's schema through `tool_search` on request; a loaded tool is appended to the conversation as a message, never inserted into the tools array, so an unused MCP tool costs no prefill and a loaded one never invalidates the cached prefix (NEW-worker-loop-8).
12. Tool semantics (the ones a small model depends on):
    - `read_file` takes 1-based inclusive `start`/`end`. An unranged read of a file over 200 lines returns an outline and the first 40 lines; an outlined file is **not** counted as read. A read is byte-budgeted: a file over 512 KB is refused with its size, and a file with a NUL in its first block is refused as binary (`tools.ts:108`, `:173-176`, `:373-376`); images and PDFs are not passed to a vision path (§7).
    - A file must have been read in this attempt before `edit`, `replace_lines`, `replace_symbol_body`, `insert_after_symbol` or `write_file` (on an existing file) may change it. `edit` is preferred over rewriting an existing file whole: diff-sized edits hallucinate less than regenerated files.
    - `edit` replaces an exact string that must occur exactly once (line endings normalised); `replace_all` is not offered. A not-found reply carries the three closest windows of the file with line numbers; an ambiguous reply gives the count and the line of each match.
    - `write_file` creates or replaces a whole file.
    - `read_symbol`, `replace_symbol_body`, `insert_after_symbol`, `find_references` and `go_to_definition` work on declarations through the TypeScript language service (`ts_service.ts`); symbol edits cannot match twice. For a file in a language the TypeScript service does not cover, `find_references` asks that language's server through a shared, per-project pool of language-server clients (`LspPool`: `pyright-langserver` for Python, `rust-analyzer` for Rust; `lsp.ts:20-24`, `tools.ts:1159-1190`, `execute.ts:471`); when no server is installed or it fails, the reply falls back to text search. A language server is a memory tenant beside the Worker, so it is started lazily, its heap is capped, virtual-environment and dependency directories are excluded from its analysis, its memory counts in the memory guard ([models.md](models.md)), and no gate depends on it being up (NEW-worker-loop-7).
    - `grep_search`, `find_files` and `list_dir` are capped and ignore what git ignores. `grep_search` takes a regular expression and has three output modes — `content` (the default, with `context` lines around each hit), `files_with_matches` and `count` — plus a `glob` filter and case-insensitivity. `find_files` lists files matching a glob **newest first** (by modification time), so what the card just touched comes first (`tool_catalog.ts:241-280`).
    - `run_cmd` runs in the sandbox with a timeout and takes an optional one-line `description` of what the command is for, recorded with the call. A leading `cat`, `grep`, `sed` or similar is refused with the structured tool to use instead. A whole command line runs through `/bin/sh` inside the same sandbox. Which commands are allowed, asked about or denied is the permission table of [security.md](security.md), not a list in the loop. Background processes (`start_process`, `read_process`, `write_process`, `stop_process`) are [runtime.md](runtime.md)'s.
    - `check` runs the card's gates on the current files and returns typed failures with the source lines at each location and, for an unknown member or export, the real members.
    - `finish_card` ends the sample and asks for verification. It is a claim, not a verdict.
    - `note` writes to the card's dossier; `recall` returns a masked observation by reference; `subtask` answers one question in a child context and returns only the answer.
    - `ask` answers now, from the card's contract: the spec's sentences, the Done-when list and the rules in force, best matches first (at most four). When nothing in the contract matches and the PM is available, Seshat answers the question now and the answer is recorded under the question in the dossier; when the PM is not loaded, the question is queued for it. With no answer, the reply tells the Worker to take the most conservative reading the acceptance tests allow and record it with `note("Assumed: …")` (`session.ts:450-520`). Every question is recorded in the dossier before it is answered. A non-blocking decision request that a person answers at a later step boundary is not built (NEW-worker-loop-4).
    - `tool_search` (while progressive loading exists, rule 11): a query that names files is answered with the files themselves — at most three, only from inside the worktree, each capped at 6,000 characters — because the reply carries what the model would have fetched (`session.ts:636-697`). A query naming code symbols (for example `ChronicleEvent`, `GENESIS_HASH`) loads `read_symbol` and names the calls to make.
    - `browse` opens a sandboxed browser; it reaches beyond localhost only on research cards. The Worker's research tools are read-only and named as in `tool_catalog.ts`: `docs` (the project's docs and a dependency's README and type declarations at the installed version; the tiered project corpus is [design-stage.md](design-stage.md)'s, Later), `dependencies` (the installed dependency's own source) and `git_history` (the repository's own history). Web search and fetch are never Worker tools; the old `repo` tool's "releases between two versions" is not a Worker ability (§7).
    - A rename across files is a tool, not a sequence of edits: `rename_symbol` asks the language service for every site and applies them, and those lines are recorded as tool-applied for the bounds gate ([gates.md](gates.md), NEW-worker-loop-6).
    - `run_script` executes a sandboxed script over the tools above, offered only where the registry marks the model script-capable.
13. **Restricted mode** (`--restricted`, for untrusted repositories and external pull requests) removes `run_cmd` and every writing tool from the catalog and refuses them in the executor whatever the model calls; only static gates run. The trust decision itself is [security.md](security.md).
14. **The write path.** Every write passes, in order: path confinement (inside the worktree after resolving symlinks; no NUL, no `..` escape, never into `.git`), scope (the declared scope; acceptance tests and `protected` patterns are never writable by the Worker), parse (the result must parse if the file did — TypeScript and JavaScript through the compiler, other languages where a checker exists), secret scan (only secrets this write adds), then an atomic write. A failure at any step returns a typed refusal and leaves the disk untouched.
15. **The Worker does not write its own tests.** The staged acceptance test is the oracle; tests an agent writes for itself cost a third to a half more input tokens for about two points of benefit.
16. **Three refusals, one rule.** A gate failure, a scope denial and a stall are refusals the Worker must act on, and each follows the repair contract: typed, with the action attached. A scope denial names what the card may modify and tells the Worker that if the change belongs elsewhere it is to stop and report that, not retry.

### Loop control

17. Each step records a signature `(tool, argumentHash, repoStateHash)`. The repository fingerprint hashes the working tree's **content** (tracked and untracked, non-ignored files, through a throwaway index), never HEAD plus `git status`.
18. Two identical signatures on an unchanged tree is a **stall**; an A-B-A pattern is an **oscillation**. The first repetition in a stall episode is delivered as a warning naming the next action; a repeat after that warning stops the card with `oscillation_detected`. A step that is not a stall ends the episode, and the next stall earns its own warning.
19. Three consecutive steps with no tool call stop the card with `no_progress`; the model is shown what it said each time. A step cut off by the length limit does not count (rule 23).
20. The detection thresholds are not tunable per card.

### Budgets

21. A card has a step, token and seconds budget. Step budgets are set per card class from measured history once three passing attempts exist: the p80 of passing attempts' steps × 1.25, moved at most 15% per calibration, never below 4 (`DEFAULT_BUDGET_POLICY`).
22. **Three generation budgets, not one.** Each request states an answer cap and a thinking cap, and the prompt budget is `window − answerCap − thinkingCap − 256`. With the Worker's 16,384-token window, a 4,096 answer cap and the high thinking budget of 2,048, the prompt budget is 9,984 tokens (real prompts: median 7,563, max 8,940).
23. The loop reads each response's `finish_reason`. A step cut off by `length` is a typed observation ("the reply was cut off at N tokens while thinking/answering; …") with a one-step remedy, and never counts as a step with no tool call for stall or oscillation purposes.

### Thinking and the working method

24. `SEKHEMET_THINKING` selects where the Worker thinks: `off` (only on escalated repair rungs), `surgical` (also on the first step of each attempt and on the step after any failed check, gate or automatic re-check) or `all` (every step, at the high budget). The default is `off` until the frozen-suite A/B picks a winner under the statistics rule in [measurement.md](measurement.md); the winner then becomes the default and the numbers are recorded in `SUITE_RUNS.md`.
25. The thinking policy is defined once, in `reasoning.ts`; the session does not hard-code a budget.
26. `SEKHEMET_WORKER_METHOD=strict` adds two refusals: `finish_card` is refused while the last check failed and nothing has been written since, with the failures and their remedies; and `run_cmd` refuses a command (normalised, so output trimming does not make it new) that already ran with no file written since, returning the earlier output. Running a *different* command does not make a repeated one new. The default is `baseline` until the suite admits `strict`.
27. The switches — `SEKHEMET_THINKING`, `SEKHEMET_WORKER_METHOD` and `SEKHEMET_EVIDENCE_GATE` (rule 29a) — are recorded in every evidence bundle's settings and in the run's `RunProfile`.
28. **Rejected for the Worker: a planning or todo tool.** Planning stays with the Planner and the design stage; the Worker gets thinking on its first step instead. The Planner's plan or edit sketch, when one exists, reaches the Worker as guidance in the card's section of the prompt (the sketch — target symbols with the change to each, preconditions, invariants, a diff outline and the blast radius — is defined in [planner-pm.md](planner-pm.md) §2.1.9; [context.md](context.md) places it); applying a sketch mechanically by symbol replacement is §7.
29. *A/B candidates, each behind a switch and admitted only by the suite under [measurement.md](measurement.md) §2's admission rule:* after a failed check, the next write carries a required one-line `hypothesis` naming the assertion it addresses (self-repair helps only when grounded in external feedback); `read_file` windows of about 100 lines instead of whole files up to 200 lines (SWE-agent measured 100-line windows best, whole files worst); `grep_search` answering with matching files and counts rather than a stream of matches; a per-step reasoning level chosen by the phase rather than by the step number; and the **evidence-gated commit** below.
29a. **Evidence-gated commit** (ECLoop, arXiv:2607.28815; `SEKHEMET_EVIDENCE_GATE=off|on`, default `off`; register [R12](../../research/RESEARCH_REGISTER.md)). With the switch on, a write or a finish is postponed until the evidence it depends on has been **observed in this attempt's step records** — never taken from the model's claims:
    - before the first write: every scope file the acceptance test imports has been read in full (an outline does not count, rule 12);
    - before a write that changes the signature of an exported declaration: every file the source index lists as importing it has been read, or `find_references` has been called on it, since the last write to that declaration's file (before T2 exists, callers are found by `find_references`);
    - before `finish_card`: the related tests — the card's acceptance tests, plus the tests reachable from the changed files once T2 exists ([gates.md](gates.md) rule 33) — have run on the current tree, by `check` or the automatic re-check.

    A postponed call is answered with the missing evidence and the one call that supplies it (principle 2), and counts as a step for the stall detector. The precondition set is computed by one pure function of the step records, beside `phaseOf`. It is the strongest measured Worker-level result in the research set (+11.8 points for the weaker model, fewer tokens) and aims at this Worker's commonest failure (rule 6). **Admission threshold** (set 2026-09-24, before the bench): a paired frozen-suite A/B against the B2.5 baseline RunProfile with a gain of at least 20 points on 30 cards (one-sided exact test at 0.05); if inconclusive, adopted only under the cheaper-or-simpler and no-significant-loss rule ([measurement.md](measurement.md) §2) (NEW-worker-loop-9).

### Stop reasons

30. Every sample ends with exactly one stored stop reason from `CardStopReason`; stop reasons are never collapsed in storage, because they are the competence model's signal.
31. **One stop-reason table** (`STOP_REASONS`) gives every stored reason: its class, whether it parks, whether it is resumable, whether the runner may verify after it, where the card goes, and its **next action**. The runner, the session, the evidence bundle and the dashboard read this table, and other specifications that add a reason ([gates.md](gates.md), [security.md](security.md), [runtime.md](runtime.md)) add it here; no other list of reasons exists. Reasons are stored as detail (the competence model needs them) and shown as **seven failure classes** ([DEC-24](../DECISIONS.md#dec-24--deliberate-reversals-in-design-v3)) — the old six plus **environment**, failures of the machine or the repository that must never read as the Worker's fault — and one **success** class that holds only `gate_passed`. A new condition is a new stored reason inside a class, never a new class. v1 stores the eighteen reasons of `CARD_STOP_REASONS` (`kernel/src/types.ts:72-91`) and adds five:

    | Reason | Class | Parks | Resumable | May verify | Then | Next action shown |
    | --- | --- | --- | --- | --- | --- | --- |
    | `gate_passed` | success | no | — | — (verified) | Review | "Ready for review" |
    | `budget_exhausted` | budget_exhausted | yes, unless the gates ran | no | yes | Parked; Planning with the failures when the gates ran | Steps used of the budget; raise it for the class or split the card |
    | `token_budget_exhausted` | budget_exhausted | yes, unless the gates ran | no | yes | as above | Tokens used of the budget; the same choice |
    | `time_budget_exhausted` | budget_exhausted | yes, unless the gates ran | no | no | as above | Seconds used of the budget; the same choice |
    | `no_progress` | no_progress | no | no | yes | Verify | What the Worker said on each silent step, and the call to make |
    | `oscillation_detected` | no_progress | no | no | yes | Verify | The repeated call and what to do instead |
    | `vacuous_tests` | no_progress | yes | no | no | Parked, before any step | The tests that already pass; rewrite them to fail until the behaviour exists |
    | `tests_not_red_for_reason` (new, [gates.md](gates.md) NEW-gates-6) | no_progress | yes | no | no | Parked, before any step | The test and its import, compile, collection or setup error; the test-author step makes it fail at an assertion |
    | `done_pending_gates` | done_pending_gates | no | no | yes | Verify | Run the gates |
    | `scope_violation` | scope_violation | no | no | no | Verify | The file, and an offer to widen the scope |
    | `git_metadata_tampered` (new, [security.md](security.md) SEC-2) | scope_violation | yes | no | no | Parked; the worktree is discarded | The gitdir the `.git` pointer names against the harness's record; no git command ran; a person inspects before the card is re-queued from Ready |
    | `repair_exhausted` | capability_ceiling | yes | no | yes | Parked | What was tried, what failed each time, and what is suspected |
    | `capability_ceiling` | capability_ceiling | yes | no | yes | Parked | The same, after a re-plan |
    | `replan_requested` | capability_ceiling | no | no | no | Planning | The Planner re-plans; the plan is recorded in the dossier (rule 34.3) |
    | `gate_suspected` (new, [gates.md](gates.md) M6) | capability_ceiling | yes | no | no | Parked | The gate and the Worker's reason; a person decides whether the gate or the card is wrong |
    | `human_abort` | human_abort | no | yes | no | stays; resumes from its last checkpoint | Who stopped it; resume or reject |
    | `hook_veto` (new, rule 32) | human_abort | yes | yes | no | Parked | The hook and its reason; change the hook or the card, then unpark |
    | `error` | environment | no | yes | yes | resumes from its last checkpoint | The error; the next run resumes |
    | `memory_pressure` | environment | no | yes | no | held; resumes when the watchdog allows | The watchdog level and what to free ([models.md](models.md) rule 19) |
    | `quota_suspended` | environment | no | yes | no | held; resumes when the quota returns | The quota and when it resets |
    | `crashed` (new, [runtime.md](runtime.md) RUN-9) | environment | no | yes | no | Ready, worktree restored to the last checkpoint | Resumes from the last completed step on the next run |
    | `rebase_conflict` | environment | no | no | yes | Planning | The conflicting files; re-plan on the new base |
    | `integration_failed` | environment | no | no | — (verified) | Planning | The gates that passed on the card branch and failed after the rebase |

    The code's sets agree with these columns today (`RESUMABLE_STOPS`, `SUSPENDING_STOPS`, `HARD_STOPS`, `PARKING_STOPS`, `BUDGET_STOPS` and `mayVerify`, `card_runner.ts:191`, `:238`, `:252`, `:273`, `:282`, `:1188-1194`, `:1609-1650`) for the eighteen, except that the dashboard maps classes by hand; the table replaces all of them.
32. Every stop names its next action. `vacuous_tests` names the tests that already pass; `scope_violation` names the file and offers to widen the scope; `oscillation_detected` names the repeated call and what to do instead; `capability_ceiling` names what was tried; a hook veto is `hook_veto`, not `human_abort`.
33. `done_pending_gates` means the Worker claimed completion but the gates could not run; its next action is to run the gates.

### The repair ladder

34. After a failed verification the ladder decides what changes:
    1. **Direct repair** (at most 2 attempts): same context, the typed failures appended.
    2. **Fresh context** (at most 1): the attempt's step history, read set, "seen" marks and lessons are discarded and the prompt is rebuilt from the card. The directive says so once, on the first step of the rung.
    3. **Re-plan** (at most 1, once per card): the Planner receives the standing failures (at most three), the files written, the lessons, the card's dossier and the constraints the Worker is under — the playbook rules in force, the scope and protected paths, and the API facts the failures carried (real exports and members) — and returns a new plan that the Worker follows; a plan may narrow the scope to the part that can pass, but may not prescribe what those rules forbid (NEW-worker-loop-5). The plan is built from exactly: the card's spec, scope files and acceptance criteria; the stop reason; the standing typed failures (at most three); the acceptance tests' and scope files' current contents, each capped by the allocator ([context.md](context.md) CX-N3-8); the files written and the lessons; the dossier; the playbook rules in force; the protected paths; and the API facts the failures carried. Today `planRepair` receives only the card, the stop reason, the failures and the files (`manager.ts:5-11`), so it can prescribe an API a rule forbids. With no in-loop Planner the card stops with `replan_requested` and the Planner re-plans it from Planning in the next repair batch (rule 40).

       **The plan's output contract** (`RepairPlan`, NEW-worker-loop-5) — what a re-plan may change, and nothing else:
       - `targetFiles`: the files the next attempt may write, a subset of the declared scope. Narrowing is allowed; widening is refused. A narrowing that leaves an acceptance criterion with no target file able to satisfy it is refused too: the card stops with `replan_requested` naming the criterion, and a split is proposed to a person ([planner-pm.md](planner-pm.md)), because dropping a criterion changes what the gates prove and is never the Planner's to do alone.
       - `edits`: the plan's steps, in order, each naming a file, the symbol and the change (add, modify or remove) — the edit sketch's shape ([planner-pm.md](planner-pm.md) §2.1.9), never a literal patch; the allocator caps the section like any other ([context.md](context.md) rule 10a).
       - `doNotTouch`: the files, symbols and APIs the next attempt must leave alone — at least every protected path in scope, the API a rule in force forbids when a standing failure involved it, and every approach an earlier attempt tried and abandoned.
       - `failuresAddressed`: which standing failures (at most three) each edit answers.

       The plan is written to the card's dossier as a `card/repair_plan` entry ([kernel.md](kernel.md) rule 20) before the next attempt starts, so the dashboard's card view and the Worker read the same plan. The next attempt starts from a fresh context (rung 3 rebuilds the pack, [context.md](context.md) rule 19) with the plan in Zone 3's static card block, before the scope files (CX-N3-5), byte-identical on every step of that attempt; `targetFiles` becomes that attempt's writable scope. The plan is measured through the attempt record, which names the plan it ran under: the capability report gives the pass rate of attempts that followed a re-plan, per card class.
    4. **Stop:** `capability_ceiling` after a re-plan, else `repair_exhausted`. The card parks with a decision request naming what was tried, what failed each time, and what is suspected — an ambiguous specification, a wrong gate, or the model's limit.
35. A rung that does not change the model's inputs is not a rung. The Worker never sees its own earlier reasoning across a rung change.
36. Three failures on one card with different contexts are evidence about the card, so the third routes to the Planner (rung 3), not to a fourth attempt.

### Repeated sampling

37. `pass_at_k` in `gates.toml` (1–4) runs k samples from the same starting tree and context, sequentially, samples 2..k at temperatures cycled through 0.4–0.7 (0.4, 0.55, 0.7); each sample starts from the tree the first started from, so no sample sees another's writes; the first sample whose gates pass is taken (`card_runner.ts:908-920`). Sampling without gate selection is never used.
38. With `cross_validate`, two passing samples each run against the other's tests; disagreement sends the card to the Planner as an ambiguous specification.

### Attempts and retries

39. **One attempt record.** Every attempt ends with one record on the ledger (`attempt/finished`): the card, its real attempt number (1 for the first run, counting every later run of the same card), the rung and tool arm it ran at, its role and model, the playbook rules and exemplars in its prompt, the repair plan it ran under (if any), steps, tokens, `builtBy` and the stop reason. The capability report, the PM's Worker record, policy tuning and competence rows all read this record and no other store, so Seshat, the Machine view and the stopping policy agree (NEW-worker-loop-5). A retry or an escalated pass is never counted as a first attempt.
40. **Every card gets the same repair chances.** A card deferred because it waited on another card, and run after that card finished, gets the same repair plans and retries as a card that ran first: the queue alternates a Worker pass, a repair batch (repair plans, answers, research) and a retry pass until a pass changes nothing, at most two repair batches per card (NEW-worker-loop-5). Today the queue loops up to six rounds, running deferred cards after each pass (`apps/harness/src/index.ts:1782-1800`).

## 3. Contract

| Item | Source |
| --- | --- |
| **Terms** ([DEC-26](../DECISIONS.md#dec-26--one-vocabulary-for-the-kind-of-card-and-the-run), [NAMING.md](../NAMING.md)): **attempt ⊃ sample ⊃ step.** An **attempt** is one recorded run of a card to a stop (`AttemptRecord`, `attempt/finished`); it holds one **sample**, or up to k under `pass_at_k`. A sample is a sequence of **steps** from the card's starting tree. A step is one model request and the tool calls it makes (a `steps` row with `step_index`, a `card/step` event); the step budget counts steps. *Turn* is the code's synonym for step (`TurnResult`, `executeTurnInner`, the `turn` field of `card/step`) and is not used in specifications | `packages/loop/src/types.ts`, `packages/kernel/src/schema.ts:181` |
| Session options, step result (`TurnResult`), stop reason alias `ExecutionStopReason` | `packages/loop/src/types.ts` |
| Tool catalog, class sets: `TOOL_CATALOG`, `CLASS_TOOLS`, `toolsForClass`, `cardClassFor` | `packages/loop/src/tool_catalog.ts` |
| Progressive core set `PROGRESSIVE_CORE_TOOLS` | `packages/loop/src/session.ts:67` |
| Tool executor, permission check, write contract; read limits `MAX_READ_BYTES` (512 KB), `isBinary` | `packages/loop/src/tools.ts:108`, `:173`, `write_contract.ts`, `parse_gate.ts` |
| Observation clamp `clampObservation` (first 2,400 and last 1,200 characters of a long observation, with the count omitted), applied after condensing ([context.md](context.md)) | `packages/loop/src/observation.ts:16-34` |
| Language-server pool `LspPool`, `DEFAULT_LSP_SERVERS`, `languageOf` | `packages/context/src/lsp.ts:20-30` |
| Dossier read and writes in the runner `getDossier`, `recordDossierEntry` | `packages/loop/src/card_runner.ts:896-1000` |
| Repair plan `planRepair`, `RepairPlanInput` (card, stop reason, failures, files) | `packages/loop/src/manager.ts:5-32` |
| Path confinement `resolveInWorktree`, `PathEscapeError` | `packages/loop/src/paths.ts` |
| Detector (stall, oscillation) | `packages/loop/src/detector.ts` |
| Repository fingerprint `getRepoStateHash` | `packages/sync/src/git_adapter.ts:352` |
| Ladder `REPAIR_LADDER`, `RepairLadder` | `packages/loop/src/ladder.ts` |
| Reasoning policy `reasoningForStep`, `REASONING_BUDGET_TOKENS` | `packages/models/src/reasoning.ts`, `http_adapter.ts` |
| Step budgets `calibratedStepBudget`, `DEFAULT_BUDGET_POLICY` | `packages/loop/src/budget.ts` |
| Stop reasons `CardStopReason`, `CARD_STOP_REASONS` (18 today; 23 in v1, rule 31); the table `STOP_REASONS` (new, T3) | `packages/kernel/src/types.ts:41`, `:72-91` |
| Switches `SEKHEMET_THINKING=off\|surgical\|all`, `SEKHEMET_WORKER_METHOD=baseline\|strict`; `SEKHEMET_EVIDENCE_GATE=off\|on` (new, rule 29a) | `apps/harness/src/execute.ts:80`, `:481` |
| Repair plan `RepairPlan {targetFiles, edits, doNotTouch, failuresAddressed}` (new, rule 34.3), recorded as `card/repair_plan` | `packages/loop/src/manager.ts`; [kernel.md](kernel.md) rule 20 |
| `gates.toml [project]`: `pass_at_k`, `cross_validate` | `packages/gates/src/config.ts` ([gates.md](gates.md)) |
| CLI: `sekhemet run [card] [--restricted]`, `abort`, `rewind`, `fork`, `resume` | `apps/harness/src/index.ts` |

**Defaults the loop enforces.** Each value has one source: measured, a prior (a starting value with no measurement behind it yet), or derived from another value. A prior names the benchmark ([OPEN_QUESTIONS.md](../../reference/OPEN_QUESTIONS.md)) or A/B that replaces it.

| Setting | Default | Source |
| --- | --- | --- |
| Step budget before a class is calibrated | 40 steps | Prior: `[loop] default_step_budget` (`apps/harness/src/config.ts:42`), equal to the planner's small-card bound `INVEST_MAX_STEPS` (`planner/src/constants.ts:21`). The card record's 50 (`kernel/src/card_store.ts:368`) and the benchmark's 50 (`eval/src/settings.ts:16`) move to it (WL-T3-11). Replaced per class by calibration and measured by OPEN_QUESTIONS benchmark 2 (step-budget curve) |
| Step-budget calibration | p80 of passing attempts' steps × 1.25, moved at most 15% per calibration, never below 4, after 3 passing attempts | `DEFAULT_BUDGET_POLICY` (`budget.ts:32-37`); prior |
| Token budget | none: tokens are bounded by the step budget and the per-request prompt budget (at most 40 × 9,984 prompt tokens before calibration) | `tokenBudget` defaults to null (`card_store.ts:374`); a person, or the budgets-and-routes inlet ([measurement.md](measurement.md) rule 17), sets one per class |
| Seconds budget | step budget × 70 s (2,800 s at 40 steps) | Derived from the overnight throughput floor's ~70 s per step ([models.md](models.md) rule 9); today none (`card_store.ts:375`) (WL-T3-11). Measured with benchmark 2 |
| Answer cap; thinking cap; prompt budget W | 4,096; 2,048 (`REASONING_BUDGET_TOKENS.high`); 16,384 − 4,096 − 2,048 − 256 = 9,984 | [models.md](models.md) rule 2 (`llama_server.ts:530-534`); `http_adapter.ts`; derived (rule 22) |
| Find-phase share (switch, rule 6) | a third of the step budget (13 of 40) | Prior; decided by the find-budget A/B (WL-T3-8) |
| Masking interval k | 8 steps; candidates 4, 8 and 16 | Prior ([context.md](context.md) §8 Q1); chosen in the M8 run by seconds per step and pass rate |
| Stall and no-progress | warn on the first repeat of a stall episode, stop on the next; 3 steps with no tool call | Fixed (rules 18–20); not configuration |
| Repair ladder | direct repair 2, fresh context 1, re-plan 1 | Fixed (rule 34) |
| `pass_at_k`; sample temperatures | 1 (at most 4); 0.4, 0.55, 0.7 | `gates/src/config.ts:185-186`; rule 37 |
| Repair batches per card | 2 | Rule 40 (NEW-worker-loop-5) |
| Observation clamp; read limits; `tool_search` file answer | 2,400 + 1,200 characters; 512 KB, outline above 200 lines with the first 40; 3 files × 6,000 characters | `observation.ts:16-34`; `tools.ts:108`; `session.ts:636-697` |
| Tool-applied line bound; gate timeouts | see [gates.md](gates.md) §3 | — |

## 4. State today

| Capability | State | Evidence | Change |
| --- | --- | --- | --- |
| Step loop, tool dispatch, typed observations | built | `session.ts:1108`; `loop.spec.ts:29` | — |
| Dossier read before every attempt; notes, questions and answers written as they happen | built | `card_runner.ts:896-1000`; `runner_depth.spec.ts`, `runner_wiring.spec.ts` | — |
| `ask` answers from the contract, then Seshat; recorded in the dossier | built | `session.ts:450-520` | — |
| Non-blocking decision request from `ask`, answered at a later step | not-built | — | NEW-worker-loop-4 |
| `tool_search` answers file queries with the files (≤ 3, worktree, 6,000 characters) | built | `session.ts:636-697` | — |
| `tool_search` answers symbol queries by loading `read_symbol` | not-built | only file terms are recognised (`session.ts:645-653`) | M2 |
| Read byte budget (512 KB) and binary refusal | built | `tools.ts:108`, `:373-376` | — |
| `grep_search` three modes with context lines; `find_files` newest first | built | `tool_catalog.ts:241-280` | — |
| Flat tool schemas | built | `tool_catalog.ts` (no object or union argument) | — |
| Observation clamp 2,400 + 1,200 characters | built | `observation.ts:16-34` | — |
| `find_references` through a language-server pool for non-TypeScript files | built | `tools.ts:1159-1190`; `execute.ts:471`; `context_units.spec.ts:119` | — |
| Language servers capped, lazy, venv-excluded, counted by the memory guard | not-built | servers start with default heaps and no exclusions (`lsp.ts:20-24`); the guard counts only model servers | NEW-worker-loop-7 |
| Symbol tools reach the TypeScript service through LSP (TS 7 server interchangeable) | not-built | `ts_service.ts` calls the `typescript` API in-process | NEW-worker-loop-7 |
| Rename tool with tool-applied lines | not-built | no rename tool in the 28 (`tool_catalog.ts`) | NEW-worker-loop-6 |
| MCP tools for non-Worker roles loaded by index, appended as messages | not-built | the Worker's progressive loading edits the tools array (M2); no index path for the Planner or Seshat | NEW-worker-loop-8 |
| Re-plan sees rules, constraints, API facts and the dossier | not-built | `RepairPlanInput` is card, stop reason, failures and files only (`manager.ts:5-11`) | NEW-worker-loop-5 |
| Re-plan output contract (target files, edits, what not to touch) recorded as a dossier entry and placed in Zone 3 | not-built | the plan is a free-text `ReplanRequest` held in memory (`card_runner.ts:217`); no dossier kind for it (`kernel/src/types.ts:231-275`) | NEW-worker-loop-5 |
| Evidence-gated commit (switch) | not-built | — | NEW-worker-loop-9 |
| One attempt record read by every consumer; real attempt number, rung and arm | not-built | `capabilityReport` reads evidence files (`pm/capability.ts:86-89`), `workerRecord` reads queue reports (`pm/service.ts:152-158`), `tune` rebuilds attempts from step counters; `startAttempt` never passes the rung or arm, so every row reads rung 1, arm A (`card_runner.ts:1033-1040`) | NEW-worker-loop-5 |
| Deferred cards get repair plans and retries | partial | round loop re-runs deferred cards (`index.ts:1782-1800`); no bound of two repair batches per card | NEW-worker-loop-5 |
| Explicit phases recorded per step | not-built | policy spread over `thinkingFor` and `strictRefusal` (`session.ts:535-589`) | T3 |
| Verification controller; one "on pass" reset | not-built | reset repeated four times (`session.ts:1287`, `1449`, `1466`, `1515`); three "verify anyway" paths | T3 |
| Automatic re-check after an edit | built | `session.ts:1436-1489` | — |
| Forced verification on a stall with scope complete | built | `session.ts:1263-1311` | — |
| Content-aware repository fingerprint | built | `git_adapter.ts:352` (468f67f); real-git tests | — |
| Stall warning per episode, then stop | built | `loop.spec.ts:101`, `:134` | — |
| Write contract: confinement, scope, parse, secrets, atomic | built | `tools.ts:380-402`, `write_contract.ts`; `paths.spec.ts` | — |
| Read-before-edit | built | `tools.ts:264-272` | — |
| Outlined read not counted as read | not-built | `readFiles` updated before the outline branch (`tools.ts:581`, `587`) | M1 |
| Fresh context resets read set, seen marks and lessons; directive shown once | partial | history cleared, read set and directive kept (`session.ts:1541-1545`; 28/28 repair prompts, context review) | M1 |
| One-step `edit` not-found remedy | not-built | "Re-read the file and copy the exact text" (`tools.ts:655`) | M1 |
| Fixed tool set per class, stable array | not-built | `implement` falls through to all 28 tools (`tool_catalog.ts:498`); progressive loading edits the array mid-card | M2 |
| Structured-tool steering for `run_cmd` | built | `tools.ts:1395` | — |
| Restricted mode | built | `restricted.spec.ts:39`, `:49` | — |
| Browse beyond localhost only on research cards | built | `tools.ts:157`, `:1072` | — |
| Separate prompt, thinking and answer budgets; `finish_reason` read | not-built | prompt budget = window − maxTokens − 256 (`session.ts:921`); thinking added on top (`http_adapter.ts:823`): 18,176 requested of 16,384 under `all`; `finish_reason` never read | M3 |
| Thinking policy `off`/`surgical`/`all` incl. after a failed re-check | built | `session.ts:535`; `c_integration.spec.ts:208-249` | — |
| Thinking policy defined once | partial | `session.ts:537` hard-codes 2,048 outside `REASONING_BUDGET_TOKENS` | M3 |
| Strict method: finish refusal, repeat refusal | built | `session.ts:553-589`; `c_integration.spec.ts:284`, `:304` | — |
| Strict repeat refusal survives an alternating command | not-built | any command change increments `effects` (`session.ts:601`) | NEW-worker-loop-1 |
| Ladder 2/1/1, fresh context, re-plan, stop | built | `ladder.ts`; `session.ts:292`; `ladder.spec.ts` | — |
| Dead ladder fields `requireSketch`, `park` | partial | read by nothing in production (`ladder.ts:19-26`) | NEW-worker-loop-2 |
| One stop-reason table with next actions | not-built | six hand-kept sets (`card_runner.ts:191-286`) plus `mayVerify`; `oscillation_detected` text has no remedy (`session.ts:1316`); hook veto reported as `human_abort` (`session.ts:1181`) | T3 |
| Step budget calibration per class | built | `budget.ts`; `budget_calibration.spec.ts` | — |
| pass@k with gate selection, each sample from the same starting tree; cross-validation | built | `card_runner.ts:908-920`, `:1239`; `pass_at_k.spec.ts:118`, `:134` | — |
| Stop reasons stored as eighteen, shown as seven classes | not-built | no class field; the dashboard maps reasons by hand (`ui/src/vocabulary.ts`) | T3 |
| The five v1 reasons (`gate_suspected`, `tests_not_red_for_reason`, `hook_veto`, `git_metadata_tampered`, `crashed`) | not-built | none is in `CARD_STOP_REASONS` (`kernel/src/types.ts:72-91`) | T3 (with M6, NEW-gates-6, S1, NEW-runtime-3) |
| One default step budget; a default seconds budget | partial | 40 in configuration (`config.ts:42`), 50 on the card record (`card_store.ts:368`) and in the benchmark (`eval/src/settings.ts:16`); no seconds budget unless set (`card_store.ts:375`) | T3 |
| One Worker: the benchmark path drives the same session as the product | not-built | `BenchmarkHarness` runs `session.run()` with no sync adapter, thinking, method or progressive tools (`eval/src/benchmark.ts:297`) | M9 ([measurement.md](measurement.md)) |
| Dead direct-tool API in the session (~140 lines) | not-built (cut) | `session.ts:1757-1895`, test-only | NEW-worker-loop-3 |

## 5. Changes for v1

### M1 — coherent tool feedback (the loop's share; the prompt's share is in [context.md](context.md))

*Problem:* the loop tells the Worker things that are false after an outline, after a context reset, and after a failed edit.

- **WL-M1-1** WHEN `read_file` returns an outline THE SYSTEM SHALL NOT add the file to the attempt's read set, and a following `edit` on it SHALL be refused as unread with the `read_file` call to make.
- **WL-M1-2** WHEN the ladder enters the fresh-context rung THE SYSTEM SHALL clear the step history, the read set, the seen marks and the lessons, and the next prompt SHALL contain no "do not re-read" marker and no EARLIER TURNS entry.
- **WL-M1-3** WHEN a step after the first on the fresh-context rung is assembled THE SYSTEM SHALL NOT repeat the rung's "history has been cleared" directive.
- **WL-M1-4** WHEN `edit`'s search string is not found THE SYSTEM SHALL reply with the three windows of the file most similar to it, each with line numbers, and SHALL NOT tell the Worker to re-read the file; WHEN it matches more than once, the reply SHALL give the line number of each match.
- **WL-M1-5** WHEN a gate failure lies in a file the card may not edit THE SYSTEM SHALL NOT offer that file as a place to fix it.

### M2 — a fixed tool set per card class, as an A/B

*Problem:* tool search cost cards in runs 3–5; 5 of 9 searches asked for tools already loaded; the index is 14% of every prompt.

- **WL-M2-1** WHEN a card of any class starts THE SYSTEM SHALL select its tools from an explicit `CLASS_TOOLS` entry for that class, and a class with no entry SHALL fail to start with an error naming the class.
- **WL-M2-2** WHEN the fixed-set arm runs THE SYSTEM SHALL send a byte-identical tools array on every step of an attempt and SHALL NOT offer `tool_search`.
- **WL-M2-3** WHEN the fixed-set arm runs an `implement` card THE SYSTEM SHALL offer at most twelve tools, including `recall` whenever the prompt can contain an observation pointer.
- **WL-M2-4** WHEN the registry does not mark the Worker model script-capable THE SYSTEM SHALL NOT offer `run_script` to any class.
- **WL-M2-5** WHEN either tool arm (fixed set or progressive loading) runs a card THE SYSTEM SHALL record the arm, tool-call format errors and tokens per step in the card's evidence, so a run's per-arm pass rate, tokens and errors can be computed from evidence alone; WHEN the baseline `RunProfile` names a tool arm ([measurement.md](measurement.md) rule 9a) THE SYSTEM SHALL offer the Worker only that arm, and the other SHALL NOT be reachable from the Worker's path (a reachability test).

### M3 — separate budgets; read `finish_reason`

*Problem:* a thinking step can request more than the window and look like a stall.

- **WL-M3-1** WHEN any Worker request is built THE SYSTEM SHALL satisfy `promptTokens + answerCap + thinkingCap + 256 ≤ window`, trimming the prompt by the context pressure rules, never the caps.
- **WL-M3-2** WHEN a response ends with `finish_reason = "length"` THE SYSTEM SHALL record a typed `truncated` observation naming whether thinking or the answer was cut and the cap, and the detector SHALL NOT count that step toward a stall or oscillation.
- **WL-M3-3** WHEN the thinking policy is `all` THE SYSTEM SHALL use the budget from `REASONING_BUDGET_TOKENS.high`, and the session source SHALL contain no literal thinking budget.
- **WL-M3-4** WHEN a step completes THE SYSTEM SHALL record its `finish_reason`, prompt tokens, thinking tokens and answer tokens in the step record.

### T3 — phases, a verification controller and one stop-reason table

*Problem:* stop reasons are classified in six hand-kept sets, some stops name no next action, and `executeTurnInner` (cognitive complexity 119) mixes twelve jobs.

- **WL-T3-1** WHEN any step completes THE SYSTEM SHALL record its phase (`find`, `edit`, `verify`, `repair`) on the step result and in the evidence bundle, computed by one pure `phaseOf` function with its own unit tests.
- **WL-T3-2** WHEN the stop-reason table is walked THE SYSTEM SHALL have, for every member of `CARD_STOP_REASONS`, a class, `resumable`, `parks`, `mayVerify` and a non-empty `nextAction`, and the runner SHALL read these from the table (no other set of stop reasons in `packages/loop` or `apps/harness`).
- **WL-T3-3** WHEN a card stops with `oscillation_detected` THE SYSTEM SHALL name the repeated call and the action to take instead.
- **WL-T3-4** WHEN a pre-step hook vetoes a step THE SYSTEM SHALL stop with `hook_veto` naming the hook, not `human_abort`.
- **WL-T3-5** WHEN verification passes by any route (explicit check, re-check, forced verification, finish) THE SYSTEM SHALL perform the same reset through one controller method, proven by a test per route.
- **WL-T3-6** WHEN the controller extraction lands THE SYSTEM SHALL replay every trajectory of the characterisation set — the recorded attempts of the latest frozen-suite run, each driven by a scripted adapter that returns the recorded model replies in order, so the replay is deterministic — and produce, on every trajectory, the same stop reason, the same number of steps and the same sequence of tool calls as the build before the extraction; and `executeTurnInner`'s cognitive complexity SHALL be under 40.
- **WL-T3-7** WHEN the repair-phase switch is on and the phase is `repair` THE SYSTEM SHALL offer only the write tools, `read_file` and `read_symbol`, and think; with the switch off, behaviour SHALL be unchanged.
- **WL-T3-8** WHEN the find-budget switch is on and the find phase has used its share of the step budget THE SYSTEM SHALL append to the next read's reply a nudge naming the files still to write; with the switch off, behaviour SHALL be unchanged.
- **WL-T3-9** WHEN the stop-reason table is walked THE SYSTEM SHALL assign every stored reason exactly one class — `gate_passed` alone in **success**, every other reason in one of the seven failure classes of rule 31, with `memory_pressure`, `quota_suspended`, `error`, `crashed`, `rebase_conflict` and `integration_failed` in **environment** — and the dashboard SHALL read the class from the table.
- **WL-T3-10** WHEN the stop-reason table is walked THE SYSTEM SHALL contain `gate_suspected`, `tests_not_red_for_reason`, `hook_veto`, `git_metadata_tampered` ([security.md](security.md) SEC-2) and `crashed` ([runtime.md](runtime.md) RUN-9), each with the class, `parks`, `resumable` and next action of rule 31, and `CARD_STOP_REASONS` SHALL list exactly the table's reasons (23 in v1).
- **WL-T3-11** WHEN a card is created or run without an explicit step budget, by any path (the CLI, the queue, the planner, the benchmark) THE SYSTEM SHALL use the one default of 40 steps, and a seconds budget of the step budget × 70 s, both read from one constant; a search test finds no other literal default.

### NEW-worker-loop-1 — repetition refusals that survive alternation and truncation

*Justification:* alternating two commands (`A, B, A`) defeats the refusal meant to stop the model's signature failure, and a truncated step must not count as a silent one.

- **WL-N1-1** WHEN three consecutive steps contain no tool call and none was cut off by the length limit THE SYSTEM SHALL stop the card with `no_progress`; WHEN one of them was cut off, it SHALL NOT count.
- **WL-N1-2** WHEN, under `strict`, the Worker runs command A, then command B, then A again with no file written in between THE SYSTEM SHALL refuse the second A with its earlier output.
- **WL-N1-3** WHEN a file was written between two runs of A THE SYSTEM SHALL run A again.

### NEW-worker-loop-2 — the ladder's dead fields

*Justification:* `requireSketch` and `park` are asserted by tests but read by nothing, so the tests pass on behaviour the product lacks.

- **WL-N2-1** WHEN the ladder's policy type is inspected THE SYSTEM SHALL carry no field that production code does not read (`requireSketch` and `park` removed, or enforced with a test that fails without the enforcement).

### NEW-worker-loop-3 — remove the session's dead direct-tool API

*Justification:* ~140 lines (`executeReadFile` … `writeFile`, plus seven unused getters and `maxRepairAttempts`) are reachable only from tests and are a second tool path that can drift from the executor.

- **WL-N3-1** WHEN the loop package is built THE SYSTEM SHALL expose no session method that executes a tool other than through the dispatcher, and the reachability check over Sekhemet SHALL report none of the listed members.

### NEW-worker-loop-4 — `ask` that can wait for a person without stopping the Worker

*Justification:* the old design's `ask` posted a non-blocking decision request answered at a later step boundary; today an unanswered question only tells the Worker to assume (ruling R2).

- **WL-N4-1** WHEN `ask`'s question is answered neither by the contract nor by Seshat THE SYSTEM SHALL post a non-blocking decision request carrying the question, the card and the Worker's stated assumption, and the Worker SHALL continue on that assumption.
- **WL-N4-2** WHEN that request is answered while the card is still running THE SYSTEM SHALL deliver the answer as an observation at the next step boundary, never mid-step, and record it under the question in the dossier; WHEN the answer contradicts the assumption, the observation SHALL say so.

### NEW-worker-loop-5 — one attempt record, a grounded re-plan, and equal repair chances

*Justification:* the integration review found three outcome stores that disagree, evidence and readers that count retries as first attempts, a repair plan that can prescribe a forbidden API because it never sees the rules, and deferred cards that missed the only repair batch (integration review A6, B4, C5; suggestions 2 and 9; ruling R20).

- **WL-N5-1** WHEN an attempt ends THE SYSTEM SHALL append one `attempt/finished` record carrying the real attempt number, rung, tool arm, role, model, the ids of the rules and exemplars in its prompt, steps, tokens, `builtBy` and stop reason; the second run of a card SHALL carry attempt number 2.
- **WL-N5-2** WHEN the capability report, the Worker record, `tune` or a competence row needs outcomes THE SYSTEM SHALL read them from `attempt/finished` records only (a search test finds no other reader of evidence files or queue reports for outcomes).
- **WL-N5-3** WHEN the re-plan rung asks the Planner for a plan THE SYSTEM SHALL include the playbook rules in force for the card, the scope and protected paths, the API facts carried by the standing failures and the card's dossier; WHEN a returned plan names a file outside the scope or an API a rule in force forbids, the plan SHALL be refused and the card SHALL stop with `replan_requested` naming the conflict.
- **WL-N5-4** WHEN a card deferred on a dependency runs after that dependency passed THE SYSTEM SHALL give it the same repair batch and retry as a card that ran first; the queue SHALL stop repairing a card after two repair batches.
- **WL-N5-5** WHEN the Planner returns a re-plan THE SYSTEM SHALL accept it only in the shape of rule 34.3 — `targetFiles` a subset of the declared scope, ordered `edits` each naming a file, a symbol and a change, `doNotTouch` containing at least the protected paths in scope, and `failuresAddressed` — and SHALL record it as a `card/repair_plan` dossier entry before the next attempt starts; a plan whose target files leave an acceptance criterion with no file able to satisfy it SHALL be refused, and the card SHALL stop with `replan_requested` naming the criterion.
- **WL-N5-6** WHEN the first prompt of the attempt after a re-plan is assembled THE SYSTEM SHALL contain the recorded plan in Zone 3's static card block, before the scope files ([context.md](context.md) CX-N3-5), byte-identical on every step of that attempt, and SHALL refuse a write outside the plan's `targetFiles` as a scope denial.
- **WL-N5-7** WHEN an attempt ran under a repair plan THE SYSTEM SHALL name the plan in its `attempt/finished` record, and the capability report SHALL give the pass rate of attempts that followed a re-plan, per card class.

### NEW-worker-loop-6 — mechanical edits as tools

*Justification:* agents solve 22% of multi-file refactors against a human's 87%, and a rename touching fourteen files cannot fit three files and 200 lines, so it would be split into cards that each leave the build broken ([DESIGN_RESEARCH_TESTS_BROWNFIELD.md](../../research/DESIGN_RESEARCH_TESTS_BROWNFIELD.md) decision 10; RefactorBench arXiv:2503.07832).

- **WL-N6-1** WHEN a card needs a rename across files THE SYSTEM SHALL offer `rename_symbol`, backed by the language service, which applies every site in one call and records those lines as tool-applied for the bounds gate ([gates.md](gates.md) GT-BF-3).
- **WL-N6-2** WHEN `rename_symbol` would touch a file outside the card's scope THE SYSTEM SHALL refuse it naming the files, unless the card declares the rename as its mechanical change.

### NEW-worker-loop-8 — MCP tools without their prefill cost

*Justification:* the old design promised that MCP servers with many tools stay usable without paying for every schema on every step; the Worker's fixed set does not cover the other roles (trace hd1 146; §8 Q1).

- **WL-N8-1** WHEN the Planner or Seshat is offered more than ten tools THE SYSTEM SHALL send a one-line index of them and only the schemas already loaded, and a schema loaded by `tool_search` SHALL be appended as a message; the tools array and every earlier message SHALL stay byte-identical.

### NEW-worker-loop-9 — the evidence-gated commit, as an A/B arm

*Justification:* the strongest measured Worker-level mechanism in the research set (ECLoop, arXiv:2607.28815: +11.8 points for the weaker model, 1.4–12.1% fewer tokens), aimed at the failure this Worker shows most — acting before localising (rule 6) — was neither carried nor rejected (review M18; [PROJECT_DONE_AND_DEPTH.md](../../research/PROJECT_DONE_AND_DEPTH.md) §1; register R12). It is built in B2.1 so the B2.5 baseline can run its arm.

- **WL-N9-1** WHEN `SEKHEMET_EVIDENCE_GATE=on` and the Worker writes before every scope file the acceptance test imports has been read in full this attempt THE SYSTEM SHALL postpone the write, reply naming the unread files and the `read_file` call to make, and leave the disk untouched.
- **WL-N9-2** WHEN the switch is on and a write would change the signature of an exported declaration whose importers have not been read, nor searched with `find_references`, since the last write to its file THE SYSTEM SHALL postpone it naming the importers and the one call that lists them.
- **WL-N9-3** WHEN the switch is on and `finish_card` is called before the related tests have run on the current tree THE SYSTEM SHALL postpone it and run the check instead, returning its result.
- **WL-N9-4** WHEN the precondition set is computed THE SYSTEM SHALL compute it by one pure function of the attempt's step records (unit-tested), never from the model's text; WHEN the switch is `off` the loop's behaviour SHALL be byte-identical to a build without it, and every evidence bundle SHALL record the switch.

### NEW-worker-loop-7 — language servers as bounded tenants, reached through LSP

*Justification:* TypeScript 7.0 (2026-07-08) ships no API and 7.1's will differ, so a symbol tool bound to the in-process `typescript` API breaks when projects move; and a language server can exhaust a 2–4 GB heap analysing a virtual environment on a 24 GB host that already holds a 13 GB Worker ([research](../../research/DESIGN_RESEARCH_TESTS_BROWNFIELD.md) decisions 13, §2.3 language servers).

- **WL-N7-1** WHEN the Worker's symbol tools run on a TypeScript file THE SYSTEM SHALL reach the language service through the LSP client, so that `typescript-language-server` and TypeScript 7's native server (`tsc --lsp --stdio`) are interchangeable by configuration, and no module outside the TypeScript adapter SHALL import `typescript` ([gates.md](gates.md) IX-4).
- **WL-N7-2** WHEN a language server is started THE SYSTEM SHALL start it only on the first symbol request that needs it, cap its heap (`--max-old-space-size`), exclude virtual-environment and dependency directories from its analysis, and count its resident memory in the memory guard ([models.md](models.md)).
- **WL-N7-3** WHEN a language server is absent, crashes or exceeds its heap THE SYSTEM SHALL fall back to text search for that call, say so in the reply, and SHALL NOT fail any gate because of it.

## 6. v1 acceptance

This spec is `built` when §5 passes and these behaviours stay under test:

- **WL-1** WHEN a file is edited twice between two identical checks THE SYSTEM SHALL compute different repository fingerprints (real git).
- **WL-2** WHEN two identical steps occur on an unchanged tree THE SYSTEM SHALL warn; WHEN a third follows, stop with `oscillation_detected`; WHEN a non-stall step intervenes, the next stall SHALL be warned afresh.
- **WL-3** WHEN a write would leave a parseable file unparseable, add a secret, land outside the scope or resolve into `.git` THE SYSTEM SHALL refuse it with a typed reason and the file on disk SHALL be byte-identical to before.
- **WL-4** WHEN `edit` targets a file not read this attempt THE SYSTEM SHALL refuse it.
- **WL-5** WHEN `run_cmd` begins with `cat`, `grep` or `sed` THE SYSTEM SHALL refuse it naming the structured tool.
- **WL-6** WHEN restricted mode is on THE SYSTEM SHALL send no writing tool or `run_cmd` and SHALL refuse them if called.
- **WL-7** WHEN `surgical` is selected THE SYSTEM SHALL think on the first step of an attempt and on the step after a failed check, gate or automatic re-check, and on no other ordinary step.
- **WL-8** WHEN verification fails repeatedly THE SYSTEM SHALL move through direct repair (2), fresh context (1), re-plan (1) and stop, with `capability_ceiling` after a re-plan and `repair_exhausted` without one.
- **WL-9** WHEN `pass_at_k = 2` and the first sample fails THE SYSTEM SHALL take the second sample if its gates pass; WHEN two passing samples disagree on each other's tests under `cross_validate`, send the card to the Planner.
- **WL-10** WHEN a card class has three passing attempts THE SYSTEM SHALL set its step budget to p80 × 1.25, moved at most 15%, never below 4.
- **WL-11** WHEN every stop reason is produced in a test THE SYSTEM SHALL show a non-empty next action for it on the card.
- **WL-12** WHEN `read_file` is called on a file over 512 KB, or on a file with a NUL in its first block THE SYSTEM SHALL refuse it with the size or "binary" and SHALL NOT return its bytes.
- **WL-13** WHEN `tool_search` names four files THE SYSTEM SHALL return the first three from inside the worktree, each capped at 6,000 characters, and SHALL NOT read a path outside the worktree.
- **WL-14** WHEN `ask` is called and the card's spec answers the question THE SYSTEM SHALL answer from the spec without calling the PM, and record the question in the dossier.
- **WL-15** WHEN a card is run a second time THE SYSTEM SHALL give its lessons and the answers from the first run to the second run's prompt through the dossier.
- **WL-16** WHEN `find_references` is asked about a symbol in a Python file and a language server is configured THE SYSTEM SHALL answer from the server; WHEN none is installed, from text search (`context_units.spec.ts:119` covers the pool).
- **WL-17** WHEN the tool catalog is walked THE SYSTEM SHALL find no argument whose type is an object or a union.

## 7. Later

- **Parallel samples.** Samples run one after another; on the reference 24 GB host the server has one slot and MTP supports only one. Parallel pass@k waits for a tier with the memory for it: the old design's rule — on tiers L and XL, or in overnight batch runs, k ∈ [2, 4] independent samples from the same context pack at T ∈ [0.4, 0.7], each in its own ephemeral worktree, with the cap on k set per tier — returns with it, the per-tier cap read from the engine's qualified parallel capacity ([models.md](models.md)).
- **Escalating the model on a failed card.** The old design's rung 3 ("narrow the scope, or escalate one tier, whichever the competence model favours") needs a second, stronger Worker that v1's single local Worker does not have. The re-plan rung is the v1 answer, and narrowing the scope survives inside it (rule 34.3); escalation returns with a second qualified Worker or a cloud role after v1.
- **Applying an edit sketch mechanically** (symbol replacement from the Planner's target symbols, preconditions and diff outline). The sketch is defined in [planner-pm.md](planner-pm.md) §2.1.9 (`EditSketch`: target symbols with the change to each, preconditions, invariants, a diff outline that is never a literal patch, and the blast radius); in v1 it reaches the Worker as guidance in Zone 3 only, and the ladder's dead `requireSketch` field is removed rather than enforced (NEW-worker-loop-2). Mechanical application waits for an A/B showing it beats guidance.
- **`read_file` passing images and PDFs to a vision path.** The v1 Worker has no vision capability; card attachments reach a vision-capable model through the adapter ([surface.md](surface.md)).
- **Release notes between two versions as a Worker tool** (the old `repo` tool). The Worker's history tool reads this repository only; an `upgrade` card receives the changelog entries between the installed and proposed versions from the Researcher when it is planned ([design-stage.md](design-stage.md), [planner-pm.md](planner-pm.md)).
- **Symbol edits beyond TypeScript and JavaScript** (`read_symbol`, `replace_symbol_body` and `insert_after_symbol` for Python and Rust; ast-grep for structural search and codemods: *proposed, needs the owner's yes* — native binaries and a Python build step), shared with the source index of [gates.md](gates.md) (T2). `find_references` already reaches other languages through the language-server pool (rule 12).
- **Splitting `tools.ts`** into file, process, browse and docs modules — when a workstream is already inside it.

## 8. Open questions

1. **Whether `tool_search` survives for non-Worker roles** (MCP tools for the Planner). *Recommendation:* keep it where tool counts exceed ~10 and the role is not the Worker, appending loaded tools to the conversation rather than editing the tools array ([extensibility.md](extensibility.md)) — adopted as rule 11a and NEW-worker-loop-8 pending the owner's confirmation.
2. **The rename tool before or after the LSP move.** *Recommendation:* build `rename_symbol` on the LSP client (NEW-worker-loop-7 first), so it works unchanged when a project moves to TypeScript 7.

## 9. Evidence and rationale

- Review: [domain03_worker_loop.md](../../reference/reviews/domain03_worker_loop.md); fixes in `468f67f` (fingerprint, data contract, re-check thinking).
- Runs: [SUITE_RUNS.md](../../reference/SUITE_RUNS.md) — run 1 (the one-step remedy rule), runs 3–5 (`tool_search` losses), the thinking A/B "off" arm.
- Research: [WEB_RESEARCH_2026-09.md](../../research/WEB_RESEARCH_2026-09.md) group A Q3 (thinking, reasoning budgets) and Q4 (tool counts: RAG-MCP arXiv:2505.03275, Less is More arXiv:2411.15399, ToolRet arXiv:2503.01763).
- Working-method literature: [WORKER_METHOD_LITERATURE.md](../../research/WORKER_METHOD_LITERATURE.md) — the ranked implications there are the basis of rules 1, 6, 12, 14, 15, 17–19, 24, 26, 28 and 29. In particular: SWE-agent ACI ablations (lint-on-edit 18.0% vs 15.0%; 100-line window 18.0% vs full file 12.7%; summarised search 18.0% vs iterative 12.0%; after one failed edit the next succeeds 57.2% vs 90.5%) (arXiv:2405.15793); SWE-smith on self-declared completion and repetition (arXiv:2504.21798); self-correction without external feedback (arXiv:2310.01798); Agentless reproduction (arXiv:2407.01489); SWE-Bench Pro interface field (arXiv:2509.16941); Qwen3 thinking on BFCL (arXiv:2505.09388); grounded repair (arXiv:2306.09896); grounded gates over textual ones (arXiv:2609.02750).
- Stuck detection thresholds: [OpenHands stuck detector](https://docs.openhands.dev/sdk/guides/agent-stuck-detector) (same action and result ×4, same error ×3, three messages with no tool call, six-cycle ping-pong); failures happen after localisation (arXiv:2511.00197); agents that gather context before editing and invest in validation succeed more (arXiv:2604.02547); agent-written tests cost 33–49% more input tokens for ~2 points (arXiv:2602.07900); overthinking lowers resolution (arXiv:2502.08235); per-step reasoning routing (ARES, arXiv:2603.07915).
- Register: [RESEARCH_REGISTER.md](../../research/RESEARCH_REGISTER.md) R9 (self-refine, rejected), R10 (multi-agent debate, rejected), R6 (on-the-fly tool synthesis, triaged — not in v1).
- *Rejected:* a Worker planning tool (evidence exists only for web tasks with a separate planner, Plan-and-Act arXiv:2503.09572; no ablation of TodoWrite); self-critique loops; multi-agent debate.
- *Changed on purpose* (each also in [DEC-24](../DECISIONS.md#dec-24--deliberate-reversals-in-design-v3) or its trace): a stall is warned once per episode before it stops the card, where the old design stopped on the first repetition — cards with 32-step budgets were ending on step two having read one file twice; `edit` offers no `replace_all` and normalises line endings — renames are a tool (NEW-worker-loop-6), and a whitespace-exact match failed more often than it protected; the detection thresholds (`stall_window = 3`, `max_rungs = 4`) are no longer configuration — a per-card threshold hid stalls; rung 3 re-plans instead of escalating (§7); six stop reasons became eighteen stored in seven classes (DEC-24); `ask` answers from the contract and Seshat now instead of posting a decision request (ruling R2; NEW-worker-loop-4 restores the request as an addition); and WORKER_METHOD_LITERATURE's implication 3 escalates a loop by "fail over or resample", where this design warns once and then stops the card with `oscillation_detected` — there is no second Worker to fail over to in v1 (§7), and resampling from the same context at these model sizes repeats the loop, so the change of inputs that a resample was meant to buy is the ladder's fresh-context rung instead (rule 35).
- Independent review of design v3 ([design_v3_review.md](../../reference/reviews/design_v3_review.md)): B4 (attempt ⊃ sample ⊃ step, [DEC-26](../DECISIONS.md#dec-26--one-vocabulary-for-the-kind-of-card-and-the-run)), M1 (the full stop-reason table), M5 (WL-T3-6, WL-M2-5), M18 (the evidence-gated commit, [PROJECT_DONE_AND_DEPTH.md](../../research/PROJECT_DONE_AND_DEPTH.md) §1, register R12), M19 (the defaults table), m1, depth item 6 (the re-plan's output contract); trace row PMFE:432 ([DESIGN_TRACE.md](../../reference/DESIGN_TRACE.md)).
- Research: [DESIGN_RESEARCH_TESTS_BROWNFIELD.md](../../research/DESIGN_RESEARCH_TESTS_BROWNFIELD.md) — decision 10 (mechanical edits as tools: RefactorBench arXiv:2503.07832, Google migrations arXiv:2504.09691), decision 13 and §2.3 (TypeScript 7.0 ships no API; `typescript-language-server` 6.0.0; pyright heap exhaustion on virtual environments). Integration review ([reviews/integration_review_2026-09-18.md](../../reference/reviews/integration_review_2026-09-18.md)): A6, B4, B5, C5 and suggestions 2, 6 and 9.
- Decisions: [DEC-02](../DECISIONS.md#dec-02) (the spine), [DEC-04](../DECISIONS.md#dec-04) (the uncensored Worker: the loop's refusals are structural, not trusted to the model), [DEC-22](../DECISIONS.md#dec-22--rejected-techniques) (self-refine, multi-agent debate, persona prompting, unbounded best-of-N, hard schema constraints by default: rejected).
