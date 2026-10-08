#!/usr/bin/env node
// The user guide's generated parts (FINISH_LINE_PLAN W3 G1–G2; surface
// SUR-20, SUR-65; security SEC-N11-1; extensibility item 25a). Each is a
// block between `<!-- generated:<name>:start -->` and
// `<!-- generated:<name>:end -->` in its page; the text around it is written
// by hand. The blocks come from the product's own tables, read from the
// built packages (run `pnpm build` first):
//
//   cli-reference        the front door (`PRIMARY_COMMANDS`) and every
//                        command's help row (`help_table.ts`, the registry)
//   troubleshooting      `doctor`'s check catalogue (`DOCTOR_CHECKS`)
//   privacy-and-network  the network policy's host catalogue
//   editors              the editor snippets `sekhemet editors` prints
//   readme-commands      the README's command table (`PRIMARY_COMMANDS`)
//
//   node scripts/gen_docs.mjs            rewrite every block
//   node scripts/gen_docs.mjs --check    exit 1 naming each block that differs
//
// apps/harness/tests/docs_generated.spec.ts runs `--check`, so a command,
// a check, a host or a snippet added without regenerating fails the build.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function load(root, rel) {
  const path = join(root, rel);
  if (!existsSync(path)) throw new Error(`${rel} is not built: run \`pnpm build\` first`);
  return import(pathToFileURL(path).href);
}

/** A synopsis's alternatives, one per line. */
const forms = (synopsis) => synopsis.split(/\s{2,}\|\s{2,}/).map((s) => s.trim());
/** A table cell: pipes escaped, no line breaks. */
const cell = (s) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
/**
 * Prose as markdown shows it: `<` and `>` outside code spans become entities,
 * or a renderer takes `<issue>` for a tag and hides it.
 */
export const prose = (s) =>
  s
    .split(/(`[^`]*`)/)
    .map((part, i) => (i % 2 ? part : part.replace(/</g, "&lt;").replace(/>/g, "&gt;")))
    .join("");
const sentence = (s) => {
  const t = s.trim();
  const first = t.charAt(0).toUpperCase() + t.slice(1);
  return /[.!?]$/.test(first) ? first : `${first}.`;
};

function frontDoorTable(primary) {
  return [
    "| Command | What it does |",
    "| --- | --- |",
    ...primary.map((c) => `| \`${cell(c.usage)}\` | ${prose(cell(c.what))} |`),
  ];
}

function cliReference(primary, rows, registry, globalOptions) {
  const byName = new Map(registry.map((c) => [c.name, c]));
  const out = [
    "## The front door",
    "",
    "`sekhemet --help` lists these.",
    "",
    ...frontDoorTable(primary),
    "",
    "## Every command",
    "",
    `Each runs as \`sekhemet <command>\`, and as \`sekhemet dev <command>\`. Every command also takes ${Object.keys(
      globalOptions,
    )
      .filter((f) => f !== "set")
      .map((f) => `\`--${f}\``)
      .join(", ")}.`,
    "",
  ];
  for (const [name, row] of rows) {
    const spec = byName.get(name);
    out.push(
      `### \`${name}\``,
      "",
      prose(sentence(row.what)),
      "",
      "```",
      ...forms(row.synopsis),
      "```",
      "",
    );
    out.push(`Example: \`${row.example}\``, "");
    if (spec) {
      const flags = Object.keys(spec.options).sort();
      if (flags.length) out.push(`Flags: ${flags.map((f) => `\`--${f}\``).join(", ")}.`, "");
    }
  }
  return out;
}

function troubleshooting(checks) {
  const out = [
    "`sekhemet doctor` runs these checks in this order. A check that does not pass prints `Do:` with its next step, and the verdict names the first one that fails. Below is each check's general next step; the line `doctor` prints may be more specific.",
    "",
  ];
  for (const c of checks) {
    out.push(`### ${c.title}`, "", `**Do:** ${prose(sentence(c.do))}`, "");
  }
  return out;
}

function privacy(catalogue, named) {
  const out = [];
  for (const e of catalogue) {
    out.push(`### ${e.title}`, "");
    out.push(`- **Hosts:** ${e.hosts.map((h) => `\`${h}\``).join(", ")}`);
    out.push(`- **When:** ${prose(e.when)}`);
    out.push(`- **What is sent:** ${prose(e.sent)}`);
    out.push(`- **Turn it off:** ${prose(e.off)}`, "");
  }
  out.push("### Named in the source, never contacted on their own", "");
  out.push("| Hosts | Why they appear |", "| --- | --- |");
  for (const n of named)
    out.push(`| ${n.hosts.map((h) => `\`${h}\``).join(", ")} | ${prose(cell(n.why))} |`);
  out.push("");
  return out;
}

function editors(snippets) {
  const out = [];
  for (const s of snippets) {
    out.push(`### ${s.name}`, "", prose(s.where), "", "```json", s.text, "```", "");
  }
  return out;
}

/** Every generated block: its page, its name and its lines. */
export async function generatedBlocks(root = ROOT) {
  const { PRIMARY_COMMANDS } = await load(root, "apps/harness/dist/cli_commands.js");
  const { COMMAND_REGISTRY, GLOBAL_OPTIONS } = await load(
    root,
    "apps/harness/dist/commands/registry.js",
  );
  const { devHelpRows } = await load(root, "apps/harness/dist/commands/help_table.js");
  const { DOCTOR_CHECKS } = await load(root, "apps/harness/dist/doctor.js");
  const { EDITOR_SNIPPETS } = await load(root, "apps/harness/dist/editor_snippets.js");
  const { HOST_CATALOGUE, NAMED_NOT_CONTACTED } = await load(
    root,
    "packages/sandbox/dist/host_catalogue.js",
  );
  // Every name with a help row: the registry's and `main`'s table, by name.
  const rows = devHelpRows(new Set());
  return [
    {
      file: "docs/guide/cli-reference.md",
      name: "cli-reference",
      lines: cliReference(PRIMARY_COMMANDS, rows, COMMAND_REGISTRY, GLOBAL_OPTIONS),
    },
    {
      file: "docs/guide/troubleshooting.md",
      name: "troubleshooting",
      lines: troubleshooting(DOCTOR_CHECKS),
    },
    {
      file: "docs/guide/privacy-and-network.md",
      name: "privacy-and-network",
      lines: privacy(HOST_CATALOGUE, NAMED_NOT_CONTACTED),
    },
    { file: "docs/guide/editors.md", name: "editors", lines: editors(EDITOR_SNIPPETS) },
    { file: "README.md", name: "readme-commands", lines: frontDoorTable(PRIMARY_COMMANDS) },
  ];
}

/** The page with the block's text replaced; throws when the page has no markers for it. */
export function withBlock(text, name, lines) {
  const start = `<!-- generated:${name}:start -->`;
  const end = `<!-- generated:${name}:end -->`;
  const a = text.indexOf(start);
  const b = text.indexOf(end);
  if (a === -1 || b === -1 || b < a) throw new Error(`no ${start} … ${end} markers`);
  return `${text.slice(0, a + start.length)}\n${lines.join("\n").trimEnd()}\n${text.slice(b)}`;
}

async function main(argv) {
  const check = argv.includes("--check");
  const drift = [];
  for (const block of await generatedBlocks()) {
    const path = join(ROOT, block.file);
    const text = readFileSync(path, "utf8");
    let next;
    try {
      next = withBlock(text, block.name, block.lines);
    } catch (err) {
      console.error(`${block.file}: ${err.message}`);
      return 2;
    }
    if (next === text) continue;
    if (check) drift.push(`${relative(ROOT, path)} (${block.name})`);
    else writeFileSync(path, next);
  }
  if (check && drift.length) {
    console.error(
      `Generated docs differ from the product's tables: ${drift.join(", ")}. Run \`node scripts/gen_docs.mjs\`.`,
    );
    return 1;
  }
  console.log(check ? "Generated docs match the product's tables." : "Generated docs written.");
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
