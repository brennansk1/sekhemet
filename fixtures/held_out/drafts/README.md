# Held-out acceptance suite — DRAFTS

The acceptance checks the Planner, Seshat and the Worker never see
(measurement T11, MS-T7-8: the premature-completion rate). One per golden
brief (`kind: "brief"`, observable checks a person runs on the final build,
each naming the implicit requirement it covers) and one per frozen-suite
fixture (`kind: "fixture"`, an executable vitest file).

Each fixture draft is proved: it fails on the fixture as seeded and passes on
the final main the registered reference solutions build. The proof is
`proof.json`, written by `node scripts/verify_held_out.mjs --record`; rerun it
after changing a draft.

**Held out means held out (MS-T11-3):** nothing that builds a prompt reads this
directory, and the suite runner copies only `fixtures/<fixture>/` into a run.
A test (`apps/harness/tests/held_out_isolation.spec.ts`) checks that no prompt
path or copy module names it. Do not move these files into a fixture.

**These are drafts, drafted on the lead's side under DEC-42, and they are not
registered.** Nothing is scored against them until a person confirms them.

## How a person confirms and registers them

1. Read each item. For the brief checks, confirm each is what you would test
   before calling that project done. For the fixture tests, read the test
   against the fixture's specification, then rerun
   `node scripts/verify_held_out.mjs --record`.
2. On each item you keep, set `labelledBy` to
   `{ "principal": "person: <your name>", "kind": "person" }` and delete
   `status`.
3. Move the confirmed files (items.json, the `.spec.ts` files, proof.json) to
   `fixtures/held_out/` and delete this `drafts/` directory.
4. Register it:

   ```sh
   pnpm exec tsc -p packages/eval
   node --input-type=module -e '
     const { registerAsset } = await import("./packages/eval/dist/index.js");
     console.log(registerAsset(process.cwd(), {
       name: "held-out-acceptance-suite",
       path: "fixtures/held_out",
       labelledBy: "person: <your name>",
       heldOut: "from the Planner, Seshat and the Worker",
     }));'
   ```
