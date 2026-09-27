# Research golden set — DRAFTS

Twenty-five software questions with checkable answers (design-stage DS-N2-9;
measurement rule 29, the research golden set): ten API signatures at pinned
versions, eight licences and seven release dates. Each question names the
version it is about (`pinned`) and the page a person checks the answer on
(`source`). The research golden set is what the Researcher bake-off runs
(models MD-N11-1) and what `sekhemet research-bakeoff` scores each research
pipeline on (DS-N2-9). Its first five questions are the quick benchmark's
Researcher screening set (measurement rule 30a).

**These are drafts, written on the lead's side by an agent from memory, and
they are not registered.** Nothing is scored against them until a person has
checked every answer against its source: a label is a person's word, never a
model's (measurement rule 29, MS-T11-4). Until then the bake-off refuses to
run and the Researcher's screen reads `not_measured`.

## The rubric (`gradeResearchAnswer`, `packages/eval/src/screening_sets.ts`)

Each question has one or two `parts`. A part is right when the answer's body
(the text before its References section) states the expected value and states
none of the part's `conflicts`:

- `date`: the ISO date, read in any of `2023-10-02`, `October 2, 2023`,
  `2 October 2023` (abbreviated months and ordinals too);
- `licence`: the SPDX id, read under its usual names (`Apache License 2.0`,
  `3-clause BSD`, `public domain`, …);
- `text`: the value or any `accept` form, spaces ignored; a version number
  must stand alone (`3.9` does not match `3.90`).

The grade is **1** when every part is right and the answer cites at least one
source the reference checker verified against text actually read, **½** when it
cites one and some but not all parts are right, and **0** otherwise — wrong or
unsourced (measurement MS-N5-3). A question counts as answered correctly only at 1.

## How a person confirms and registers them

1. Check each answer against its `source`, at the pinned version. Correct any
   value, `accept` form or `conflicts` entry; remove any question you would not
   stand behind and write a replacement, so the set keeps 25.
2. On each question you keep, set `labelledBy` to
   `{ "principal": "person: <your name>", "kind": "person" }` and delete
   `status`.
3. Move the confirmed `items.json` to `fixtures/research_golden/items.json` and
   delete this `drafts/` directory (the asset's hash covers its whole
   directory).
4. Register it through the asset API (it refuses a model's label, checks every
   item's label and records the hash):

   ```sh
   pnpm exec tsc -b packages/eval
   node --input-type=module -e '
     const { registerAsset } = await import("./packages/eval/dist/index.js");
     console.log(registerAsset(process.cwd(), {
       name: "research-golden-set",
       path: "fixtures/research_golden",
       labelledBy: "person: <your name>",
     }));'
   ```

A later change to a registered question is a new version, never an edit in
place.

## The screening set's cached corpus

The quick benchmark answers the first five questions over a cached offline
corpus pinned by hash, so nothing leaves the machine (measurement rule 31).
Capturing it fetches pages, which waits on a person's go-ahead: save each page
under `fixtures/research_golden/corpus/` and list it in
`corpus/index.json` as `[{ "id": "rg-01", "url": "…", "file": "rg-01.html",
"sha256": "…" }]`, at least one page per question. Until every one of the five
has a page whose hash matches, the Researcher's screen reads `not_measured`.
The corpus lies inside the asset's directory, so capture it before registering,
or register the result as the asset's next version.
