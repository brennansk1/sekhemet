#!/usr/bin/env node
// Verify the frozen suite's reference solutions against their frozen tests
// (measurement rule 8 and 29, MS-T7-2, MS-T11-4), and register the verified
// set in fixtures/eval_assets.json.
//
//   node scripts/verify_reference_solutions.mjs [--fixtures chronicle,onyx] [--record] [--keep]
//
// Each fixture is copied into a fresh git repository and its board seeded as
// scripts/run_suite.mjs does. The cards run in board order, so a card's
// solution applies on top of its predecessors'. For each card the harness's
// staging is repeated (acceptance/<test> copied to tests/<test>); the staged
// test must fail before the solution is applied and pass after it; the
// fixture's typecheck and lint gates are run and recorded as well. A card's
// solution is the files under fixtures/reference_solutions/<fixture>/<card>/, each of which must be in the
// card's declared scope.
//
// With --record, and only when every card verifies, the records are written
// to items.json and the directory's hash is registered in
// fixtures/eval_assets.json through packages/eval's asset API. Otherwise
// nothing is registered.
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The verifier lives outside the asset it verifies, so editing it never
// changes the asset's hash (review minor 5).
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HERE = join(ROOT, "fixtures", "reference_solutions");
const ASSET = "reference-solutions";
const ASSET_PATH = "fixtures/reference_solutions";
const PROVENANCE = "written by an agent (claude-opus-5-5), verified by the frozen tests";

const { filesUnder, formatJson, prepare, sha256, vitest, run } = await import(
  join(ROOT, "scripts", "lib", "fixture_verify.mjs")
);
const { registerAsset, seededCards, validateAssetLabels } = await import(
  join(ROOT, "packages/eval/dist/index.js")
);

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const flag = (name) => process.argv.includes(`--${name}`);

const suite = JSON.parse(readFileSync(join(ROOT, "fixtures", "suite.json"), "utf8"));
const only = arg("fixtures")?.split(",");
const fixtures = suite.fixtures.filter((f) => !only || only.includes(f.name));

const items = [];
const failed = [];
const perFixture = [];

for (const { name: fixture, tasks } of fixtures) {
  const { dir, git } = prepare(fixture);
  let verified = 0;
  try {
    const cards = seededCards(dir, tasks);
    for (const { id, info } of cards) {
      const solutionDir = join(HERE, fixture, id);
      const files = filesUnder(solutionDir);
      const problem = (why) => {
        failed.push({ id: `${fixture}/${id}`, why });
        console.log(`  FAIL ${fixture}/${id}: ${why}`);
      };
      if (files.length === 0) {
        problem("no reference solution");
        continue;
      }
      const outside = files.filter((f) => !info.scope.includes(f));
      if (outside.length) {
        problem(`files outside the card's scope: ${outside.join(", ")}`);
        continue;
      }
      // The seed's own typecheck, before the card's test is staged: a
      // types-only card's failure at the seed must come from its test, not
      // from a seed that never typechecked (review minor 5).
      const typecheckWithoutTest = run(dir, "tsc", ["-b"]);
      // The harness's staging (execute.ts onWorktreeReady).
      mkdirSync(join(dir, "tests"), { recursive: true });
      for (const t of info.tests) copyFileSync(join(dir, "acceptance", t), join(dir, "tests", t));
      const testFiles = info.tests.map((t) => `tests/${t}`);
      const atSeed = vitest(dir, testFiles);
      // A types-only card's test passes at run time on an empty file (types
      // are erased), so failing at the seed is judged on the card's gates:
      // its test or the typecheck over it (MS-T7-2).
      const typecheckAtSeed = run(dir, "tsc", ["-b"]);
      for (const f of files) {
        mkdirSync(dirname(join(dir, f)), { recursive: true });
        copyFileSync(join(solutionDir, f), join(dir, f));
      }
      const onReference = vitest(dir, testFiles);
      const typecheck = run(dir, "tsc", ["-b"]);
      const lint = run(dir, "biome", ["check", "."]);
      git("add", "-A");
      git("commit", "-q", "-m", `reference: ${id}`);
      const record = {
        id: `${fixture}/${id}`,
        fixture,
        card: id,
        files: files.map((f) => ({
          path: f,
          sha256: sha256(readFileSync(join(solutionDir, f))),
        })),
        acceptanceTests: testFiles,
        provenance: PROVENANCE,
        verification: {
          command: `vitest run ${testFiles.join(" ")}`,
          appliedOn:
            "the fixture seeded as scripts/run_suite.mjs seeds it, with every earlier card's reference solution committed",
          atSeed: {
            typecheckWithoutTestExitCode: typecheckWithoutTest.status,
            typecheckExitCode: typecheckAtSeed.status,
            exitCode: atSeed.exitCode,
            passed: atSeed.passed,
            total: atSeed.total,
            outputSha256: atSeed.outputSha256,
          },
          onReference: {
            exitCode: onReference.exitCode,
            passed: onReference.passed,
            total: onReference.total,
            outputSha256: onReference.outputSha256,
          },
          typecheck: { command: "tsc -b", exitCode: typecheck.status },
          lint: { command: "biome check .", exitCode: lint.status },
        },
        labelledBy: {
          principal: "frozen tests",
          kind: "executed",
          passedFrozenTests: onReference.exitCode === 0 && onReference.total > 0,
        },
      };
      const why = [
        atSeed.exitCode === 0 && typecheckAtSeed.status === 0
          ? "the frozen test and the typecheck pass before the solution (MS-T7-2)"
          : "",
        atSeed.exitCode === 0 && typecheckWithoutTest.status !== 0
          ? "the seed does not typecheck even without the card's test, so its failure is not the test's"
          : "",
        onReference.exitCode !== 0 || onReference.total === 0
          ? `the frozen test fails on the solution (${onReference.passed}/${onReference.total})`
          : "",
        typecheck.status !== 0 ? "tsc -b fails" : "",
        lint.status !== 0 ? "biome check fails" : "",
      ].filter(Boolean);
      if (why.length) {
        problem(why.join("; "));
        if (flag("verbose")) {
          console.log(onReference.output.slice(-4000));
          console.log(typecheck.output.slice(-3000));
          console.log(lint.output.slice(-3000));
        }
        continue;
      }
      items.push(record);
      verified++;
      console.log(
        `  pass ${fixture}/${id}: ${onReference.passed}/${onReference.total} (seed ${atSeed.passed}/${atSeed.total})`,
      );
    }
    // Every staged suite together, as the regression gate runs them.
    const all = vitest(dir, []);
    console.log(
      `${fixture}: ${verified}/${tasks} verified; all staged tests together ${all.passed}/${all.total}`,
    );
    perFixture.push({ fixture, verified, tasks, allStaged: `${all.passed}/${all.total}` });
  } finally {
    if (flag("keep")) console.log(`  kept ${dir}`);
    else rmSync(dir, { recursive: true, force: true });
    rmSync(`${dir}.vitest-report.json`, { force: true });
  }
}

console.log(JSON.stringify({ perFixture, failed }, null, 2));

if (flag("record")) {
  if (only) {
    console.error("--record needs every fixture: the asset is the whole set");
    process.exit(2);
  }
  // Review minor 5: the set is registered whole or not at all.
  const total = fixtures.reduce((n, f) => n + f.tasks, 0);
  if (failed.length || items.length !== total) {
    console.error(
      `not recorded: ${items.length} of ${total} solutions verify${failed.length ? `; failing: ${failed.map((f) => f.id).join(", ")}` : ""}`,
    );
    process.exit(1);
  }
  const labels = validateAssetLabels(items);
  if (labels.length) {
    console.error(`not recorded: ${labels.join("; ")}`);
    process.exit(1);
  }
  writeFileSync(join(HERE, "items.json"), `${JSON.stringify(items, null, 2)}\n`);
  // Formatted as the repository's lint gate formats it, before hashing, so
  // the gate never changes the registered bytes.
  formatJson(join(HERE, "items.json"));
  // The asset API validates, hashes and versions the entry (packages/eval
  // registerAsset); the manifest is then formatted as the lint gate would.
  const { entry, changed } = registerAsset(ROOT, {
    name: ASSET,
    path: ASSET_PATH,
    labelledBy: "frozen tests (each solution executed against its card's frozen acceptance test)",
    provenance: PROVENANCE,
  });
  formatJson(join(ROOT, "fixtures", "eval_assets.json"));
  const hash = entry.hash;
  console.log(`registered ${ASSET} (${changed}): ${items.length} items, hash ${hash.slice(0, 12)}`);
}
if (failed.length) process.exitCode = 1;
