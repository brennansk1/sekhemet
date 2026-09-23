# Knowing when a project is done, and how deep to build it

*Web research, 2026-09-22, at the owner's request: "LLMs are usually bad at determining when a project is done and the depth and features to add to a project." Sources were opened unless marked [search]. What this changes in the design is in the last section; the requirements are in [planner-pm.md](../design/specs/planner-pm.md), [design-stage.md](../design/specs/design-stage.md), [dashboard.md](../design/specs/dashboard.md) and [measurement.md](../design/specs/measurement.md) under COVERAGE P13 and P14.*

## 1. The weakness is real, and it runs in both directions

**Stopping too early.**
- NL2Repo-Bench ([2512.12730](https://arxiv.org/abs/2512.12730), ICML 2026) builds whole Python libraries from a requirements document. The best agents pass under 40% of tests and rarely finish a repository. It names two ways of not finishing:
  - **early termination**: the agent calls finish while work remains, a "false positive estimation of progress";
  - **passive non-finish**: the agent stops to wait for input, or times out.
- In the same study, a thinking model **terminated early in 49.0% of tasks**. Its reasoning convinced it the code was correct without running anything.
- A study of 20,574 real developer–agent sessions ([2605.29442](https://arxiv.org/abs/2605.29442), 2026) lists **false completion claims** as a main category of misalignment, alongside scope creep and incomplete execution. Prevalence figures were not readable in the fetched copy.
- The mechanism, per [agentpatterns.ai](https://agentpatterns.ai/patterns/anti-patterns/premature-completion/) [search]: training data is dominated by single-fix trajectories, so the "stop" fires on the first local success.

**Committing before the evidence is in.** ECLoop ([2607.28815](https://arxiv.org/abs/2607.28815), July 2026):
- **How it works.** From the task and the repository structure, it compiles the conditions that must be *observed* before an edit or a submission may run: callers read, a related test run. It tracks those conditions deterministically from the actual trajectory, never from the model's claims, and postpones any commit action whose evidence gap is not empty.
- **Results on SWE-bench Verified:**
  - GPT-5-mini went from 56.2% to 68.0% (**+11.8 points**);
  - MiniMax-M2.5 went from 75.8% to 80.6% (+4.8 points);
  - token use fell 1.4–12.1%.
- The weaker model gained the most.

**Building the wrong amount.**
- **Missed requirements.** ReqElicitGym ([2602.18306](https://arxiv.org/abs/2602.18306), Feb 2026) ran 101 website projects with 632 annotated implicit requirements. The best model elicited only **32%** of them. Style requirements came out **below 1%** for almost every model. Models over-used open "probing" questions and under-used clarifying ones. Chain-of-thought made questions more efficient but did not improve coverage.
- **Interviews alone miss a lot.** LLMREI ([2507.02564](https://arxiv.org/abs/2507.02564)) fully elicited at most 60.9% of requirements in interviews.
- **Doing more than asked.**
  - FeatBench ([2509.22237](https://arxiv.org/abs/2509.22237)) calls it **"aggressive implementation"**: agents add unrequested logic they judge "correct". In one case, adding a second compiler the task never mentioned broke the build.
  - "Overeager coding agents" ([2605.18583](https://arxiv.org/abs/2605.18583), May 2026) finds out-of-scope actions widespread across agents. Explicit scope definitions and sandboxing reduce them but do not remove them.
  - SlopCodeBench ([2603.24755](https://arxiv.org/abs/2603.24755)) shows agent code eroding structurally as a project is extended.
- **Too shallow.** ProjDevBench ([2602.01655](https://arxiv.org/abs/2602.01655)) accepted 27.38% of end-to-end projects. Agents handle basic functions but struggle with system design, complexity and resource management: the non-functional depth. A mixed-methods study on ISO/IEC 25010 ([2511.10271](https://arxiv.org/abs/2511.10271)) finds generated code weakest on the qualities practitioners care most about, maintainability and readability.

## 2. What works

**Judge completion by requirements, not by the agent.**
- Agent-as-a-Judge / DevAI ([2410.10934](https://arxiv.org/abs/2410.10934), ICML 2025) states each of 55 tasks as **365 hierarchical requirements arranged in a dependency graph**; for example, "visualise the results" depends on "load the data".
- An agent that checks each requirement against the artefacts agreed with human experts about **90%** of the time, against about 70% for a plain LLM judge, at about 3% of the cost.
- The lesson for us is the structure more than the judge: done becomes a count of requirements proven, not a feeling.

**Fix the appetite, vary the scope.** Shape Up ([Basecamp, ch. 3](https://basecamp.com/shapeup/1.2-chapter-03) and [ch. 14](https://basecamp.com/shapeup/3.5-chapter-14)):
- An appetite is a budget chosen *before* the design; "appetites start with a number and end with a design."
- Scope is hammered to fit: every task is marked must-have or nice-to-have (`~`), and nice-to-haves are cut first.
- Finished work is compared **down, to the baseline** (is this better than what people have now?), not up to an ideal.
- A **circuit breaker** ends the project at its appetite. An extension is allowed only when what remains is essential and purely "downhill" execution with no unsolved problem.

**Make the release slice the unit of done.** User story mapping ([Patton](https://www.jpattonassociates.com/wp-content/uploads/2015/03/story_mapping.pdf)):
- a **backbone** of user activities, in narrative order;
- tasks under each activity;
- horizontal **release slices**, of which the first is a **walking skeleton**: one story under every activity, the smallest end-to-end journey that works.

Maps surface the gaps a flat backlog hides.

**Classify features by what their absence costs.** The Kano model ([Kano, 1984](https://www.productschool.com/blog/product-fundamentals/kano-model) [search]) has five categories:

| Category | Effect |
| --- | --- |
| **Must-be** | Absence causes dissatisfaction; presence is taken for granted |
| **Performance** | Satisfaction grows with how well it is done |
| **Attractive** | Delights when present; missed by nobody |
| **Indifferent** | Nobody cares either way |
| **Reverse** | Some users actively do not want it |

LLMs are good at the attractive and poor at the must-be, the pattern ReqElicitGym measures.

**Look at comparable products.**
- Comparing app-store-inspired and LLM-inspired feature elicitation ([2408.17404](https://arxiv.org/abs/2408.17404), ASE 2024; 1,200 sub-features): both give relevant sub-features, and the LLM is stronger on novel scopes.
- **Both produce "imaginary" features of unclear feasibility**, so a person stays in the loop.

**Simulate the users.** Elicitron ([2404.16045](https://arxiv.org/abs/2404.16045)) has simulated users walk through product scenarios and explain their actions and difficulties, then interviews them. It surfaced **more latent needs than conventional human interviews**.

**A quality checklist the model cannot forget.** ISO/IEC 25010:2023 names the product qualities:
- functional suitability;
- performance efficiency;
- compatibility;
- interaction capability;
- reliability;
- security;
- maintainability;
- flexibility;
- safety.

Using it as an explicit checklist addresses exactly the non-functional depth that ProjDevBench and 2511.10271 find missing.

## 3. What this means for Sekhemet

The spine already says *the model never certifies its own work* — for a card. The weakness the owner names is the same failure one level up, so the fix is the same: **move the decision out of the model and into evidence**, at the level of the project.

| Weakness | Mechanism in Sekhemet | Evidence |
| --- | --- | --- |
| The model declares the project done early | **Project done is computed, never claimed.** The brief compiles into a *requirement graph*: requirements with dependencies, each carrying its acceptance criteria and the tests that prove them. A release slice is done when every must-have requirement in it is proven by passing tests on `main`, the project gates pass, and a person accepts the slice. The PM reports "9 of 11 must-haves proven", never "looks done" | DevAI, ECLoop, NL2Repo |
| Reasoning replaces running | A completion claim that is not backed by an execution is ignored; thinking is never evidence | NL2Repo's 49% |
| It never stops, or gold-plates | **Appetite and a circuit breaker.** Each project and slice has an appetite (cards, hours) set before planning. At the appetite, the PM stops and asks the person: ship the slice, cut a nice-to-have, or extend. An extension is offered only when every remaining card is already planned with passing red tests | Shape Up |
| It adds what nobody asked for | **No orphan cards.** Every card traces to a requirement in the brief; a new idea becomes a proposed change the person approves. This adds to the card scope and reachability gates already in place | FeatBench, Overeager, 2605.29442 |
| It misses implicit requirements | **Coverage does not rely on the interview.** The design stage fills the requirement graph from four sources: the conversation; a **depth profile**'s quality checklist (ISO/IEC 25010, scaled to the project); **comparable products** found by the Researcher, whose common features become must-be candidates; and a **walkthrough** of the story map from each user's point of view. It asks clarifying questions (which beat probing) and only where the answer changes the cards | ReqElicitGym, LLMREI, 2408.17404, Elicitron |
| It builds too shallow or too deep | **A depth profile, chosen with the person**: *prototype*, *internal tool*, *production* or *regulated*. It sets which quality rows are must-haves (error handling, input validation, persistence and migrations, logging, accessibility, a security baseline) and turns the must-haves into project gates. A calculator gets *prototype* and no questions; a payments service gets *production* or *regulated* and a short conversation | ProjDevBench, 2511.10271, Shape Up |
| Features without judgement | **Kano classes on every requirement** — must-be, performance, attractive — with comparables as the evidence for must-be. Nice-to-haves are marked and cut first. Features that exist only in the model's imagination are proposals, never cards, until a person accepts them | Kano, 2408.17404 |
| Depth decided once and forgotten | **The story map is the depth artefact**: the walking skeleton first, then slices, each with its exit criteria. People see where "done" is drawn and move it, and the Learn layer explains why a walking skeleton comes first | Patton |

**What this is not.** It is not a second model grading the project. Requirement coverage is computed from the traceability graph and the gate results; the model's contribution is proposing requirements, and a person accepts them. An LLM judge in the DevAI style is at most a *Reviewer finding* on requirements that cannot be tested, never the thing that marks a project done.

**How it is measured.** Two planning-measure items join COVERAGE T7:
- **implicit-requirement recall** on a golden set of briefs with annotated implicit requirements, ReqElicitGym-style;
- **premature-completion rate**: projects the PM reported done that a held-out acceptance suite shows are not.

Both are tracked per release against the B2.5 baseline.
