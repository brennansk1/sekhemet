# Seshat's scripted conversations — DRAFTS

Twenty scripted conversations for the senior-PM skill's evaluation
(planner-pm PM-P6-13 and PM-N9-4; measurement rule 29, the asset
`pm-conversations`). Each is a board (`boards.json`, or its own) and one or two
things a person says to Seshat. `sekhemet measure seshat` holds each
conversation through Seshat's own answer path — the prompt, tools and fitting
the product uses — on the configured PM model, and scores every reply with a
fixed rubric of deterministic checks (`apps/harness/src/pm/eval.ts`). No model
judges another.

**These are drafts, written on the lead's side by an agent, and they are not
registered.** Nothing is scored against them until a person has confirmed each
conversation and what it expects: a label is a person's word, never a model's
(measurement rule 29, MS-T11-4; DEC-42). Until then `sekhemet measure seshat`
refuses to run.

## The rubric

Every reply meets:

- **answer_first** — the first sentence answers; it is not a preamble ("Sure",
  "Let me…", "Great…") or a question, and it matches the conversation's
  `answer` pattern when one is given;
- **numbers_with_basis** — every sentence that states a quantity (points,
  days, hours, issues, steps, a percentage) states its basis in the same
  sentence ("13 of 21 points … with 4 days left");
- **no_invented_ids** — every issue key, goal, assumption, finding or
  evidence id it names is on the board;
- **cites_source** — it cites an issue, goal, assumption, finding or evidence
  id, or says what it is based on (not asked of a conversation with
  `cite: false`, such as starting a project on an empty board);
- **voice** — none of "I've assigned", "I've decided", "I approved", "You
  should", "Great question", "happy to help", and no exclamation mark
  (PM-N9-4);
- **proposals_reasoned** — every proposed change carries its reason
  (PM-N9-4);
- **proposals_invest** — every drafted issue passes the criterion lint and the
  proposal-time part of INVEST: a criterion a test can check, no dictated
  syntax, at most 3 files, at most 8 points (the rest of INVEST runs when a
  person applies it, PM-P1-1).

And, where the conversation's `expect` names it: **zero_questions** (a small
tool, planned at once), **brief** (a service that holds money or personal data
starts from a brief, with at most two questions), **not_at_risk** (PM-P6-7),
**sprint_bet** (at most 85% of the last three sprints' mean, with that basis;
PM-P6-8), **split_not_retry** (PM-P6-9), **failure_facts** (stop reason, step,
check, `file:line` and evidence id; PM-P6-6), **says_missing**, **mentions**,
**proposals** and **plain_words** (§2.8.9).

A conversation meets the rubric when every reply meets every item that applies.
P6 passes when at least 16 of the 20 meet it on every run.

Each conversation carries `exemplar` replies that meet every item: they prove
the scorer (`apps/harness/tests/seshat_eval.spec.ts`) and show the person
confirming what a good answer looks like. They are never shown to the model.

## How a person confirms and registers them

1. Read each conversation, its board and its `expect`. Correct anything you
   would not stand behind — a board fact, an expectation, a turn — and keep the
   set at 20.
2. On each conversation you keep, set `labelledBy` to
   `{ "principal": "person: <your name>", "kind": "person" }` and delete
   `status`.
3. Move `items.json` and `boards.json` to `fixtures/pm_conversations/` and
   delete this `drafts/` directory (the asset's hash covers its whole
   directory).
4. Register it through the asset API:

   ```sh
   pnpm exec tsc -b packages/eval
   node --input-type=module -e '
     const { registerAsset } = await import("./packages/eval/dist/index.js");
     console.log(registerAsset(process.cwd(), {
       name: "pm-conversations",
       path: "fixtures/pm_conversations",
       labelledBy: "person: <your name>",
     }));'
   ```
