#!/usr/bin/env node
// The one npm package for a person (surface item 31, NEW-surface-4, SUR-41).
//
//   pnpm build && node scripts/pack_npm.mjs --out <dir> [--offline]
//
// Stages the harness with its production dependencies (the workspace
// packages copied in, a flat node_modules) and packs `sekhemet-<version>.tgz`
// with every dependency bundled, so `npm install -g <tarball>` needs no
// registry and no build step, and the bare `sekhemet` is the first run.
// Nothing is published: this writes a tarball, and a person decides where it
// goes (the owner's yes, DEC-29 O9).
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const outArg = args.indexOf("--out");
const out = resolve(
  outArg !== -1 && args[outArg + 1] ? args[outArg + 1] : join(root, "packaging", "out"),
);
const stage = join(out, "stage");

if (!existsSync(join(root, "apps", "harness", "dist", "index.js"))) {
  console.error("Build first: pnpm build");
  process.exit(1);
}
if (existsSync(stage)) {
  console.error(`${stage} exists; choose an empty --out directory`);
  process.exit(2);
}
mkdirSync(out, { recursive: true });

execFileSync(
  "pnpm",
  [
    "--filter",
    "@sekhemet/harness",
    "deploy",
    "--prod",
    "--legacy",
    "--config.node-linker=hoisted",
    ...(args.includes("--offline") ? ["--offline"] : []),
    stage,
  ],
  { cwd: root, stdio: ["ignore", "ignore", "inherit"] },
);

const pkg = JSON.parse(readFileSync(join(stage, "package.json"), "utf8"));
const dependencies = {};
for (const [name, range] of Object.entries(pkg.dependencies ?? {})) {
  dependencies[name] = String(range).startsWith("workspace:")
    ? JSON.parse(readFileSync(join(stage, "node_modules", name, "package.json"), "utf8")).version
    : range;
}
writeFileSync(
  join(stage, "package.json"),
  `${JSON.stringify(
    {
      name: "sekhemet",
      version: pkg.version,
      description: "A coding harness for professional teams, on your own machine.",
      type: "module",
      bin: { sekhemet: "./dist/index.js" },
      // Surface item 5a: node:sqlite without a flag.
      engines: { node: ">=22.13.0" },
      // DEC-54: source-available under the Functional Source License.
      license: "FSL-1.1-ALv2",
      // CHANGELOG.md: What's new reads it after an upgrade (surface SUR-68).
      files: ["dist", "data", "README.md", "LICENSE", "NOTICE", "CHANGELOG.md"],
      dependencies,
      bundleDependencies: Object.keys(dependencies),
    },
    null,
    2,
  )}\n`,
);
for (const f of ["README.md", "LICENSE", "NOTICE", "CHANGELOG.md"]) {
  if (existsSync(join(root, f))) cpSync(join(root, f), join(stage, f));
}
const tarball = execFileSync("npm", ["pack", "--silent", "--pack-destination", out], {
  cwd: stage,
  encoding: "utf8",
})
  .trim()
  .split("\n")
  .at(-1);
console.log(join(out, tarball));
