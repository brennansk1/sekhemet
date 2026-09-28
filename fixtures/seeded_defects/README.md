# The Reviewer's seeded defects

The evaluation asset `reviewer-seeded-defects` (measurement rule 29; review-git
RG-P8-13). Each item is a defect seeded into one frozen-suite issue's
verified reference solution that **still passes that issue's checks** — its
frozen acceptance tests, `tsc -b` and `biome check .` — and so reaches Review
in the product. The measure is how many of them the AI review finds before a
person would.

The set sits beside the frozen suite, never in it: `fixtures/suite.json` does
not name this directory, and no fixture or reference solution is edited, so
the suite's hash is unchanged.

## What an item is

`defects.json` holds the definitions, one per defect:

- `fixture`, `card`, `file`: the issue and the one file of its scope;
- `edits`: find-and-replace steps applied to the reference solution in
  `fixtures/reference_solutions/<fixture>/<card>/<file>`; each `find` occurs
  exactly once;
- `violates`: the words of the issue's spec or criteria the defect breaks,
  verbatim;
- `defect`: what is wrong, in one sentence, for the person reading a result;
- `witness`: a test in `witness/` that fails on the seeded solution and passes
  on the reference solution.

The defect's description and its witness are never shown to the Review model.

## How the labels are made

Every label is executed, never a model's (MS-T11-4).
`scripts/verify_seeded_defects.mjs` seeds each fixture as
`scripts/run_suite.mjs` does and, issue by issue in board order, checks each
defect:

1. the seeded solution passes the issue's frozen tests, the typecheck and the
   lint;
2. the witness fails on the seeded solution and passes on the reference
   solution;
3. the `violates` words appear in the issue's spec or criteria.

With `--record`, and only when every defect verifies, it writes `items.json`
(the definitions with their verification and label) and registers the
directory through the asset API. A changed item is a new version; the earlier
hash is kept.

```sh
pnpm exec tsc -b packages/eval
node scripts/verify_seeded_defects.mjs --record
```

## How it is scored

`sekhemet measure reviewer [--model <id>]` reviews each item on the Review
model, as the product builds the review's input, and scores it
(`apps/harness/src/learning/review_eval.ts`):

- **caught**: a finding the model judged `unmet`, at a line the harness
  checked, within 3 lines of a line the defect changed;
- **false positive**: any other `unmet` finding the model made on that issue;
  `unclear` findings claim no defect, and the harness's own fidelity check is
  not the model's.

RG-P8-13 is met when recall is at least 0.3 and no issue has more than one
false positive, counted on each issue, not averaged.
