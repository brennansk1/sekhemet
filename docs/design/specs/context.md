---
spec: context
status: partial
audiences: [developer]
code:
  - packages/context/src/worker_prompt.ts
  - packages/context/src/prompts.ts
  - packages/context/src/tool_interface.ts
  - packages/context/src/ranked_repo_map.ts
  - packages/context/src/condenser.ts
  - packages/context/src/zones.ts
  - packages/context/src/allocator.ts
  - packages/context/src/pressure.ts
  - packages/context/src/playbook.ts
  - packages/context/src/exemplars.ts
  - packages/context/src/versioning.ts
  - packages/context/src/prefix_guard.ts
  - packages/context/src/subtask.ts
  - packages/context/src/conventions.ts
  - packages/loop/src/working_memory.ts
  - apps/harness/src/learning/store.ts
  - packages/loop/src/repo_map.ts
  - packages/models/src/llama_server.ts
tests:
  - packages/context/tests/worker_prompt.spec.ts
  - packages/context/tests/worker_prompt_wave2.spec.ts
  - packages/context/tests/compaction.spec.ts
  - packages/context/tests/allocator.spec.ts
  - packages/context/tests/playbook.spec.ts
  - packages/context/tests/playbook_scoping.spec.ts
  - packages/context/tests/tool_output_evidence.spec.ts
  - packages/loop/tests/c_integration.spec.ts
  - packages/loop/tests/prompt_wiring.spec.ts
changes: [M1, M5, M8, P1, T2, NEW-context-1, NEW-context-2, NEW-context-3, NEW-context-4, NEW-context-5, NEW-context-6]
---

# Context assembly and the prompt

## 1. Purpose

Context assembly decides what the Worker sees on each turn: the card, the code it builds on, the project's guidance and what just happened. A 3B-active model in a 16k window cannot tolerate noise, contradiction or a prompt that changes under it, so the prompt is assembled deterministically, kept append-only for the prefix cache, and held to hard budgets. It serves **a card is the unit of work** (context is per card, never accumulated across cards) and the product's local promise: on local hardware, prompt reading is most of the Worker's wall-clock.

## 2. Behaviour

### Determinism and the cache

1. **Assemble, never accumulate.** Each attempt starts from a pack built from the card and the repository; nothing from another card's conversation is carried. The same card, repository state and context version produce a byte-identical first prompt.
2. **Append-only within an attempt.** The system prompt and the tools array are byte-identical on every turn of an attempt. Each turn's prompt is the previous turn's prompt with new messages appended; earlier messages, including tool output, are never edited in place. History is sent as native tool-call and tool-result messages, the format the model was trained on.
3. **Compaction is rare and whole.** Older observations are masked in batches at masking points (at most once every k turns, and when pressure requires it), never one step at a time; the prefix therefore changes at most once per batch. A masking point replaces each masked observation with a pointer of about 15 tokens naming what it was and how to get it back (`recall(ref)`); the full observation stays in the ledger's blob store. Outside context pressure, the five most recent observations are never masked; the pressure tiers may reduce that to two.
4. **Thinking does not rewrite history.** If the Worker thinks, earlier thinking is preserved in the conversation (`preserve_thinking`, reasoning sent back); if it is stripped, it is stripped at a masking point, never between two ordinary turns. No template may emit empty `<think>` blocks for past turns.
5. **Nothing volatile before the boundary.** Timestamps, session ids, counters and other per-turn values appear only in the newest message.
6. **Server settings that serve reuse.** The Worker's llama-server runs with `cache_prompt: true` on every request, `--cache-ram` and `--ctx-checkpoints` sized to the host (2,048 MiB and 6 at ≤ 32 GB; 4,096 and 8 at ≤ 64 GB; 8,192 and 16 above), `--checkpoint-min-step` between 512 and 1,024 (chosen by measurement), and **without** `--cache-reuse`, which shifts the KV cache and cannot work on hybrid-attention models. Slot save/restore files are not relied on for hybrid models. Slot prefix similarity (`-sps`) is passed only to a server with more than one slot (the Researcher's two-slot server), never to the Worker's single slot, where there is nothing to choose between (`llama_server.ts:305-307`). These values hold for the **single-user profile** (one slot, batch one). Batch size is a property of the host, not of this design: on a multi-user server the engine's qualified parallel capacity ([models.md](models.md)) decides the slots, and the cache and memory budgets above are per slot. The byte-stable, append-only prompt (rules 1–5) is kept on every engine, because every engine's prefix cache rewards it.
7. **The cache is measured, not assumed.** Every turn records the server-reported cached and evaluated prompt tokens and the hit rate. Text identity of the prefix (`prefix_guard.ts`) is a diagnostic, not the measure. A median hit rate below 0.85 on turns after the first of an attempt is a defect: it is reported in the run's evidence and **alerts the operator** in the queue report and on the Machine view, naming the card and the median.

### Layout

8. The prompt has four zones, in this order:

   | Zone | Contents | Changes |
   | --- | --- | --- |
   | 1 | System prompt, tool interface, output contract | Never within a version |
   | 2 | Project conventions (the repository's own `AGENTS.md`, `CLAUDE.md` or `.sekhemet/CONVENTIONS.md`, read when present), playbook rules, skill manifest lines, exemplars | Only at card boundaries |
   | 3 | The card: spec and acceptance criteria, the acceptance test, the static per-card blocks (the dossier's directives, the team note, a re-plan's plan or an edit sketch), the scope files' contents, the data contracts, the repo map slice | Once per attempt |
   | 4 | The volatile tail: step counter, what is still to be written, the latest observation or gate failure (with the code at the failing lines), the current rung's directive, one next action | Every turn (appended) |

   The full spec and criteria sit in Zone 3, inside the cached prefix; the tail restates the goal in one line and names the criteria still unmet, where attention is strongest. Static per-card blocks come **before** the scope files, which change with every write, so a write never forces the blocks to be re-read; the repair rung's directive lives in the tail, never in Zone 2's rules, so a rung change never edits the system prompt.
9. Immutable material comes first and task material last; nothing important sits in the middle of a long block.
10. **Zone budgets**, as fractions of the working budget W: Zone 1 ≤ 0.12W, Zone 2 ≤ 0.10W, Zone 3 ≤ 0.50W, Zone 4 the remainder and never below 0.20W. The system prompt stays under 1,000 tokens and the tool interface under 2,000. The budgets are asserted on the live assembly path at every W. When Zone 3 cannot fit, assembly shrinks the repo map slice first, then drops the lowest-ranked symbols, then refuses the card at the `ready` entry condition — it never overflows.
10a. **One allocator, every section capped.** Every section of every role's prompt is a typed section with a priority, a token cap and, for guidance, a fact key. The allocator removes duplicate fact keys, fills sections by priority with static sections before volatile ones, and cuts the lowest priority first. For the Worker the priority order is: the tool contract; the card's contract and acceptance tests; the standing failure with its excerpt and one remedy; the scope files; the dossier's directives (capped); the working memory; the playbook rules matched to the current error first; recent turns; the repo map; the team note. The pinned scope files and the acceptance test are never the first thing cut. Today only four of fourteen sources are ever reduced (repo map, scope files, history, tests); rules, skills, the repair plan, the team note, lessons and failure blocks are not (NEW-context-3).
10b. **Tools are described once.** When the adapter sends native tool schemas, the text tool interface is left out of the system prompt and the schemas' size counts against Zone 1 (`worker_prompt.ts:70-76`); the text interface is rendered only when native tools are off.
10c. **Every role has a budget.** Seshat's, the Reviewer's, the Researcher's and the re-plan's prompts go through the same allocator with their own window, and no prompt is sent that exceeds its model's configured context. An engine that silently drops the start of an over-long prompt (Ollama does, and the start is the spec) is never relied on: the assembler cuts by priority first, and the adapter refuses a request whose counted tokens exceed the context it set (NEW-context-3).
11. **One token estimator**, calibrated per model against the server's own tokenizer at the start of a card; character heuristics are only a fallback.
12. **Graduated pressure.** As the prompt approaches W, masking tightens at 70%, 80%, 85% and 90%; at 95% the step ends with `budget_exhausted` rather than truncating silently. Truncation of anything is announced in the prompt ("Context was cut: …").

### What goes in

13. **The repo map** ranks files by personalised PageRank (damping 0.85) over the reference graph, seeded on the card's scope, and fits the top-ranked outlines to a 1,200-token budget by binary search; it is byte-stable for the same tree, scope and budget. Edge weights: an import is weight 1; a use of an identifier another file exports is weight 1 shared among its exporters (names exported by more than five files are ignored); a scope file ranks the files that use it by a reverse edge of weight 0.5, because a change there must keep its callers compiling; scope files are always ranked first (`ranked_repo_map.ts:282-318`). Identifiers the card's spec mentions, and long, well-named identifiers, are weighted up as Aider does (NEW-context-5). The cache key covers paths, sizes and mtimes today; a content hash joins it, so an edit that keeps size and mtime cannot serve a stale map (NEW-context-5). It shows only files with something to build on: no `(no exports)` entries, no test files, no tool configuration. It is built with the TypeScript compiler for TS/JS; other languages are T2's (rule 13b).
13a. **Large repositories rank at two levels.** When a repository has more workspace packages than fit a tenth of the repo-map budget, the map first renders a **package map** — one line per package: name, a role line and its dependencies — and ranks files only inside the packages the card's scope touches (T2).
13b. **Roles and other languages come from the source index.** A file's role, where the map or scope declaration needs one, is one line derived from the source index — its exports and first documentation comment — never from a model. For a language whose parser adapter has a tags query, the map is built from the index's definitions and references with the same ranking as for TypeScript, and the card says which parser produced it ([gates.md](gates.md) T2 owns the index).
14. **Data contracts** — the fields of the exported interfaces and the tables created (`CREATE TABLE`) in the files the card builds on — are their own section in Zone 3, at a priority above the repo map, so pressure trims the map before the contracts.
15. **The acceptance test and the scope files** are pinned in full and marked as already seen.
16. **Gate failures** reach the prompt in the repair contract's shape ([gates.md](gates.md)), at most three, with the code at each failing location; raw logs never do. A failure in a file the card may not edit is not presented as a place to fix it.
17. **Output condensing.** Tool output is condensed before it becomes an observation, by a native reimplementation of RTK's four strategies — filter (ANSI, spinners, blank noise), group (tests by status, lint by rule), truncate (keep error lines, paths and exit codes; trim traces) and deduplicate (repeated lines to counts). The RTK binary is never required: `read_file`, `grep_search`, `find_files` and `run_cmd` all use the native condenser, and PROVENANCE's optional binary is not on any v1 path. Condensing is lossless for repair data: error lines, file paths, test names and exit codes survive. The raw output is kept in the blob store. Structured results are rendered readably, never as escaped JSON. Each condensing records the tokens it saved (`condenser.ts:73-77`), and the run reports the total and the share saved per tool — the measure register R2's threshold (≥ 60% fewer tool-output tokens with no rise in repair turns) is judged on (NEW-context-5).
18. **Subtask branching.** A `subtask` runs in a clean child context seeded from the parent's Zones 1 and 2 plus its own question and scope, and returns only its answer and an evidence reference; the parent never receives the child's trajectory.
19. **Fresh context on a rung change.** Ladder rungs 2 and 3 rebuild the pack from the card and discard the attempt's history ([worker-loop.md](worker-loop.md)).

### Coherence

20. **The prompt never contradicts itself.** It does not say a tool list is exhaustive when other tools are callable; it does not both allow several calls per step and demand exactly one; it does not tell the model to re-read a file it is told not to re-read; it does not show a pointer without the tool that resolves it; it does not number an already-numbered list; it uses no internal jargon ("WAL"). A prompt that fails any of these is a defect caught by a test.
21. **One place for the Worker's words.** Every sentence the Worker reads that is not card data comes from one copy module; the system prompt is a few lines: identity in a sentence, the output contract and the hard rules (scope, no gate edits, stop conditions). Instructions are positive and concrete. There is no persona framing and no prose "laws" section; structure is carried by tags, not by forcing reasoning into JSON. No prompt template contains a bracketed placeholder (`[describe the change]`, `<your answer>`): small Qwen-family models copy them verbatim. Where a model must produce a shape, the template gives numbered requirements and an empty file skeleton instead.
21a. **A prompt change is measured before it ships.** A hand-made change to the prompt templates, the copy module or the tool descriptions changes the context version (rule 27) and is merged only with a frozen-suite A/B recorded in `SUITE_RUNS.md` under [measurement.md](measurement.md)'s statistics; an unmeasured change is a defect, however well it is argued.

### Scope: from a specification to `filesTouched`

22. Before a card is `ready`, the Planner declares its scope with a bounded search, outside the Worker's budget: (1) every identifier-like token in the spec is looked up in the repo map's symbol table; (2) lexical search over the remaining terms, ranking definitions above references, source above tests, tests above generated files; (3) the files found are expanded one hop along the reference graph; (4) a cap of twelve tool calls and one Planner turn — if scope cannot be declared within it, the card does not become `ready` and a decision request asks which files are in play. The result is a declaration: the Worker may read outside it and may not write outside it. Whether twelve is the right cap is decided by measuring scope precision and recall against the files a person would have named (CX-P1-5). In a workspace, a card's scope sits inside one package where it can ([gates.md](gates.md) IX-5 records the packages).

### What the harness remembers

23. The harness remembers three kinds of thing and nothing else. **Guidance** is what a model is told: playbook rules, skills, exemplars and the card's dossier — scoped, dated, attributed to the signal that produced it, retired when it stops earning its place, and delivered only in Zone 2 at a card boundary. **Measurements** are what the machine observed about itself: outcomes, qualifications, throughput, and the budgets and routes derived from them, each keyed by class and settings (a number without its settings is not admissible). **Fetched bytes** are everything read from outside — documentation, pages, repository reads, raw observations — content-addressed, expiring by the mutability of what they hold, and safe to delete. Each kind has exactly one location and one writer; a store that is none of these is a design error.
24. **The playbook** is per project, versioned, and grows by delta, never by wholesale rewrite. Each rule carries its id, role (Worker or PM), scope (card kind, path pattern, error pattern such as a `TS\d{4,5}` code or a lint rule), origin card, trigger gate, instruction, effective date and evidence, and its helpful and harmful counts with a recency-weighted value. A rule starts as a candidate and is in force only when a person approves it; similar rules are consolidated rather than duplicated; a rule whose harmful count exceeds its helpful count by three or more is proposed for retirement. At most eight rules, those scoped to the card, reach one prompt, and only at a card boundary — the ones matching the card's current error code first. Project rules live on the project's ledger; a rule applies to every project only when a person promotes it to the global store in their configuration directory. How a candidate is admitted is [measurement.md](measurement.md)'s inlet rule.
24a. **One store per kind of rule.** Learned rules live only on the ledger; the harness never writes `.sekhemet/playbook.toml`, which holds only the rules a person wrote by hand and is read like `gates.toml` (learned rules join the card's playbook in memory, `execute.ts:359-369`). The dashboard shows a seeded rule as seeded and read-only.
24b. **Scoping is exact.** A rule applies to a card only when every scope it declares matches: its kind (from `cardKind`, not a title pattern), its path pattern, its error pattern while that error still stands, **and** its trigger gate — conditions combine with AND, never OR. An empty path pattern, an empty scope object or a pattern that matches every path (`src/`) is refused when the rule is written, because it would put the rule in every prompt. Ties in value are broken by the most recent evidence, then by id — never by ledger order (NEW-context-4).
24c. **One curator, one fact per key.** The same fact can reach a prompt from four places — a seeded rule, an exploration rule, a gate's remedy (`remedyFor`) and a struggle candidate. Every candidate is keyed by what it is about (an error code, a constraint, a path) with one `errorCode()` helper, and one curator deduplicates it by key against seeded rules and gate remedies as well as learned rules, with one similarity function (today `LearningStore.propose` compares only learned rules, by Jaccard ≥ 0.8, `store.ts:155-158`) (NEW-context-4).
24d. **Rules for the PM.** A rule with role PM is written from signals about planning (a send-back that names a plan's mistake, a re-plan's cause, a person's edit of a proposal) and reaches Seshat in its snapshot, at most eight at a time, never the Worker ([planner-pm.md](planner-pm.md) owns the snapshot) (NEW-context-4).
24e. **Credit only where it is due.** A rule's helpful and harmful counts come from the attempt record ([worker-loop.md](worker-loop.md)), and rules in force are rotated across comparable cards so each rule has cards run with and without it; crediting every rule in a prompt with the card's outcome only tracks the project's pass rate (integration review B3). The playbook's `RulePerformance` counters (`playbook.ts:81`), which the diagnostics' context-debt audit reads (`auditContextDebt`), are derived from those records, not kept as a second tally (NEW-context-4).
24f. **Learning within a run.** In production use, a lesson verified by execution — a gate that failed and then passed with the lesson applied (a configuration constraint, a remedy keyed to an error code, a research answer tied to the failing card) — may be applied to later cards of the same run **on probation**: recorded as probationary, shown as such, and rolled back by the paired rule when cards with it do worse. In a **measurement run** (the frozen suite, a bake-off, the planning measure) no rule or exemplar learned during the run is applied to a later card, so trials stay independent ([measurement.md](measurement.md) rule 6).
25. **Exemplars** are one or two accepted cards of the same class from this repository, shown as the accepted diff hunks (real code, not tool-call skeletons); generic examples are never used. **Public agent trajectories are never exemplars**, at any price: they carry another harness's tool vocabulary (`create`, `edit 1:1`, `str_replace_editor`), and an exemplar in the stable zone teaches a small model, as authoritative, tools this harness does not have. Playbook rules are likewise local-only: a rule's value is "this reviewer, on this repository, keeps returning cards for this", which does not transfer. A trajectory becomes an exemplar only if it is structurally complete (events in order, every tool call closed). Whether exemplars stay at all is decided by an A/B.
26. **The attempt's working memory** lists, in the volatile tail, the failures the Worker fixed (with "do not reintroduce") and the fixes that did not work, at most six of each; a failure that vanished because the run failed earlier or differently is not "fixed". The fresh-context rung discards it. Truncation is defined: what an earlier attempt left (the dossier's lines) is kept newest first and an answer from Seshat is never the line cut; lines are clipped individually, never by dropping whole entries in insertion order; and a line carried from an earlier attempt is prefixed once, never nested. Today `seed` keeps the first six lines, so Seshat's appended answer is dropped, and `lines()` cuts at ten with seeded lines last (`working_memory.ts:79-96`) (NEW-context-3).
27. **Versioning.** The prompt templates, the rules in force and the tool catalog are hashed together into one context version (`computeContextVersion`), stamped on every pack and evidence record. A new version invalidates the affected models' qualification ([models.md](models.md)) and schedules their re-qualification, because the harness and the prompt are jointly the thing measured; a model with an invalidated qualification is not used as Worker without a recorded override.

### Deliberately not done

28. No model-written summaries of the trajectory — they drop the exact strings later steps need. No embedding search or vector compression of code context. No large windows: a larger machine buys co-residency and parallel cards, never a longer prompt. No LSP expansion as an assembly stage (the language service backs tools instead).

### Measurement

29. Per turn: prompt tokens by zone, the prefix hash, masked-observation count, cached and evaluated prompt tokens, hit rate, and tokens saved by condensing. Per card: peak context, steps to first gate pass, and pass rate against pack size, which the competence model uses to lower budgets when smaller packs pass more often.

## 3. Contract

| Item | Source |
| --- | --- |
| Worker prompt assembly `buildWorkerPrompt`, sections and priorities | `packages/context/src/worker_prompt.ts` |
| System prompt `PROMPT_ZONE_1_SYSTEM` | `packages/context/src/prompts.ts` |
| Tool interface preamble | `packages/context/src/tool_interface.ts` |
| Repo map `buildRankedRepoMap` (budget 1,200, damping 0.85, ≤ 400 files); data contracts `dataContracts` | `packages/context/src/ranked_repo_map.ts`; `packages/loop/src/repo_map.ts` |
| Zone budgets, `MIN_ASSERTED_WORKING_BUDGET = 12_288` (to be removed), prefix hash | `packages/context/src/zones.ts` |
| Pressure tiers | `packages/context/src/pressure.ts` |
| Condensing, masking, compaction: `condenseToolOutput`, `maskOlderObservations`, `compactHistory` | `packages/context/src/condenser.ts` |
| Playbook rule shape; seeded rules (`.sekhemet/playbook.toml`, a person's file, read-only to the harness); learned rules on the ledger: `LearningStore`, `activeFor`, `propose`, `similarity`, `recordOutcome`, `retirementCandidates` | `packages/context/src/playbook.ts`; `apps/harness/src/learning/store.ts:71-285` |
| Project conventions `CONVENTION_FILES` (`AGENTS.md`, `CLAUDE.md`, `.sekhemet/CONVENTIONS.md`), `loadProjectConventions` | `packages/context/src/conventions.ts:14` |
| Native-tool switch: `nativeToolSchemas` omits the text interface | `packages/context/src/worker_prompt.ts:70-76` |
| Working memory `WorkingMemory.seed`, `lines` | `packages/loop/src/working_memory.ts:79-96` |
| Cache alert `PrefixCacheMonitor`, `CACHE_ALERT_THRESHOLD = 0.85` | `packages/models/src/telemetry.ts:33`, `:215-225`; `apps/harness/src/index.ts:1261` |
| Context version | `packages/context/src/versioning.ts` |
| Cache profile per host `cacheProfileForHost`; launch arguments | `packages/models/src/llama_server.ts:46`, `:274` |
| Cache telemetry `usageFromLlamaServer` (`cachedPromptTokens`, `evaluatedPromptTokens`, `cacheHitRate`) | `packages/models/src/http_adapter.ts:338` |
| Planner scope selection | `packages/planner/src/scope.ts` ([planner-pm.md](planner-pm.md)) |

## 4. State today

| Capability | State | Evidence | Change |
| --- | --- | --- | --- |
| Deterministic pack; prompt hash in the reproducibility record | built | `worker_prompt.spec.ts`; commit `4dfa310` | — |
| Append-only prompt; batch masking; native history messages | not-built | masking every turn (`worker_prompt.ts:821-822`); history rendered as `Turn N: tool -> …` text | M8 |
| Server reuse settings (`--checkpoint-min-step`, no `--cache-reuse`, `preserve_thinking`) | partial | `--cache-ram`/`--ctx-checkpoints` sized per host (`llama_server.ts:46`); no min-step; thinking stripped | M8 |
| Cache hit measured | built | `http_adapter.ts:338-354` | — |
| Cache hit alert (< 0.85) | partial | `PrefixCacheMonitor` alerts in the queue report (`telemetry.ts:215-225`, `index.ts:1261`) per step, not on the per-attempt median after the first turn; not on `run` | M8 |
| Cache hit at ≥ 0.85 | not-built | median 0.29 over 100 real turns, all below 0.85 (context review §1) | M8 |
| Four-zone layout | partial | spec and criteria re-sent in the uncached tail every turn (13% of the prompt) | M8 |
| Zone budgets asserted on the live path | partial | skipped below W = 12,288 (`zones.ts:149`, `:165`); system-zone assert only in dead `buildFullPromptPack` | NEW-context-2 |
| System prompt < 1,000 tokens | not-built | ~1,600 tokens | M1 |
| One calibrated token estimator | not-built | `/4` (`tokens.ts`) and `/3.2` (`allocator.ts:113`); measured ~3.0 chars/token | NEW-context-1 |
| Graduated pressure 70/80/85/90/95% | built (dormant) | `pressure.ts`; never engaged on a real prompt | — |
| Ranked repo map, PageRank, budget fit, cache | built | `ranked_repo_map.ts`; TS/JS only | — |
| Repo map shows only files with something to build on | not-built | 42% of map lines are `(no exports)` (context review §1) | M1 |
| Data contracts in the prompt | built | `session.ts:852-862` (468f67f); `c_integration.spec.ts:328` | — |
| Data contracts as their own high-priority section | not-built | appended to the repo map, the lowest-priority section, trimmed first (`pressure.ts:197`) | M5 |
| Coherent prompt (no contradictions); one copy module | not-built | "No other tool exists" (`tool_interface.ts:44`) in 57/120 prompts; "several calls" vs "exactly one" (`tool_interface.ts:41`, `worker_prompt.ts:315`); double numbering 102/109; pointers without `recall` 67/120; "preserved in WAL" (`condenser.ts:601`); "NON-NEGOTIABLE LAWS" (`prompts.ts:17`) | M1 |
| Compaction index kept when masking | not-built | the index is itself masked (`worker_prompt.ts:822`; 50/120 prompts) | M1 |
| Output condensing, lossless for repair data | built | `condenser.ts:366`, `:509`; `tool_output_evidence.spec.ts` | — |
| Subtask branch-and-return | built | `subtask.ts`; `c_integration.spec.ts:356` | — |
| Playbook: versioned, delta, card-boundary, retirable | built | `playbook.ts`; `playbook.spec.ts`, `playbook_scoping.spec.ts` | — |
| Rules: candidates approved by a person, helpful/harmful counts, consolidation, retirement at harmful − helpful ≥ 3, global promotion by a person | built | `learning/store.ts:129-285`; `learning.spec.ts` | — |
| At most eight scoped rules per prompt | built | `learning/store.ts:255` | — |
| Working memory: "fixed" means fixed | partial | a failure that vanished because the run failed earlier is reported fixed (`working_memory.ts:43-50`, gap sweep) | M1 |
| Structural filter before a trajectory becomes an exemplar | not-built | exemplars harvested from any passed card (`eval/src/loops.ts:332-360`) | M1 |
| Exemplars as accepted diff hunks | not-built | 3-line tool skeletons with no code (context review §2) | M1 |
| Joint prompt/playbook/tool version stamped on packs and evidence | built | `versioning.ts`; `worker_prompt.ts:813` | — |
| A new context version invalidates qualification and schedules a re-run | not-built | the version is only stamped; qualification is invalidated only by a template change (`models/src/registry.ts:130-150`) | NEW-context-6 |
| Prompt changes admitted only by a suite A/B | not-built | no check; prompt edits land by review | NEW-context-6 |
| Project conventions from `AGENTS.md`/`CLAUDE.md` in Zone 2 | built | `conventions.ts:14`; `session.ts:948` | — |
| Tools described once when native schemas are sent | built | `worker_prompt.ts:70-76` | — |
| One allocator with capped, prioritised sections for every role | not-built | 4 of 14 sources reduced (integration review A1); Seshat, Reviewer and Researcher prompts unbudgeted; no front-truncation guard (A10) | NEW-context-3 |
| Static per-card blocks before scope files; rung directive in the tail | not-built | the rung directive is unshifted into Zone 2 rules; the team note and repair plan follow the scope files (integration review A7) | NEW-context-3 |
| Working-memory truncation keeps Seshat's answer | not-built | `seed` keeps the first 6 lines; `lines()` cuts at 10, seeded last (`working_memory.ts:79-96`) | NEW-context-3 |
| Learned rules only on the ledger; `playbook.toml` never written | built | learned rules added in memory only (`execute.ts:359-369`) | — |
| Exact rule scoping (AND, no match-all patterns, defined tie-break, kind from `cardKind`) | not-built | an empty `pathPattern` matches every card; kind parsed from the title; ties in ledger order (`store.ts:236-255`) | NEW-context-4 |
| One curator deduplicating by fact key against seeded rules and remedies | not-built | Jaccard ≥ 0.8 against learned rules only (`store.ts:155-158`) | NEW-context-4 |
| PM-role rules written and delivered to Seshat | not-built | the role exists in the type; nothing writes or reads PM rules (integration review B5) | NEW-context-4 |
| Rule credit from the attempt record, with rotation | not-built | every rule in a prompt is credited with the card's outcome (`store.ts:258-280`) | NEW-context-4 |
| In-run probation for executable-verified lessons (production only) | partial | candidates approved for the run apply through `runRules` (`store.ts:245-246`); no probation record or paired rollback | NEW-context-4 |
| Repo map edge weights: imports, shared exporters, reverse scope edges | built | `ranked_repo_map.ts:282-318` | — |
| Repo map: spec-mentioned identifiers weighted up; content hash in the cache key | not-built | cache key is path, size, mtime (`ranked_repo_map.ts:261-264`) | NEW-context-5 |
| Condensing savings recorded per run | partial | computed per call (`condenser.ts:73-77`); not aggregated or reported | NEW-context-5 |
| No bracketed placeholders in prompt templates | not-built | no check exists | M1 |
| Package map, role lines and multi-language map from the source index | not-built | the map reads files, not an index | T2 |
| Bounded scope declaration (identifiers, lexical, one hop, cap 12, decision request) | not-built | keyword match on file paths (`planner/src/scope.ts:47`) | P1 |
| Dead code: `buildFullPromptPack`, `engine.ts`, `DefaultContextEngine`, `ContextCondenser`, `condenseOutput`, three `tool_interface` exports, `splitRulesByScope` | not-built (cut) | test-only (context review §3); `buildFullPromptPack` and `engine.ts` cuts approved ([DEC-09](../DECISIONS.md#dec-09)) | M1 |

## 5. Changes for v1

### M1 — prompt coherence (the prompt's share; the loop's share is in [worker-loop.md](worker-loop.md))

*Problem:* the Worker has been measured under prompts that contradict themselves, with about a quarter of each prompt noise.

- **CX-M1-1** WHEN the golden coherence test renders prompts from at least three recorded real inputs (a first turn, a repair turn, a post-masking turn) THE SYSTEM SHALL find none of: "No other tool exists" while any unlisted tool is callable; both "several calls" and "exactly one tool call"; a "do not re-read" marker for a file the same prompt tells the model to re-read; an observation pointer while `recall` is not offered; a list item starting with two numbers; the strings "WAL" or "NON-NEGOTIABLE".
- **CX-M1-2** WHEN the Worker prompt is rendered THE SYSTEM SHALL take every non-data sentence from one copy module, verified by a test that fails if a Worker-facing literal is added elsewhere in `packages/context` or `packages/loop`.
- **CX-M1-3** WHEN the system prompt is measured with the Worker's tokenizer THE SYSTEM SHALL be under 1,000 tokens, and the tool interface under 2,000.
- **CX-M1-4** WHEN the repo map is rendered THE SYSTEM SHALL omit files with no exports, test files and tool configuration files.
- **CX-M1-5** WHEN history is compacted and then masked THE SYSTEM SHALL keep the compaction index visible and SHALL NOT fold it into a pointer.
- **CX-M1-6** WHEN a structured tool result is rendered THE SYSTEM SHALL pretty-print it and SHALL NOT show JSON-escaped file contents.
- **CX-M1-7** WHEN exemplars are shown THE SYSTEM SHALL show the accepted diff hunk of a same-class card from this repository, and the exemplar A/B SHALL be recorded in `SUITE_RUNS.md` with its keep-or-cut verdict.
- **CX-M1-8** WHEN the context package is built THE SYSTEM SHALL contain none of the dead members listed in §4 (reachability check).
- **CX-M1-9** WHEN a failure disappears from a check because the run failed before reaching it (for example, the test file stopped compiling) THE SYSTEM SHALL NOT list it as fixed in the working memory.
- **CX-M1-10** WHEN a card's prompt is assembled THE SYSTEM SHALL include at most eight playbook rules, all scoped to the card's kind, paths or current error codes.
- **CX-M1-11** WHEN a passed card's trajectory has an unclosed tool call or events out of order THE SYSTEM SHALL NOT store it as an exemplar.
- **CX-M1-12** WHEN the prompt templates and the copy module are scanned THE SYSTEM SHALL find no bracketed placeholder (a `[`…`]` or `<`…`>` span of lower-case words meant to be filled in), verified by a test.

### M5 — data contracts as their own section

*Problem:* the contracts sit in the section cut first.

- **CX-M5-1** WHEN pressure trims the prompt THE SYSTEM SHALL remove repo map lines before any data-contract line.
- **CX-M5-2** WHEN the vault fixture's card is assembled THE SYSTEM SHALL include its table's columns (for example `created INTEGER`) in a section titled for data contracts, separate from the repo map.

### M8 — an append-only Worker prompt

*Problem:* on a hybrid-attention model one changed early byte forces a full prefill; the measured median hit rate is 0.29, about 18 s of prefill per turn, about 60% of model time.

- **CX-M8-1** WHEN turn n+1 of an attempt is assembled and no masking point falls between n and n+1 THE SYSTEM SHALL produce a request whose messages begin with turn n's messages, byte for byte.
- **CX-M8-2** WHEN two turns of one attempt are compared THE SYSTEM SHALL send a byte-identical system prompt and tools array.
- **CX-M8-3** WHEN masking runs THE SYSTEM SHALL mask at most once every k turns (k recorded in the evidence) unless the 85% pressure tier forces it, and each masking point SHALL be recorded as an event.
- **CX-M8-4** WHEN the Worker's llama-server is launched THE SYSTEM SHALL pass `--checkpoint-min-step` with the measured value in 512–1,024 and SHALL NOT pass `--cache-reuse`.
- **CX-M8-5** WHEN thinking is on for any turn of an attempt THE SYSTEM SHALL send earlier reasoning back (`preserve_thinking`), and no request SHALL contain an empty think block for a past turn.
- **CX-M8-6** WHEN a turn is assembled THE SYSTEM SHALL place the full spec and criteria in Zone 3 and SHALL limit the tail to the step counter, unmet criteria, the latest observation and one next action.
- **CX-M8-7** WHEN a frozen-suite run completes on the M8 build THE SYSTEM SHALL record the median server-reported cache-hit rate on turns after the first of each attempt and seconds of prefill per turn, and the M8 workstream is done only if the median is at least 0.85 or the shortfall is attributed to a named cause in `SUITE_RUNS.md`.

### P1 — bounded scope declaration (carried by the planner workstream, [planner-pm.md](planner-pm.md))

- **CX-P1-1** WHEN a spec names an identifier that the repo map's symbol table defines THE SYSTEM SHALL include that identifier's file in the declared scope.
- **CX-P1-2** WHEN scope declaration has made twelve tool calls without a result THE SYSTEM SHALL stop, leave the card out of `ready`, and post a decision request asking which files are in play.
- **CX-P1-3** WHEN identifier and lexical search have found files THE SYSTEM SHALL expand them one hop along the reference graph, and SHALL record for each declared file which step (identifier, lexical or expansion) produced it.
- **CX-P1-4** WHEN lexical results are ranked THE SYSTEM SHALL order definitions above references, source above tests and tests above generated files.
- **CX-P1-5** WHEN scope declaration is benchmarked on the frozen suite's cards THE SYSTEM SHALL record its precision and recall against the files each card's reference solution changed, and the twelve-call cap SHALL be changed only on that record.

### T2 — the context's share of the source index ([gates.md](gates.md) owns the index)

- **CX-IX-1** WHEN the repository has more workspace packages than fit a tenth of the repo-map budget THE SYSTEM SHALL render a package map (one line per package: name, role line, dependencies) and rank files only inside the packages the scope touches.
- **CX-IX-2** WHEN the repo map or scope declaration needs a file's role THE SYSTEM SHALL derive a one-line role from the index (its exports and first documentation comment), and SHALL NOT call a model for it.
- **CX-IX-3** WHEN the repo map is built for a language with a tags query THE SYSTEM SHALL build it from the index's definitions and references with the same ranking as for TypeScript, and the card SHALL state which parser produced it.

### NEW-context-1 — one token estimator calibrated to the model

*Justification:* two heuristics (`/4`, `/3.2`) both undercount against the measured ~3.0 characters per token, so every budget is wrong on the side that overflows.

- **CX-N1-1** WHEN a card starts against a server that offers `/tokenize` THE SYSTEM SHALL measure characters per token on the card's pack and use that ratio for every budget in the card.
- **CX-N1-2** WHEN no tokenizer is available THE SYSTEM SHALL use one fallback ratio defined in one place, and no other estimator SHALL exist in `packages/context`.

### NEW-context-2 — budgets asserted on the live path

*Justification:* the zone assertions are skipped below W = 12,288 and the system-zone check runs only in dead code, so no real prompt has ever been checked.

- **CX-N2-1** WHEN a prompt is assembled at any W THE SYSTEM SHALL assert every zone cap in §2 rule 10 and record the per-zone tokens.
- **CX-N2-2** WHEN Zone 3 cannot fit after shrinking the map and dropping low-ranked symbols THE SYSTEM SHALL refuse the card at the `ready` entry condition with the zone's size and cap.

### NEW-context-3 — one allocator for every role

*Justification:* the integration review found that only four of fourteen sources are ever reduced, that Seshat's, the Reviewer's and the Researcher's prompts have no budget (`planRepair` inlines tests and scope files of up to 8,000 characters each into an 8,192-token window, and Ollama silently drops the start of the prompt — the spec), that the rung directive edits Zone 2 mid-card, and that working-memory truncation drops Seshat's answer (A1, A7, A8, A10; suggestions 4 and 7; ruling R20).

- **CX-N3-1** WHEN any role's prompt is assembled THE SYSTEM SHALL build it from typed sections, each with a priority and a token cap, and the assembled prompt SHALL fit the role's window with every cap asserted.
- **CX-N3-2** WHEN a Worker prompt is over budget THE SYSTEM SHALL cut sections from the lowest priority up, and SHALL cut neither the acceptance test nor a pinned scope file while any lower-priority section remains.
- **CX-N3-3** WHEN a request's counted prompt tokens exceed the context the adapter set for that model THE SYSTEM SHALL refuse to send it, naming the role and both numbers, rather than let the engine drop the start.
- **CX-N3-4** WHEN the repair rung changes mid-card THE SYSTEM SHALL put the rung's directive in the volatile tail, and the system prompt and Zone 2 SHALL be byte-identical to the previous turn's.
- **CX-N3-5** WHEN a Worker prompt is assembled THE SYSTEM SHALL place the dossier's directives, the team note and a re-plan's plan before the scope files.
- **CX-N3-6** WHEN a dossier of more than six lines, ending with Seshat's answer, seeds the working memory THE SYSTEM SHALL keep Seshat's answer, and SHALL prefix a carried line with "from an earlier attempt:" once, never nested.
- **CX-N3-7** WHEN Seshat's prompt is assembled (its system text, the board snapshot, the rules for the PM, the profile, the conversation and any card's dossier) THE SYSTEM SHALL fit it to the Planner model's configured context by the allocator's priorities — the person's newest message and the system text never cut — and SHALL record the per-section tokens.
- **CX-N3-8** WHEN the re-plan prompt inlines acceptance tests and scope files THE SYSTEM SHALL cap each by the allocator instead of a fixed 8,000 characters, and the whole prompt SHALL fit the Planner's context with the spec at the start intact.

### NEW-context-4 — rules that are scoped exactly, kept once, and credited fairly

*Justification:* the same fact reaches the prompt from up to four places; `activeFor` lets an empty or broad pattern match every card and breaks ties by ledger order; PM rules exist only as a type; every rule in a prompt is credited with the card's outcome; and the review's in-run probation was ruled for production only (integration review A3, A4, B3, B5; suggestions 3 and 8; rulings R12, R20).

- **CX-N4-1** WHEN a rule with an empty path pattern, an empty scope, or a path pattern matching every file of the project is written THE SYSTEM SHALL refuse it, naming the pattern.
- **CX-N4-2** WHEN a rule declares a kind, a path pattern, an error pattern and a trigger gate THE SYSTEM SHALL apply it only to a card that matches all four, with the kind read from `cardKind`.
- **CX-N4-3** WHEN more than eight rules match a card THE SYSTEM SHALL take those matching the current error code first, then by value, then by most recent evidence, then by id, and the same inputs SHALL give the same eight.
- **CX-N4-4** WHEN a candidate rule restates a seeded rule, a gate remedy or another candidate with the same fact key THE SYSTEM SHALL merge it into the existing one instead of adding it.
- **CX-N4-5** WHEN a PM-role rule is in force THE SYSTEM SHALL include it in Seshat's snapshot and SHALL NOT include it in any Worker prompt.
- **CX-N4-6** WHEN rule outcomes are recorded THE SYSTEM SHALL credit a rule only from attempt records of comparable cards run with and without it, and SHALL report "insufficient data" until both exist.
- **CX-N4-7** WHEN, outside a measurement run, a gate failed and then passed with a lesson applied THE SYSTEM SHALL record the lesson as probationary and apply it to later cards of the run, marked as probationary in their evidence; WHEN the paired comparison shows cards with it doing worse, it SHALL be withdrawn automatically; WHEN the run is a measurement run, it SHALL NOT be applied.

### NEW-context-5 — the repo map's weighting and cache, and condensing savings

*Justification:* the old design weighted spec-mentioned and well-named identifiers up and keyed the cache on content, and tracked condensing savings; the first two were dropped silently and the third is computed and thrown away (traces hd1 214, 215, 228; inventory C1).

- **CX-N5-1** WHEN a card's spec names an identifier a file defines THE SYSTEM SHALL rank that file above an otherwise equal file that does not define it.
- **CX-N5-2** WHEN a file's content changes and its size and mtime do not THE SYSTEM SHALL rebuild the map rather than serve the cached one.
- **CX-N5-3** WHEN a run completes THE SYSTEM SHALL report the tokens condensing saved, in total and per tool, beside the raw tool-output tokens.

### NEW-context-6 — the context version gates qualification; prompt changes are measured

*Justification:* the version is stamped but invalidates nothing, although the design says it does (inventory C21, ruling R23); and a hand-made prompt change can ship unmeasured (trace hd1 588, 600).

- **CX-N6-1** WHEN the context version changes THE SYSTEM SHALL mark the qualification of every model qualified under the old version invalidated, with the old and new versions as the reason, and SHALL schedule their re-qualification.
- **CX-N6-2** WHEN a change to the prompt templates, the copy module or the tool descriptions is proposed for merge THE SYSTEM SHALL require a frozen-suite A/B recorded in `SUITE_RUNS.md` against the previous version (a check in the release gate fails otherwise).

## 6. v1 acceptance

This spec is `built` when §5 passes and these stay under test:

- **CX-1** WHEN the same card is assembled twice on the same tree and version THE SYSTEM SHALL produce byte-identical first prompts.
- **CX-2** WHEN pressure reaches 95% THE SYSTEM SHALL end the step with `budget_exhausted` and SHALL NOT truncate silently.
- **CX-3** WHEN tool output contains error lines, file paths, test names and an exit code THE SYSTEM SHALL keep every one of them after condensing, and the raw output SHALL be retrievable by its reference.
- **CX-4** WHEN a subtask answers THE SYSTEM SHALL return only its answer and evidence reference to the parent.
- **CX-5** WHEN a playbook rule is added or retired mid-card THE SYSTEM SHALL apply the change from the next card, not the current one.
- **CX-6** WHEN the prompt templates, rules or tools change THE SYSTEM SHALL produce a new context version and stamp it on the pack and evidence.
- **CX-7** WHEN the adapter sends native tool schemas THE SYSTEM SHALL omit the text tool interface from the system prompt.
- **CX-8** WHEN the repository has an `AGENTS.md` or `CLAUDE.md` THE SYSTEM SHALL include its conventions in Zone 2 once per card.
- **CX-9** WHEN learned rules are applied to a card THE SYSTEM SHALL NOT write `.sekhemet/playbook.toml`.

## 7. Later

- **A multi-language repo map** on Tree-sitter (`web-tree-sitter` with the grammars' `tags.scm`: *proposed, needs the owner's yes*; ast-grep is a tool, not the index's foundation) — built on the source index's fact schema (T2, [gates.md](gates.md)) when a Python adapter is built. Until then TypeScript comes first ([DEC-20](../DECISIONS.md#dec-20)): Python, Rust and Go get a flat file map, and the card and its evidence say so. The rule for it (CX-IX-3) is fixed now so the map needs no second design.
- **Model-written file summaries for localisation.** Deterministic role lines (rule 13b) are free; summaries are admitted only if they beat role lines on register R1's Chronicle localisation threshold.
- **Exemplars from this repository's fixing commits.** The old design drew exemplars from accepted cards and from fixing commits in the repository's history; v1 uses accepted cards only, and fixing commits feed synthesised tasks ([measurement.md](measurement.md)). Whether exemplars stay at all is the A/B's verdict (CX-M1-7); widening their source waits for it.
- **A learned line pruner** (SWE-Pruner / SWE-Pruner Pro) — the keyword heuristic is the accepted substitute ([DEC-21](../DECISIONS.md#dec-21--accepted-substitutions)); a learned pruner returns only if it beats structure-preserving random line dropping at equal budget on the suite ([measurement.md](measurement.md)). The heuristic pruner stays dormant until a real prompt triggers it. LLMLingua-2 is rejected as lossy on identifiers.
- **Offline prompt optimisation** (GEPA: *proposed*), scored by the frozen suite; kept only if it gains at least 5% over the hand-tuned prompt.
- **An MLX engine path** with native MTP heads (unified-memory buffer reuse, MTPLX), if [models.md](models.md)'s engine measurement favours it; only an engine label exists today (`bakeoff.ts:17`).

## 8. Open questions

1. **The masking interval k.** *Recommendation:* start at k = 8 turns and choose between 4, 8 and 16 by the M8 run's seconds per turn and pass rate; with the 8,192 default `--checkpoint-min-step` only about two spaced checkpoints survive a 16k window, so k and the min-step are tuned together.
2. **`tool_search` and the tools array.** M2 ([worker-loop.md](worker-loop.md)) decides whether the Worker keeps progressive loading; if it does, loaded tools must be appended as a message, never inserted into the tools array. *Recommendation:* adopt that rule regardless of the A/B's winner.
3. **How many rules reach one prompt.** The integration review's target was "the top three to five rules matched to the current error"; this spec keeps at most eight scoped rules, error-matched first (rule 24, CX-N4-3). *Recommendation:* keep eight until rule outcomes come from the attempt record with rotation (CX-N4-6), then let the playbook diagnostics' context-debt measure ([measurement.md](measurement.md) rule 24) set the cap.

## 9. Evidence and rationale

- Review: [domain04_context.md](../../reference/reviews/domain04_context.md) (109–120 real prompts; 100 turns with server cache telemetry). Integration review ([reviews/integration_review_2026-09-18.md](../../reference/reviews/integration_review_2026-09-18.md)) A1–A10, B1, B3, B5 and suggestions 3, 4, 7 and 8, with the target allocator and curator.
- *Changed on purpose* ([DEC-24](../DECISIONS.md#dec-24--deliberate-reversals-in-design-v3)): masking keeps the five most recent observations, not two, and masks in batches — SWE-agent's ablation and the cache (masking every turn broke the prefix, median hit 0.29); earlier thinking is preserved rather than stripped between steps (per-model `stripTraces` retired) — an edited prefix forces a full re-read on hybrid-attention models; the cache flags moved from 8–16 GiB, 32 checkpoints and min-step 8,192 to host-sized values with min-step 512–1,024 and `-sps` dropped for the Worker — checkpoints moved to message boundaries upstream, a 16k window keeps only two checkpoints at the old spacing, and a single slot needs no slot selection; the spec and criteria moved from the volatile tail into cached Zone 3 (M8); there is no LSP expansion stage — the language service backs the Worker's symbol tools instead, and the data-contracts section (rule 14) carries the interfaces the card builds on; the `[context] mask_after_observations` and `map_tokens` keys were removed (the map budget is 1,200).
- Research: [DESIGN_RESEARCH_TESTS_BROWNFIELD.md](../../research/DESIGN_RESEARCH_TESTS_BROWNFIELD.md) §2.2 (localisation for small models: Agentless skeletons, LocAgent, role-aware summaries arXiv:2607.11046, repository guidance on a 35B-A3B model arXiv:2606.20512; package-level ranking arXiv:2606.11976) and §3.4 (CX-IX-1…3). [DESIGN_RESEARCH_TEAM_SERVER.md](../../research/DESIGN_RESEARCH_TEAM_SERVER.md) (batch size as a host property; prefix caches reward a stable prefix on every engine).
- Research: [WEB_RESEARCH_2026-09.md](../../research/WEB_RESEARCH_2026-09.md) group A Q1 — checkpoint placement ([llama.cpp #22929](https://github.com/ggml-org/llama.cpp/pull/22929), [#24176](https://github.com/ggml-org/llama.cpp/pull/24176), [#25472](https://github.com/ggml-org/llama.cpp/pull/25472)); full re-processing on hybrids ([#24055](https://github.com/ggml-org/llama.cpp/issues/24055)); `--cache-reuse` on hybrids ([#18497](https://github.com/ggml-org/llama.cpp/issues/18497)); slot save/restore broken ([#25913](https://github.com/ggml-org/llama.cpp/issues/25913)); empty think blocks ([Qwen3.6 #131](https://github.com/QwenLM/Qwen3.6/issues/131)); `preserve_thinking` ([Qwen3.6-27B card](https://huggingface.co/Qwen/Qwen3.6-27B)); Q4 on tool counts.
- Research sources for the rejected techniques and the pruner: SWE-Pruner (arXiv:2601.16746), SWE-Pruner Pro (arXiv:2607.18213); the random-selection null baseline from [PAPER_REVIEWS_2026-09.md](../../research/PAPER_REVIEWS_2026-09.md) (arXiv:2609.03430: a random scorer matched the strongest learned one in 31 of 60 comparisons).
- Observation windows: SWE-agent collapsed observations older than the last five (18.0% vs 15.0% with full history) and found 100-line viewer windows best ([WORKER_METHOD_LITERATURE.md](../../research/WORKER_METHOD_LITERATURE.md) §1); The Complexity Trap (arXiv:2508.21433) for masking over summarisation ([IMPLEMENTATION_AUDIT.md](../../research/IMPLEMENTATION_AUDIT.md) §3).
- Playbook and exemplars: [PUBLIC_DATA_SURVEY.md](../../research/PUBLIC_DATA_SURVEY.md) verdicts 3 and 4 (public trajectories as exemplars: negative value; playbook rules: not available publicly; CodeReviewQA and c-CRAB usable only as evaluation sets for whether induced rules fire — *proposed*); structural trajectory filter from NeoHorse-1 (arXiv:2609.08183, [PAPER_REVIEWS_2026-09.md](../../research/PAPER_REVIEWS_2026-09.md)); ACE playbook counters and Mem0-style consolidation (arXiv:2504.19413) as built ([IMPLEMENTATION_AUDIT.md](../../research/IMPLEMENTATION_AUDIT.md) §2–3).
- Register: [RESEARCH_REGISTER.md](../../research/RESEARCH_REGISTER.md) R1 (repo map, adopted; threshold "top-10 contains the edited file on ≥ 70% of Chronicle cards", not yet benched), R2 (native condensing, adopted; "≥ 60% fewer tool-output tokens with no rise in repair turns", not yet benched), R3 (query-aware line pruning, shortlisted; "≥ 20% fewer context tokens at no Pass@1 loss"), R11 (embedding RAG, rejected).
- Programme: [COVERAGE.md](../../reference/COVERAGE.md) M1, M5, M8. Decisions: [DEC-09](../DECISIONS.md#dec-09) (cuts), [DEC-20](../DECISIONS.md#dec-20) (TypeScript first), [DEC-21](../DECISIONS.md#dec-21--accepted-substitutions) (keyword pruner instead of SWE-Pruner), [DEC-22](../DECISIONS.md#dec-22--rejected-techniques) (public trajectories as exemplars, embedding RAG, large-context stuffing, continuous-embedding compression, persona prompting, a seventh durable store: rejected).
