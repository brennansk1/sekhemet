#!/usr/bin/env node
// Verify the Reviewer's seeded defects (review-git RG-P8-13; measurement
// rule 29, the asset `reviewer-seeded-defects`) by execution, and register
// the verified set in fixtures/eval_assets.json.
//
//   node scripts/verify_seeded_defects.mjs [--fixtures onyx,vanguard] [--record] [--keep] [--verbose]
//
// Each fixture is copied into a fresh git repository and its board seeded as
// scripts/run_suite.mjs does; the cards run in board order, each staged
// (acceptance/<test> copied to tests/<test>) and its reference solution
// applied on top of its predecessors', as verify_reference_solutions.mjs
// does. Before a card's reference solution is applied, each defect seeded
// into it (fixtures/seeded_defects/defects.json) is checked:
//   - the seeded solution passes the card's checks: its frozen tests,
//     `tsc -b` and `biome check .` (a gate-passing defect);
//   - its witness test (fixtures/seeded_defects/<witness>) fails on the
//     seeded solution and passes on the reference solution (it is a defect);
//   - the words it `violates` appear in the card's spec or criteria.
// The seeded set is data beside the frozen suite: nothing under fixtures/
// that suite.json names is written, so the suite's hash never changes.
//
// With --record, and only when every defect verifies, the records are
// written to fixtures/seeded_defects/items.json with each item's executed
// label, and the directory is registered through packages/eval's asset API.
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HERE = join(ROOT, "fixtures", "seeded_defects");
const REFERENCE = join(ROOT, "fixtures", "reference_solutions");
const ASSET = "reviewer-seeded-defects";
const ASSET_PATH = "fixtures/seeded_defects";
const PROVENANCE =
  "seeded by an agent (claude-opus-5-5) into the verified reference solutions; each defect executed against its card's frozen tests and its witness test";

const { prepare, vitest, run } = await import(join(ROOT, "scripts", "lib", "fixture_verify.mjs"));
const { registerAsset, seededCards, validateAssetLabels } = await import(
  join(ROOT, "packages/eval/dist/index.js")
);
const { formatJson } = await import(join(ROOT, "scripts", "lib", "fixture_verify.mjs"));

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const flag = (name) => process.argv.includes(`--${name}`);

/** The reference with the defect's edits applied; each find occurs exactly once. */
function applyEdits(reference, edits) {
  let text = reference;
  for (const e of edits) {
    const at = text.indexOf(e.find);
    if (at < 0 || text.indexOf(e.find, at + 1) >= 0)
      throw new Error(`edit text not found exactly once: ${e.find.slice(0, 60)}`);
    text = text.slice(0, at) + e.replace + text.slice(at + e.find.length);
  }
  return text;
}

const defects = JSON.parse(readFileSync(join(HERE, "defects.json"), "utf8"));
const suite = JSON.parse(readFileSync(join(ROOT, "fixtures", "suite.json"), "utf8"));
const only = arg("fixtures")?.split(",");
const fixtures = suite.fixtures.filter(
  (f) => (!only || only.includes(f.name)) && defects.some((d) => d.fixture === f.name),
);

const items = [];
const failed = [];
const outcome = (r) => ({ exitCode: r.exitCode, passed: r.passed, total: r.total });

for (const { name: fixture, tasks } of fixtures) {
  const { dir, git } = prepare(fixture, "seeded");
  const cardsJson = JSON.parse(readFileSync(join(ROOT, "fixtures", fixture, "cards.json"), "utf8"));
  try {
    for (const { id, info } of seededCards(dir, tasks)) {
      mkdirSync(join(dir, "tests"), { recursive: true });
      for (const t of info.tests) copyFileSync(join(dir, "acceptance", t), join(dir, "tests", t));
      const testFiles = info.tests.map((t) => `tests/${t}`);
      const solutionDir = join(REFERENCE, fixture, id);
      const card = cardsJson.find((c) => c.id === id);
      const cardText = `${card?.spec ?? ""}\n${(card?.acceptanceCriteria ?? []).join("\n")}`;
      // Every earlier card's reference solution is committed; the card's
      // other scope files take their reference solution too.
      for (const f of info.scope) {
        try {
          mkdirSync(dirname(join(dir, f)), { recursive: true });
          copyFileSync(join(solutionDir, f), join(dir, f));
        } catch {
          // A scope file the reference solution does not write stays as seeded.
        }
      }
      for (const d of defects.filter((x) => x.fixture === fixture && x.card === id)) {
        const problem = (why) => {
          failed.push({ id: d.id, why });
          console.log(`  FAIL ${d.id}: ${why}`);
        };
        if (!info.scope.includes(d.file)) {
          problem(`${d.file} is outside the card's scope`);
          continue;
        }
        if (!cardText.includes(d.violates)) {
          problem("the words it violates are not in the card's spec or criteria");
          continue;
        }
        const reference = readFileSync(join(solutionDir, d.file), "utf8");
        let seeded;
        try {
          seeded = applyEdits(reference, d.edits);
        } catch (err) {
          problem(err.message);
          continue;
        }
        writeFileSync(join(dir, d.file), seeded);
        const frozen = vitest(dir, testFiles);
        const typecheck = run(dir, "tsc", ["-b"]);
        const lint = run(dir, "biome", ["check", "."]);
        const witnessAt = join(dir, "tests", "seeded_witness.spec.ts");
        copyFileSync(join(HERE, d.witness), witnessAt);
        const onDefect = vitest(dir, ["tests/seeded_witness.spec.ts"]);
        writeFileSync(join(dir, d.file), reference);
        const onReference = vitest(dir, ["tests/seeded_witness.spec.ts"]);
        rmSync(witnessAt, { force: true });
        const checksPass =
          frozen.exitCode === 0 && frozen.total > 0 && typecheck.status === 0 && lint.status === 0;
        const witnessFails =
          onDefect.exitCode !== 0 && onDefect.total > 0 && onDefect.passed < onDefect.total;
        const witnessPasses =
          onReference.exitCode === 0 &&
          onReference.total > 0 &&
          onReference.passed === onReference.total;
        const why = [
          frozen.exitCode !== 0 || frozen.total === 0
            ? `the frozen tests fail on it (${frozen.passed}/${frozen.total}): the checks catch it`
            : "",
          typecheck.status !== 0 ? "tsc -b fails on it" : "",
          lint.status !== 0 ? "biome check fails on it" : "",
          witnessFails
            ? ""
            : `its witness does not fail on it (${onDefect.passed}/${onDefect.total})`,
          witnessPasses
            ? ""
            : `its witness fails on the reference solution (${onReference.passed}/${onReference.total})`,
        ].filter(Boolean);
        if (why.length) {
          problem(why.join("; "));
          if (flag("verbose")) {
            console.log(frozen.output.slice(-3000));
            console.log(typecheck.output.slice(-2000));
            console.log(lint.output.slice(-2000));
            console.log(onDefect.output.slice(-2000));
            console.log(onReference.output.slice(-2000));
          }
          continue;
        }
        items.push({
          ...d,
          verification: {
            appliedOn:
              "the fixture seeded as scripts/run_suite.mjs seeds it, with every earlier card's reference solution committed",
            frozenTests: { command: `vitest run ${testFiles.join(" ")}`, ...outcome(frozen) },
            typecheck: { command: "tsc -b", exitCode: typecheck.status },
            lint: { command: "biome check .", exitCode: lint.status },
            witnessOnDefect: outcome(onDefect),
            witnessOnReference: outcome(onReference),
          },
          labelledBy: { principal: "frozen tests", kind: "executed", passedFrozenTests: true },
        });
        console.log(
          `  pass ${d.id}: checks pass (${frozen.passed}/${frozen.total}); witness ${onDefect.passed}/${onDefect.total} on the defect, ${onReference.passed}/${onReference.total} on the reference`,
        );
      }
      git("add", "-A");
      git("commit", "-q", "-m", `reference: ${id}`);
    }
  } finally {
    if (flag("keep")) console.log(`  kept ${dir}`);
    else rmSync(dir, { recursive: true, force: true });
    rmSync(`${dir}.vitest-report.json`, { force: true });
  }
}

console.log(JSON.stringify({ verified: items.length, of: defects.length, failed }, null, 2));

if (flag("record")) {
  if (only) {
    console.error("--record needs every fixture: the asset is the whole set");
    process.exit(2);
  }
  if (failed.length || items.length !== defects.length) {
    console.error(
      `not recorded: ${items.length} of ${defects.length} defects verify${failed.length ? `; failing: ${failed.map((f) => f.id).join(", ")}` : ""}`,
    );
    process.exit(1);
  }
  const labels = validateAssetLabels(items);
  if (labels.length) {
    console.error(`not recorded: ${labels.join("; ")}`);
    process.exit(1);
  }
  // In the defects' own order, so the items read as the definitions do.
  const ordered = defects.map((d) => items.find((i) => i.id === d.id));
  writeFileSync(join(HERE, "items.json"), `${JSON.stringify(ordered, null, 2)}\n`);
  formatJson(join(HERE, "items.json"));
  const { entry, changed } = registerAsset(ROOT, {
    name: ASSET,
    path: ASSET_PATH,
    labelledBy:
      "frozen tests (each defect passes its card's frozen tests, typecheck and lint, and fails a witness test that passes on the reference solution)",
    provenance: PROVENANCE,
  });
  formatJson(join(ROOT, "fixtures", "eval_assets.json"));
  console.log(
    `registered ${ASSET} (${changed}): ${items.length} items, hash ${entry.hash.slice(0, 12)}`,
  );
}
if (failed.length) process.exitCode = 1;
