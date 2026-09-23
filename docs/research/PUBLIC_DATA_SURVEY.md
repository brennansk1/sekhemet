# Public data for the learning loops

*Two surveys, 2026-09-22: whether public datasets can seed the competence model, difficulty scorer, calibration, exemplars and playbook, and which public code-review datasets could seed playbook rules. Licences verified at the source; nothing was downloaded. The resulting decisions are in [DECISIONS.md](../design/DECISIONS.md) (public trajectories as exemplars: rejected) and [measurement.md](../design/specs/measurement.md). Nothing here is imported without the owner's yes.*

## Survey 1: data for the self-improvement loops

### Public data for the harness's data-hungry loops — survey and verdicts

Everything below was verified against the repository's own LICENSE / `gh api` licence field / dataset card, or the HF datasets-server schema and statistics endpoints. Nothing was downloaded beyond metadata and one 700-byte range read of a trajectory file to confirm its format.

### What the harness actually needs (grounded in the code)

I read the consumers so the fit judgement is concrete, not hand-wavy:

- `packages/kernel/src/types.ts` — `CompetenceEntry { repoId, cardClass, filesTouchedCount, difficulty, modelId, toolArm, stepBudget, stepsUsed, stopReason, passed, tokensUsed, wallClockSeconds }`. That is the row a competence prior has to fill.
- `packages/context/src/exemplars.ts` — `Exemplar.trajectory: string[]`, one line per step as `` `${action} -> ${first line of result}` ``, keyed by `cardClass = ${tier}:${ext}:${kind}` (e.g. `task:ts:fix`), retrieved into the prompt's **static zone**.
- `packages/context/src/playbook.ts` — TOML rules with `pattern`, `instruction`, `triggerGate`, and `errorPattern` matched against `TS\d{4,5}` / `lint/...` diagnostic codes.
- `packages/kernel/src/types.ts` — `difficulty?: number` (planner-assigned 1..10).
- `packages/models/src/registry.ts` — `selectArm()` discards any arm with `trials < MIN_ARM_TRIALS`.

The comment already in `apps/harness/src/pm/capability.ts` ("there is no public benchmark for these fine-tunes at this quantization, so capability must come from the ledger") turns out to be correct, and this survey mostly reinforces it.

---

### Ranked shortlist — worth importing

### 1. `nebius/SWE-rebench-V2` — the single best import

| | |
|---|---|
| Licence | **CC-BY-4.0**, and carries a **per-instance `license` field** |
| Size | **0.43 GB** on disk, parquet, streamable |
| Format | `instance_id, repo, language, license, base_commit, patch, test_patch, problem_statement, pr_description, FAIL_TO_PASS, PASS_TO_PASS, install_config, image_name, interface, meta` |
| Serves | 1 (features), 5 (instance supply for anchor pairs); indirectly 2 |

Language mix (verified): **python 7,243 · go 6,144 · ts 4,204 · js 4,138 · rust 3,123** · java 1,716 · php 1,445 · +13 more. That is **14,570 instances in exactly TypeScript, Python and Rust** — no other public dataset comes close on language fit.

Licence mix inside it: MIT 13,117 · Apache-2.0 10,407 · BSD 2,532 · **AGPL-3.0 54 · GPL-3.0 5** · `custom-check-github` 5,038 (unresolved). A loader must filter on `license` and drop the 59 copyleft rows and the 5,038 unknowns before any patch text is persisted.

Companion `nebius/SWE-rebench-V2-PRs` — 126,300 instances, 2.68 GB, same licence — if you want volume over pre-built images.

### 2. `SWE-bench/experiments` — the outcome matrix

| | |
|---|---|
| Licence | **NONE. `license: null`, no LICENSE file in the tree.** See the caveat below. |
| Size | 340 MB / 4,355 files whole; a sparse checkout of `**/results/results.json` + `metadata.yaml` is a few MB |
| Format | `evaluation/{lite,verified,test,multimodal,multilingual}/<date>_<system>/{metadata.yaml, results/results.json}` |
| Serves | **2 (competence/routing) — the best source there is** |

**326 submissions** (verified 182, lite 84, test 24, multimodal 22, multilingual 14). `results.json` is `{"resolved": [instance_id…], "no_generation": […], "no_logs": […]}`; `metadata.yaml` gives `tags.model`, `tags.agent`, `tags.system.attempts`. Cross-joined against the instance tables this yields on the order of **10^5 (instance, system, pass/fail) rows** for a few MB. This is the cheapest high-value import in the whole survey.

Licence caveat, stated plainly: there is no licence grant, so strictly this is all-rights-reserved. What you actually need from it is a set of booleans — "system X resolved instance Y" — which is factual data rather than creative expression, and is aggregate-only. Import the derived pass/fail matrix; do not vendor the repo.

### 3. `nebius/SWE-agent-trajectories` — best model-size match

| | |
|---|---|
| Licence | **CC-BY-4.0** |
| Size | **1.11 GB** on disk (5.28 GB expanded), parquet, streamable |
| Format | `instance_id, model_name, target(bool), trajectory, exit_status, generated_patch, eval_logs` |
| Serves | **2 (strongly)**, 5 |

80,036 rows. Models: `swe-agent-llama-70b` 74,792 · `swe-agent-llama-8b` 4,053 · `swe-agent-llama-405b` 1,191. `target=True` on 13,389 (**16.7 % resolve**). This is the only large outcome corpus generated by **open-weight models near your 4B–35B band** rather than frontier models.

It maps onto `CompetenceEntry` better than anything else: `passed ← target`, `modelId ← model_name`, `stepsUsed ← len(trajectory)`, `filesTouchedCount ← parse(generated_patch)`, and — the nice one — **`stopReason ← exit_status`**, whose vocabulary (`submitted` 51,087 · `submitted (exit_context)` 21,026 · `early_exit` 3,176 · `exit_context` 3,568 · `exit_cost` · `submitted_no_patch` 1,066) is a direct semantic match for budget-exhaustion vs clean completion. Missing: `cardClass`, `toolArm`, `tokensUsed`, `wallClockSeconds`.

### 4. `nebius/SWE-rebench-openhands-trajectories` — the only real anchor-pair source

| | |
|---|---|
| Licence | **CC-BY-4.0** |
| Size | 2.08 GB on disk (16.6 GB expanded) — stream the columns you need, do not materialise |
| Format | `trajectory_id, instance_id, repo, trajectory, tools, model_patch, exit_status, resolved, gen_tests_correct, pred_passes_gen_test` |
| Serves | **5 (uniquely)**, 2 |

67,074 trajectories from Qwen3-Coder-480B-A35B + OpenHands v0.54; 32,161 resolved (47.9 %). The card's own field definitions: `pred_passes_gen_test` = "number of agent-generated tests passed by the agent's own solution", `resolved` = ground truth. **That is 67,074 (cheap surrogate score, expensive real score) pairs** — exactly consumer 5's requirement. The card claims, and I found nothing to contradict it, that no other public trajectory dataset includes generated-test evaluation.

Import the four scalar columns (`instance_id, resolved, gen_tests_correct, pred_passes_gen_test`) and leave the 16 GB of conversation text alone.

### 5. OpenAI SWE-bench Verified human annotations — the only difficulty labels that exist

| | |
|---|---|
| URL | `https://cdn.openai.com/introducing-swe-bench-verified/swe-bench-annotation-results.zip` (HTTP 200, **2,397,074 bytes**) |
| Licence | **Not stated anywhere I could find.** Flag before use. |
| Format | `ensembled_annotations_public.csv` + `samples_with_3_annotations_public.csv`; columns `instance_id`, `difficulty`, `filter_out`, plus well-specified / valid-evaluation scores |
| Serves | **1 — and it is the only thing that does** |

1,699 instances, 3 annotators each, 4 levels: `<15 min fix` / `15 min - 1 hour` / `1-4 hours` / `>4 hours`. The consumer-side confirmation that this is the canonical artifact: SWE-smith's own difficulty rater loads exactly these two filenames (`swesmith/train/difficulty_rater/create_datasets.py`, MIT).

The 500-instance released subset skews short — **194 / 261 / 42 / 3**. That skew happens to *match* your card discipline (<200 LOC, 1–3 files), which is a genuine point in its favour.

### 6. `SWE-bench/SWE-smith-ts` and `-rs` — cheap multi-language instance supply

5,032 TypeScript rows (9.5 MB) and 5,311 Rust rows (22.2 MB). Parent `SWE-bench/SWE-smith` is **MIT**; `-go` is tagged MIT; **the `-ts` and `-rs` cards carry no licence tag** — MIT by parity, unconfirmed. Trivially cheap.

Important caveat: these are **synthetically injected bugs**, not real issues. `problem_statement` is LLM-generated and there is no `base_commit`/`test_patch` pair from history. Injected bugs are more localised and more uniform than real ones, so their difficulty distribution is not the real one.

### 7. Code review — the honest picture

A delegated deep-dive established there is **no public dataset** giving the full object you want (reviewer returns → states reason → author revises → reviewer accepts) at scale under a clean licence. What exists splits into two halves that are useless alone:

- **Volume, no verdict:** Microsoft CodeReviewer (Zenodo 10.5281/zenodo.6900648, **CC-BY-4.0** — note the widely-miscited "Apache-2.0" belongs to the *model* card, not the data). ~317k rows, 4.8 GB zipped, streamable as parquet via the `fasterinnerlooper/codereviewer` mirror. Its `ref` split is genuinely `(old, comment) → new`. But its `cls` label is literally `y = 1 if len(msg) > 0` — "someone commented", not "was returned" — and arXiv 2502.02757 documents that the comments are substantially vague and non-actionable. **Nine languages, no TypeScript, no Rust.**
- **Verdict, no volume:** c-CRAB (234 test-verified review comments, CC-BY-4.0), SWE-PRBench (350 merged PRs with an explicit `has_requested_changes` bool, CC-BY-4.0/MIT, ~21 TypeScript PRs), CROP (Zenodo 3599150, CC-BY-4.0, 144,906 Gerrit revisions with per-revision status — structurally the richest return-loop, but Java/2018-vintage; the 131 MB metadata + discussion archives can be taken without the 3.5 GB repo dump).

The dataset that is *exactly* the right shape — `ronantakizawa/github-codereview`, 355,807 rows with `before_code`/`reviewer_comment`/`after_code`, explicit negatives, 37 languages **including TypeScript and Rust** — is published under `license: other` with `license_name` and `license_link` both absent. That is a declared-but-undefined licence, i.e. no grant of rights. **Do not import it.** Its pipeline is fully documented, so reproducing it yourself against permissive repos is legal and gives you a compilation you own.

---

### The five verdicts

**1. Difficulty scoring — PRIOR ONLY.**
Source: the 1,699 OpenAI annotations, optionally distilled by prompting a local model (SWE-smith's MIT recipe shows how; their released `SWE-Rater-32B` has 21 downloads, no card and no licence — reproduce rather than depend on it). Feature vectors can come free from `R2E-Gym-V1` (Apache-2.0), which already ships `num_non_test_files`, `num_non_test_func_methods`, `num_non_test_lines`, `modified_files`, `relevant_files` — the exact feature set, just with no label.
**Specific risk of the prior being wrong:** the labels are human *time-to-fix* estimates on **Python**, and **46 % of SWE-bench Verified is django alone**. A prior fitted there encodes "django-ness" and "Python-ness". Your `cardClass` key is extension-based (`task:ts:fix`), so a Python-trained prior does not even land in the right class bucket without an explicit bridge. Difficulty in TypeScript is driven by type-level and build-graph effects (TS4023, project references, declaration emit) that have no Python analogue and are entirely absent from the label set. Use it to initialise the 1..10 scale, not to rank TS cards.

**2. Competence model / routing — PRIOR ONLY, and the weakest of the five.**
Volume is genuinely available: ~10^5 rows from `SWE-bench/experiments`, plus 80,036 from `nebius/SWE-agent-trajectories` and 67,074 from the OpenHands set. So the "you only have hundreds of cards" criticism is answerable *on volume*. It is not answerable on **shape**. `CompetenceEntry` needs `cardClass`, `toolArm`, `stepBudget`, `tokensUsed`, `wallClockSeconds` — public data has none of `toolArm`, `tokensUsed` or `wallClockSeconds`, and `cardClass` cannot be recovered because SPIDR kind is a planner artifact with no public analogue.
**Specific risk:** P(success) is dominated by the *agent scaffold*, not the task. The same instance set resolves at 16.7 % under SWE-agent+Llama-70B and 47.9 % under OpenHands+Qwen3-Coder — a 3× spread driven by harness and model, not difficulty. A prior fitted across scaffolds learns scaffold identity and then mis-attributes it to task features. Worse, it would poison `selectArm()`: public data has no `toolArm` dimension at all, so seeding it can only ever bias toward whichever arm happens to resemble the scaffold that generated the data. **Import the prior for the task-difficulty axis only; leave the model×arm axis to `MIN_ARM_TRIALS` and the local ledger.**

**3. Exemplar store — NOT AVAILABLE. Do not import public trajectories here.**
Your hazard instinct is correct and I can make it concrete. A SWE-agent `.traj` file (confirmed by range-reading one from `s3://swe-bench-submissions`, ~400 KB each) is:

```json
{"environment": "swe_main",
 "trajectory": [{"action": "create reproduce_issue.py",
                 "observation": "[File: /astropy__astropy/reproduce_issue.py (1 lines total)]\n1:",
                 "response": "...", "state": "...", "thought": "..."}]}
```

The `{action, observation}` shape maps *deceptively cleanly* onto `trajectoryFromTurns()`'s `` `${action} -> ${result}` `` — which is exactly the trap. The `action` strings are SWE-agent ACI commands (`create <f>`, `edit 1:1`, `open`, `search_dir`, `scroll_down`, `submit`); OpenHands uses a different set again (`str_replace_editor`, `execute_bash`). Exemplars land in the prompt's **static zone**, so a 4B model would be shown a worked example of a tool vocabulary the harness does not implement, presented as the authoritative way to work. For a small model, imitation of surface form is the dominant behaviour. This is not a weak fit — it is negative value. Additionally the `cardClass` key would be `*:py:*` and never match a `task:ts:fix` card.
`ChrisDing1105/unified-agent-trajectories` is the closest on vocabulary (harnesses `claudecode`, `codex`, `openclaw`) but is only 2,410 trajectories and its card states "No new blanket license is granted over upstream benchmark prompts, model-generated content, or referenced assets." Small *and* unlicensable.
**What would be needed instead:** exemplars in your own action vocabulary. Only local runs produce those.

**4. Playbook rules — NOT AVAILABLE.**
CodeReviewer at CC-BY-4.0 is importable and has ~150k comment→revision pairs, so something *could* be loaded. But `PlaybookRule.errorPattern` matches `TS\d{4,5}` and `lint/...` codes, and `triggerGate` is a Sekhemet gate name. CodeReviewer covers nine languages with **zero TypeScript and zero Rust**, its comments are natural-language prose with no diagnostic codes, and its label is "was commented on" rather than "was returned". The join key does not exist.
**What would be needed instead:** your own PR/review history mined with the `isResolved` / `resolvedBy` GraphQL fields (definition from arXiv 2607.21997), against TypeScript/Rust repos. Failing that, the playbook is genuinely a local-only loop — which is defensible, because a rule whose whole value is "this reviewer, on this repo, keeps returning cards for *this*" does not transfer by construction. Import CodeReviewQA (MIT, 900 rows, 22.7 MB) and c-CRAB (234 test-verified comments) as **eval sets** to check whether your induced rules fire on real returns.

**5. Proposal pre-filtering calibration — closest to SOLVED, call it PRIOR ONLY.**
`nebius/SWE-rebench-openhands-trajectories` gives 67,074 rows of (`pred_passes_gen_test` = cheap surrogate, `resolved` = expensive ground truth), CC-BY-4.0, and you only need four scalar columns. `SWE-Gym/OpenHands-Verifier-Trajectories` (5,272 `(messages, resolved)` rows) is the same idea but has **no licence and an empty README** — skip it.
**Specific risk:** "generated tests pass" is one particular cheap surrogate. If your surrogate is something else — a static score, a lint pass, a small-model judge — the calibration curve shape transfers but the intercept does not. Use it to initialise the mapping's *form* (how sharply surrogate score should gate), then let local anchor pairs move the threshold.

---

### The git-history alternative — better for some consumers, and a volume trap for others

I measured it on this repository: **203 commits, 155 of which touch both a `src/` file and a `.spec.ts`/`.test.ts` file.** That is the honest ceiling, and only a subset of those 155 would yield a genuine FAIL_TO_PASS under validation.

| | Public datasets | Local git history |
|---|---|---|
| Volume | 10^4–10^5 instances, 10^5 trajectories | **~10^2 here. 155, not 10^5.** |
| Relevance | Python/django, other harnesses, other models | Your languages, your repo, your conventions |
| Licence | Mostly clean if filtered; a few landmines | You own it outright |
| Cost | Import once, hours | SWE-rebench's own numbers: 30,000 repos → ~450k PRs → ~153k candidates → **21,336 validated**, and an install recipe succeeds for only **31 % of repositories**. Non-trivial engineering. |

**Blunt reading:** git history does **not** solve the volume criticism. If the loops truly need 10^5 trajectories, mining this repo gives you 0.15 % of that, and no amount of cleverness changes it. The criticism stands on volume.

But volume is the wrong frame for three of the five consumers:

- **Exemplars (3): git history wins outright, and it is the only option.** Every merged commit with a test is a worked example *in your action vocabulary, your language, your card classes*. 155 exemplars spread over `cardClass` buckets is thin but real; 100,000 foreign-vocabulary exemplars are worse than zero.
- **Playbook (4): git history wins.** Your own review threads and gate failures are the only place `TS4023`-shaped rules exist.
- **Competence (2): git history wins on shape, loses on volume.** It is the only source of `toolArm` and `tokensUsed`. Keep `MIN_ARM_TRIALS` honest and accept that routing stays uncertain for a long time — the Wilson intervals in `capability.ts` are the correct response to that, not a prior fitted on frontier-model data.
- **Difficulty (1) and calibration (5): public data wins.** These need labels and anchor pairs that a 155-commit history simply cannot supply at any useful resolution.

A middle path worth more than either: SWE-rebench V2's pipeline is **language-agnostic and open-sourced** (CC-BY-4.0, 20 languages, 32,079 tasks). Pointing it at ~50 permissively-licensed TypeScript and Rust repos you already depend on gets 10^3–10^4 instances in *your* languages, under a licence you control, without the Python/django skew. That dominates both the 155-commit ceiling and the foreign-language public sets — at the cost of real build-environment engineering, which is where 69 % of repos fail.

---

### Do NOT import

| Dataset | Reason |
|---|---|
| Any agent trajectory into the **exemplar store** | Foreign tool vocabulary in the prompt's static zone. Actively harmful to a 4B model. Applies to SWE-agent, OpenHands, SWE-smith, Moatless — all of them. |
| `ChrisDing1105/unified-agent-trajectories` | Card: "No new blanket license is granted over upstream benchmark prompts, model-generated content, or referenced assets." Only 2,410 rows. Licence murk for no volume. |
| `ronantakizawa/github-codereview` | `license: other`, `license_name`/`license_link` both absent = no grant of rights. Painful, because its shape and its TS+Rust coverage are exactly right. Reproduce the pipeline instead. |
| CodeReviewSE / any Stack Exchange dump | **CC-BY-SA — share-alike, disqualifying.** The `CarperAI/CodeReviewSE` scraper has no LICENSE file at all. And there is no outcome signal: Code Review SE has no subsequent revision. Fails on both counts. |
| `SWE-Gym/OpenHands-Verifier-Trajectories`, `OpenHands-Sampled-Trajectories`, `MoatlessTools-Sampled-Trajectories` | `license: None`, empty READMEs. Moatless alone is 5.52 GB. No licence, no import. |
| `Toucan-1.5M` | Apache-2.0 and clean, but 21.8 GB and it is MCP tool-calling QA with LLM-judge quality scores — **no ground-truth pass/fail**. Serves none of your five consumers. |
| `AlienKevin/SWE-ZERO-12M-trajectories` (36 GB), `nvidia/SWE-Zero-openhands-trajectories` (12.2 GB) | Non-starters on a 24 GB M4 with limited disk, and they only duplicate signal you get from the 1.11 GB Nebius set. |
| `princeton-nlp/SWE-bench` **patch text**, if it is ever persisted into the repo | No licence declared on the HF card, and **`pylint-dev/pylint` is GPL-2.0** — 57 instances in the test split, 10 in Verified. Patch text from those is a GPL derivative work. The pass/fail booleans are fine; the diffs are not. |
| Anything requiring a live service at runtime | The Transluce Docent dashboards linked from recent `experiments` submissions (`trajs_docent`) are a web UI, not a bulk export. Import-once at best; they break air-gapped operation. |

Two small corrections to assumptions worth recording: the `s3://swe-bench-submissions` bucket **is** publicly readable (anonymous/unsigned boto3, per `analysis/download_logs.py`; a direct object GET returned HTTP 200) even though a plain REST bucket listing returns 403 — so those trajectories are retrievable, they are just not something you want. And `SWE-bench/experiments` holds *entries, not artifacts*: the `results/` JSON is there, the logs and trajectories are not.

**Sources:** [SWE-bench/experiments](https://github.com/SWE-bench/experiments) · [SWE-bench Verified (OpenAI)](https://openai.com/index/introducing-swe-bench-verified/) · [nebius/SWE-rebench-V2](https://huggingface.co/datasets/nebius/SWE-rebench-V2) · [nebius/SWE-agent-trajectories](https://huggingface.co/datasets/nebius/SWE-agent-trajectories) · [nebius/SWE-rebench-openhands-trajectories](https://huggingface.co/datasets/nebius/SWE-rebench-openhands-trajectories) · [SWE-rebench paper](https://arxiv.org/abs/2505.20411) · [SWE-rebench V2 paper](https://arxiv.org/abs/2602.23866) · [SWE-bench/SWE-smith](https://huggingface.co/datasets/SWE-bench/SWE-smith) · [SWE-Gym](https://huggingface.co/datasets/SWE-Gym/SWE-Gym) · [R2E-Gym](https://github.com/R2E-Gym/R2E-Gym) · [Multi-SWE-bench](https://huggingface.co/datasets/ByteDance-Seed/Multi-SWE-bench) · [Toucan-1.5M](https://huggingface.co/datasets/Agent-Ark/Toucan-1.5M) · [Zenodo 6900648 (CodeReviewer)](https://zenodo.org/record/6900648) · [CROP / Zenodo 3599150](https://zenodo.org/records/3599150) · [arXiv 2502.02757](https://arxiv.org/abs/2502.02757) · [arXiv 2607.21997](https://arxiv.org/html/2607.21997v1)

## Survey 2: code-review datasets for playbook rules

Research complete. Here is the report.

---

### Public code-review datasets for "playbook rules from reviewer-return reasons"

### 1. Microsoft CodeReviewer (Li et al., arXiv 2203.09095)

- **Licence: CC-BY-4.0.** Zenodo record `10.5281/zenodo.6900648` licence field reads verbatim `"Creative Commons Attribution 4.0 International"`. **Not NC, not SA — commercially importable with attribution.**
  - Caveat worth knowing: `huggingface.co/microsoft/codereviewer` frontmatter says `license: apache-2.0`, but that card is the **model**, not the dataset. Several papers (incl. CRScore++) wrongly cite Apache-2.0 for the data. The authoritative dataset licence is the Zenodo CC-BY-4.0.
- **Size:** Zenodo archives total **4.8 GB zipped** — `Diff_Quality_Estimation.zip` 2.8 GB, `Code_Refinement.zip` 1.2 GB, `Comment_Generation.zip` 846.6 MB, `CodeReviewer.zip` 803 kB. **Streamable alternative:** the community mirror `fasterinnerlooper/codereviewer` on HF is auto-converted to Parquet with 9 named configs (train/validation/test × generation/quality/refinement, 317,216 rows, 25.2 GB total). You can stream **only** the refinement config and never touch the 2.8 GB quality dump. Fits the 24 GB M4 easily if you stream.
- **Format** (verified by reading `microsoft/CodeBERT@master:CodeReviewer/code/utils.py`, not guessed):
  - **cls / msg tasks** — JSONL, one object per line, parsed at `read_review_examples()`: `oldf` (whole old file), `patch` (the diff hunk), `msg` (review comment, `""` if none), `cmtid`, `y` (label), plus `proj` and `lang` in the HF schema. The label rule is literally `if "msg" in js and len(js["msg"]) > 0: js["y"] = 1` — i.e. **y = "did a human leave a comment on this hunk"**, nothing more.
  - **ref task** — JSONL with `old`, `new`, `comment` (`RefineDataset.tokenize`: source = `old` + `<msg>` + `comment`, target = `new`).
- **Languages:** nine — C, C++, C#, Go, Java, JavaScript, PHP, Python, Ruby. **No TypeScript. No Rust.**
- **Outcome signal:** **Partial, and this is the single most important nuance in the whole survey.** The `ref` split *is* `(old code, reviewer comment) → actually-revised code`. That is genuinely "reviewer objected, here is what changed after". What it does **not** have: any signal that the revision was *accepted*, any reviewer approve/request-changes verdict, any thread-resolution flag, and any record of revisions that were rejected again. `y` in the cls split is "was commented on", not "was returned".
- **Verdict: import it — it is the only large, cleanly-licensed, outcome-adjacent corpus.** Use the `ref` split, stream the Parquet mirror. Expect to derive rules from *comment → delta* pairs, not from reviewer-return verdicts.

### 2. CodeReviewSE (Code Review Stack Exchange)

- **Licence: CC-BY-SA 4.0 — SHARE-ALIKE. Disqualifying.** Stack Exchange network content is CC BY-SA (2.5/3.0/4.0 by era, current posts 4.0). The scraper repo `CarperAI/CodeReviewSE` has **no LICENSE file at all** (`gh api repos/CarperAI/CodeReviewSE` → `"license": null`) and its entire README is a link to a Google Doc — so there is not even a permissive wrapper claim to lean on. Derived HF copies (`VatsaDev/code-review`, `mlfoundations-dev/stackexchange_codereview`) inherit the SA obligation regardless of what tag they carry.
- **Outcome signal: none.** Stack Exchange Code Review is *ask-for-review-on-a-snippet*; there is no subsequent revision, no merge, no resolution. Q&A pairs only.
- **Verdict: do not touch.** Share-alike *and* no outcome signal. Fails both tests independently.

### 3. CRScore / CRScore++

- **Licence:** code repo `atharva-naik/CRScore` is **MIT** (verified LICENSE file). But **there is no new dataset** — the README instructs you to download `Comment_Generation.zip` from the *same* Zenodo 6900648 record. CRScore++ (arXiv 2506.00296) likewise trains on 20,888 Python CodeReviewer instances and **announces no data release**.
- **Size/format/languages:** inherits CodeReviewer. CRScore++ eval = Python (train), Java + JavaScript (eval); 101 human-rated examples.
- **Outcome signal: none.** These are *metrics* for scoring review-comment quality (conciseness/comprehensiveness/relevance) against code claims and smells. There is no post-review revision linkage.
- **Verdict: not a data source.** The MIT-licensed *scoring code* is mildly interesting as a way to filter noise out of comments before rule induction, but it contributes zero outcome data.

### 4. Tomo-Melb/CodeReviewQA

- **Licence: MIT** (HF API `cardData.license = "mit"`). Clean.
- **Size: 22.7 MB** (`usedStorage` 22,740,981 bytes), single file `CodeReviewQA.jsonl`. Trivially streamable; no download concern.
- **Format:** 900 records (100 per language). Fields: `old`, `new`, `review`, `lang`, plus MCQ scaffolding — `type_correct`/`type_wrong` (change-type recognition), `loc_correct`/`loc_wrong_easy`/`loc_wrong_hard` (localisation), `solution_correct`/`solution_wrong_easy`/`solution_wrong_hard`.
- **Languages:** C, C++, C#, Go, Java, JavaScript, PHP, Python, Ruby. **No TypeScript, no Rust.**
- **Outcome signal: yes but tiny.** `old → review → new` is a real reviewer-driven revision from closed PRs, hand-curated. 900 rows is an eval set, not a training corpus.
- **Verdict: import as a *test* set only.** It is the cleanest-licensed, highest-quality `(code, why-returned, what-changed)` triple available, and it is manually verified. Use it to score whether your induced playbook rules actually fire on real returns. Do not try to learn from 900 rows.

### 5. "Too Noisy To Learn" (arXiv 2502.02757, Liu/Lin/Thongtanunam, U. Melbourne)

- **No dataset located.** Both the arXiv abstract page and the PDF yield no data-availability statement, no Zenodo/figshare/GitHub replication URL. The paper's contribution is an LLM-based cleaning *method* (66–85% precision detecting valid comments) applied to the existing CodeReviewer corpus.
- **Verdict: not importable — there is nothing to import.** Its value to you is methodological: it is direct published evidence that CodeReviewer's comments are substantially noisy (vague, non-actionable), which is exactly the failure mode that would poison naive playbook-rule induction. Read the method, apply your own filter.

### 6. Outcome-linked PR-review datasets (the ones that actually answer your question)

### 6a. c-CRAB — Code Review Agent Benchmark (arXiv 2603.23448)
- **Licence: CC BY 4.0** per the paper. Flag: the GitHub repo `c-CRAB-Benchmark/dataset` has **no LICENSE file** (`license: null`), so the only licence evidence is the paper text. Worth an email before commercial import.
- **Size: ~17.9 MB** repo. No download problem.
- **Format:** 184 PR instances / 234 validated review comments / 67 repos. Per record: PR + patch, NL review comment, **executable test cases derived from the review**, repo context + execution environment, test category (behavioural/structural).
- **Languages:** Python-dominant, language-agnostic pipeline. No TS/Rust in practice.
- **Outcome signal: the strongest of any dataset here, and it is *verified*, not inferred.** Each review comment is converted into a test that **fails on the original patch and passes once the issue is resolved**. That is a machine-checkable "the reviewer was right and here is proof the fix landed".
- **Verdict: import.** 234 comments is small, but every one is a gold-standard `(return reason → verifiable resolution)` pair. This is the best seed material for high-precision playbook rules.

### 6b. CR-Bench / CR-Bench-Verified (arXiv 2603.11078)
- **Licence: CC BY 4.0** per paper. Hosting URL not stated in the paper HTML — you will have to chase the authors.
- **Size:** 584 instances (CR-Bench), 174 (Verified). Built on SWE-Bench repos (django, sympy, astropy, scikit-learn).
- **Format:** PR + commits + diff + metadata; review comment; **patch that resolves the comment**; taxonomy tags `category` / `impact` / `severity`.
- **Languages:** Python only.
- **Outcome signal: yes — comment paired with its resolving patch**, plus a severity/impact taxonomy that is *directly* playbook-shaped. But the paper does not clarify whether the resolution is the true historical revision or a reconstructed one.
- **Verdict: worth importing if you can locate the artifact.** The severity/impact/category taxonomy is the closest thing published to a pre-built playbook ontology. Python-only is a real limit.

### 6c. SWE-PRBench (arXiv 2603.26130)
- **Licence: CC BY 4.0** (HF card). Harness `FoundryHQ-AI/swe-prbench` is **MIT**. Both clean.
- **Size: 41.4 MB**, 450 rows total (`prs` 350, `eval_split` 100, `train` 100). Parquet, streamable. No download concern.
- **Format:** `task_id`, `repo`, `pr_number`, `language`, `pr_type`, `difficulty`, `merged_at`, `base_commit`, `head_commit`, `lines_added/removed`, `files_changed`, `changed_files`, `rvs_score` + `rvs_breakdown`, `num_substantive_comments`, `num_unique_reviewers`, **`has_requested_changes` (bool)**, `ai_comments_removed`, `human_review_comments` (list of objects: author, body, path, line, diff hunk, **reply status**), `diff_patch`.
- **Languages: Python 69.1%, JavaScript 10.6%, Go 10.0%, TypeScript 6.0%, Java 4.3%.** **This is the only cleanly-licensed dataset in the survey with an explicit TypeScript slice** — but 6% of 350 PRs is ~21 PRs. Token amount. No Rust.
- **Outcome signal: yes, and it is closest to your literal phrasing.** `has_requested_changes` is precisely "the reviewer returned the card". All PRs are **merged**, so the trajectory is `returned → revised → accepted`. `human_review_comments[].reply status` gives per-comment engagement.
- **Verdict: import.** Small, but the `has_requested_changes` + merged-outcome combination is the exact semantics you asked for, and it is CC-BY-4.0.

### 6d. "Go Home Copilot, You're Drunk" (arXiv 2607.21997)
- **Licence: CC BY 4.0.** Replication package on figshare (`articles/conference_contribution/Replication_Package/32673702`).
- **Size:** 54,713 comments across 341 repos. Package size not stated; comment-metadata scale implies well under 1 GB.
- **Format:** per inline comment — author identity, originating agent, comment body, **resolution status, and subsequent developer replies**.
- **Outcome signal: yes, and it is the *cleanest definition* in the literature.** Verbatim from the paper: a comment is resolved when "a project collaborator explicitly marks the review thread as resolved on GitHub, as indicated by the `isResolved` field in the GitHub API response, along with the identity of the resolver captured in the `resolvedBy` field."
- **Catch:** the comments are **agent-generated** (Copilot/Cursor/Codex), not human-reviewer-authored, and **Python repositories exclusively**.
- **Verdict: import for the *schema and the resolution definition*, not the content.** It gives you the exact GraphQL fields (`isResolved`, `resolvedBy`) to mine your own outcome-linked corpus, which is probably the real answer to your problem.

### 6e. CROP — Code Review Open Platform (Zenodo 3599150, MSR'18)
- **Licence: CC-BY-4.0** (Zenodo API `metadata.license.id = "cc-by-4.0"`, plus a LICENSE file in the record). Clean.
- **Size: 3.66 GB total** — `git_repos.zip` 3.53 GB, `discussion.zip` 117 MB, `metadata.zip` 14 MB. **You can download only `metadata.zip` + `discussion.zip` = 131 MB** and skip the repo dump entirely. Excellent for the M4.
- **Format:** 50,959 reviews / 144,906 **revisions** / ~507k comments. Metadata per revision: revision ID, review number, **revision number**, author, **status**, change ID, and **commit IDs for the before and after code versions**. Discussion files carry the comments with author attribution.
- **Languages:** Eclipse (Java: egit, jgit, linuxtools, platform.ui) + Couchbase (JavaScript, Python, C++, Go, Java). No TS, no Rust. Data is from 2018 — dated.
- **Outcome signal: yes, and structurally the richest.** Gerrit's multi-revision model means you get `revision N → review comments → revision N+1 → ... → final status (merged/abandoned)`. That is literally "reviewer returned the card, here is why, here is what changed, here is whether it eventually landed" — with the *full return loop*, including cards that were returned repeatedly and cards that were abandoned.
- **Verdict: import the metadata + discussion archives.** Best structural fit to your framing; worst language fit and oldest data.

### 7. Additional find: `ronantakizawa/github-codereview` (HF)

Worth calling out because it is the only dataset with real TypeScript *and* Rust coverage — and it is legally unusable.

- **Licence: `license: other` with `license_name` and `license_link` both absent.** That is a declared-but-undefined licence, which in practice means **no grant of rights**. The card asserts source repos are "MIT, Apache-2.0, BSD, or similar", but the compilation itself carries no usable terms. **Disqualifying until the author publishes actual terms.**
- **Size: 2.58 GB** (HF `usedStorage`), all Parquet, fully streamable. Card cites 653 MB for the current revision. Fine for the M4 either way.
- **Format:** 355,807 rows (167K+ positive triplets, 51K+ negatives). Fields: `pr_title`, `pr_number`, `repo_name`, `repo_stars`, `repo_language`, `author_username`, `reviewer_username`, `before_code`, `reviewer_comment`, `after_code`, `diff_context`, `file_path`, `comment_line`, `language`, `quality_score`, `comment_type`, `comment_length`, `before_lines`, `after_lines`, `is_negative`.
- **Languages: 37, explicitly including TypeScript and Rust.**
- **Outcome signal: yes, by construction.** Build pipeline verbatim: "Only keep triplets where the code chunk around the comment actually changed", plus negatives built by "identify source code files that were changed but received no review comments". Bots and AI reviewers excluded.
- **Verdict: perfect shape, unusable licence.** This is the dataset you actually want — `before_code` / `reviewer_comment` / `after_code` / `comment_type` / TS + Rust / verified-changed filter / explicit negatives. **Do not import it.** Instead: ask the author to relicense, or **reproduce the pipeline yourself** — it is fully described, the source repos are permissively licensed by construction, and you control the licence of your own compilation.

### 8. Explicitly checked, nothing there

No TypeScript-specific and **no Rust-specific** code-review dataset exists. The Java/Python skew is near-total: CodeReviewer (9 langs, no TS/Rust), CodeReviewQA (same 9), CR-Bench (Python), c-CRAB (Python), "Go Home Copilot" (Python), CROP (Java/JS/Py/C++/Go). The entire published TS footprint is SWE-PRBench's ~21 PRs. Rust appears only inside `ronantakizawa`'s unusable-licence corpus. Searches for Rust review datasets surface only code-comment-inconsistency work (RustC++), which is a different problem.

---

### Licence summary

| Dataset | Licence | NC? | SA? | Importable |
|---|---|---|---|---|
| CodeReviewer (Zenodo 6900648) | CC-BY-4.0 | No | No | **Yes** |
| CodeReviewSE / StackExchange | CC-BY-SA 4.0 | No | **Yes** | **No** |
| CRScore (code) | MIT | No | No | Yes (no data) |
| CRScore++ | — | — | — | No data released |
| CodeReviewQA | MIT | No | No | **Yes** |
| Too Noisy To Learn | — | — | — | No data released |
| c-CRAB | CC-BY-4.0 (paper; no LICENSE in repo) | No | No | Yes, verify |
| CR-Bench | CC-BY-4.0 (paper; no host URL) | No | No | Yes, chase artifact |
| SWE-PRBench | CC-BY-4.0 / MIT harness | No | No | **Yes** |
| Go Home Copilot | CC-BY-4.0 | No | No | **Yes** |
| CROP (Zenodo 3599150) | CC-BY-4.0 | No | No | **Yes** |
| ronantakizawa/github-codereview | `other`, undefined | ? | ? | **No** |

---

### Blunt answer

**Partially, and not in the form you want.** There is no public dataset that gives you the full object — reviewer returns a change, states a reason, the author revises, and the reviewer explicitly accepts the revision — at anything close to training scale with a commercial-friendly licence. What exists splits into two useless-alone halves: **large corpora with comment→revision pairs but no verdict** (CodeReviewer's `ref` split, ~150K rows, CC-BY-4.0, the only thing with real volume — but its `y` label is merely "someone commented", its comments are documented by arXiv 2502.02757 to be substantially vague and non-actionable, and it has zero TypeScript and zero Rust), and **tiny, high-precision sets with genuine verified outcomes** (c-CRAB's 234 test-verified comments, SWE-PRBench's 350 merged PRs carrying `has_requested_changes`, CROP's 144K Gerrit revisions with per-revision status, "Go Home Copilot"'s `isResolved`/`resolvedBy` — hundreds of rows each, almost all Python, all CC-BY-4.0). The one dataset genuinely shaped like your requirement — `ronantakizawa/github-codereview`, with `before_code`/`reviewer_comment`/`after_code`, an explicit "only keep triplets where the code actually changed" filter, negative examples, and real TypeScript and Rust coverage — is published under an undefined `license: other`, which means you cannot lawfully import it. My recommendation: **treat public data as seed and eval, not as the training corpus.** Import CodeReviewer `ref` (streamed Parquet) for volume, CodeReviewQA + c-CRAB + SWE-PRBench as gold eval sets, and CROP metadata for the multi-revision return-loop structure. Then build your own TypeScript/Rust corpus by reproducing the `ronantakizawa` pipeline against permissively-licensed repos, using the `isResolved`/`resolvedBy` GraphQL definition from arXiv 2607.21997 as the outcome label — that combination is fully documented, legally clean since you own the compilation, and is the only route to the language coverage Sekhemet actually needs.

**Sources:** [Zenodo 6900648](https://zenodo.org/record/6900648) · [microsoft/CodeBERT CodeReviewer](https://github.com/microsoft/CodeBERT/tree/master/CodeReviewer) · [arXiv 2203.09095](https://arxiv.org/abs/2203.09095) · [Stack Overflow data licensing](https://stackoverflow.co/data-licensing/) · [CarperAI/CodeReviewSE](https://github.com/CarperAI/CodeReviewSE) · [atharva-naik/CRScore](https://github.com/atharva-naik/CRScore) · [arXiv 2506.00296 (CRScore++)](https://arxiv.org/html/2506.00296) · [Tomo-Melb/CodeReviewQA](https://huggingface.co/datasets/Tomo-Melb/CodeReviewQA) · [arXiv 2502.02757](https://arxiv.org/abs/2502.02757) · [arXiv 2603.23448 (c-CRAB)](https://arxiv.org/html/2603.23448) · [arXiv 2603.11078 (CR-Bench)](https://arxiv.org/html/2603.11078v1) · [arXiv 2603.26130 / foundry-ai/swe-prbench](https://huggingface.co/datasets/foundry-ai/swe-prbench) · [arXiv 2607.21997](https://arxiv.org/html/2607.21997v1) · [arXiv 2510.05450](https://arxiv.org/html/2510.05450v1) · [CROP](https://crop-repo.github.io/) / [Zenodo 3599150](https://zenodo.org/records/3599150) · [OussamaSghaier/CuREV](https://github.com/OussamaSghaier/CuREV) · [ronantakizawa/github-codereview](https://huggingface.co/datasets/ronantakizawa/github-codereview) · [fasterinnerlooper/codereviewer](https://huggingface.co/datasets/fasterinnerlooper/codereviewer)
