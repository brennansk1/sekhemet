# The Worker's working method: what the literature says

*Web research digest, 2026-09-22, commissioned when the Worker's senior-engineer method was designed (see [worker-loop.md](../design/specs/worker-loop.md)). Kept verbatim below its title; [opened] marks a source read in full, [search] a search summary only.*


Legend: [opened] = I fetched the page or paper and read the relevant part; [search] = taken from a search-result summary only, so treat it as less certain. "pp" = percentage points.

## 1. SWE-agent ACI (Yang et al., arXiv 2405.15793) [opened, Table 3 ablations, GPT-4]
- **Lint-on-edit guardrail.** If an edit introduces a syntax error, the edit is rejected and the agent is shown the error. With the guardrail: 18.0% resolved. Without it: 15.0%. With no edit command at all: 10.3%.
- **Windowed file viewer.** A 100-line window scored 18.0%. A 30-line window scored 14.3%. Showing the full file scored 12.7%. Both too little and too much context hurt.
- **Search.** A summarized search (list of matching files and a count) scored 18.0%. Iterative, result-by-result search scored 12.0%, which is worse than having no search tool (15.7%).
- **History.** Collapsing observations older than the last 5 scored 18.0%. Keeping the full history scored 15.0%.
- **Failed edits snowball.** 51.7% of resolved runs still had at least one failed edit. After a successful edit, the chance the next edit succeeds was 90.5%. After one failed edit it dropped to 57.2%, and it fell further with each additional failure.
- **Design principles.** Keep commands simple, merge common operations into few actions, give concise but informative feedback, and add guardrails.
- The paper only ablates GPT-4-class models. I found no small-model ACI ablation there (uncertain).

## 2. Structures imposed by other systems
- **CodeAct** (2402.01030) [opened]: letting the model act by writing executable Python code gave up to 20% higher success than JSON or text actions, across 17 LLMs.
- **mini-SWE-agent** (github.com/SWE-agent/mini-swe-agent) [opened]: about 100 lines of agent code, bash as the only tool, a linear history, and each command run independently. The README claims more than 74% on SWE-bench Verified but does not say which model. Takeaway: with a strong model, a minimal loop is enough, so the scaffold matters most for weaker models.
- **Agentless** (2407.01489) [opened]: a fixed pipeline of localize (file, then class/function, then edit location), repair with search/replace diffs, and validate. It scored 32.00% on SWE-bench Lite at $0.70 per issue.
  - Patch validation, step by step: majority vote alone gave 25.67%. Adding regression tests gave 27.00%. Adding reproduction tests gave 32.00% (+5 pp).
  - Showing a file skeleton instead of the full file raised localization accuracy from 53.67% to 58.33% and cut cost from $0.15 to $0.02 per issue.
  - Jumping straight from file to edit location scored 47.00%, worse than the step-by-step localization.
  - The authors chose small diffs over regenerating whole files because diffs are "more reliable and accurate (less chances for hallucination)".
- **AutoCodeRover** (2404.05427) [opened]: code search over the syntax tree (classes and methods), plus test-based fault localization when tests exist. It scored 19% on SWE-bench Lite at $0.43 per issue. The abstract gives no separate number for the test-based localization.
- **SWE-Search / Moatless** (2410.20285) [opened abstract]: adds tree search with backtracking, a value agent and a discriminator. It reports a 23% relative gain across five models.
- **Kimi-Dev** (2509.23045) [search]: training on the fixed Agentless pipeline first instilled localization, code-editing and self-reflection skills. The result: 60.4% on SWE-bench Verified as a pipeline, and 48.6% as an agent after SFT on 5k trajectories.

## 3. Planning
- **Plan-and-Act** (2503.09572) [search]: splitting the work into a planner and an executor improved an untrained executor by 34.39%, to 44.24%, on web tasks (WebArena-Lite), just by giving it a good plan. That is web, not code.
- **Claude Code TodoWrite** (docs: code.claude.com/docs/en/agent-sdk/todo-tracking) [search]: a checklist tool whose items move through pending, in_progress and completed. I found no published ablation of its effect.
- **Thinking vs Doing** (2506.07976) [opened abstract]: giving an agent more environment interactions (explore, backtrack, re-plan) is a separate lever from more reasoning per step. Even prompt-only interaction scaling helped a 12B model on web tasks.
- Coding-specific evidence that explicit plans help small models: none found (uncertain).

## 4. Verification and test-driven work
- **Test-Driven Development for Code Generation** (2402.13521) [opened abstract]: giving GPT-4 and Llama 3 the tests alongside the problem raised solve rates on MBPP and HumanEval. The abstract gives no exact numbers.
- **Rethinking the Value of Agent-Generated Tests** (2602.07900) [opened]: whether a strong agent writes its own tests barely changes whether it succeeds, but it costs a lot.
  - gpt-5.2 wrote tests in 0.6% of tasks and still resolved 71.8%.
  - Prompting it to write tests (64.4% of tasks) left the resolve rate unchanged at 71.8%.
  - Stopping test-writing dropped success by only 2.6 pp (kimi-k-thinking) and 1.8 pp (deepseek-v3.2-reasoner), and cut input tokens by 49.0% and 32.9%.
  - Implication: reproduction tests the harness supplies (Agentless) are worth more than tests the agent writes itself.
- **SWE-Bench Pro** (2509.16941) [opened PDF]:
  - Each task comes with an "interface" field listing the expected class and function names, signatures and file paths. It exists to stop agents from writing a working solution under names the tests don't expect.
  - Among the models analysed, Qwen3-32B had the highest tool-error failure rate: 42.0%. The authors note that weaker open models "struggle with syntax, formatting, and tool-use."
  - Sonnet 4 failures included 17.0% "endless file reading."
  - Their SWE-agent setup syntax-checks Python files after each edit.
- **Premature "done"**: in SWE-smith (2504.21798) [opened], when the agent ended the run itself, its submission was correct 60% of the time for SWE-agent-LM-32B and 63% for Claude 3.7. So roughly 40% of self-declared completions were wrong, even for a frontier model.

## 5. Repair, repetition, stopping
- **Is Self-Repair a Silver Bullet?** (2306.09896) [opened abstract]: once compute cost is counted, self-repair gains are modest and sometimes absent compared with fresh samples. The bottleneck is the quality of the feedback: using a stronger model's feedback gave "substantially larger" gains.
- **LLMs Cannot Self-Correct Reasoning Yet** (2310.01798) [opened abstract]: without external feedback, self-correction does not help and can make answers worse.
- **SWE-smith** (2504.21798) [opened]: repetition is the signature failure of small models.
  - More than 25% of SWE-agent-LM-32B trajectories contained a run of 10 or more identical commands, versus under 4% for Claude 3.7.
  - A run of 10 repeats meant an 89% chance of failure.
  - 53% of failures hit the cost or step limit, mostly while still localizing, before any edit.
- **OpenHands Stuck Detector** (docs.openhands.dev/sdk/guides/agent-stuck-detector) [opened]: hard rules that flag the agent as stuck when it sees:
  - the same action with the same result 4 or more times;
  - the same action with an error 3 or more times;
  - 3 or more messages in a row with no tool call;
  - two action/result pairs alternating for 6 or more cycles;
  - repeated context-window errors.
- **Understanding Code Agent Behaviour** (2511.00197) [opened abstract]: failed trajectories are longer and vary more. 72–81% of failed runs still found the right file, so failures happen after localization, during the fix.
- **Beyond Resolution Rates** (2604.02547) [opened abstract]: 9,374 trajectories from 19 agents.
  - Agents that "gather context before editing and invest in validation" succeed more often.
  - Once task difficulty is controlled for, the usual finding that longer runs fail more often reverses.
  - The underlying model matters more than the scaffold, and prompt-level tactics matter less the stronger the model.

## 6. Thinking budgets
- **Qwen3 Technical Report** (2505.09388) [opened], BFCL v3 agent/tool-calling scores:
  - Qwen3-30B-A3B: 69.1 with thinking, 58.6 without (+10.5).
  - Qwen3-32B: 70.3 vs 63.0.
  - Qwen3-8B: 68.1 vs 60.2.
  - Qwen3-235B-A22B: 70.8 vs 68.0.
  - The smaller or sparser the model, the bigger the gain from thinking. Performance also rises smoothly with the thinking budget (math, code, STEM).
  - The search summary also gave τ-bench numbers, but I could not confirm their source (uncertain).
- **Qwen3.6-35B-A3B model card** (huggingface.co/Qwen/Qwen3.6-35B-A3B) [opened]:
  - Thinking is on by default.
  - A `preserve_thinking` option keeps earlier turns' reasoning in context, recommended for agents for "decision consistency."
  - Recommended settings for precise coding: temperature 0.6, top_p 0.95, top_k 20, presence penalty 0.
  - It reports 73.4 on SWE-bench Verified using an internal bash + file-edit scaffold. The card does not say whether thinking was on.
- **MiniMax-M2 report** (2605.26494) [opened PDF]: says keeping the reasoning state across turns ("interleaved thinking") helps most on software engineering and deep search. The ablation sentence is ambiguously worded and gives no numbers in the text (uncertain).
- **The Danger of Overthinking** (2502.08235) [opened abstract]: across 4,018 SWE-bench Verified trajectories, more "overthinking" meant lower success. The failure patterns are analysis paralysis, rogue actions and premature disengagement. Picking the run with the lower overthinking score improved performance by nearly 30% and cut compute by 43%.
- **ARES** (2603.07915) [opened abstract]: a router picks a reasoning level for each step. It cut reasoning tokens by up to 52.7% with little loss in success, by saving high effort for the hard steps. Not tested on coding.
- **s1** (2501.19393) [opened abstract]: "budget forcing" appends "Wait" when the model tries to stop thinking. That pushed AIME24 from 50% to 57% on math. There is no agentic evidence.

## 7. What successful trajectories look like (training papers)
- **SWE-Gym** (2412.21139) [opened abstract]: fine-tuning a 32B model gave up to +19 pp, reaching 32.0% on Verified with a verifier trained on trajectories. The behaviour analysis is not in the abstract.
- **SWE-smith**: training on diverse repositories helps (gains grow roughly with the log of the repo count). Over-sampling easy tasks hurts. Diverse action repertoires correlate with better data.
- **SWE-RL** (2502.18449) [opened abstract]: RL with a patch-similarity reward reached 41.0% on Verified with Llama3-70B. It lists no specific behaviours.
- **Kimi-Dev** (see section 2) and **Beyond Resolution Rates** (see section 5) agree on the pattern: localize, then edit, then verify. **Understanding Code Agent Behaviour** (2511.00197) found that successful runs balance gathering information, testing hypotheses and validating the fix.

## Implications for a small-model Worker (ranked by strength of evidence)

1. **Validate every edit syntactically before accepting it; reject broken edits with the error in the reply.** Measured +3 pp, and a reduction in failure cascades after a bad edit. [SWE-agent 2405.15793; SWE-Bench Pro 2509.16941]
2. **Make `check` (gates) the only way to finish.** `finish_card` should be refused unless the latest `check` on the current file state passed. About 40% of self-declared completions are wrong even for frontier models, and self-correction without external feedback does not work. [SWE-smith 2504.21798; Huang 2310.01798; Olausson 2306.09896]
3. **Detect loops by rule and refuse repeats.** Hash (tool, arguments, result).
   - On the 2nd identical call with the same result (e.g., re-running the same failing test with no file change since), refuse it and return the previous result plus a short "files unchanged since last run" note.
   - Escalate by the OpenHands thresholds (3 identical errors, 4 identical action/result pairs, 6-cycle ping-pong): fail over or resample.
   - Evidence: repetition is *the* small-model signature (>25% of runs, 89% failure after 10 repeats). [SWE-smith; OpenHands Stuck Detector]
4. **Supply the test, and the interface it expects, before any write.**
   - Inline the acceptance test plus the exact symbol names and signatures it imports.
   - Block `write_file` on an existing file until it, or the symbols the test imports, has been read (`read_file`/`read_symbol`).
   - Prefer `edit` (search/replace) over whole-file `write_file` for existing files.
   - Evidence: reproduction tests +5 pp; diff edits "less hallucination"; the interface field prevents naming mismatches; successful agents gather context before editing. [Agentless 2407.01489; SWE-Bench Pro; 2604.02547; TDD 2402.13521]
5. **Turn thinking on for this Worker, at least on the first turn and on any turn right after a failing `check`.**
   - On a 30B-A3B-class model, thinking adds about 10.5 pts of tool-calling accuracy (the biggest gain of any size tested).
   - Keep reasoning across turns (`preserve_thinking`).
   - Cap per-turn thinking tokens to avoid overthinking and analysis paralysis. Routine reads and greps can stay low-effort.
   - Evidence: moderate, since the thinking-vs-not numbers are from BFCL, not SWE-bench. [Qwen3 2505.09388; Qwen3.6 card; Overthinking 2502.08235; ARES 2603.07915; MiniMax-M2 (uncertain)]
6. **Shape tool output the way SWE-agent found works best.** Viewer windows of about 100 lines. Search results as a list of matching files with counts, not a stream. Older observations collapsed so only the last ~5 are shown in full. Test failures trimmed to the assertion, the expected vs actual values, and the stack frames in scope. Measured gains of 3–6 pp per knob. [SWE-agent]
7. **Enforce a phase order: localize, then edit, then verify.** A lightweight state machine (reads and search, then edits, then `check`) mirrors Agentless and Kimi-Dev. It also stops the model spending its budget before the first edit (53% of small-model failures hit the limit while still localizing). Add a step budget for localization with a nudge when it runs out. [Agentless; Kimi-Dev 2509.23045; SWE-smith]
8. **After a failing check, require a one-line diagnosis before the next edit**, e.g., a required `hypothesis` field on `edit` after a failure, pointing at the specific assertion. Self-repair only works when grounded in external feedback, so tie it to the gate output. If two diagnosed repairs fail, stop repairing and resample: restart the card fresh, keeping only the notes. Evidence: moderate to weak. [Olausson 2306.09896; SWE-Search 2410.20285; Understanding Code Agent Behaviour 2511.00197]
9. **Don't make the Worker write extra tests; use the harness's acceptance test as the oracle.** Agent-written tests cost 33–49% more input tokens for roughly 2 pp of benefit. [2602.07900]
10. **Plans and todo lists: low priority for a 1–3-file card.** Evidence exists only for web tasks with a separate planner. Keep planning upstream (the board and planner) and hand the Worker a short, fixed step list, not a planning tool. [Plan-and-Act 2503.09572 (search only); TodoWrite (no ablation found)]
