# Domain 4: Context and prompts (Phase A review, read-only)

**Evidence base.** Code at `468f67f`. 109–120 real Worker prompts (`/tmp/claude-501/suite/{onyx,chronicle}/.sekhemet/blobs`; most are from run 5, before `c5d5bff`, and the chronicle ones are from the run in progress). 100 real onyx turns in `traces.db` (`gen_ai.chat` spans: real token counts and server cache-hit rate). My scripts only read these files.

## 1. Positioning: what the 3B-active Worker actually sees

**Size.** Median prompt is **7,563 real tokens** (p90 8,241, max 8,940). Median output is 73 tokens. Prompt tokens are 95% of all tokens.

**Share of prompt characters by section** (108 blobs):

| Section | Share | Verdict |
|---|---|---|
| Acceptance test (full) | 21.3% | **Signal.** It is exactly what a senior engineer wants in front of them |
| Tool index (system prompt) | **14.3%** | **Noise.** It lists 29 tools, and only 5–8 of them can be called |
| Scope file (current content) | 13.7% | Signal |
| GOAL tail (full spec and criteria, re-sent every step) | 13.3% | Signal, but in the uncached tail |
| Repo map | 7.1% | **42% of it is `path: (no exports)` lines**: test files, empty files, `vitest.config.ts` |
| Last gate failure, with the code at the failing lines | 6.7% | Strong signal. The best section in the prompt |
| Earlier turns, last turn | 8.4% | Mixed (see below) |
| Playbook rules | 4.9% | Signal: concrete gotchas from the fixture |
| "NON-NEGOTIABLE LAWS" (`prompts.ts:13-22`) | 4.5% | **Noise.** It is prose, which the design itself says this model ignores |
| Loaded-tool text, lessons, exemplars, contract | 5.5% | Mostly noise |

**Missing.** Interface *bodies* of imported types: the map prints `export interface CryptoEnvelope` with no fields (`ranked_repo_map.ts:104-107`). The DATA CONTRACTS fix appears in only 16/120 prompts so far.

**Contradictions a literal-minded small model receives** (counted over the blobs):
1. The REPAIR MODE directive "Your turn history has been cleared. Re-read the relevant files" (`loop/ladder.ts:51`) arrives next to "SCOPE FILE … do not read_file it" and "read src/cli.ts (do not re-read)", and above a populated EARLIER TURNS section. This happened in **28/28** repair-mode prompts. History is reset once (`session.ts:1548`), but the directive stays on every later turn, and the read-set and lessons are never reset.
2. "Call only the tools named below. **No other tool exists.**" (`tool_interface.ts:44`) is rendered above a *loaded-tools* block that lists 2 tools, while `read_file`, `edit` and others are callable. This happened in **57/120** prompts.
3. "You may emit several calls in one step" (`tool_interface.ts:41`) contradicts "emit exactly one tool call now" (`worker_prompt.ts:315`).
4. The pointers say "Use recall(ref)", but `recall` is not loaded in 67/120 prompts.
5. Every criterion is double-numbered, "1. 1. …" (**102/109**). The frozen fixtures already number their criteria, and `renderList` numbers them again (`worker_prompt.ts:228`).
6. "Suggested Fix Files: tests/e2e.spec.ts" appears under "NEVER modify test assertions" (49/109). This is a gate defect that is fixed upstream, but the context layer does not filter out failures in files the card may not edit.

**History.** The compaction index is itself masked: 50/120 prompts show `Turn 17: compacted history -> [Observation #17: …]`. `compactHistory` (`condenser.ts:618`) builds a one-line-per-turn index, and then `maskOlderObservations(compacted, 2)` (`worker_prompt.ts:821-822`) folds that index into one pointer. So the model loses the index the compaction was built to keep. Pointers say "preserved in WAL", jargon that means nothing to the model. A `run_script` result rendered as JSON-escaped file contents (`"…\n…"`, 9k characters) was the whole LAST TURN in one prompt.

**Cache economics, measured.** The server-reported cache hit rate has a median of **0.29** (mean 0.27). **Every one of the 100 turns** is below the design's 85% "defect" line. Yet the text prefix shared between consecutive steps is 67% (median). The system prompt was byte-identical within every attempt (0 of 104 step pairs changed), and the tool set changed 6 times. At about 290 tok/s prefill, that is **about 18 s of prefill per turn**, roughly 60% of model time (estimate: decode assumed at 30 tok/s). The 0.29 is about the share of the system prompt plus tool schemas. So the static user prefix (repo map, test) is **not** being reused.
- *Likely cause, not verified:* Cyber-Tiel is a Qwen3.x-35B-A3B derivative with hybrid linear attention. llama.cpp can then restore state only at checkpoints, and not at an arbitrary common prefix.
- The prefix guard's "stable" metric (`prefix_guard.ts`) is therefore true and useless. It tracks text identity, not what the server reuses.

## 2. Drift (design vs code)

- **The repo map uses the TypeScript compiler API, not Tree-sitter.** It covers TS/JS only (`ranked_repo_map.ts:55,123`), and the fallback is regex. A Python or Go repository gets essentially no map.
- **"LSP expansion" is not a stage of context assembly.** `lsp.ts` backs the `go_to_definition` tool only.
- **The pruner is lexical scoring (`pruner.ts`), not a learned SWE-Pruner.** It has never fired: there are 0 "Context was cut" notices across 120 prompts.
- **System prompt is over its target.** The design targets "under 1,000 tokens"; the real one is about 1,600 (5,026 chars). `assertSystemZoneBudget` runs only in the dead `buildFullPromptPack` (`prompts.ts:191`). The live zone-fraction assertion is skipped below a 12,288-token working budget (`zones.ts:149,165`).
- **"Fresh context on rung change"** is half-built (item 1 in §1).
- **The design says the 85% cache-hit alert is a defect.** The adapter measures the hit rate (`models/http_adapter.ts:332-354`), and nothing acts on it.
- **Playbook "grows from gate failures".** The suite's `playbook.toml` was hand-written "from the reference implementation", and it is solution-bearing. Flag for domain 10: it inflates fixture scores relative to real use.
- **Exemplars "teach local idioms".** In practice they are 3-line tool skeletons ("write_file → check → edit") with no code at all.
- **Never seen in a real prompt:** skills, conventions, repair plan, error rules. There is also a stale comment, "card prompts measure ~1.1-3k" (`http_adapter.ts:1176`).

## 3. Dead and duplicated code

- **Dead (test-only or unused):**
  - `prompts.ts` `buildFullPromptPack`, about 190 lines. It is a *divergent* duplicate of the Worker prompt ("Follow it exactly" vs "Follow it unless…").
  - `engine.ts` and `types.ts` (`DefaultContextEngine`, its own chars/4 estimator).
  - `condenser.ts` `ContextCondenser`, `condenseOutput`.
  - `tool_interface.ts` `renderToolIndex`, `measureToolInterface`, `toolInterfaceFromDefinitions`.
  - `worker_prompt.ts` `splitRulesByScope`, `assertPromptDeterminism` (test-only).
- **Duplicated:**
  - Three repo-map outliners: `context/repo_map.ts` (regex), `ranked_repo_map.ts` (AST), `loop/repo_map.ts`.
  - Two token estimators: `tokens.ts` (/4) and `allocator.ts:113` (/3.2). Real ratio from the traces: about 3.0 chars per token, so both undercount.
  - Two "tool_search was asked for files" paths: `tool_search.ts:83` `filesReply` and `session.ts:640` `filesAskedFor`.
  - `goalText` is duplicated in `prompts.ts:125` and `worker_prompt.ts:297`.
- **Prompt wording is authored in at least six places:** `prompts.ts`, `worker_prompt.ts`, `tool_interface.ts`, `tool_search.ts`, `loop/session.ts`, `loop/ladder.ts`, plus gate remedies and working memory. No one place shows the rendered result, which is how the contradictions in §1 arose.

## 4. Complexity hotspots

- **`worker_prompt.ts` (1,018 lines).** `buildSections` is about 360 lines of magic priority and order numbers (10…100, 0…1000). `buildWorkerPrompt` is about 195 lines and mixes assembly, pinning, metrics, determinism checks and zone assertions.
- **`allocator.ts` and `pressure.ts`.** Caps, fact-key dedup, priority fitting and five pressure tiers: sound, well-tested machinery that **has never engaged on a real prompt**, because prompts are about 50% of a 16k window.
- **`facts.ts` hard-codes four constraint keys** tuned to the fixtures (TS2375, `node:sqlite`, `.js` extensions). It is TS-specific overfitting inside a generic deduplicator.
- **`playbook.ts:488`** decides "over budget" with `e.reason.startsWith("costs")`, logic keyed on a string.
- **Module-level state:** `seenBuilds` (`worker_prompt.ts:792`) and `defaultEvidenceStore` (`evidence.ts:248`).

## 5. Test quality (DEFINITION_OF_DONE §2)

- **Good.** 11 specs and about 1,900 lines. Exact-value assertions dominate, and trivial `toBeDefined` appears twice. Prefix stability, pressure tiers and the tool_search dead-end regressions are pinned to named suite incidents.
- **Gaps:**
  - **No test of the rendered prompt's coherence.** None of the six contradictions in §1 would fail a test.
  - No golden test from a recorded real input.
  - No test of compaction followed by masking; the bug in §1 is untested.
  - No test that loaded tools are not described twice when schemas go natively. `worker_prompt.ts:464` renders the text block regardless of `native`.
  - `condenser.spec.ts` asserts the jargon ("preserved in WAL") and tests the dead `condenseOutput`.
  - `context.spec.ts` tests the dead `DefaultContextEngine`.
- **§2B (two negative cases per happy path) is not met** for `ranked_repo_map`, `pruner`, `exemplars` or `tool_search`.
- **Mechanism tests assert a proxy.** "Byte-stable prefix" passes while the real cache hit is 0.29.

## 6. Senior judgement, ranked by impact

1. **Make the prompt coherent before making it smarter.** Remove the six contradictions and the prose "laws". Put all Worker-facing wording in one module (`worker_copy.ts`), and add golden tests on 3–5 recorded real inputs that fail on known contradictions. This costs almost nothing and removes instructions the model provably acts on wrongly.
2. **Drop `tool_search` for the Worker. Give it a fixed tool set per card class with full native schemas.**
   - Evidence: tool_search cost cards in runs 3, 4 and 5 (`onyx_4_vault` twice, `chron_db` eight searches, `chron_ledger`). In the visible histories, **5 of 9** tool_search calls asked for tools that were *already loaded* (`check`, `finish_card`).
   - The index costs about 950 tokens (14%) on every turn, more than the full schemas of the 3–4 tools it is actually used to fetch. Loading also changes the native tools block mid-card, which sits in the cached prefix under Qwen-style templates.
   - `toolsForClass` exists, but `implement` falls through to all 29 tools (`tool_catalog.ts:498`). Give it about 9 core tools; keep progressive loading only if the A/B favours it.
   - Verdict: **change → probably cut**.
3. **Fix the cache before cutting tokens.** Prefill is the Worker's wall clock. First confirm why the hit rate is 0.29 (the hybrid-model checkpoint theory). Then choose:
   - (a) sized llama.cpp checkpointing at the static/volatile boundary, or
   - (b) an append-only transcript between masking points: mask in batches every *k* turns, so the prefix changes every *k* turns and not every turn. This also shows the model its history as native tool-call and tool-result messages, the format it was trained on, instead of `Turn 17: run_script -> …` text.
4. **Move the spec into the cached static zone.** Leave a short tail: step counter, what is still to write, one next action. Today 13% of the prompt (the full spec) is re-prefilled every turn.
5. **Repo map: signal only.**
   - Drop `(no exports)`, test files and config files.
   - Show only the scope's imports and importers.
   - Give DATA CONTRACTS its own high-priority section. Today it is appended to the repo map, the *lowest*-priority section (priority 10). Pressure tier 2 trims the map from the tail (`pressure.ts:197`), so the contracts go first.
6. **History.** Never mask the compaction index, pretty-print structured results, and load `recall` whenever a pointer is shown.
7. **Exemplars.** Show the accepted diff hunk of a same-class card (real idioms), or cut them. A/B.
8. **Leave allocator, pressure and pruner dormant.** They are insurance; add nothing until a real prompt triggers them.

## 7. Verdict per file

| File | Verdict |
|---|---|
| `worker_prompt.ts` | **Refactor.** Split into copy, sections and assembly; fix compaction-then-masking and the double numbering; stop duplicating loaded tools under native |
| `prompts.ts` | **Cut** `buildFullPromptPack`; keep a rewritten 3–4 line system constant |
| `tool_search.ts` | **Cut for the Worker**, after the A/B and with owner sign-off |
| `tool_interface.ts` | Keep; fix the preamble; remove its 3 dead exports |
| `allocator.ts`, `pressure.ts` | Keep (dormant) |
| `zones.ts`, `tokens.ts` | Refactor: one estimator calibrated to the real tokenizer, and assert the budgets on the live path |
| `condenser.ts` | Refactor: remove the dead API and the jargon; keep `condenseToolOutput` |
| `ranked_repo_map.ts` | **Rebuild** on Tree-sitter for more than one language (proposal below). Short term: filter out the noise |
| `repo_map.ts`, `engine.ts`, `types.ts` | **Cut** |
| `playbook.ts` | Keep; minor cleanup |
| `facts.ts` | Refactor: move the keys to data |
| `prefix_guard.ts`, `versioning.ts`, `evidence.ts` | Keep (evidence: remove the global singleton) |
| `exemplars.ts` | Rebuild the content or cut, decided by an A/B |
| `lsp.ts` | Keep; move to `loop` (it serves tools) |
| `skills.ts`, `conventions.ts`, `subtask.ts` | Keep; never exercised by the suite |

## Proposals (none added without owner approval)

1. **`web-tree-sitter` plus grammar packages** (MIT; very active; used by Aider, Zed and others). Replaces the three outliners and gives a multi-language repo map with definition and reference `tags.scm` queries (Aider's query set is MIT or Apache-2.0; verify per file). Why: professional teams are not TS-only.
2. **llama-server's own `/tokenize` endpoint** (MIT, already running; no new dependency). Replaces both character heuristics with a per-model calibrated ratio, measured at card start. Why: /3.2 and /4 both undercount (real ratio about 3.0), so the budgets are wrong on the side that matters.
3. **`@ast-grep/napi`** (MIT; active). An alternative to (1) if structural search is wanted too.
4. **promptfoo** (MIT; active), *optional*. Prompt regression tests over recorded inputs. Try Vitest golden files first.
5. **GEPA** (`gepa-ai/gepa`, MIT, Python, active). For the design's offline prompt optimizer, scored by the frozen suite. Later: it is costly at 290 tok/s prefill.
6. **Rejected.** LLMLingua-2 (MIT) is lossy on identifiers. A learned SWE-Pruner is unjustified while nothing is ever cut.

## Top 5 changes

| # | What | Why (evidence) | Effort | Risk | How measured |
|---|---|---|---|---|---|
| 1 | **Coherence pass**: one copy module; remove the laws, "No other tool exists", the stale REPAIR MODE claim (show it once only; reset the read-set), the double numbering, "WAL"; filter failures in files the card may not edit; golden tests on recorded inputs | 28/28, 57/120, 102/109, 49/109 contradiction counts (§1) | S | Low | Golden tests; frozen-suite pass rate; turns spent on `read_file` or `tool_search` after "do not re-read" |
| 2 | **Replace tool_search with a per-class tool set** (about 9 tools, native, stable per card) | Runs 3–5 losses; 5 of 9 calls were for loaded tools; the 14% index share | S–M | Medium: a missing tool on a rare card | A/B on the suite: pass rate, tokens per turn, tool-call format errors |
| 3 | **Diagnose and fix KV reuse** (checkpoint at the static boundary, or append-only between masking points) | Hit rate 0.29, 0% of turns ≥85%, about 18 s prefill per turn | M | Medium: touches the determinism rules | `sekhemet.cache_hit_rate` and wall-clock per card, before and after |
| 4 | **Repo map and data contracts**: drop the no-export, test and config entries; make contracts a high-priority section; spec into the static zone | 42% of the map is noise; contracts sit in the first section to be cut; 13% spec re-prefilled | S | Low | Map tokens; suite failures attributed to "guessed interface" (the `onyx_4` class) |
| 5 | **Fix compaction then masking**, and render structured results readably | 50/120 prompts lost the compaction index; escaped-JSON LAST TURN | S | Low | Unit test on the interaction; `recall` usage; repeat-read counts |

*Uncertainties:* the hybrid-checkpoint cause of the 0.29 hit rate; the size of the native schemas (not stored in the blobs); most blobs predate `c5d5bff`, so some counts may already be lower.
