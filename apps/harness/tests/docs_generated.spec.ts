import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HOST_CATALOGUE, catalogueHosts, hostCovered } from "@sekhemet/sandbox";
import { describe, expect, it } from "vitest";
import { literals } from "../../../packages/ui/tests/copy_scan.js";
import { COMMANDS } from "../src/cli_commands.js";
import { helpFor } from "../src/commands/help_table.js";
import { COMMAND_REGISTRY, GLOBAL_OPTIONS } from "../src/commands/registry.js";
import { DOCTOR_CHECKS } from "../src/doctor.js";
import { EDITOR_SNIPPETS } from "../src/editor_snippets.js";
import { BIN, cliEnv, place } from "./support/cli_spawn.js";

// The user guide's generated pages (FINISH_LINE_PLAN W3 G1–G2): each is
// written by `scripts/gen_docs.mjs` from the product's own tables, and fails
// here when the table moved and the page did not, or when the product shows
// a person something the page leaves out.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const GUIDE = join(ROOT, "docs", "guide");
const SCRIPT = join(ROOT, "scripts", "gen_docs.mjs");
const page = (name: string) => readFileSync(join(GUIDE, name), "utf8");

/** The built command in a fresh folder and home (each removed after its test). */
const run = (args: string[]) => {
  const p = place("sek-docs-");
  const r = spawnSync(process.execPath, [BIN, ...args], {
    cwd: p.repo,
    env: cliEnv(p),
    encoding: "utf8",
    timeout: 120_000,
  });
  return { code: r.status, stdout: r.stdout, out: `${r.stdout}${r.stderr}` };
};

/** Every name `main` dispatches: `COMMANDS`, the board's decisions and `card` (as cli_help.spec). */
const NAMES = [
  ...new Set<string>([
    ...COMMANDS,
    ...COMMAND_REGISTRY.map((c) => c.name),
    "request-changes",
    "send-back",
    "park",
    "unpark",
    "reopen",
    "reject",
    "revert",
    "card",
  ]),
].sort();

describe("the generated pages match the product's tables", () => {
  it("SEC-N11-1, SUR-65: `node scripts/gen_docs.mjs --check` finds every generated block as the tables write it", () => {
    const r = spawnSync(process.execPath, [SCRIPT, "--check"], {
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(`${r.stdout}${r.stderr}`).toMatch(/Generated docs match/);
    expect(r.status).toBe(0);
  });
});

describe("the CLI reference (W3 G2)", () => {
  it("names every command main dispatches, each under its own heading with its synopsis", () => {
    const text = page("cli-reference.md");
    const missing = NAMES.filter((n) => {
      const row = helpFor(n);
      return !text.includes(`### \`${n}\``) || !row || !text.includes(row.example);
    });
    expect(missing).toEqual([]);
  });

  it("lists every command `sekhemet dev --help` and `sekhemet --help` print, through the built binary", () => {
    const text = page("cli-reference.md");
    const dev = run(["dev", "--help"]);
    expect(dev.code).toBe(0);
    // Each command's line is its usage, indented two spaces; its word is the command.
    const listed = [...dev.stdout.matchAll(/^ {2}([a-z][a-z0-9-]*)\b/gm)].map((m) => m[1] ?? "");
    expect(listed.length).toBeGreaterThan(40);
    expect(listed.filter((n) => !text.includes(`### \`${n}\``))).toEqual([]);
    const front = run(["--help"]);
    const usages = [...front.stdout.matchAll(/^ {2}(sekhemet\S*(?: \S+)*?) {2,}/gm)].map(
      (m) => m[1] ?? "",
    );
    expect(usages.length).toBe(8);
    expect(usages.filter((u) => !text.includes(`\`${u}\``))).toEqual([]);
  });
});

describe("the troubleshooting page (SUR-65)", () => {
  it("SUR-65: has an entry for every check in doctor's catalogue and every check the built `doctor --json` reports", () => {
    const text = page("troubleshooting.md");
    const headings = new Set([...text.matchAll(/^### (.+)$/gm)].map((m) => m[1] ?? ""));
    expect(DOCTOR_CHECKS.filter((c) => !headings.has(c.title)).map((c) => c.title)).toEqual([]);
    const r = run(["doctor", "--json"]);
    const result = JSON.parse(r.stdout) as { checks: { name: string }[] };
    expect(result.checks.length).toBeGreaterThan(5);
    expect(result.checks.map((c) => c.name).filter((n) => !headings.has(n))).toEqual([]);
  });
});

// ── Privacy and network (SEC-N11-1) ─────────────────────────────────────────

/** Where the product's own code lives: every package's source, the web layer, the relay. */
function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        if (!["node_modules", "dist", "tests", "fixtures"].includes(name)) walk(path);
      } else out.push(path);
    }
  };
  for (const pkg of readdirSync(join(ROOT, "packages"))) {
    for (const sub of ["src", "web", "bin"]) {
      const dir = join(ROOT, "packages", pkg, sub);
      if (statSync(dir, { throwIfNoEntry: false })?.isDirectory()) walk(dir);
    }
  }
  walk(join(ROOT, "apps", "harness", "src"));
  // The catalogue itself names every host; it is the list, not a caller.
  return out.filter((f) => !f.endsWith(join("sandbox", "src", "host_catalogue.ts")));
}

/** Reserved names (RFC 2606, RFC 6761) and addresses are no one's host. */
const RESERVED =
  /(^|\.)(example|test|invalid|local|localhost|internal)$|(^|\.)example\.(com|net|org)$|^\d+(\.\d+){3}$/;
const BARE =
  /^\.?([a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|org|io|dev|sh|app|co|rs|net|ai|gov|edu))(?:\/.*)?$/i;

/** The hosts a string names: every `http(s)://` address in it, or the string itself when it is a host. */
function hostsIn(text: string): string[] {
  const hosts = [...text.matchAll(/\bhttps?:\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)+)/gi)].map(
    (m) => m[1] ?? "",
  );
  const bare = BARE.exec(text.trim());
  if (bare?.[1]) hosts.push(bare[1]);
  return hosts.map((h) => h.toLowerCase()).filter((h) => !RESERVED.test(h));
}

/** Every host the source names in a string: TypeScript and JavaScript by their literals, other files whole. */
function hostsInSource(): Map<string, Set<string>> {
  const found = new Map<string, Set<string>>();
  for (const file of sourceFiles()) {
    const text = readFileSync(file, "utf8");
    const strings: string[] = [];
    // The literals by the copy scan's own reader, so the compiler stays
    // imported by the TypeScript adapter alone (gates IX-4).
    if (/\.(ts|js|mjs|cjs)$/.test(file)) {
      for (const l of literals(text)) strings.push(l.text);
    } else strings.push(text);
    for (const s of strings)
      for (const h of hostsIn(s)) {
        const at = found.get(h) ?? new Set<string>();
        at.add(relative(ROOT, file));
        found.set(h, at);
      }
  }
  return found;
}

describe("the Privacy and network page (SEC-N11-1)", () => {
  it("SEC-N11-1: every host the product's source names is on the page, from the network policy's host catalogue", () => {
    const text = page("privacy-and-network.md");
    const found = hostsInSource();
    // The scan reads what it should: a host each kind of caller names.
    for (const h of ["registry.npmjs.org", "huggingface.co", "api.github.com", "hooks.slack.com"])
      expect(found.has(h), h).toBe(true);
    const listed = catalogueHosts();
    const unlisted = [...found]
      .filter(([h]) => !hostCovered(h, listed))
      .map(([h, files]) => `${h} (${[...files].join(", ")})`);
    expect(unlisted).toEqual([]);
    const notOnPage = listed.filter((h) => !text.includes(`\`${h}\``));
    expect(notOnPage).toEqual([]);
  });

  it("SEC-N11-1: names, for each host it contacts, the purpose, what is sent and the setting that turns it off", () => {
    const text = page("privacy-and-network.md");
    for (const e of HOST_CATALOGUE) {
      const section = text.slice(text.indexOf(`### ${e.title}`));
      expect(section.length, e.id).toBeLessThan(text.length + 1);
      expect(section).toMatch(/\*\*When:\*\*/);
      expect(section).toMatch(/\*\*What is sent:\*\*/);
      expect(section).toMatch(/\*\*Turn it off:\*\*/);
      expect(e.off.trim().length, e.id).toBeGreaterThan(10);
    }
  });

  it("a scanner that misses a new host fails: a host named in a string is found, one in a comment is not", () => {
    expect(hostsIn("https://api.newservice.dev/v1/x")).toEqual(["api.newservice.dev"]);
    expect(hostsIn("cdn.example.com")).toEqual([]);
    expect(hostsIn("metrics.collector.io")).toEqual(["metrics.collector.io"]);
    expect(hostCovered("api.newservice.dev", catalogueHosts())).toBe(false);
  });
});

describe("the editors page (extensibility item 25a)", () => {
  it("shows each snippet exactly as the built `sekhemet editors` prints it", () => {
    const text = page("editors.md").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
    const r = run(["editors"]);
    expect(r.code).toBe(0);
    for (const s of EDITOR_SNIPPETS) {
      expect(r.stdout).toContain(s.text);
      expect(text).toContain(s.text);
      expect(text).toContain(s.where);
    }
  });
});

// ── Every command the guide names exists ────────────────────────────────────

/** Every `sekhemet <words>` in the guide's code: inline spans and fenced blocks. */
function commandLines(text: string): string[] {
  const code = [
    ...[...text.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].flatMap((m) => (m[1] ?? "").split("\n")),
    ...[...text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1] ?? ""),
  ];
  return code.flatMap((line) =>
    // `docker compose exec sekhemet sekhemet backup`: the first is the service's name.
    [...line.matchAll(/(?:^|[\s;&|(])sekhemet (?!sekhemet )([^#\n]*)/g)].map((m) =>
      (m[1] ?? "").trim(),
    ),
  );
}

/** Why a guide's command line names something the CLI does not have, or undefined. */
function unknownIn(line: string): string | undefined {
  const words = line.split(/\s+/);
  const first = words[0] ?? "";
  // `sekhemet "<spec>"`, `sekhemet` alone, `sekhemet --yes` and `sekhemet --help` are the front door.
  if (!first || first.startsWith('"') || first.startsWith("<") || first.startsWith("--")) return;
  const name = first === "dev" ? (words[1] ?? "") : first;
  if (name === "--help" || name === "<command>") return;
  if (!NAMES.includes(name)) return `${name} is no command`;
  // Every `--flag`, bracketed or not: `[--yes]`, `--folder <path>`, `--ack=1`.
  const flags = [...line.matchAll(/(?:^|[\s[(|])--([a-z][a-z0-9-]*)/g)].map((m) => m[1] ?? "");
  const spec = COMMAND_REGISTRY.find((c) => c.name === name);
  const synopsis = helpFor(name)?.synopsis ?? "";
  for (const f of flags) {
    if (f === "help" || Object.hasOwn(GLOBAL_OPTIONS, f)) continue;
    const known = spec ? Object.hasOwn(spec.options, f) : synopsis.includes(`--${f}`);
    if (!known) return `${name} takes no --${f}`;
  }
  return undefined;
}

describe("the guide names only what the CLI has", () => {
  const files = readdirSync(GUIDE)
    .filter((f) => f.endsWith(".md"))
    .map((f) => join(GUIDE, f));

  it("every `sekhemet` command and flag in the guide and the README is one the CLI dispatches", () => {
    const wrong: string[] = [];
    for (const file of [...files, join(ROOT, "README.md")])
      for (const line of commandLines(readFileSync(file, "utf8"))) {
        const why = unknownIn(line);
        if (why) wrong.push(`${relative(ROOT, file)}: sekhemet ${line} — ${why}`);
      }
    expect(wrong).toEqual([]);
    // The check itself catches a wrong one.
    expect(unknownIn("frobnicate --now")).toBeDefined();
    expect(unknownIn("uninstall --purge")).toBeDefined();
    expect(unknownIn("uninstall --dry-run")).toBeUndefined();
  });

  it("names no path of one machine", () => {
    const machine = /\/Users\/[a-z]|\/Volumes\/|[A-Z]:\\\\|\/home\/(?!node\/)[a-z]/;
    const found = files.filter((f) => machine.test(readFileSync(f, "utf8")));
    expect(found.map((f) => relative(ROOT, f))).toEqual([]);
  });

  it("says source-available, never open source, about Sekhemet", () => {
    // Saying what it is not is allowed: "not open source", "never *open source*", the FAQ's question.
    const allowed = /not open source|never \W?open source|Is Sekhemet open source\?/gi;
    const said = files.filter((f) =>
      /\bopen[- ]source\b/i.test(readFileSync(f, "utf8").replace(allowed, "")),
    );
    expect(said.map((f) => relative(ROOT, f))).toEqual([]);
  });
});
