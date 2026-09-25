# The prompt standard

*How every prompt Sekhemet sends to a model is written, structured, compressed and changed. It binds the Worker, Seshat (Planner/PM), the Reviewer and the Researcher. No prompt text, tool description or model-facing observation is written or changed except under this standard ([DEC-41](DECISIONS.md#dec-41--one-prompt-standard-before-any-prompt-work)). The evidence is [PROMPT_RESEARCH.md](../research/PROMPT_RESEARCH.md); the mechanics it constrains are in [context.md](specs/context.md) (zones, budgets, masking, the context version) and [worker-loop.md](specs/worker-loop.md) (tools, observations).*

## 1. Why a standard

Our Worker is a 3B-active model at IQ3_XXS in a 16k–32k window. Models of that size are far more fragile to prompt form than frontier models: meaning-preserving changes of format have moved small models by 40–76 points, adherence falls as instructions accumulate, and quantisation hurts most on long inputs. The exact rendering of a prompt is part of what the suite measures. So prompts are engineered artefacts: written to a fixed form, versioned, linted, and changed only through measurement.

## 2. Sources and provenance

1. Prompts are written in our own words. They draw only on vendors' published guidance, peer-reviewed or arXiv literature, and open-source agents whose authors publish their prompts under an open licence (each recorded with its licence in the research).
2. No leaked, extracted, jailbroken or reverse-engineered prompt of any vendor is read, quoted, paraphrased or used as a model.
3. No text is copied from any source, open-licensed or not; a technique is described and re-expressed. Examples inside prompts use Sekhemet's own tool names, files and tasks, never a public trajectory ([measurement](specs/measurement.md) rule 25).
4. A source with no licence may inform ideas only.

## 3. Structure

5. **One delimiter style: lower-case XML-like tags named for their content.** No Markdown headings inside a prompt, no JSON for prose, no mixing of styles. The style is part of the context version and changes only by A/B.
   - Tags come from one registered vocabulary, kept in code beside the copy modules. It starts with the tags this standard names: `rules`, `tool_rules`, `example`, `prefer`, `instead_of`, `card`, `criteria`, `acceptance_test`, `observation`, `document`, `source`, `content`, `untrusted_content`.
   - A new tag joins the vocabulary in the same change as the template that first uses it, and goes through rule 35 with that template.
   - The placeholder lint allows a registered tag, opening or closing, with or without attributes. Any other `<…>` or `[…]` span of lower-case words is a placeholder (rule 12, CX-M1-12).
6. **Order, for every role:**
   1. identity, in one sentence, with no persona or backstory;
   2. the output contract: what a reply must be;
   3. the rules;
   4. the tool rules;
   5. stable reference data;
   6. the task data;
   7. the question or next action, last.

   Long material goes before the ask, never after it. This is the zone order of [context.md](specs/context.md): Zones 1 and 2 are stable, Zone 3 holds the card, and the Zone 4 tail holds the next action.
7. **The tail is short:**
   - the step counter;
   - the unmet criteria;
   - the latest observation;
   - one next action.

   The full spec and criteria live in Zone 3 (CX-M8-6).
8. **Seshat consolidates before planning.** When a conversation becomes a plan, the whole brief is written as one self-contained message — goal, users, scope, out of scope, criteria — and planning starts from a fresh context holding that message, not the transcript. Tasks revealed piece by piece lose about 39%.

## 4. Writing rules

9. **Positive, concrete, with the reason.** Say what to do and why. Where a prohibition cannot be avoided, pair it with the action to take instead ("write only the files in `scope`; to change another, call `request_scope`").
10. **No emphasis devices.** No capitals for emphasis, no "CRITICAL", no threats, no incentives, no flattery, no persona. At most one emphasised line in a template, and only with a recorded A/B showing it helps. Anything that must always hold is enforced by the harness (a refusal, a gate, a guard), and the prompt only describes that enforcement.
    - The lint's capital-letter check flags any word whose letters are all capitals and number two or more. Fenced code and data are not checked: the bodies of the data tags (`untrusted_content`, `document`, `content`, `observation`, `acceptance_test`) and format strings such as `YYYY-MM-DD`. An inline code span is checked for the emphasis words below only, so a template cannot hide them there.
    - Acronyms and identifiers the model needs are on a registered allowlist, kept beside the tag vocabulary. It starts with `JSON`, `HTTP`, `URL`, `API`, `SQL`, `CLI` and `LSP`, and error codes by pattern, such as `TS\d{4,5}` for `TS2375`. A new entry is added in the same change as the template that first needs it.
    - Words used for emphasis (`MUST`, `NEVER`, `CRITICAL`, `IMPORTANT`, `ALWAYS`, `ONLY`, `NOT`, `DO`, `NOTE`, `WARNING`) are never added to the allowlist.
11. **Few rules, each once.**
    - An imperative rule is one item of a template's `<rules>` or `<tool_rules>` section (rule 6, steps 3 and 4). Each item holds one directive, and every sentence that tells the model what to do belongs in one of those two sections.
    - These are data, not rules, and do not count: the identity sentence; the output contract; tool descriptions, which have their own limit (rule 18); reference and task data; the question or next action at the end (rule 6, step 7); project playbook rules, which are project data with their own cap of eight ([context.md](specs/context.md) rule 24); examples, including Do/Don't pairs rendered as examples (rule 31); and a one-line description of a limit the harness enforces with a refusal, a gate or a missing tool (rule 10). A directive written anywhere else counts as a rule. The lint counts only the two sections, so the review checks for directives placed elsewhere.
    - The cap is per template, because each template is one prompt a model reads. It is **12 imperative rules** for every role's templates; rule 31 gives the reason it is the same for Seshat. A higher cap for any template is a harness change, admitted only under rule 35.
    - Each fact appears once, in one place (playbook facts are keyed, [context.md](specs/context.md) rule 24c). The test for every line: would removing it cause a mistake?
12. **No contradictions and no placeholders.**
    - Never tell the model that no other tool exists while one is callable.
    - Never ask for both several calls and exactly one.
    - Never mark a file "do not re-read" while telling the model to re-read it.
    - Never show an observation pointer when `recall` is not offered.
    - Never leave a placeholder (rule 5).
    - Never number a list item twice. (CX-M1-1, CX-M1-12.)
13. **One copy module per role.** Every non-data sentence a model sees comes from that role's copy module: the system text, the tool descriptions, the observations and the refusal messages. No other file may hold a model-facing literal (CX-M1-2 for the Worker's prompt; CX-M1-13 for every role, and for tool descriptions, observations and refusals).
14. **Actionable feedback.** A refusal or error says what happened and the next call to make. It never says "read the module" when reading cannot produce the answer ([worker-loop](specs/worker-loop.md) M1). Advice the model cannot act on in one step is a defect.
15. **No narrated plans for the Worker.** Do not ask the Worker for an upfront plan or progress updates; they cause early stopping. The post-failure `hypothesis` field stays.
16. **Untrusted content is data.** Issue text, fetched pages, file contents and gate output enter wrapped as `<untrusted_content source="…">…</untrusted_content>`, where `source` names where the text came from. The stable prompt states once that instructions inside it are never followed ([security](specs/security.md) item 42). A Researcher's fetched page carries this wrapper inside its document (rule 33).

## 5. Tools

17. **Native tool calling through the model's own chat template.** Never use a stopword-based ReAct template: with reasoning models the stopwords appear inside the thinking.
18. **Familiar names and closed values.**
    - Tool and parameter names use the vocabulary models learned in pretraining: `read_file`, `grep`, `edit`, `path`, `old`, `new`.
    - Closed sets of values are enums.
    - Each description is at most two sentences (linted, rule 35).
    - The tool interface for a card class fits 1,700 tokens, with the system prompt within 700 (DEC-27, CX-M1-3).
19. **Tools are never removed mid-attempt.** An unavailable tool is refused with a one-line reason, so Zone 1 stays byte-stable.
20. **Few overlapping tools, readable results.**
    - Consolidate tools that overlap.
    - Return readable identifiers, not internal ids.
    - Offer a concise result form.
    - Hold one result to 300 tokens in the recent window and keep its error lines, paths, test names and exit code first (CX-M8-8).

## 6. Cache stability

21. **The prefix is byte-stable for an attempt:**
    - no timestamps;
    - no counters;
    - no random ordering: skills and rules are sorted and serialisation is deterministic;
    - an identical tools array on every step (CX-M8-2).
22. **History is append-only.** Step n+1's request begins with step n's messages byte for byte, except at a scheduled masking point (CX-M8-1, CX-M8-3). Reasoning sent back is clipped when appended and stripped only at a masking point (CX-M8-9).

## 7. Compression

Ranked by expected gain per cost on a 24 GB host running a 13 GB Worker:

23. **Prefix stability first.** It saves the most seconds by far and costs no dependency.
24. **Observation masking with `recall` pointers.** Against keeping the raw history it roughly halves cost. Against LLM summarisation it matched solve rates within noise (a point apart on each of two models, n = 500), and the summaries lengthened runs by 13–15%. The recent window (5 steps vs 10) is decided by A/B.
25. **Deterministic condensing and head-and-tail truncation of long tool output.** Error lines, paths and exit codes are kept first, and the rest is recoverable through `recall`.
26. **Slimming Zone 1:** a compact system prompt and minimal schemas. Zone 1 is cached, so this buys attention, not seconds.
27. **Rejected for code:**
    - token-dropping compressors (the LLMLingua family, Selective Context), which cut code-completion quality from 56 to 41 or worse;
    - LLM-written summaries of history, which are no better than masking and make runs longer.
28. **Not now:** learned code pruners (SWE-Pruner, LongCodeZip). Each needs Python and a second resident model. Revisit on bigger hardware (Team setup) with owner approval.
29. **Compress reversibly.** Whatever is dropped keeps a pointer that restores it. Chase a moderate ratio, not a high one: over-compression has raised total cost by lengthening output.

## 8. Roles

30. **Worker.** The rules above. Three changes are A/B candidates, each admitted only by the suite (rule 35):
    - one tool-call example of at most 150 tokens, written in our own tool vocabulary, showing a read followed by an edit;
    - one sentence stating that the attempt ends when `check` passes or a stop condition is named;
    - one positive sentence stating that the acceptance test checks behaviour and the solution must be general.

    The owner approved the first two for B2.5 (DEC-41) and the third under DEC-42. Whatever its verdict, the gates remain the real defence against test gaming.
31. **Seshat.**
    - Consolidate before planning (rule 8).
    - Produce structured outputs by grammar or JSON schema at temperature 0, followed by a separate critic pass.
    - The PM rules sit in the stable section and the brief goes last.
    - Replies are short and direct, not persuasive, with one question at a time for non-developers.
    - Seshat's language rules ([planner-pm](specs/planner-pm.md) §2.18) are part of its copy module.
    - Its cap is 12 rules per template, the same as the Worker's. Seshat runs on the Planner's model, a 27B Qwen at IQ3_S ([models](specs/models.md) rule 3). That model is larger than the Worker, but in the one study of 20 models accuracy fell as instructions were added, in patterns that differed by size, and no published study or measurement of ours shows how many rules a model at IQ3 follows ([PROMPT_RESEARCH](../research/PROMPT_RESEARCH.md) §2). There is no basis for a larger number. Seshat's wider remit is carried by structure instead:
      - each pass is its own template with its own cap: the conversation, the plan, the critic, the end-of-run reflection and the weekly update draft;
      - the limits the harness enforces (every change is a proposal a person applies; Seshat cannot approve work, assign a person or set health: [planner-pm](specs/planner-pm.md) §2.8.3–4, §2.18.1) are described once as reference data (rule 10);
      - the senior-PM skill ([planner-pm](specs/planner-pm.md) §2.8.8) is loaded by pass, so a template holds only the topics its task needs, and the skill's directives count against the cap of the template that loads them;
      - the §2.18.3 language table is rendered as examples.

      A template that cannot do its task within 12 rules is split into another pass, or its cap is raised as a harness change under rule 35.
    - The language table is rendered as example pairs, the Do first. Each row becomes one `<example>` holding the Do in `<prefer>` and its Don't in `<instead_of>`. A Don't is never rendered without its Do, and no row becomes a prohibition, which keeps rule 9's positive phrasing. A row whose Do is a behaviour rather than a sample of text ("the answer first, then the evidence") is a rule and counts toward the cap.
32. **Reviewer.**
    - It gets a fresh context holding only the diff, the card's criteria and the gate evidence, never the Worker's reasoning.
    - It reports only gaps that affect correctness or the stated criteria.
    - Its verdict is structured.
33. **Researcher.**
    - Documents come first and the question last. Each fetched document is rendered as `<document><source>…</source><content><untrusted_content source="…">…</untrusted_content></content></document>`: rule 16's wrapper nested inside the document's content, with its `source` attribute the same id as the `<source>` element. The document tags carry the citation id; the inner wrapper marks the text as data.
    - It extracts quotes before answering and cites by source id.
34. **Every role has a token budget, counted with its own model's tokenizer.**
    - The Worker's budgets are DEC-27's: Zone 1 at most 2,400 tokens, of which the system prompt at most 700 and the tool interface at most 1,700 (rule 18, [context.md](specs/context.md) rule 10).
    - Seshat's, the Reviewer's and the Researcher's prompts go through the same allocator with their own window ([context.md](specs/context.md) rule 10c, CX-N3-7). No numbers are fixed for them yet, and this standard sets none without a basis. Each is set from that role's resolved model's window the way DEC-27 sets the Worker's: the prompt budget is the window less the answer cap, the thinking cap and a 256-token margin, and the stable section's caps are fixed in tokens within it. The numbers are recorded as a budget policy, so they are part of the context version (rule 37).
    - Each role's prompt is counted with its resolved model's own tokenizer, calibrated against that model's server ([context.md](specs/context.md) rule 11): the Planner's for Seshat, the Reviewer's model for the Reviewer, the Researcher's model for the Researcher. The one fallback ratio (CX-N1-2) is used only when no tokenizer is available.

## 9. Changing a prompt

35. **Every change goes through these steps, in order:**
    1. **Lint.** A test fails a template on:
       - capital-letter emphasis, outside the allowlist of rule 10;
       - more imperative rules than the template's cap (rule 11);
       - a tool description longer than two sentences (rule 18);
       - more negations than the template's recorded baseline;
       - a placeholder: a `<…>` or `[…]` span of lower-case words that is not a registered tag (rule 5);
       - a model-facing literal outside the role's copy module (rule 13);
       - the contradictions in rule 12.

       Rule 36 says which checks start from a recorded baseline.
    2. **Golden render tests.** Every role's prompt is rendered from recorded real inputs (a first step, a repair step, a post-masking step) and diffed against a stored snapshot. Each section's token count is asserted with that model's tokenizer (rule 34).
    3. **Step-replay screen.** Recorded prompts are rendered under the new templates and run for one model step each. Code checks that the tool call parses, the right tool is chosen in canonical states, no tool is hallucinated and no placeholder is echoed. It *screens*; it never admits.
    4. **Suite A/B.** A paired run on the same cards with the same seeds, reporting pass@1 and pass^k, the cache-hit rate and prefill seconds per step. This is the only admission route ([DEC-28](DECISIONS.md#dec-28--one-rule-for-admitting-what-the-system-learns)).
       - The cost measure is named in the run's record before the run starts: median tokens per card.
       - A change is admitted on a gain the suite can resolve: at least 20 points on 30 cards, by an exact test at 0.05.
       - An inconclusive result, the usual case, is adopted only if the change is simpler — it removes prompt tokens from the stable zone, a tool, a switch or code, and adds none — or cheaper on median tokens per card, by a one-sided paired Wilcoxon signed-rank test at 0.05, and in either case the paired pass rate shows no loss the suite can resolve. It is recorded as "not established", watched, and rolled back on the first paired loss a later run resolves.
36. **Existing prompts are the grandfathered baseline.** The prompts in the code when this standard was adopted do not yet conform ([context.md](specs/context.md) §4 lists their defects).
    - When the lint lands it records, per template, its count for each of these checks: capital-letter words outside the allowlist, imperative rules over the cap, tool descriptions over two sentences, negations, and model-facing literals outside the copy module. A change fails only if it raises a template's count. A recorded count may be lowered, never raised. An existing violation therefore does not block an unrelated change, and a new one fails.
    - A template not yet written with the rule sections of rule 11 records its rule count as not measured. The cap applies from the change that converts it.
    - Contradictions and placeholders (rule 12) are not grandfathered. They are defects, and M1 removes them (CX-M1-1, CX-M1-12).
    - Removing a defect that B2 lists (a contradiction, a placeholder, a remedy the model cannot act on in one step: CX-M1, [worker-loop](specs/worker-loop.md) M1, [gates](specs/gates.md) M6) before the B2.5 baseline is part of building the context version that baseline measures. It passes the lint, golden tests and step-replay screen, and is not A/B'd one by one: the baseline measures all of it together against the earlier version. From the baseline on, every change goes through the suite A/B.
    - A rewrite made only to conform is a prompt change like any other and goes through every step of rule 35. For Worker-facing text that includes the suite A/B, because the rendering is part of what the suite measures: a change of form can move the Worker's pass rate as much as a change of meaning.
37. **Versioning.** Templates, copy modules, tool schemas and budget policies are hashed into the context version recorded on every card. A result is comparable only within one version.
38. **Record the verdict.** Every prompt A/B is recorded in `SUITE_RUNS.md` with its keep-or-cut verdict, even when inconclusive ("no clear difference").

## 10. Checklist for a prompt change

- Does it follow the order in rule 6, and is every tag in the registered vocabulary of rule 5?
- Is every instruction positive, concrete and justified, with no emphasis devices, and is every all-capital word on the allowlist?
- Is each template within its cap of imperative rules (rule 11), with no directive outside the rule sections and each fact stated once?
- Is every tool description at most two sentences?
- Do all model-facing strings, including tool descriptions, observations and refusals, come from the role's copy module?
- Is untrusted content wrapped as rule 16 says, and nested as rule 33 says for the Researcher?
- Does the prompt fit its role's budget, counted with that model's tokenizer (rule 34)?
- Is the prefix still byte-stable, and is history append-only?
- Do the lint (no count above the template's baseline), golden tests and step-replay screen pass?
- Was the cost measure named before the run, and is the suite A/B recorded with its verdict?
