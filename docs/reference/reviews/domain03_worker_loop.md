# Domain 3 — Worker loop and tools (read-only review, 2026-09-22)

Scope: `packages/loop/src` at 7944e9f. Paths below are relative to `packages/loop/src` unless stated. "Verified" means I ran something. "Read" means the claim comes from reading the code only.

## 1. Positioning

**What helps a professional-quality result (all built):**
- The acceptance test and the scope files are pinned into every prompt and marked as seen (`session.ts:813-833`). This is Agentless's "read the test first", done by structure rather than by instruction.
- Every write goes through the write contract (`tools.ts:380-402`, `write_contract.ts`): it must parse, it must not add a secret, and it lands atomically. Read-before-edit is enforced (`tools.ts:264-272`).
- `check` gives typed failures together with the offending source lines and the real API members (`session.ts:347-380`, `390-440`). The gates re-run automatically after any edit while a failure stands (`session.ts:1436-1489`).
- The first stall produces a warning that names the next action, not a stop (`session.ts:1249-1261`). If the Worker stalls with its scope complete, the loop forces a verification instead of discarding the work (`1263-1311`). Progressive tool loading keeps 5 core contracts in the prompt (`session.ts:67`, enabled at `apps/harness/src/execute.ts:476`).

**What hurts:**
- **Stall detection cannot see content changes.** `repoStateHash` is HEAD plus `git status --porcelain`, truncated to 64 base64 characters (`packages/sync/src/git_adapter.ts:337-344`). Once a file shows as `M`, further edits to it leave the hash unchanged. I verified this with a scratch git repo: two different contents produced the same hash. So the ordinary senior loop `read X → edit X → read X`, or `check → edit → check`, satisfies the A-B-A rule (`detector.ts:98-113`). The Worker is then told "the repository is unchanged… Repeating it again will end the card" right after a real edit. That is false feedback, and it arrives at the moment of repair.
- **The run-5 data-contract fix does not reach the Worker.** `session.repoMap()` uses `buildRankedRepoMap` and only falls back to `buildRepoMap` when the ranked map is empty (`session.ts:841-860`). Interface fields, the `CREATE TABLE` schema and the dropping of "(no exports)" files exist only in the fallback (`repo_map.ts:62-65, 87-108`). Verified: on a copy of the vault fixture, the production map printed `export interface SecretRecord` with no fields, no schema, and kept `src/vault.ts: (no exports)` and `acceptance/cli.spec.ts: (no exports)`.
- **Contradictory instructions:**
  - Reading a file over 200 lines returns only an outline, yet the file is added to `readFiles` first (`tools.ts:581` before `587`). The prompt then says "read X (do not re-read)" (`session.ts:982`).
  - On `fresh_context` the history is cleared (`session.ts:1541-1545`) but `readFiles` and `seen` are not. The rung directive says "Re-read the relevant files" (`ladder.ts:51`) while the prompt still says "do not re-read".
- **The edit-failure remedy is not one step.** It says "Re-read the file and copy the exact text" (`tools.ts:655`), which breaks the one-step rule from SUITE_RUNS run 1. The failure should carry the nearest matching lines instead.
- **The senior habits are off by default.** `thinking` defaults to `off` (`session.ts:536`) and `workerMethod` to `baseline` (`execute.ts:481`). This is correct pending the A/B, but the shipped Worker is still the one that "never planned".

## 2. Drift (design ↔ code)

| Design says | Code does |
| --- | --- |
| "Rung 3: Narrow the scope, or escalate the model one tier… Re-decomposition is the Planner's job and happens at rung 4, not here" | Rung 3 is `edit_sketch` with `replan: true` (`ladder.ts:54-60`); "Rung 3 asks for a re-plan once per card" (`session.ts:286-326`). No scope narrowing and no model escalation exist. |
| Rung 3 "requireSketch: Require a written plan before any edit" (the field's own doc, `ladder.ts:19-20`) | `requireSketch` and `park` are read by nothing in production. The rung directive (`ladder.ts:58-59`) is prose only, against the design's rule that "every habit is enforced by structure". |
| "Six is the vocabulary… An implementation that has grown to eighteen…" | `CardStopReason` has 19 members (`packages/kernel/src/types.ts:41-69`). |
| `done_pending_gates` — "Worker completed declared work; ready for gates" | It means "the gates could not run" (`session.ts:1494-1511`, `card_runner.ts:1219, 1232, 1296`). |
| "Every stop reason names the next action" | The `oscillation_detected` text is "Repeated identical actions detected; execution halted." (`session.ts:1316`), with no remedy. A pre-step hook veto reports `human_abort` (`session.ts:1181`). |
| "surgical… on the turn after a failed check or gate" | `lastTurnFailed` counts only `gateResult` or a failed `check`/`finish_card` observation (`session.ts:1564-1566`). A failed automatic re-check never sets `gateResult` (`1478-1488`), so the most common failure gets no thinking. Read, not executed. |
| Working method: data contract in the map, state "Built" | Built only in the dead fallback (see §1). |
| "Tool set: deliberately small and flat" (~10 tools) | `TOOL_CATALOG` has 28 tools plus `tool_search`. Implement cards get all of them (`tool_catalog.ts:491-499`). Progressive loading mitigates this on the CLI path. |
| Pass@k: "Parallel… sampling" | Sequential (`card_runner.ts:1239-1261`). |
| Loop control: "(tool, argumentHash, repoStateHash)" | Implemented, but the hash is content-blind (§1). |

## 3. Dead and duplicated code

**Dead (no production caller; tests only):**
- The session's "Direct tool access" API, about 140 lines (`session.ts:1757-1895`): `executeReadFile`, `executeReplaceLines`, `executeEdit`, `readSymbol`, `replaceSymbolBody`, `insertAfterSymbol`, `executeListDir`, `executeFindFiles`, `executeGrepSearch`, `findReferences`, `executeRunCmd`, `executeNote`, `getNotes`, `executeDocs`, `writeFile`.
- Also `getSystemPrompt`, `getLadderState`, `getHistory`, `getLastGateFailure`, `getCompactedTurns`, `isReplanned` and `getLastPromptReport`, which have no caller outside `session.ts`.
- `SessionOptions.maxRepairAttempts` (`types.ts:156`), which is read nowhere.
- `RungPolicy.requireSketch` and `.park`.
- The `OscillationDetector` constructor threshold. It is used only by the test at `tests/loop.spec.ts:68`, while `detector.ts:31-35` says "Not a tunable".
- `isInsideWorktree` (`paths.ts:85`).
- `buildRepoMap` is effectively dead: it runs only when the ranked map is empty.

**Duplicated:**
- The "on pass" reset (`isFinished`, clear failures, `ladder.reset()`, `activeRung = undefined`) appears four times: `session.ts:1287-1288`, `1449-1453`, `1466-1470`, `1515-1519`.
- "Verify anyway" logic exists in three places: the stall-forced verification (`session.ts:1263-1311`), the re-check after edit (`1457-1489`), and the runner's end-of-sample check (`card_runner.ts:1188-1233`). The scope-complete test is re-implemented at `session.ts:1269` next to `isScopeComplete()` at `784`.
- Acceptance-test path normalisation is written four ways. Two call sites guard the `tests/` prefix (`session.ts:194`, `1646`, `1666`). Two do not: `830` and `1709`, where `1709` also reads `options.card` rather than `this.card`.
- Stop-reason classification is spread across six hand-maintained sets: `RESUMABLE_STOPS`, `SUSPENDING_STOPS`, `HARD_STOPS`, `PARKING_STOPS`, `BUDGET_STOPS` (`card_runner.ts:191-286`), and the inline `mayVerify` list (`1188-1194`).
- There are two Worker loops. The eval benchmark drives `session.run()` (`packages/eval/src/benchmark.ts:297`) with no sync adapter, so A-B-A detection is off there (`detector.ts:108`). It also runs without progressive tools, thinking or method. It measures a different Worker than the product ships.

## 4. Complexity hotspots

Biome cognitive complexity (threshold 15), verified:

| Function | Lines | Score |
| --- | --- | --- |
| `CardRunner.run` → `runSample` closure | `card_runner.ts:928-1235` | **121** |
| `executeTurnInner` | `session.ts:1108-1570` (463 lines) | **119** |
| `CardRunner.finish` | `card_runner.ts:1480-1764` | **114** |
| `CardRunner.run` | `card_runner.ts:815-1314` | 69 |
| `ToolExecutor.grep` | `tools.ts:1272-1384` | 61 |
| `runVerificationInner` | `session.ts:1626-1731` | 42 |
| `docs` | `tools.ts:1577` | 34 |
| `authorize` | `tools.ts:405` | 31 |
| `buildPrompt` | `session.ts:936` | 31 |

**Mixed responsibilities:**
- `executeTurnInner` does twelve jobs in one method: guards, prompt, reasoning, hooks, model call, empty turns, stalls, dispatch split across two classes (`1370-1381`), scope stop, three verification paths, the ladder, and budget.
- `runVerificationInner` hosts gate policy that belongs to the gates domain: integrity, bounds and the built-in layers.
- `SessionOptions` has about 65 fields (`types.ts:95-275`).
- `tools.ts` puts file, process, browse, docs and git tools in one class.

## 5. Test quality (DoD §2)

- Trivial assertions are rare: 4 in total across 26 specs. `runner_depth.spec.ts` (29 tests) and `session_depth.spec.ts` use real git. Mock model adapters and fake `GateRunner`s are appropriate at this layer.
- **Tests assert code the product does not run.** `tests/repo_map.spec.ts` tests `buildRepoMap` directly, so the suite is green while the fix is absent from the prompt. `ladder.spec.ts:33-36` asserts `requireSketch`, which nothing reads.
- **The detector is tested only with synthetic hashes** (`loop.spec.ts:84-99`, `"tree1"`/`"tree2"`). No test uses `NodeGitSyncAdapter` across two edits of the same file, which is how the content-blind hash went unnoticed.
- **Missing negative cases for the working method** (`c_integration.spec.ts:222-294`):
  - A re-run after an edit must run.
  - Alternating two commands (`A, B, A`) must still be refused. By reading, it is not: every command change increments `effects` (`session.ts:601`), so the refusal at `579` is bypassed.
  - `finish_card` after a failed automatic re-check.
- **Surgical-thinking tests** (`c_integration.spec.ts:208-220`) cover an explicit `check` only, not the automatic re-check.
- `normaliseCommand` has no direct test. Its trimming only strips a trailing `| tail|head N`.

## 6. Senior judgement (ranked by impact on pass rate, then maintainability)

1. **Fix what the Worker is told.** The content-blind stall hash, the dead data contract, "do not re-read" after an outline or a context reset, and the edit-failure remedy are four harness-caused mis-feedbacks. They fire in exactly the replayed failure modes (oscillation, guessed schema, re-reading). Each is small. Suite history says fixes of this kind moved the most cards: run 1's stall feedback, run 4's `tool_search` fix.
2. **Make the default Worker the measured one.** Close the A/B (already Phase A's baseline). Then make surgical thinking fire after automatic re-checks, and fix the strict-method loophole, **before** that A/B runs. Otherwise the A/B measures a partial `surgical` policy.
3. **Explicit phases (find → edit → verify).** Much of this already exists implicitly: "find" is mostly done by pinning, and "verify" is the automatic re-check. What is missing is the **repair transition**. After a failed check, run 5's `onyx_7_cli` re-ran `check` instead of editing. The seams in `session.ts`:
   - **(a) Policy.** A pure `phaseOf(state)` computed from `turnsTaken`, `filesWritten`, `lastCheck`, `writtenSinceCheck`, `lastGateFailures`. It would absorb `thinkingFor` (`535-543`) and `strictRefusal` (`553-589`).
   - **(b) Dispatch.** `dispatchCalls` (`1327-1406`), with the special tools (`check`, `ask`, `recall`, `tool_search`, `subtask`) moved into one registry.
   - **(c) Verification.** A `VerificationController` owning `runVerification*`, `applyLadder`, the re-check, forced verification and the one "on pass" reset (`1242-1325`, `1436-1549`, `1584-1731`).

   **Smallest safe first step:** extract (a) with no behaviour change and record `phase` on each `TurnResult` and in the evidence bundle. It is a pure function, trivially tested and diff-small. Then run the Phase A replays to see where turns are actually spent before any phase restricts tools. Step two, behind a switch: in the repair phase, expose only the write tools plus `read_file`/`read_symbol`, with thinking on. Only then extract (c), which removes most of `executeTurnInner`'s score.
4. **Reconcile the ladder with the design.** Either implement rung 3 as narrow-or-escalate and move re-plan to rung 4, or amend the design. Delete `requireSketch`/`park`, or enforce the sketch as a required `note` before the next write.
5. **Collapse stop reasons to six plus detail, and delete the dead code in §3.** Replace the six runner sets with one table. This is cross-domain (kernel, UI) and needs owner sign-off.

## 7. Verdict

- **Domain: refactor.** The architecture is right (a closed loop, typed feedback, structural refusals), and most mechanisms are sound. The defects are in the feedback the Worker receives and in the size of two god-methods.
- `session.ts`: **refactor.** Strangle into policy, dispatch and verification. Cut lines 1757-1895.
- `card_runner.ts`: **refactor.** Extract `runSample` into a `SampleRunner` and `finish` into evidence and board steps, and use one stop-reason table.
- `tools.ts`: **keep, then refactor.** Fix the three feedback bugs. Later, split process, browse and docs into their own modules.
- `detector.ts`: **keep.** Fix its input: a content-aware fingerprint.
- `ladder.ts`: **refactor.** Match the design, and drop or enforce the dead fields.
- `tool_catalog.ts`: **keep.** Recommend a smaller implement-class list, with owner sign-off.
- `repo_map.ts`: **cut, after merging** `dataContract` and the "(no exports)" filter into the ranked map. Owner sign-off needed.

## Top 5 changes

1. **Content-aware repo fingerprint.**
   - **What:** hash `git diff HEAD` plus untracked file contents (or combine the session's write counter into the signature).
   - **Why:** `git_adapter.ts:337-344` ignores content changes (verified), so A-B-A (`detector.ts:98-113`) warns after real edits.
   - **Effort:** S. **Risk:** low. Cost is one extra git call per turn.
   - **Measure:** a new real-git spec (edit the same file twice → the hash differs), plus a count of stall warnings that follow a successful write in replays, before and after.
2. **Data contract into the production map.**
   - **What:** port `dataContract` and the empty-file filter into `ranked_repo_map.ts` render, and test through `session.buildPrompt`.
   - **Why:** `session.ts:841-860`, `repo_map.ts:62-108`, and the verified missing schema.
   - **Effort:** S. **Risk:** low. Watch the 1,200-token budget.
   - **Measure:** the prompt for `onyx_4_vault` contains `created INTEGER`; the card's result in the next suite run.
3. **One-step, non-contradictory tool feedback.**
   - **What:** an outlined read is not listed as "(do not re-read)"; `readFiles` is cleared on `resetContext`; an `edit` not-found reply returns the three closest line windows.
   - **Why:** `tools.ts:581/587`, `session.ts:982`, `1541-1545`, `ladder.ts:51`, `tools.ts:655`.
   - **Effort:** S–M. **Risk:** low.
   - **Measure:** the ratio of failed edits followed by a successful edit on the next turn, and re-reads per card, from the evidence bundles.
4. **Phase policy extraction, then a repair phase.**
   - **What:** `phaseOf(state)` recorded per turn (no behaviour change). Surgical thinking also fires after a failed automatic re-check. Fix the A-B-A bypass of the strict refusal. Then, behind a switch, a repair phase with write-first tools.
   - **Why:** `session.ts:535-589`, `1564-1566`, `601`; run 5's `onyx_7_cli` and vault replays.
   - **Effort:** M. **Risk:** medium. Refusals can confuse a 3B model, which is why it sits behind a switch.
   - **Measure:** the frozen-suite pass rate against the Phase A baseline (at least two runs), turns from a failed check to the first edit, and the biome score of `executeTurnInner` (119 → under 40 after the controller extraction).
5. **Verification controller plus a stop-reason table.**
   - **What:** move the four "on pass" blocks, three verify paths and `applyLadder` into one class. Replace the six runner sets and `mayVerify` with one `STOP_REASONS` table (class, resumable, parks, may-verify, next action).
   - **Why:** §3 and §4; the design's six-reason and next-action rules.
   - **Effort:** M–L. **Risk:** medium, touching the kernel/UI vocabulary (owner sign-off).
   - **Measure:** the full suite shows the same stop-reason distribution on replay (characterization), `runSample` and `finish` complexity drop, and every stop carries a non-empty next action (a test that walks the table).

**Uncertain:** the surgical-after-re-check gap and the strict-refusal bypass are established by reading, not by execution. How often the stall hash misfires in real runs is not measured. The replay transcripts would settle it.
