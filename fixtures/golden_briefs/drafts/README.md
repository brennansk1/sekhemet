# Golden briefs — DRAFTS

Twelve project briefs, written as a stakeholder would say them, each with the
implicit requirements a good plan must still cover (measurement T11, MS-T7-7:
implicit-requirement recall). Six are for people who do not write software
(`audience: "non-developer"`).

**These are drafts, drafted on the lead's side under DEC-42, and they are not
registered.** Nothing is scored against them until a person confirms them:
a label is a person's word, never a model's (measurement rule 29, MS-T11-4).

## How a person confirms and registers them

1. Read each brief and its `implicitRequirements`. Edit, add or remove
   requirements until the list is what *you* would expect a plan to cover.
   Remove any brief you would not stand behind.
2. On each brief you keep, set `labelledBy` to
   `{ "principal": "person: <your name>", "kind": "person" }` and delete
   `status`.
3. Move the confirmed `items.json` to `fixtures/golden_briefs/items.json` and
   delete this `drafts/` directory (the asset's hash covers its whole
   directory).
4. Register it through the asset API (it refuses a model's label, checks every
   item's label and records the hash):

   ```sh
   pnpm exec tsc -p packages/eval
   node --input-type=module -e '
     const { registerAsset } = await import("./packages/eval/dist/index.js");
     console.log(registerAsset(process.cwd(), {
       name: "golden-briefs",
       path: "fixtures/golden_briefs",
       labelledBy: "person: <your name>",
     }));'
   ```

A later change to a registered brief is a new version, never an edit in place.
