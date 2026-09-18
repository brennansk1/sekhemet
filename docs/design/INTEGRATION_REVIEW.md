# Integration review: how the parts fit, and how to make them work as one

Reviewed 2026-09-18 against the working tree of `claude/harness-definition-done-4d9161` at `9731b30`. The tree also held uncommitted work from a concurrent session (the Worker's `askTeam`, the team note, and residency on the runner lease). Findings C2 and D1 concern that work.

**Scope.** The queue path the benchmarks use (`scripts/run_gate.sh` → `sekhemet queue --auto-accept`), the worker loop, context, gates, models, and the harness's `pm/`, `learning/` and `research/` code. The review was read-only: nothing was built or run. Token figures marked *est.* are estimates from source sizes; measure them before acting on them.

---

## 1. The system as it actually runs

One `sekhemet queue` run (`apps/harness/src/index.ts`, `main`, the `queue` branch):

```
ModelRouter(factories)  →  router.calibrate(totalmem)  →  planResidency   (24 GB: one model at a time)
holdRunnerLease  (.sekhemet/runner.lock: roster and resident roles; the dashboard defers PM chat to the queue)
[--explore]  applyExploration  →  exploreProject + exploreCurriculum  →  LearningStore.propose, then update(active)

pass(ready, 1)   board order; inferDependencies defers a card until its prerequisites are done
 └ attempt(card, 1)  →  router.use("worker")  →  executeCard(ctx, card, model, guidance?, priorLessons?)
    ├ PlaybookRegistry(.sekhemet/playbook.toml)  +  LearningStore.activeFor  →  playbook.addRule (writes the toml)
    ├ CardRunner.run  →  worktree, stage acceptance tests  →  CardExecutionSessionImpl
    │   per turn:  buildPrompt (reduction levels 0–5)  →  buildPromptAt  →  buildFullPromptPack
    │              →  model.generate (tools sent natively too)  →  tools | check | ask | recall
    │              →  re-check after an edit, or finish_card  →  runVerification
    │                   (autofix, then one style fix per rule, then gates, then the integrity scan)
    │                   →  WorkingMemory.observe, RepairLadder.recordFailure
    │              →  onTurn: card/step on the ledger  →  afterTurn: answerPm (a human message swaps in Merit)
    ├ compileEvidence(attempt: 1)  →  .sekhemet/evidence/ev_*.json
    └ learnFromAttempt  →  recordOutcome (first attempts)  +  struggle candidates
   in memory: lessonsByCard, unexplained[], passedResults, workerQuestions      [--auto-accept] acceptCard

if --manager and something failed:  router.use("manager")
   planRepair for each failure  →  answerPm(batch) + collectAnswers  →  reflectWithManager
   →  reviewPassed (swap to the reviewer and back)  →  askResearcher ×≤3 (swap to the researcher and back, each)
   →  consolidateWithManager  →  pass(retry, 2, plans) on the worker, or the escalation model
deferred sweep: pass(deferred, 1)  (first attempts only; no manager batch follows)
[--review] reviewPassed  →  answerPm()  →  router.releaseAll  →  writeQueueReport (runs/*.json)  →  notifySlack
```

Outside the queue:
- **Dashboard** (`server.ts`, `pm_api.ts`):
  - It answers Merit's chat when no lease is held (`kick` → `answerQueued`).
  - A send-back becomes a candidate rule, a profile entry and a line in the legacy `playbook_candidates.jsonl` (`learnFromSendBack`).
  - Applying or discarding a proposal feeds the profile (`learnFromProposalChoices`).
  - Approving a rule in `/api/learning` makes it active from the next matching card.
- **`sekhemet tune`** replays `card/step` events and writes `.sekhemet/tuning/latest.json`, a recommendation only.
- **Merit's answers** read `buildSnapshot`: the board, `runs/*.json` (`workerRecord`), evidence files (`capabilityReport`), the profile and a Monte Carlo forecast.

---

## 2. Findings

Each finding gives the location, the harm, and how it is known.

### A. The Worker's context (16k window; request budget 16384 − 4096 − 256 = 12,032 tokens)

**A1. No single allocator. Pressure falls on the most valuable content.**
- `session.ts` `buildPromptAt` assembles 14 sources: laws, the tool interface, playbook and learned rules, the rung directive, skills, the repo map, pinned tests and scope files, the team note, the repair plan (up to 1,800 tokens, `planRepair maxTokens`), the contract, turns, failures with code excerpts and API hints, and completed work with working memory.
- `buildPrompt` reduces only four of them, in this order: the repo map, then the pinned scope files (level 3), then history, then tests (level 5). Rules, skills, the repair plan, the team note, lessons and failure blocks are never reduced.
- Harm: as those unreduced sources grow, the Worker loses its own file and spends turns reading it back with `read_file`.
- `packages/context/src/pressure.ts` (`applyContextPressure`, a tiered strategy, 251 lines) exists and is imported nowhere.

**A2. Tools are described twice on every turn.**
- The tool interface is rendered as text into Zone 1 (`buildFullPromptPack` → `renderToolInterface`).
- The same 20 tools are also sent as JSON schemas (`toolDefinitions` → `HttpInferenceAdapter` `payload.tools`), and the llama.cpp or Ollama chat template renders those into the prompt again.
- About 1–1.5k tokens each (*est.*). That is roughly 10–20% of the request budget, and prefill on every turn.

**A3. The same fact reaches the prompt from up to four places.** On Chronicle:
- **exactOptionalPropertyTypes:** seeded `rule_exact_optional` (playbook.toml); the explore rule `ts_exact_optional`; `remedyFor("TS2375")` in the failure block; and a struggle candidate reading "When you see TS2375 …: `<the same remedy>`" (`reflect.ts` `learnFromAttempt`).
- **node:sqlite:** `rule_node_sqlite`; explore `node_sqlite_api`; the curriculum's `api_node_sqlite`; and `apiHints` on failure.
- **ESM `.js` extensions:** `rule_esm_extensions` and `esm_js_extensions`.
- Cause: `LearningStore.propose` deduplicates (Jaccard ≥ 0.8) only against other learned rules. It never checks playbook.toml or `remedyFor`.

**A4. Rule scopes do not work as designed.**
- `LearningStore.activeFor` ignores `scope.errorPattern`. Error-scoped rules (every explore rule, every struggle rule) therefore ride in every prompt from turn 1, not when the error appears.
- These rules match every card:
  - `pathPattern: ""` (`node_sqlite_api`);
  - the Researcher's `scope: {}`;
  - 19 of the 37 seeded fixture rules, whose `pattern` is `"src/"`.
- `PlaybookRegistry.matchRules` ORs `triggerGate` with `pattern`. After any typecheck failure, file-specific rules for other cards join the prompt (for example Vanguard's `src/hmac.ts` rules).
- The cap of 8 sorts by value. With every value at 0, the cut falls in ledger order, so the curriculum API rules (added last) are the ones dropped.

**A5. Learned rules leak into playbook.toml.**
- `execute.ts` `executeCard` calls `playbook.addRule`, and `PlaybookRegistry.addRule` calls `save()`.
- Every active learned rule is therefore written into `.sekhemet/playbook.toml`, with `pattern` set to the current card's title, and the file's comments are stripped.
- Retiring the rule in the LearningStore never removes it from the file. The two stores diverge, and the Playbook screen then shows learned rules as "seeded".

**A6. Directives contradict each other.**
- **Re-reading files:**
  - The `fresh_context` rung (`ladder.ts`) says "Re-read the relevant files from disk".
  - Pinned files say "(shown in full; do not read_file it)".
  - `completedWork` says "read X (do not re-read)"; `getReadFiles` is not cleared when context resets.
  - Seeded `rule_finish_promptly` says "Do not re-read files".
- **The repair plan:** it says "Follow it exactly", but `loop/manager.ts` `planRepair` never sees the active rules, the explored constraints or the API hints. It can prescribe the very API a rule forbids.

**A7. The cache prefix is less stable than designed.**
- The rung directive is unshifted into `playbookRules`, which Zone 2 then sorts. Rules matched on `triggerGate` also change as failures change. Either way the *system* prompt changes mid-card, which invalidates llama.cpp's prompt cache from byte 0.
- The team note and the repair plan (both static for the card) sit after the pinned scope files, which change on every write. So they are prefilled again on every turn.

**A8. Lessons are truncated in the wrong place.**
- `WorkingMemory.seed` keeps the first 6 lines. `collectAnswers` appends Merit's answer at the end, so the answer is dropped whenever an attempt left 6 or more lines.
- `lines()` cuts at 10 with the seeded lines last, and prefixes nest ("from an earlier attempt: from an earlier attempt: …").

**A9. The output condenser is built but unused.**
- `run_cmd` output goes through `clampObservation`, which keeps a head and a tail and can cut error lines in the middle of long test output.
- `condenser.ts` `condenseCommandOutput`, which protects error lines and deduplicates, is used only by the unused `pressure.ts`.

**A10. Prompts for Merit, the reviewer and the Researcher have no budget.**
- `planRepair` inlines each acceptance test and scope file, up to 8,000 characters each (`collectCardFiles`), into an 8,192-token manager window.
- Ollama silently drops the start of an over-long prompt, which is where the card's spec is.

### B. Learning

**B1. On the benchmark, almost nothing learned reaches the Worker.**
- `run_gate.sh` creates a fresh repo, and so a fresh `events.db`, for every run. Project rules, the profile and rule outcomes start empty.
- Every candidate needs a human's approval, and no human approves anything during an unattended queue.
- So reflection, research, struggles and consolidation all produce candidates that affect nothing in the run. Only playbook.toml and `--explore` (which auto-activates its rules) reach the Worker, plus global rules if someone promoted them earlier.

**B2. Merit's reflection is told something false.**
- `reflectWithManager` runs *before* the retries. Every input therefore has `retryPassed: false`, and the prompt says "the retry with your plan also failed".
- The signal that matters most, whether the plan worked, is never collected. `reviewPassed` likewise runs before the retries, so a card that passes on retry is reviewed only with `--review`, at the cost of one more swap.

**B3. The helpful/harmful counters cannot tell rules apart.**
- `recordOutcome` credits every rule in the prompt with the card's result. Because of A4, almost every prompt carries the same rules, so the counters track the overall pass rate.
- `retirementCandidates` (harmful − helpful ≥ 3) will then flag every rule on a hard project and none on an easy one.
- A with/without comparison exists (`PlaybookRegistry` `RulePerformance` and `auditContextDebt`) and nothing calls it.

**B4. Three outcome stores disagree.**
- `workerRecord` reads `runs/*.json`, which knows attempt numbers.
- `capabilityReport` reads `evidence/ev_*.json`. There `card_runner.ts` hard-codes `attempt: 1` and nothing filters by model, so retries and escalation-model passes count as the Worker's first attempts. The capability model Merit plans against is inflated.
- `tune.loadAttempts` rebuilds attempts from `card/step` events, splitting where the turn counter restarts.

**B5. Some signals go nowhere.**
- **Notes:** the Worker's `note("Assumed: …")` lives only in `ToolExecutor.notes`. `askObservation` promises "so the reviewer sees it", and nobody does.
- **Review findings:** `card/review` findings reach the dashboard only. They go neither to Merit's snapshot, nor to a retry, nor to learning.
- **Send-back notes:** a note becomes a candidate rule, a profile entry and a JSONL line, but the returned card's next attempt does not see it.
- **`manager` rules:** the role exists in the type, but nothing produces or reads it.
- **Profile decay:** PM_CONTRACT §6 specifies it; it is not implemented.
- **Lessons:** `lessonsByCard` lives in memory and is lost when the queue restarts.

**B6. The Researcher works blind and too late.**
- `index.ts` asks it with only the error text and a hard-coded "TypeScript project": no card, no code.
- It runs *after* the repair plans are written, so its answer cannot shape a plan.
- The answer (`slice(0, 500)`) becomes an unscoped candidate that cannot help this run.

### C. Model scheduling (24 GB host)

**C1. The manager batch thrashes models.**
- `askResearcher` calls `router.use("researcher")`, then `router.use("manager")`, for each question.
- A batch with a reviewer and three research questions therefore evicts 10 times: worker → M → reviewer → M → R → M → R → M → R → M → worker.
- The work needs 4 evictions. At 40–120 s each (PM_DESIGN §2.5; run 7's cold start was 401 s), the 6 extra swaps cost about 4–12 minutes per run.

**C2. `askTeam` during an escalated retry is a memory hazard** (uncommitted code).
- `router.isResident("manager")` is true while the escalation model is resident, because the two share a model id.
- `askTeam` answers, then calls `router.use("worker")`, which evicts the 27B and loads Cyber-Tiel. The escalated session keeps calling its own adapter, so Ollama reloads the 27B behind the router's back.
- That puts about 13.7 GB and about 12 GB of weights on a 24 GB host: the failure mode behind the earlier OOM.

**C3. Hidden reloads on the same weights.**
- The manager (`num_ctx` 8192), the escalation model (12288) and `createPmAdapter` (8192) are separate adapters with the same model id.
- The router counts them as resident together, but Ollama reloads the runner whenever `num_ctx` changes. These reloads never show in `swapCount`.

**C4. The dashboard has a second scheduler that tracks no memory.**
- `pm_api.ts` `kick` loads Merit with `createPmAdapter`, and the Researcher as an *Ollama* model, with no router and no footprint check.
- Under `SEKHEMET_RESEARCHER=apodex`, a GGUF that the queue runs under llama-server, the dashboard sends "apodex" to Ollama as a model name.

**C5. Cards late in the dependency chain get fewer chances.**
- Deferred cards run after the only manager batch, so a failing deferred card never gets a plan or a retry.
- `inferDependencies` makes every card wait on the contract card. On Chronicle, `api` waits on `ledger`, the hardest card. This structure caps the "after escalation" score.

**C6. The tuner's recommendation is never applied.**
- The replay tuner measured that a 12-step cap keeps 17 of 18 passes and cuts time by 38%. The queue still uses each card's `stepBudget` (40), and `--max-turns` is opt-in.
- A fresh benchmark repo has no history to tune from.
- Each verification also starts 5 extra `pnpm exec biome` processes: the autofix, plus one per style rule (`card_runner` `styleFixCommands`). Verification runs after every edit that happens while a failure stands.

### D. Collaboration

**D1. The Worker's questions enter the human's chat as the human.**
- `appendUserMessage` records them as `actor: "human"` on the hash-chained ledger.
- Merit answers every queued question in one reply, and `collectAnswers` attaches that whole reply (its first 400 characters) to every card that asked, including answers meant for other cards.

**D2. No single place holds what the team knows about a card.**
- The repair plan is on the ledger and in the prompt.
- Lessons and Merit's answers live in in-memory maps.
- Research becomes a rule candidate.
- The review is on the ledger, for the dashboard only.
- Notes go nowhere.
- A send-back becomes a rule candidate, a profile entry and a JSONL line.

Each role sees a different, partial picture.

### E. Duplicated logic, configuration and dead code

**E1. Duplicated logic.**
- **Card kind:** parsed from the title with `/\(SPIDR:\s*([A-Za-z]+)/` in 4 places (`capability.cardKind`, `reflect.kindOf`, `store.activeFor`, `ui/vocabulary`), and the suffix is stripped in 5 more. Cards Merit creates carry no suffix, so they become "Other" and kind-scoped rules skip them.
- **Error-code regex:** in `index.ts` and in `reflect.ts`.
- **Reasoning-tag stripping:** `<think>` is stripped 8 times, although `HttpInferenceAdapter.generate` already strips reasoning. `/\{[\s\S]*\}/` JSON extraction appears 4 times.
- **Similarity:** there are two measures (`store.similarity`, and the ad-hoc overlap in `askObservation`).
- **Verification:** `session.ts` has four paths (`checkObservation`, the re-check after an edit, forced verification, `finish_card`), each updating state differently.
- **`moduleApiSummary`:** wrapped three times (API hints, the curriculum, the Researcher's `module_api`).
- **Stores:** two playbook stores, and two sinks for send-backs.

**E2. Configuration is spread over nine places.**
- The queue reads 17 CLI flags, 9 environment variables, `~/.config/sekhemet/repos/*.json`, `global_playbook.json`, `gates.toml`, `playbook.toml` and `tuning/latest.json` (advisory).
- `config.ts` `SekhemetConfig` (models, context budget, loop defaults: "config is now the single place those live") is read only by `server.ts`, for review minutes.
- Model profiles (context size, sampling) are written inline in `index.ts` and again in `pm_api.ts` and `pm/service.ts`, with magic names ("cyber-tiel", "apodex").

**E3. Code that is dead or off by default.**
- **Dead:** `pressure.ts`, `DefaultContextEngine`, `FileEvidenceStore`, `RulePerformance`/`auditContextDebt`, and the RTK condenser in the loop.
- **Off in the benchmark command:** `--explore`, `--review`, `--reviewer`, `--researcher`, `--escalate-retries` and `--max-turns`. The benchmark measures a harness without most of the features built this cycle.

---

## 3. Suggestions for ideal harmony and efficiency (ranked)

Ranked by effect on benchmark completion and speed on the 24 GB Mac.

| # | Change | Unifies | Expected benefit | Risk | Size |
|---|---|---|---|---|---|
| 1 | **Reorder the manager batch by residency** (see the sequence below). Remove the per-question `router.use("manager")`. Make `askTeam` return early unless `activeRole === "worker"` and the worker and manager are co-resident. | Researcher, Merit, reviewer, Worker questions | 10 → 4 swaps per run (4–12 min saved). Research can shape plans. Removes the C2 OOM path. | Low | S |
| 2 | **Give every card the same chances:** loop pass → manager batch → retry until nothing changes, so deferred cards get plans too. Reflect *after* the retries, with the real `retryPassed`. | Queue, reflection | Directly raises the "after escalation" score (Chronicle `api`, late Trifecta cards). The reflection signal becomes true. | Low (longer worst-case runs; cap at 2 batches) | S |
| 3 | **Fix rule scope and deduplication:** apply `errorPattern` only while that code stands; make `triggerGate` an AND condition; stop `addRule` persisting (add in memory); key facts by error code or constraint and suppress a rule when `remedyFor` or a seeded rule covers the same key. | Playbook, explore, remedies, struggles, Researcher | *est.* 0.5–1.5k tokens per turn back to scope files and history. Removes contradictory and duplicate guidance. Makes B3's counters meaningful. | Low | S |
| 4 | **Describe the tools once, and order the prompt from static to volatile:** text interface only when native tools are off. Keep the rung directive out of Zone 2 and place it in the volatile tail. Put static per-card blocks (team, plan, contract) before the scope files. | Prompt zones, adapter | *est.* 1–1.5k tokens per turn. More prefix-cache hits, so less prefill per turn. | Low: A/B one fixture for tool-call accuracy | S |
| 5 | **Apply the tuned stopping policy by default:** `queue` reads the newest tuning report (global under `~/.config`, so fresh benchmark repos inherit it). Run one `biome lint --write --unsafe` with every `--only` rule in a single call. | Tuner, gates | About 38% less wall time on recorded runs (the tuner's own replay). 4 fewer processes per verification. | Medium: a cap can cut a slow pass (1 of 18 on record) | S |
| 6 | **A card dossier on the ledger:** typed events `card/lesson`, `card/note`, `card/question` (actor `worker`), `card/answer`, `card/research`, `card/review` and `card/send_back`, read by `executeCard` for every attempt and by `planRepair`, the reviewer and Merit. Replaces `lessonsByCard`, `workerQuestions`, the notes and the JSONL sink. | All four roles, the human | Retries see the send-back note, the review, the research and the answer meant for *this* card. Survives a queue restart. Fixes D1 and A8. | Medium (migration of readers) | M |
| 7 | **One context allocator** (target architecture below) replaces `buildPrompt`'s levels and the unused `pressure.ts`. | Every prompt source, including Merit's and the reviewer's (A10) | The pinned scope file is never the first thing cut. Every section has a known cap. Budgets for all four roles. | Medium: needs a fixture A/B | M |
| 8 | **In-run probation for verified learning:** a rule whose fact is executable (a config constraint, a remedy keyed to an error code, a research answer tied to the failing card) is active *for this run* only, and still needs a human to persist. Research answers go into the retry's dossier, not the rule list. | Explore, struggles, Researcher, reflection, approval | Learning finally pays off inside unattended benchmark runs (B1). | Medium: a wrong rule can hurt a run. Mitigate by scoping to the error, and by rolling it back when the retry fails | M |
| 9 | **One attempt record:** `card/attempt_finished` with the attempt number, role and model, the rules in the prompt, turns, tokens and the stop reason. `capabilityReport`, `workerRecord`, `tune` and `recordOutcome` all read it. Fix `attempt: 1` in the evidence. | Capability, tuner, Merit's snapshot, rule counters | Merit plans against true first-attempt rates. The counters get a with/without contrast by rotating rules across cards. | Low | M |
| 10 | **A scheduler that owns residency and work queues:** adapters keyed by weights with the largest `num_ctx`; per-role queues (plans, reviews, research, questions, chat); a batching policy decided by the residency plan. The dashboard's `kick` goes through it, or refuses when footprints are unknown. | Router, queue, dashboard chat, the 128 GB node | Removes the C3 hidden reloads and the C4 second scheduler. The 128 GB host gets true co-residency with no code change. | Medium | M/L |
| 11 | Shared helpers: a `kind` field on `CardRecord` (set by the planner and by Merit's proposals); `errorCode()`; `extractJson()` in models; one `verify()` in the session; one similarity function. | E1 | Less maintenance, and kind-scoped learning works for Merit's cards. | Low | S |
| 12 | One resolved `RunProfile` (config.ts → flags override), with `--profile benchmark` turning on explore, escalation, the tuned cap and the reviewer. A `models.toml` roster replaces the inline profiles. | E2, E3 | The benchmark measures the harness as built. One place to read the settings. | Low | M |
| 13 | Delete or merge dead code: `pressure.ts` (into #7), `RulePerformance` (into #9), `playbook_candidates.jsonl`, `DefaultContextEngine`. | E3 | Less code to keep in sync. | Low | S |
| 14 | Make the reviewer actually adversarial: check the diff against the spec and acceptance criteria, list untested behaviour, read the Worker's recorded assumptions. Findings go into the dossier, and a `likely_send_back` triggers one retry before Review. | Reviewer, dossier | Catches passes that meet the tests but not the intent before the human does. | Medium: extra retries cost time | M |

**The batch sequence for suggestion 1**, on a 24 GB host:
1. Worker pass.
2. Researcher: every unexplained struggle, each question carrying its card and code.
3. Merit: plans that use the research findings, answers to the Worker's questions, reflection *after* the retries, consolidation.
4. Worker retries.
5. Reviewer: once, at the end of the run, for every card that passed.

---

## 4. Target architecture

**One card dossier; the ledger is the only channel.**
- **Every role writes typed events about a card:**
  - the Worker's lessons, notes and questions;
  - Merit's plans and answers;
  - the Researcher's findings, with sources;
  - the reviewer's findings;
  - the human's send-back.
- **Every role reads the dossier through one function** (`dossierFor(cardId)`). In-memory maps, JSONL side files and the practice of routing Worker questions through the human's chat all go away.
- **The PM chat becomes a view.** It shows the human's conversation, plus Worker questions labelled as the Worker's. The ledger's actor field is true again.

**One context allocator for every role.** Each prompt is a list of typed sections, each with a priority, a token cap and a fact key. The allocator removes duplicate keys, fills by priority, places static sections before volatile ones (for the prefix cache), and cuts the lowest priority first. It serves the Worker, Merit, the reviewer and the Researcher alike. The Worker's order, highest priority first:
1. Laws and tools (once).
2. The card contract and acceptance tests.
3. The standing failure, with its code excerpt and a single remedy.
4. The scope files.
5. The dossier's directives: the plan, the answers, the send-back (capped).
6. Working-memory lessons.
7. Rules matched to the current error (top 3–5).
8. Recent turns.
9. The repo map.
10. The team note.

The goal is always re-stated at the tail.

**One learning pipeline with typed signals.**
- **Signals** come from four sources, each tagged with its source and its verification:
  - gate transitions (struggles);
  - attempt records (outcomes);
  - human actions (send-backs, proposal choices, edits);
  - model syntheses (reflection, research).
- **One Curator** turns signals into keyed facts. It deduplicates against seeded rules and `remedyFor` by key (an error code or a constraint), and scopes each fact to the error, path or kind it came from.
- **One lifecycle:** candidate → probation (in-run; executable-verified facts only) → active (human-approved; project or global reach) → retired.
- **Rule outcomes** come from the attempt record, with rotation giving a with/without comparison, so the counters mean something.
- **Consumers:** the Worker's allocator, Merit's snapshot (manager rules and the profile) and the reviewer. The tuner and the capability model read the same attempt records, so Merit, the Machine view and the stopping policy agree on the numbers.

**One scheduler that decides residency and batches work.**
- **Adapters** are keyed by weights, not by role. Roles on the same weights share one adapter with the largest context any of them needs.
- **Work** enters per-role queues: plans, questions, reviews, research, chat.
- **Batching:** the scheduler drains a queue whenever its model is resident, and orders swaps by which queues are waiting and by the residency plan. On the 24 GB Mac that means the batch sequence above. On the 128 GB node everything is resident, and queues drain as work arrives, with no code path changed.
- **One scheduler for all callers:** the dashboard asks the same scheduler, through the runner lease, rather than loading models itself.
- **One profile:** a single `RunProfile` from config (flags override) says which roles exist and which policies are on, so the benchmark measures what the product ships.
