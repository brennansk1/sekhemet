#!/usr/bin/env node
// Prove the held-out acceptance drafts for the frozen-suite fixtures
// (measurement T11, MS-T7-8): each fails on the fixture as seeded, and
// passes on the final main that the registered reference solutions build —
// every card's solution applied, in board order.
//
//   node scripts/verify_held_out.mjs [--record]
//
// The held-out tests live under fixtures/held_out/drafts/ and are copied into
// a throwaway copy only here; no role's prompt ever sees them (MS-T11-3).
// With --record the proof is written to fixtures/held_out/drafts/proof.json.
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";

const { ROOT, formatJson, prepare, sha256, vitest } = await import(
  join(import.meta.dirname, "lib", "fixture_verify.mjs")
);
const { loadAssetManifest, seededCards } = await import(join(ROOT, "packages/eval/dist/index.js"));

// The drafts until a person confirms them, then the registered directory.
const DRAFTS = existsSync(join(ROOT, "fixtures", "held_out", "drafts"))
  ? join(ROOT, "fixtures", "held_out", "drafts")
  : join(ROOT, "fixtures", "held_out");
const suite = JSON.parse(readFileSync(join(ROOT, "fixtures", "suite.json"), "utf8"));
const references = loadAssetManifest(ROOT).assets.find((a) => a.name === "reference-solutions");
if (!references) {
  console.error("the reference solutions are not registered; nothing to prove the drafts against");
  process.exit(2);
}
const refDir = join(ROOT, references.path);

const proof = [];
const failed = [];
for (const { name: fixture, tasks } of suite.fixtures) {
  const draft = join(DRAFTS, `${fixture}.spec.ts`);
  if (!existsSync(draft)) {
    failed.push(`${fixture}: no held-out draft`);
    continue;
  }
  const { dir, git } = prepare(fixture, "heldout");
  try {
    mkdirSync(join(dir, "tests"), { recursive: true });
    copyFileSync(draft, join(dir, "tests", "held_out.spec.ts"));
    const atSeed = vitest(dir, ["tests/held_out.spec.ts"]);
    // The final main: every card's reference solution, in board order.
    for (const { id } of seededCards(dir, tasks)) {
      const sol = join(refDir, fixture, id);
      if (!existsSync(sol)) throw new Error(`${fixture}/${id}: no reference solution`);
      cpSync(sol, dir, { recursive: true });
    }
    git("add", "-A");
    git("commit", "-q", "-m", "held-out proof: every reference solution");
    const onMain = vitest(dir, ["tests/held_out.spec.ts"]);
    const summary = (r) => ({
      exitCode: r.exitCode,
      passed: r.passed,
      total: r.total,
      outputSha256: r.outputSha256,
    });
    const item = {
      fixture,
      file: relative(ROOT, draft),
      fileSha256: sha256(readFileSync(draft)),
      referenceSolutions: { version: references.version, hash: references.hash },
      atSeed: summary(atSeed),
      onReferenceMain: summary(onMain),
    };
    const why = [
      atSeed.exitCode === 0 ? "passes on the seed" : "",
      onMain.exitCode !== 0 || onMain.total === 0 || onMain.passed !== onMain.total
        ? `fails on the reference main (${onMain.passed}/${onMain.total})`
        : "",
    ].filter(Boolean);
    if (why.length) {
      failed.push(`${fixture}: ${why.join("; ")}`);
      if (process.argv.includes("--verbose")) console.log(onMain.output.slice(-4000));
    }
    proof.push(item);
    console.log(
      `${fixture}: seed ${atSeed.passed}/${atSeed.total} (exit ${atSeed.exitCode}), reference main ${onMain.passed}/${onMain.total} (exit ${onMain.exitCode})`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(`${dir}.vitest-report.json`, { force: true });
  }
}

if (failed.length) {
  console.error(`not proved: ${failed.join("; ")}`);
  process.exitCode = 1;
} else if (process.argv.includes("--record")) {
  const file = join(DRAFTS, "proof.json");
  writeFileSync(
    file,
    `${JSON.stringify({ about: "Each held-out fixture draft failed on the seed and passed on the final main the registered reference solutions build (scripts/verify_held_out.mjs).", proof }, null, 2)}\n`,
  );
  formatJson(file);
  console.log(`recorded ${proof.length} proofs in ${file}`);
}
