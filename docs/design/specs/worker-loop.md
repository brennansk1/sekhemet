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
changes: [M1, M2, M3, T3, NEW-worker-loop-1, NEW-worker-loop-2, NEW-worker-loop-3]
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

### The turn

5. A card run is: the runner prepares the worktree, stages the card's acceptance tests, checks they fail (red-first, [gates.md](gates.md)), then runs one or more **samples**; each sample is a session of turns. A turn is: assemble the prompt ([context.md](context.md)), decide the reasoning level, call the model, dispatch its tool calls, record observations, and verify when the loop calls for it.
6. **Phases.** Every turn is in one phase, computed by a pure function `phaseOf(state)` from the turns taken, the files written, the last check's verdict, whether anything was written since that check, and the last gate failures:
   - **find** — before the first write: reading the test, the scope files and the interfaces they import;
   - **edit** — writing inside the scope;
   - **verify** — a check or gate run is due or running;
   - **repair** — the last check or gate failed and nothing has been written since.

   The phase is recorded on every turn result and in the evidence bundle. What a phase *changes* is a switch admitted by the suite. The first candidates are: a **repair** phase that offers only the write tools plus `read_file` and `read_symbol`, with thinking on; and a **find** budget — a share of the step budget for reading before the first write, after which the reply to a read nudges the Worker to write (53% of a small model's failures hit the step limit while still localising, before any edit).
7. **Automatic re-check.** After any write while a failure stands, the loop re-runs the check on the current files before the next turn. A passing re-check stops the sample with `gate_passed` evidence; a failing one feeds the ladder and counts as a failed check for thinking and method purposes.
8. **Forced verification.** When the Worker stalls with every scope file written, the loop verifies instead of discarding the work.
9. **One verification controller** owns the re-check, forced verification, the ladder and the single "on pass" reset (finished, failures cleared, ladder reset). Gate composition belongs to the gate pipeline ([gates.md](gates.md), T1), not to the session.

### Tools

10. The Worker's tools and their argument schemas are declared once, in `TOOL_CATALOG` (`tool_catalog.ts`). A card's class selects its set through `CLASS_TOOLS` ([models.md](models.md) defines `cardClass`); no class falls through to the full catalog.
11. **A fixed tool set per card.** The tools array sent to the model is byte-identical on every turn of an attempt, as native schemas. Tools are never added by editing that array mid-card. Whether the `implement` class uses a fixed set of at most twelve tools or progressive loading through `tool_search` is decided by the M2 A/B; until it is decided, the CLI path uses progressive loading with five core tools (`read_file`, `edit`, `write_file`, `check`, `finish_card`).
12. Tool semantics (the ones a small model depends on):
    - `read_file` takes 1-based inclusive `start`/`end`. An unranged read of a file over 200 lines returns an outline and the first 40 lines; an outlined file is **not** counted as read.
    - A file must have been read in this attempt before `edit`, `replace_lines`, `replace_symbol_body`, `insert_after_symbol` or `write_file` (on an existing file) may change it. `edit` is preferred over rewriting an existing file whole: diff-sized edits hallucinate less than regenerated files.
    - `edit` replaces an exact string that must occur exactly once (line endings normalised); `replace_all` is not offered. A not-found reply carries the three closest windows of the file with line numbers; an ambiguous reply gives the count and the line of each match.
    - `write_file` creates or replaces a whole file.
    - `read_symbol`, `replace_symbol_body`, `insert_after_symbol`, `find_references` and `go_to_definition` work on declarations through the TypeScript language service (`ts_service.ts`); symbol edits cannot match twice.
    - `grep_search`, `find_files` and `list_dir` are capped and ignore what git ignores.
    - `run_cmd` runs in the sandbox with a timeout. A leading `cat`, `grep`, `sed` or similar is refused with the structured tool to use instead. A whole command line runs through `/bin/sh` inside the same sandbox.
    - `check` runs the card's gates on the current files and returns typed failures with the source lines at each location and, for an unknown member or export, the real members.
    - `finish_card` ends the sample and asks for verification. It is a claim, not a verdict.
    - `note` writes to the card's thread; `ask` posts a non-blocking decision request whose answer arrives at a later turn boundary; `recall` returns a masked observation by reference; `subtask` answers one question in a child context and returns only the answer.
    - `browse` opens a sandboxed browser; it reaches beyond localhost only on research cards. `docs`, `dependencies` and `git_history` read version-pinned documentation, installed dependency source and the repository's history. Web search and fetch are never Worker tools.
    - `run_script` executes a sandboxed script over the tools above, offered only where the registry marks the model script-capable.
13. **Restricted mode** (`--restricted`, for untrusted repositories and external pull requests) removes `run_cmd` and every writing tool from the catalog and refuses them in the executor whatever the model calls; only static gates run. The trust decision itself is [security.md](security.md).
14. **The write path.** Every write passes, in order: path confinement (inside the worktree after resolving symlinks; no NUL, no `..` escape, never into `.git`), scope (the declared scope; acceptance tests and `protected` patterns are never writable by the Worker), parse (the result must parse if the file did — TypeScript and JavaScript through the compiler, other languages where a checker exists), secret scan (only secrets this write adds), then an atomic write. A failure at any step returns a typed refusal and leaves the disk untouched.
15. **The Worker does not write its own tests.** The staged acceptance test is the oracle; tests an agent writes for itself cost a third to a half more input tokens for about two points of benefit.
16. **Three refusals, one rule.** A gate failure, a scope denial and a stall are refusals the Worker must act on, and each follows the repair contract: typed, with the action attached. A scope denial names what the card may modify and tells the Worker that if the change belongs elsewhere it is to stop and report that, not retry.

### Loop control

17. Each turn records a signature `(tool, argumentHash, repoStateHash)`. The repository fingerprint hashes the working tree's **content** (tracked and untracked, non-ignored files, through a throwaway index), never HEAD plus `git status`.
18. Two identical signatures on an unchanged tree is a **stall**; an A-B-A pattern is an **oscillation**. The first repetition in a stall episode is delivered as a warning naming the next action; a repeat after that warning stops the card with `oscillation_detected`. A turn that is not a stall ends the episode, and the next stall earns its own warning.
19. Three consecutive turns with no tool call stop the card with `no_progress`; the model is shown what it said each time. A turn cut off by the length limit does not count (rule 23).
20. The detection thresholds are not tunable per card.

### Budgets

21. A card has a step, token and seconds budget. Step budgets are set per card class from measured history once three passing attempts exist: the p80 of passing attempts' steps × 1.25, moved at most 15% per calibration, never below 4 (`DEFAULT_BUDGET_POLICY`).
22. **Three generation budgets, not one.** Each request states an answer cap and a thinking cap, and the prompt budget is `window − answerCap − thinkingCap − 256`. With the Worker's 16,384-token window, a 4,096 answer cap and the high thinking budget of 2,048, the prompt budget is 9,984 tokens (real prompts: median 7,563, max 8,940).
23. The loop reads each response's `finish_reason`. A turn cut off by `length` is a typed observation ("the reply was cut off at N tokens while thinking/answering; …") with a one-step remedy, and never counts as a turn with no tool call for stall or oscillation purposes.

### Thinking and the working method

24. `SEKHEMET_THINKING` selects where the Worker thinks: `off` (only on escalated repair rungs), `surgical` (also on the first turn of each attempt and on the turn after any failed check, gate or automatic re-check) or `all` (every turn, at the high budget). The default is `off` until the frozen-suite A/B picks a winner under the statistics rule in [measurement.md](measurement.md); the winner then becomes the default and the numbers are recorded in `SUITE_RUNS.md`.
25. The thinking policy is defined once, in `reasoning.ts`; the session does not hard-code a budget.
26. `SEKHEMET_WORKER_METHOD=strict` adds two refusals: `finish_card` is refused while the last check failed and nothing has been written since, with the failures and their remedies; and `run_cmd` refuses a command (normalised, so output trimming does not make it new) that already ran with no file written since, returning the earlier output. Running a *different* command does not make a repeated one new. The default is `baseline` until the suite admits `strict`.
27. Both switches are recorded in every evidence bundle's settings.
28. **Rejected for the Worker: a planning or todo tool.** Planning stays with the Planner and the design stage; the Worker gets thinking on its first turn instead. The Planner's plan or edit sketch, when one exists, reaches the Worker as guidance ([planner-pm.md](planner-pm.md)).
29. *A/B candidates, each behind a switch and admitted only by the suite:* after a failed check, the next write carries a required one-line `hypothesis` naming the assertion it addresses (self-repair helps only when grounded in external feedback); `read_file` windows of about 100 lines instead of whole files up to 200 lines (SWE-agent measured 100-line windows best, whole files worst); `grep_search` answering with matching files and counts rather than a stream of matches; a per-step reasoning level chosen by the phase rather than by the turn number.

### Stop reasons

30. Every sample ends with exactly one stored stop reason from `CardStopReason`; stop reasons are never collapsed in storage, because they are the competence model's signal.
31. **One stop-reason table** (`STOP_REASONS`) gives every stored reason: its class (one of the classes a person learns, §8 Q1), whether it is resumable, whether it parks, whether the runner may verify after it, and its **next action**. The runner, the session, the evidence bundle and the dashboard read this table; no other list of reasons exists.
32. Every stop names its next action. `vacuous_tests` names the tests that already pass; `scope_violation` names the file and offers to widen the scope; `oscillation_detected` names the repeated call and what to do instead; `capability_ceiling` names what was tried; a hook veto is `hook_veto`, not `human_abort`.
33. `done_pending_gates` means the Worker claimed completion but the gates could not run; its next action is to run the gates.

### The repair ladder

34. After a failed verification the ladder decides what changes:
    1. **Direct repair** (at most 2 attempts): same context, the typed failures appended.
    2. **Fresh context** (at most 1): the attempt's turn history, read set, "seen" marks and lessons are discarded and the prompt is rebuilt from the card. The directive says so once, on the first turn of the rung.
    3. **Re-plan** (at most 1, once per card): the Planner receives the standing failures (at most three), the files written and the lessons, and returns a new plan that the Worker follows; with no in-loop Planner the card stops with `replan_requested`.
    4. **Stop:** `capability_ceiling` after a re-plan, else `repair_exhausted`. The card parks with a decision request naming what was tried, what failed each time, and what is suspected — an ambiguous specification, a wrong gate, or the model's limit.
35. A rung that does not change the model's inputs is not a rung. The Worker never sees its own earlier reasoning across a rung change.
36. Three failures on one card with different contexts are evidence about the card, so the third routes to the Planner (rung 3), not to a fourth attempt.

### Repeated sampling

37. `pass_at_k` in `gates.toml` (1–4) runs k samples from the same starting tree, sequentially, samples 2..k at temperatures cycled through 0.4–0.7; the first sample whose gates pass is taken. Sampling without gate selection is never used.
38. With `cross_validate`, two passing samples each run against the other's tests; disagreement sends the card to the Planner as an ambiguous specification.

## 3. Contract

| Item | Source |
| --- | --- |
| Session options, turn result, stop reason alias `ExecutionStopReason` | `packages/loop/src/types.ts` |
| Tool catalog, class sets: `TOOL_CATALOG`, `CLASS_TOOLS`, `toolsForClass`, `cardClassFor` | `packages/loop/src/tool_catalog.ts` |
| Progressive core set `PROGRESSIVE_CORE_TOOLS` | `packages/loop/src/session.ts:67` |
| Tool executor, permission check, write contract | `packages/loop/src/tools.ts`, `write_contract.ts`, `parse_gate.ts` |
| Path confinement `resolveInWorktree`, `PathEscapeError` | `packages/loop/src/paths.ts` |
| Detector (stall, oscillation) | `packages/loop/src/detector.ts` |
| Repository fingerprint `getRepoStateHash` | `packages/sync/src/git_adapter.ts:352` |
| Ladder `REPAIR_LADDER`, `RepairLadder` | `packages/loop/src/ladder.ts` |
| Reasoning policy `reasoningForStep`, `REASONING_BUDGET_TOKENS` | `packages/models/src/reasoning.ts`, `http_adapter.ts` |
| Step budgets `calibratedStepBudget`, `DEFAULT_BUDGET_POLICY` | `packages/loop/src/budget.ts` |
| Stop reasons `CardStopReason`, `CARD_STOP_REASONS` (18 today) | `packages/kernel/src/types.ts:41` |
| Switches `SEKHEMET_THINKING=off\|surgical\|all`, `SEKHEMET_WORKER_METHOD=baseline\|strict` | `apps/harness/src/execute.ts:80`, `:481` |
| `gates.toml [project]`: `pass_at_k`, `cross_validate` | `packages/gates/src/config.ts` ([gates.md](gates.md)) |
| CLI: `sekhemet run [card] [--restricted]`, `abort`, `rewind`, `fork`, `resume` | `apps/harness/src/index.ts` |

## 4. State today

| Capability | State | Evidence | Change |
| --- | --- | --- | --- |
| Turn loop, tool dispatch, typed observations | built | `session.ts:1108`; `loop.spec.ts:29` | — |
| Explicit phases recorded per turn | not-built | policy spread over `thinkingFor` and `strictRefusal` (`session.ts:535-589`) | T3 |
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
| pass@k with gate selection; cross-validation | built | `card_runner.ts:1239`; `pass_at_k.spec.ts:118`, `:134` | — |
| One Worker: the benchmark path drives the same session as the product | not-built | `BenchmarkHarness` runs `session.run()` with no sync adapter, thinking, method or progressive tools (`eval/src/benchmark.ts:297`) | M9 ([measurement.md](measurement.md)) |
| Dead direct-tool API in the session (~140 lines) | not-built (cut) | `session.ts:1757-1895`, test-only | NEW-worker-loop-3 |

## 5. Changes for v1

### M1 — coherent tool feedback (the loop's share; the prompt's share is in [context.md](context.md))

*Problem:* the loop tells the Worker things that are false after an outline, after a context reset, and after a failed edit.

- **WL-M1-1** WHEN `read_file` returns an outline THE SYSTEM SHALL NOT add the file to the attempt's read set, and a following `edit` on it SHALL be refused as unread with the `read_file` call to make.
- **WL-M1-2** WHEN the ladder enters the fresh-context rung THE SYSTEM SHALL clear the turn history, the read set, the seen marks and the lessons, and the next prompt SHALL contain no "do not re-read" marker and no EARLIER TURNS entry.
- **WL-M1-3** WHEN a turn after the first on the fresh-context rung is assembled THE SYSTEM SHALL NOT repeat the rung's "history has been cleared" directive.
- **WL-M1-4** WHEN `edit`'s search string is not found THE SYSTEM SHALL reply with the three windows of the file most similar to it, each with line numbers, and SHALL NOT tell the Worker to re-read the file; WHEN it matches more than once, the reply SHALL give the line number of each match.
- **WL-M1-5** WHEN a gate failure lies in a file the card may not edit THE SYSTEM SHALL NOT offer that file as a place to fix it.

### M2 — a fixed tool set per card class, as an A/B

*Problem:* tool search cost cards in runs 3–5; 5 of 9 searches asked for tools already loaded; the index is 14% of every prompt.

- **WL-M2-1** WHEN a card of any class starts THE SYSTEM SHALL select its tools from an explicit `CLASS_TOOLS` entry for that class, and a class with no entry SHALL fail to start with an error naming the class.
- **WL-M2-2** WHEN the fixed-set arm runs THE SYSTEM SHALL send a byte-identical tools array on every turn of an attempt and SHALL NOT offer `tool_search`.
- **WL-M2-3** WHEN the fixed-set arm runs an `implement` card THE SYSTEM SHALL offer at most twelve tools, including `recall` whenever the prompt can contain an observation pointer.
- **WL-M2-4** WHEN the registry does not mark the Worker model script-capable THE SYSTEM SHALL NOT offer `run_script` to any class.
- **WL-M2-5** WHEN the suite A/B between the fixed set and progressive loading completes THE SYSTEM SHALL record pass rate, tokens per turn and tool-call format errors per arm in `SUITE_RUNS.md`, and the losing arm SHALL be removed from the Worker's path.

### M3 — separate budgets; read `finish_reason`

*Problem:* a thinking turn can request more than the window and look like a stall.

- **WL-M3-1** WHEN any Worker request is built THE SYSTEM SHALL satisfy `promptTokens + answerCap + thinkingCap + 256 ≤ window`, trimming the prompt by the context pressure rules, never the caps.
- **WL-M3-2** WHEN a response ends with `finish_reason = "length"` THE SYSTEM SHALL record a typed `truncated` observation naming whether thinking or the answer was cut and the cap, and the detector SHALL NOT count that turn toward a stall or oscillation.
- **WL-M3-3** WHEN the thinking policy is `all` THE SYSTEM SHALL use the budget from `REASONING_BUDGET_TOKENS.high`, and the session source SHALL contain no literal thinking budget.
- **WL-M3-4** WHEN a turn completes THE SYSTEM SHALL record its `finish_reason`, prompt tokens, thinking tokens and answer tokens in the step record.

### T3 — phases, a verification controller and one stop-reason table

*Problem:* stop reasons are classified in six hand-kept sets, some stops name no next action, and `executeTurnInner` (cognitive complexity 119) mixes twelve jobs.

- **WL-T3-1** WHEN any turn completes THE SYSTEM SHALL record its phase (`find`, `edit`, `verify`, `repair`) on the turn result and in the evidence bundle, computed by one pure `phaseOf` function with its own unit tests.
- **WL-T3-2** WHEN the stop-reason table is walked THE SYSTEM SHALL have, for every member of `CARD_STOP_REASONS`, a class, `resumable`, `parks`, `mayVerify` and a non-empty `nextAction`, and the runner SHALL read these from the table (no other set of stop reasons in `packages/loop` or `apps/harness`).
- **WL-T3-3** WHEN a card stops with `oscillation_detected` THE SYSTEM SHALL name the repeated call and the action to take instead.
- **WL-T3-4** WHEN a pre-step hook vetoes a turn THE SYSTEM SHALL stop with `hook_veto` naming the hook, not `human_abort`.
- **WL-T3-5** WHEN verification passes by any route (explicit check, re-check, forced verification, finish) THE SYSTEM SHALL perform the same reset through one controller method, proven by a test per route.
- **WL-T3-6** WHEN the controller extraction lands THE SYSTEM SHALL replay the frozen suite with the same stop-reason distribution as before it (characterisation), and `executeTurnInner`'s cognitive complexity SHALL be under 40.
- **WL-T3-7** WHEN the repair-phase switch is on and the phase is `repair` THE SYSTEM SHALL offer only the write tools, `read_file` and `read_symbol`, and think; with the switch off, behaviour SHALL be unchanged.
- **WL-T3-8** WHEN the find-budget switch is on and the find phase has used its share of the step budget THE SYSTEM SHALL append to the next read's reply a nudge naming the files still to write; with the switch off, behaviour SHALL be unchanged.

### NEW-worker-loop-1 — repetition refusals that survive alternation and truncation

*Justification:* alternating two commands (`A, B, A`) defeats the refusal meant to stop the model's signature failure, and a truncated turn must not count as a silent one.

- **WL-N1-1** WHEN three consecutive turns contain no tool call and none was cut off by the length limit THE SYSTEM SHALL stop the card with `no_progress`; WHEN one of them was cut off, it SHALL NOT count.
- **WL-N1-2** WHEN, under `strict`, the Worker runs command A, then command B, then A again with no file written in between THE SYSTEM SHALL refuse the second A with its earlier output.
- **WL-N1-3** WHEN a file was written between two runs of A THE SYSTEM SHALL run A again.

### NEW-worker-loop-2 — the ladder's dead fields

*Justification:* `requireSketch` and `park` are asserted by tests but read by nothing, so the tests pass on behaviour the product lacks.

- **WL-N2-1** WHEN the ladder's policy type is inspected THE SYSTEM SHALL carry no field that production code does not read (`requireSketch` and `park` removed, or enforced with a test that fails without the enforcement).

### NEW-worker-loop-3 — remove the session's dead direct-tool API

*Justification:* ~140 lines (`executeReadFile` … `writeFile`, plus seven unused getters and `maxRepairAttempts`) are reachable only from tests and are a second tool path that can drift from the executor.

- **WL-N3-1** WHEN the loop package is built THE SYSTEM SHALL expose no session method that executes a tool other than through the dispatcher, and the reachability check over Sekhemet SHALL report none of the listed members.

## 6. v1 acceptance

This spec is `built` when §5 passes and these behaviours stay under test:

- **WL-1** WHEN a file is edited twice between two identical checks THE SYSTEM SHALL compute different repository fingerprints (real git).
- **WL-2** WHEN two identical turns occur on an unchanged tree THE SYSTEM SHALL warn; WHEN a third follows, stop with `oscillation_detected`; WHEN a non-stall turn intervenes, the next stall SHALL be warned afresh.
- **WL-3** WHEN a write would leave a parseable file unparseable, add a secret, land outside the scope or resolve into `.git` THE SYSTEM SHALL refuse it with a typed reason and the file on disk SHALL be byte-identical to before.
- **WL-4** WHEN `edit` targets a file not read this attempt THE SYSTEM SHALL refuse it.
- **WL-5** WHEN `run_cmd` begins with `cat`, `grep` or `sed` THE SYSTEM SHALL refuse it naming the structured tool.
- **WL-6** WHEN restricted mode is on THE SYSTEM SHALL send no writing tool or `run_cmd` and SHALL refuse them if called.
- **WL-7** WHEN `surgical` is selected THE SYSTEM SHALL think on the first turn of an attempt and on the turn after a failed check, gate or automatic re-check, and on no other ordinary turn.
- **WL-8** WHEN verification fails repeatedly THE SYSTEM SHALL move through direct repair (2), fresh context (1), re-plan (1) and stop, with `capability_ceiling` after a re-plan and `repair_exhausted` without one.
- **WL-9** WHEN `pass_at_k = 2` and the first sample fails THE SYSTEM SHALL take the second sample if its gates pass; WHEN two passing samples disagree on each other's tests under `cross_validate`, send the card to the Planner.
- **WL-10** WHEN a card class has three passing attempts THE SYSTEM SHALL set its step budget to p80 × 1.25, moved at most 15%, never below 4.
- **WL-11** WHEN every stop reason is produced in a test THE SYSTEM SHALL show a non-empty next action for it on the card.

## 7. Later

- **Parallel samples.** Samples run one after another; on the reference 24 GB host the server has one slot and MTP supports only one. Parallel pass@k waits for a tier with the memory for it ([models.md](models.md)).
- **Escalating the model on a failed card.** The old design's rung 3 ("narrow the scope, or escalate one tier") needs a second, stronger Worker that v1's single local Worker does not have. The re-plan rung is the v1 answer; escalation returns with a second qualified Worker or a cloud role after v1.
- **Symbol tools beyond TypeScript and JavaScript** (Tree-sitter or ast-grep: *proposed, needs the owner's yes*), shared with the source index of [gates.md](gates.md) (T2).
- **Splitting `tools.ts`** into file, process, browse and docs modules — when a workstream is already inside it.

## 8. Open questions

1. **How many stop-reason classes a person learns.** The old design fixed six (`done_pending_gates`, `budget_exhausted`, `no_progress`, `scope_violation`, `capability_ceiling`, `human_abort`) with detail carried in the message; the code stores eighteen. *Recommendation:* keep all eighteen as stored detail (the competence model needs them) and show seven classes: the six plus **environment** (`memory_pressure`, `quota_suspended`, `error`, `rebase_conflict`, `integration_failed`) — failures of the machine or the repository, which must never read as the Worker's fault. `vacuous_tests` is class `no_progress`; the three budget reasons are class `budget_exhausted`; `repair_exhausted` and `replan_requested` are class `capability_ceiling`.
2. **Whether `tool_search` survives for non-Worker roles** (MCP tools for the Planner). *Recommendation:* keep it where tool counts exceed ~10 and the role is not the Worker, appending loaded tools to the conversation rather than editing the tools array ([extensibility.md](extensibility.md)).

## 9. Evidence and rationale

- Review: [domain03_worker_loop.md](../../reference/reviews/domain03_worker_loop.md); fixes in `468f67f` (fingerprint, data contract, re-check thinking).
- Runs: [SUITE_RUNS.md](../../reference/SUITE_RUNS.md) — run 1 (the one-step remedy rule), runs 3–5 (`tool_search` losses), the thinking A/B "off" arm.
- Research: [WEB_RESEARCH_2026-09.md](../../research/WEB_RESEARCH_2026-09.md) group A Q3 (thinking, reasoning budgets) and Q4 (tool counts: RAG-MCP arXiv:2505.03275, Less is More arXiv:2411.15399, ToolRet arXiv:2503.01763).
- Working-method literature: [WORKER_METHOD_LITERATURE.md](../../research/WORKER_METHOD_LITERATURE.md) — the ranked implications there are the basis of rules 1, 6, 12, 14, 15, 17–19, 24, 26, 28 and 29. In particular: SWE-agent ACI ablations (lint-on-edit 18.0% vs 15.0%; 100-line window 18.0% vs full file 12.7%; summarised search 18.0% vs iterative 12.0%; after one failed edit the next succeeds 57.2% vs 90.5%) (arXiv:2405.15793); SWE-smith on self-declared completion and repetition (arXiv:2504.21798); self-correction without external feedback (arXiv:2310.01798); Agentless reproduction (arXiv:2407.01489); SWE-Bench Pro interface field (arXiv:2509.16941); Qwen3 thinking on BFCL (arXiv:2505.09388); grounded repair (arXiv:2306.09896); grounded gates over textual ones (arXiv:2609.02750).
- Stuck detection thresholds: [OpenHands stuck detector](https://docs.openhands.dev/sdk/guides/agent-stuck-detector) (same action and result ×4, same error ×3, three messages with no tool call, six-cycle ping-pong); failures happen after localisation (arXiv:2511.00197); agents that gather context before editing and invest in validation succeed more (arXiv:2604.02547); agent-written tests cost 33–49% more input tokens for ~2 points (arXiv:2602.07900); overthinking lowers resolution (arXiv:2502.08235); per-step reasoning routing (ARES, arXiv:2603.07915).
- Register: [RESEARCH_REGISTER.md](../../research/RESEARCH_REGISTER.md) R9 (self-refine, rejected), R10 (multi-agent debate, rejected), R6 (on-the-fly tool synthesis, triaged — not in v1).
- *Rejected:* a Worker planning tool (evidence exists only for web tasks with a separate planner, Plan-and-Act arXiv:2503.09572; no ablation of TodoWrite); self-critique loops; multi-agent debate.
- Decisions: [DEC-02](../DECISIONS.md#dec-02) (the spine), [DEC-04](../DECISIONS.md#dec-04) (the uncensored Worker: the loop's refusals are structural, not trusted to the model), [DEC-22](../DECISIONS.md#dec-22--rejected-techniques) (self-refine, multi-agent debate, persona prompting, unbounded best-of-N, hard schema constraints by default: rejected).
