# Prompt research: structure, techniques, compression, measurement

*Web research, 2026-09-24. Question: how should Sekhemet write its prompts (Worker, Seshat, Reviewer, Researcher) for a 3B-active, IQ3_XXS, 16k–32k-window local model, and which prompt or context compression is worth its cost on a 24 GB Mac? This builds on [WEB_RESEARCH_2026-09.md](WEB_RESEARCH_2026-09.md) Group A (prefix cache, MTP, thinking, tool count), [WORKER_METHOD_LITERATURE.md](WORKER_METHOD_LITERATURE.md), [PAPER_REVIEWS_2026-09.md](PAPER_REVIEWS_2026-09.md), [context.md](../design/specs/context.md) §2 and [DEC-27](../design/DECISIONS.md#dec-27--context-budgets-are-fixed-in-tokens-at-the-reference-window), and does not repeat them. Sources: vendors' published guidance, arXiv, and open-source agents whose prompts their authors publish under an open licence. No leaked or extracted vendor prompt was used. Techniques are described in our own words, and no prompt text was copied. **[opened]** means the page was read; **[search]** means a search summary only. Nothing here is adopted until the owner says yes.*

## Summary

- **The spec already matches most of the evidence**: a small stable system prompt, append-only history, the goal restated in the tail, code-rendered masking with pointers, no model summaries, deterministic condensing. What is new is *how the words are written* and *how prompt changes are screened before the suite*.
- **Small models are more fragile to prompt form.** Meaning-preserving format changes swing smaller models by 40–76 points. Fix one format, freeze it under the context version, and change it only by A/B.
- **Emphasis and negation are weak tools.** Vendors advise against shouting, and emotional appeals measurably hurt in Aider's benchmark. A rule that must hold belongs in a harness guard.
- **Instruction count matters.** Adherence falls as instructions accumulate. Keep the Worker's rules few and unique.
- **Examples and familiar names help small models call tools** (+21.5% few-shot on a 3B model; up to +17% from renaming). A single harness-native tool-call example is worth an A/B.
- **Compression.** Observation masking roughly halves cost against raw history and matched LLM summarisation within noise. Token-dropping compressors (LLMLingua family) damage code badly (edit similarity 56 → 41). Code-aware pruners need a second model and Python. On 24 GB beside a 13 GB Worker, none beats the append-only prefix cache.
- **Measurement.** Add a cheap *step-replay screen* and prompt lint in front of the 30-card suite. The suite A/B stays the only admission route (DEC-28).

## 1. How leading coding agents structure system prompts

**Section order.** Every agent examined runs: identity and mode, core rules (scope, safety, conventions), workflow, tool-use rules, output style, and environment and project memory last.
- gemini-cli (**Apache-2.0**) builds its prompt from typed sections in this order: preamble (identity and approval mode), core mandates, sub-agents, skills, workflow, operational guidelines (tone, safety, tools), sandbox constraints, git, and finally user memory. Sections are included conditionally by mode. [opened] https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/prompts/snippets.ts
- Codex CLI (**Apache-2.0**) keeps a prompt of about 1,100 words. Its sections are: general (search tool preference), editing constraints, the plan tool, special requests, and presenting the final message. [opened] https://github.com/openai/codex/blob/main/codex-rs/core/gpt_5_codex_prompt.md
- OpenAI's GPT-4.1 guide recommends this order: role, instructions, reasoning steps, output format, examples, context, and a final instruction. [opened] https://developers.openai.com/cookbook/examples/gpt4-1_prompting_guide

**Role and identity** is one or two sentences in all of them. There is no persona backstory.

**Tool-use rules.** Batch independent reads, prefer the edit tool to shell edits, read rather than guess. Codex keeps its patch format exact because the model was trained on it. [opened] https://developers.openai.com/cookbook/examples/gpt-5/codex_prompting_guide.md

**Safety and scope.** gemini-cli explains a state-changing command before running it; Codex forbids destructive commands without approval. Claude Code separates *advisory* instructions (CLAUDE.md) from *deterministic* hooks for anything that must always hold. [opened] https://code.claude.com/docs/en/best-practices

**Output format and verbosity.** gemini-cli targets under three lines of prose per response. Codex prescribes a short final message with file references. Cursor, working with GPT-5, set verbosity low globally and high only inside code. [opened] https://developers.openai.com/cookbook/examples/gpt-5/gpt-5_prompting_guide

**Planning and todo discipline.** Codex skips plans for simple tasks and reconciles the plan before finishing; its guide reports that prompting for *upfront plans or status updates* causes early stopping. Claude Code skips planning when the diff fits in one sentence. This agrees with WORKER_METHOD_LITERATURE implication 10.

**Verification loops.** Every source treats an executable check as the closing condition. Claude Code's first best practice is to give the agent a check that returns pass or fail, and to ask for evidence rather than an assertion of success. gemini-cli makes validation the only route to finishing. SWE-agent's default instance template (**MIT**) walks through reproduce, fix, re-run, then edge cases. [opened] https://github.com/SWE-agent/SWE-agent/blob/main/config/default.yaml

**Long context.**
- Anthropic: put long documents at the top and the query at the end. Queries at the end improved quality by up to 30% in its tests. [opened] https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices
- GPT-4.1: instructions at both the beginning and the end work best. If there is only one copy, put it above the context.
- Gemini: context first, instructions at the very end. [opened] https://ai.google.dev/gemini-api/docs/prompting-strategies

**Examples vs rules.**
- Anthropic's context-engineering article prefers a few "diverse, canonical examples" over lists of edge cases, and a prompt at the "right altitude": neither hard-coded if-else logic nor vague. [opened] https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- Google recommends always including few-shot examples with identical formatting.
- Manus warns that repetitive examples in context make an agent imitate itself, and adds controlled variation. [opened] https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus

**Positive vs negative instructions.**
- Anthropic: say what to do instead of what not to do, and give the reason behind an instruction.
- Evidence on negation is old but consistent: negated prompts showed *inverse scaling* on 2022 models (OPT, GPT-3, InstructGPT). [opened abstract] https://arxiv.org/abs/2209.12711

**Emphasis (caps, "IMPORTANT").**
- Anthropic says newer models *overtrigger* on "CRITICAL / MUST" and advises calm phrasing.
- Claude Code's docs allow emphasis on *one* ignored line. If many lines are emphasised, "none of them stands out".
- GPT-4.1's guide advises against caps and artificial incentives.
- Aider measured folk remedies (claiming blindness, offering tips) and found they *lowered* benchmark scores. [opened] https://aider.chat/2023/12/21/unified-diffs.html
- gemini-cli still uses caps on a few safety words. None of these sources measures the effect of emphasis on a small model.

**Tagging.** Anthropic: XML tags separate instructions, context and inputs. GPT-4.1: XML with attributes works well for documents and JSON works poorly. Google: choose one delimiter style and use it throughout. OpenHands (**MIT**) wraps its system prompt sections in upper-case XML-style tags. [search] https://github.com/OpenHands/software-agent-sdk

**Instruction hierarchy.** Codex merges AGENTS.md files root to leaf, deeper overriding; gemini-cli ranks global < extensions < workspace < subdirectory. GPT-4.1: in a conflict the later instruction wins; GPT-5: contradictions waste reasoning.

**Cache-stable prefix.**
- Manus: no timestamps in the prefix, deterministic serialisation, append-only history. Make tools unavailable by constraining decoding, not by removing their schemas.
- OpenHands has an open plan to replace its single template with a typed section registry in which each section declares its cache tier. [opened] https://github.com/OpenHands/software-agent-sdk/issues/3606
- This is the shape of Sekhemet's allocator (context rule 10a).

**For local models specifically.** Cline (**Apache-2.0**) ships a *compact system prompt* for local models, about 10% of its full size. It drops features such as MCP to get it. [opened] https://cline.bot/blog/local-models

## 2. Techniques with evidence, and what changes for small models

**Context engineering.** Anthropic: context is a finite budget with diminishing returns. Use the smallest high-signal set, load just in time through identifiers, clear old tool results, take structured notes, and let subagents return 1,000–2,000-token summaries (article above).

**Length alone hurts.**
- Reasoning degraded at about 3,000 tokens of irrelevant padding, even when the padding was duplicate text. [opened abstract] https://arxiv.org/abs/2402.14848
- Chroma tested 18 models, including Qwen3, and all degraded as input grew, well inside their windows. [search] https://research.trychroma.com/context-rot
- Lost in the middle: recall is U-shaped, best at the start and end. [search] https://arxiv.org/abs/2307.03172
- For a 16k Worker, every token in Zones 2–4 competes with the card.

**Instruction density.** IFScale tested 20 models. Accuracy falls as instructions are added, with degradation patterns that differ by model size. Models are biased toward earlier instructions and fail by *omitting* instructions. [opened abstract] https://arxiv.org/abs/2507.11538

**Format sensitivity is worst in small models.**
- Meaning-preserving format changes moved LLaMA-2-13B by up to 76 points. [search] https://arxiv.org/abs/2310.11324
- GPT-3.5 swung up to 40% on code translation across plain text, Markdown, JSON and YAML templates, while GPT-4 was robust. [opened abstract] https://arxiv.org/abs/2411.10541
- Tool-calling leaderboards shift with undocumented choices of system prompt and multi-turn template. [opened abstract] https://arxiv.org/abs/2606.00135
- Consequence: the exact rendering is part of the thing being measured, as the context version already asserts.

**Few-shot vs zero-shot for tools (small models).**
- On Llama-3.2-3B, few-shot examples added +21.5% and documentation +5.0%. A trained hypernetwork added nothing. [opened abstract] https://arxiv.org/abs/2604.20148
- Renaming tools and parameters toward pretraining-familiar names gave up to +17% and 80% fewer hallucinated tool names. [opened abstract] https://arxiv.org/abs/2510.07248
- Letting models choose tools in natural language instead of JSON raised accuracy by 18.4 points, with open-weight models gaining most. [opened abstract] https://arxiv.org/abs/2510.14453
- Qwen advises Hermes-style native tool templates and warns against stopword-based ReAct templates for reasoning models, because stopwords can appear inside the thinking. [opened] https://qwen.readthedocs.io/en/latest/framework/function_call.html
- GPT-4.1 measured +2% from passing tools through the API's tools field rather than pasting them into the prompt.

**Tool design.** Anthropic: consolidate overlapping tools, name parameters unambiguously, return readable identifiers, offer a concise mode (72 vs 206 tokens), write actionable errors; Claude Code caps a tool response at 25,000 tokens. [opened] https://www.anthropic.com/engineering/writing-tools-for-agents

A study of six tool architectures over 11,700 coding trajectories found that structured low-level interfaces made repeated attempts up to 4.7× more consistent. CodeAct-style interfaces used 41.6% fewer steps. Text-only "cognitive scaffolding" tools changed little. [opened abstract] https://arxiv.org/abs/2608.11386

**Explicit plans, persistence, reflection.**
- GPT-4.1: three short agentic reminders (persist, use tools rather than guess, plan between calls) raised OpenAI's internal SWE-bench Verified score by about 20%. Planning alone gave about 4%. This was on a frontier model and has not been replicated on small ones.
- Codex found that asking for upfront plans causes early stopping.
- Self-correction without external feedback does not help (already in WORKER_METHOD_LITERATURE §5).

**The "think" tool.** Anthropic's τ-bench result: 0.570 vs 0.370 on airline tasks, but *only with domain examples* of how to think. On SWE-bench the isolated effect was about 1.6%. Anthropic advises against it for non-sequential tasks. [opened] https://www.anthropic.com/engineering/claude-think-tool Our Worker has native thinking, so there is no case for adding a tool.

**Goal re-injection and recency.**
- Manus rewrites a todo file every step (about 50 tool calls per task) so the objective stays in recent attention.
- Multi-turn conversations that reveal a task piece by piece lost 39% on average against one fully specified message, mostly through unreliability (+112%). This held for reasoning models too. [opened abstract] https://arxiv.org/abs/2505.06120
- This matters most for Seshat, whose briefs arrive in pieces.

**Quantisation.** 8-bit is near-lossless. 4-bit methods lose more, and most on long inputs: up to 59% on one long-context task for one method. [search] https://arxiv.org/abs/2505.20276 IQ3_XXS is below every level tested there. Expect long-input fragility and keep prompts short. No published study measures instruction following at IQ3 (**uncertain**).

## 3. Compression for context and speed

| Technique | Licence / dependency | Measured gains | Risks for code | Fit on 24 GB, 3B-active Worker |
| --- | --- | --- | --- | --- |
| **Stable, append-only prefix** (llama.cpp checkpoints) | none | Group A: a 0.29 hit rate costs ~18 s prefill/step; an open llama.cpp PR reports zero reprocessing over 5 agent turns | none | **Highest.** Already M8 |
| **Observation masking** with pointers | none (code: JetBrains-Research/the-complexity-trap, licence not checked) | Halves cost vs raw; matches LLM summary. Qwen3-Coder-480B 54.8% vs 53.8%; Qwen3-32B 15.0% vs 16.0% (noise at n=500). Summaries lengthen runs 13–15%. Window M=10 turns. [opened] https://arxiv.org/html/2508.21433 | masked detail needed later → pointer | **High.** Already rule 3; window untested |
| **Truncate-only compaction** (CliffCompaction, 2026-09) | repo MIT per page | SWE-bench Verified at 16k: 71.9% vs 73.9% full context, ~50% cost; beat summarisation on Terminal-Bench [opened] https://arxiv.org/html/2609.26779 | drops, never rephrases | Confirms rule 28; frontier-size open models only |
| **Deterministic tool-output condensing / head+tail truncation** | none | mini-swe-agent keeps first and last 5,000 chars over 10,000 (**MIT**) [opened] https://github.com/SWE-agent/mini-swe-agent; SWE-agent summarised search +6 pp | loses middle of long logs | **High.** Already rule 17 |
| **Tool-schema minimisation** | none | Cline compact prompt ~10% size; PA-Tool naming +17%; Zone 1 is cached, so the gain is attention, not seconds | over-terse descriptions → misuse | Medium; within CX-M1-3 |
| **Selective Context** (self-information from a small LM) | Python + LM | 50% context cut, 32% faster, small quality loss on prose [opened abstract] https://arxiv.org/abs/2310.06201 | token dropping breaks syntax | Low |
| **LLMLingua / LongLLMLingua / LLMLingua-2** | **MIT**, `pip install llmlingua`, PyTorch + GPT-2/LLaMA-7B or XLM-RoBERTa-large (560M) [opened] https://github.com/microsoft/LLMLingua | LLMLingua-2: 2–5× compression, 1.6–2.9× end-to-end speed-up on prose [opened abstract] https://arxiv.org/abs/2403.12968 | **Code completion with Qwen2.5-Coder-7B: edit similarity 56.4 → 41.3 (LLMLingua-2), 21.6 (LLMLingua), 23.9 (LongLLMLingua)** [opened] https://arxiv.org/html/2510.00446 | **Reject** for code; a second runtime too |
| **LongCodeZip** (function- then block-level, perplexity-ranked) | **MIT**, Python, Qwen2.5-Coder-7B by default (0.5B works) [opened] https://github.com/YerbaPage/LongCodeZip | 4.3–5.6× with no loss (56.4 → 57.6 ES); 2.6 s compression, +0.7 GB | needs a query; the second model competes for RAM | Low: Zone 3 is only 3,792 tokens |
| **SWE-Pruner** (0.6B goal-conditioned line skimmer) | **MIT**, Python, GPU [opened] https://github.com/Ayanami1314/swe-pruner | 23–54% fewer tokens on SWE-bench Verified agent runs, "minimal" impact [opened abstract] https://arxiv.org/abs/2601.16746 | a model decides what code the Worker sees | Lead only (see appendix) |
| **Moderate vs aggressive compression** | — | Pre-registered RCT: r=0.5 cut cost 27.9%; r=0.2 *raised* cost, because output grew [opened abstract] https://arxiv.org/abs/2603.23525 | — | Warns against chasing the ratio |
| **LLM summarisation of history** | none | no better than masking and makes trajectories longer | drops exact strings | **Reject** (rule 28 stands) |

**Recall pointers.** Manus's rule is to compress only reversibly, keeping the path or URL so content can be restored. That is Sekhemet's `recall(ref)`.

**KV/prefix layouts on llama.cpp.**
- The server reports `timings.cache_n` (tokens reused) and `timings.prompt_n` (tokens processed) per request. Use these for the hit rate. [opened] https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md
- Everything else (checkpoints, min-step, no `--cache-reuse`, `preserve_thinking`) is Group A's and already specified.

## 4. Measuring prompts

- **Paired, not independent.** Anthropic's statistics note: compare arms on the same questions, where scores correlate 0.3–0.7. Cluster standard errors by task, since they can be over 3× the naive ones. Resample each question to cut within-question variance. Do a power analysis first. [opened] https://www.anthropic.com/research/statistical-approach-to-model-evals Group D already gives the power arithmetic for 30 cards.
- **Small, real, transcript-read.** Start from 20–50 tasks taken from real failures. Early changes have large effects, so small samples are enough. Use pass^k when reliability matters. Isolate every trial, and read transcripts to separate agent errors from grader errors. [opened] https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents
- **Golden prompt tests.** Render each role's prompt from recorded inputs and diff it byte for byte against a stored snapshot. Assert each section's token count with the model's tokenizer. CX-M1-1 and CX-M8-2 do this for the Worker only.
- **Cache-hit rate** from `cache_n` / (`cache_n` + `prompt_n`) on each step after the first (CX-M8-7).
- **Versioning.** Hash templates, the copy module, tool schemas and budget policies (context version, rule 27). Promptfoo (**MIT**, runs against Ollama and llama.cpp) shows the outside-world version: a prompt × model matrix with assertions, run in CI. [opened] https://github.com/promptfoo/promptfoo
- **Determinism caveat.** Output can vary with batch size even at temperature 0. [search] https://thinkingmachines.ai/blog/defeating-nondeterminism-in-llm-inference/ Our Worker runs one slot at batch one, so fixed seeds give *common random numbers* across arms. That is cheap variance reduction, and still not proof of identical sampling (**uncertain** on Metal).

## Recommendations for Sekhemet's prompt standard

**A. Rules for every role**

1. **One delimiter style: XML-like tags, in lower case, named for their content** (`<card>`, `<acceptance_test>`, `<observation>`). No Markdown headings inside prompts, and no JSON for prose documents. The format is frozen under the context version. (Anthropic, GPT-4.1, Google; small-model format sensitivity.)
2. **Order: identity (one sentence) → output contract → hard rules → tool rules → [stable data] → task data → the question or next action last.** Long material first and the ask last (Anthropic +30%, Gemini, GPT-4.1). This is the zone order already in place.
3. **Instructions are positive, concrete and give a reason.** Where a prohibition is unavoidable, pair it with the action to take instead ("Write only inside `filesTouched`; to change another file, call `request_scope`"). Add a prompt lint that counts negations per template.
4. **No capital-letter emphasis, no threats, no incentives, no persona.** Allow at most one emphasised line per template, and only with a recorded A/B. Anything that must always hold is enforced by the harness (tool refusal, gate, guard), and the prompt only *describes* the enforcement. (Anthropic, Claude Code, GPT-4.1, Aider's measurement.)
5. **Count instructions.** A template carries at most 12 imperative rules (the standard, rule 11, defines what counts). Each fact appears once, keyed like playbook facts (rule 24c). Lint fails a template above the count. (IFScale; Claude Code's test: would removing this line cause mistakes?)
6. **No contradictions, no placeholders** (rules 20–21, extended to Seshat, Reviewer and Researcher templates).

**B. Worker**

7. **Native tool calling through the model's own chat template.** Never use a stopword ReAct template (Qwen). Tool names and parameters use pretraining-familiar vocabulary (`read_file`, `grep`, `edit`, `path`, `old`, `new`), with enums wherever values are closed (PA-Tool). Each description is at most two sentences.
8. **Tools are never removed mid-attempt.** An unavailable tool is refused with a one-line reason (Manus). This keeps Zone 1 byte-stable.
9. **Do not ask the Worker to narrate an upfront plan or progress updates** (Codex early-stopping). Keep the post-failure `hypothesis` field (WORKER_METHOD_LITERATURE item 8).
10. **A/B candidate (harness change): one harness-native tool-call example** of at most 150 tokens, showing a read then an edit, inside Zone 1's 2,400-token cap. Evidence: +21.5% for few-shot on a 3B model. Risk: self-imitation (Manus). It is written in our own tool vocabulary, never taken from a public trajectory (rule 25).
11. **A/B candidate: one persistence sentence** stating that the attempt ends only when `check` passes or a stop condition is named. The about-20% evidence is from GPT-4.1 only.
12. **Anti-test-gaming line (an A/B candidate, not a mandate):** one positive sentence saying the acceptance test verifies behaviour and the solution must be general (Anthropic). It is admitted only by the suite A/B; gates remain the real defence.

**C. Seshat (Planner/PM)**

13. **Consolidate before planning.** When the conversation turns into a plan, Seshat first writes the whole brief as one self-contained message (goal, users, scope, out of scope, criteria) and plans from a fresh context holding that message, not the transcript. (39% multi-turn loss.)
14. **Structured outputs by grammar or JSON schema at temperature 0, with a separate critic pass** (Group C #8). The PM rules (rule 24d) sit in the stable section, and the brief goes last.
15. **Direct, non-persuasive conversational tone.** Replies are short, and there is one question at a time for non-developers.

**D. Reviewer**

16. **A fresh context holding only the diff, the card's criteria and the gate evidence**, never the Worker's reasoning. The Reviewer is told to report only gaps that affect correctness or the stated criteria, because reviewers asked to find gaps always find some (Claude Code). The verdict is structured.

**E. Researcher**

17. **Documents first, each wrapped as `<document><source>…</source><content>…</content></document>`; question last. Extract quotes before answering; cite by source id** (Anthropic long-context guidance). Fetched text is data. Instructions inside it are quoted, never followed.

**F. Compression choices, ranked by expected gain per cost on this hardware**

1. **Prefix stability (M8).** It saves the most seconds by far and needs no new dependency. Finish it first.
2. **Observation masking with `recall` (rule 3).** It roughly halves cost against raw history and matched summarisation within noise. Run an A/B on the recent-step window (5, our current setting, vs 10, the paper's).
3. **Deterministic condensing and head/tail truncation (rule 17).** Measure the R2 threshold.
4. **Zone 1 slimming**, toward a Cline-style compact prompt. This buys attention rather than seconds, since Zone 1 is cached.
5. **Repo map and skeletons** (already specified).
6. **Code-aware learned pruning (SWE-Pruner, LongCodeZip).** Not now: each needs Python, PyTorch and a second resident model on a 24 GB host.
7. **LLMLingua family, Selective Context, LLM summarisation.** Rejected for code.

**G. Measuring prompt changes**

18. **Add a step-replay screen before the suite.** Take recorded prompts from the ledger (first steps, repair steps, post-masking steps), render them under the new templates, and run one model step each. Code then checks: the tool call parses, the right tool is chosen for canonical states, no hallucinated tool, no placeholder copied, output tokens used. It is cheap enough for hundreds of samples. It *screens* a change and never *admits* one (DEC-28 unchanged).
19. **Extend golden render tests and per-section token assertions to all four roles** (context rule 10c).
20. **Run A/B arms on the same cards with the same seeds**, and repeat to report pass^k beside pass@1. Record the cache-hit rate and prefill seconds per step in every arm.

**Needs the owner's approval**

- Any compression library or second model (LLMLingua, LongCodeZip, SWE-Pruner). **Recommendation: no.**
- Promptfoo as a dev dependency. **Recommendation: no.** Build the replay screen inside `eval` instead.
- The step-replay screen itself (new `eval` work), and the two A/B candidates (items 10–11), which are harness changes that still pass DEC-28's admission rule.

## Appendix: Leads for later development

*Owner-supplied leads first. Licences were checked on each repository's own page.*

- **Ancienttwo/repo-harness.** **MIT** (LICENSE file, 2026). https://github.com/Ancienttwo/repo-harness
  - A file-backed workflow with per-task contract files (allowed paths, exit criteria, budget) and a pre-edit hook that blocks edits outside the contract. It returns a structured reason and fix.
  - It also has session handoff packets, a one-screen review surface (intended vs actual files, commands passed, residual risk, rollback) and budgeted, leased autonomous runs.
  - *Serves:* gates and the worker loop (scope guard with a remedy), the dashboard (acceptance view), planner/PM (contract shape).
- **autonomous-ai/openharness.** The LICENSE file reads **MIT** (©2026 Autonomous, Inc.), not Apache-2.0 as the note said. https://github.com/autonomous-ai/openharness
  - A command centre that runs several vendor coding CLIs in tmux panes, each in its own git worktree. It reads their transcripts and uses their hooks rather than wrapping them.
  - Domain harnesses are declared by manifest plus AGENTS.md.
  - *Serves:* dashboard (multi-agent view), security (one worktree per agent), and the "AI teammates" idea (DEC-35–37).
- **nee1k/prompt-engineering-test-harness.** **No licence (no LICENSE file found). Ideas only; nothing reusable.** https://github.com/nee1k/prompt-engineering-test-harness
  - The idea: regression datasets of inputs and expected outputs, scored by several matchers (exact, fuzzy, substring, semantic), comparing prompts side by side across models, re-run on a schedule to catch drift.
  - *Serves:* measurement (the replay screen, recommendation 18).
- **ServaboFidem, "Harness Guidance" gist.** **No licence stated. Ideas only; nothing reusable.** https://gist.github.com/ServaboFidem/e52125daedbba5b5582463f5331da7f1
  - A weighted rubric for judging whether an LLM system is production grade.
  - Automatic failures: no evals or happy-path-only evals, speed or cost claims without quality evidence, retried side effects without idempotency.
  - Positive signals: eval cases drawn from real failures, before/after tables tied to commits, p50/p95 latency and cost per successful task.
  - *Serves:* measurement and release-gate self-audit.

Others found during this research:

- **OpenHands typed prompt-section registry** (**MIT**), a plan in which each section declares its cache tier. https://github.com/OpenHands/software-agent-sdk/issues/3606 *Serves:* context (compare with rule 10a before NEW-context-3).
- **CliffCompaction** (repo page shows **MIT**; verify the LICENSE file). Truncate-only compaction that rebuilds from scratch when full. https://arxiv.org/html/2609.26779 *Serves:* context (an alternative masking-point policy to A/B).
- **ACON.** Optimises history and observation compression guidelines, then distils them into small compressors. It reports up to +46% for smaller models and 26–54% lower peak tokens. https://arxiv.org/abs/2510.00615 (licence not checked). *Serves:* context, and the learning loops as a source of condenser rules.
- **SWE-Pruner** (**MIT**) and **LongCodeZip** (**MIT**). Goal-conditioned code pruning. Revisit if a larger host makes a second resident model free. *Serves:* context.
- **Tool-architecture study.** Structured interfaces made attempts 4.7× more consistent. https://arxiv.org/abs/2608.11386 *Serves:* worker loop (tool catalogue design, M2).
- **PA-Tool.** Renames tool schemas toward pretraining-familiar names. https://arxiv.org/abs/2510.07248 *Serves:* worker loop (a one-off naming pass under A/B).
- **Natural Language Tools** and **IFFC.** Tool selection in plain text, or by a small dedicated model; IFFC reports being robust to quantisation. https://arxiv.org/abs/2510.14453, https://arxiv.org/abs/2608.22472 *Serves:* worker loop, if tool-call parse errors stay high.
- **Manus: make tools unavailable by constrained decoding, not by editing schemas.** With llama.cpp grammars this could enforce phase order (localise → edit → verify) without touching the prefix. https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus *Serves:* worker loop and context.
- **Batch-invariant inference.** https://thinkingmachines.ai/blog/defeating-nondeterminism-in-llm-inference/ *Serves:* measurement (how reproducible replays are).
- **Evaluation sensitivity to templates and seeds.** https://arxiv.org/abs/2606.00135 *Serves:* measurement (stamp the chat template hash beside the context version).
- **Anthropic, "Demystifying evals for AI agents"**: pass^k, isolated trials, transcript review. *Serves:* measurement and the dashboard (show pass^k per card class).
- **Claude Code's four levels of verification**: in the prompt, a goal evaluator, a Stop hook, an adversarial subagent. https://code.claude.com/docs/en/best-practices *Serves:* gates and the Reviewer (Sekhemet is already at the hook level; the adversarial reviewer is the next step).
- **gemini-cli's hierarchical memory precedence** (**Apache-2.0**) and **Codex's per-directory AGENTS.md merging** (**Apache-2.0**). *Serves:* context (Zone 2 conventions when a monorepo has nested AGENTS.md files).
