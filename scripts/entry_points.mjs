#!/usr/bin/env node
// The entry-point report: is every criterion marked built reached by a test
// through a door a person uses? (FINISH_LINE_PLAN C2d and §G 14; FINDINGS_C1
// TST-01 and SPEC-01.) Read only over the repository.
//
//   node scripts/entry_points.mjs [--root <dir>] [--no-write] [--json <file>]
//
// It prints the totals and writes docs/reference/ENTRY_POINTS.md (totals, a
// summary per spec, a table per spec, and the status conflicts and orphans).
// apps/harness/tests/entry_points.spec.ts runs it on a fixture and on this
// repository, where the unit-only, no-test, conflict and orphan counts must
// equal docs/reference/entry_points_ceiling.json and may never rise above
// that file at the merge base with main; and ENTRY_POINTS.md's totals must
// be the tree's (regenerate it with this script).
//
// THE RULES
//
// 1. Criteria. Every `- **ID** text` line in docs/design/specs/*.md; the first
//    definition of an id is the one that counts.
//
// 2. Status (specs/README.md: "status is stated, never implied"). The §4 table
//    of every spec is read row by row. An id cited in a row's Capability cell,
//    or in its Evidence before the words "Not yet", is cited by that row with
//    the row's State; an id after "Not yet", or in the Change cell (the last:
//    the change still to make), is cited as not built. A criterion
//    is BUILT when at least one row whose State begins "built" cites it.
//    Ranges are expanded: `SUR-1–6`, `SUR-1–SUR-6`, `DB-1..DB-12`, `DB-1..12`,
//    `DS-N9-19 to -22`, `SUR-83 to SUR-88`, `SEC-44 through SEC-53`, and the
//    shorthand `TEAM-18, -41`.
//      - a status conflict: built in one row and not built in another;
//      - an orphan: a criterion that no row cites, so its status is unstated.
//
// 3. Tests. Every *.spec|test.(ts|mjs|js) under apps/harness/tests and
//    packages/*/tests, parsed with the TypeScript compiler into test blocks
//    (`it`/`test`). An id links to a block when it is cited
//      - inside the block (its title or body)            — strong,
//      - in a comment at most 3 lines above it            — strong,
//      - in an enclosing `describe` (title or body)       — strong,
//      - anywhere else in the file (a file header)        — weak: every block.
//    A criterion no test cites falls back to the test files its built rows
//    name (weak). `it.skip`/`it.todo` blocks are skipped; `skipIf`/`runIf`
//    blocks, or blocks under such a `describe`, are conditional.
//
// 4. Entry kinds of a block, followed through the file's own functions and
//    the functions it imports from helper modules in the test directories:
//      strict  cli   spawns apps/harness/dist/index.js, or calls main([...])
//                    imported from src/index (with "queue": also queue);
//              http  sends HTTP over a socket to startDashboardServer, or to a
//                    spawned `serve`/`dashboard`/`night`;
//              ui    drives a Chromium page;
//              mcp   connects an MCP client over a transport.
//      lenient cli-dispatch  runWave2Command/runMeasureCommand/… argv dispatch;
//              http-route-module  a route module mounted on a test server;
//              mcp-handler   handleMcpRequest in process;
//              script        spawns a repository script, not the product.
//
// 5. The class of a built criterion, first match wins:
//      n/a                a reviewed reason (REVIEWED below), or a criterion
//                         that is a static property of the source ("…is
//                         searched", "WHEN the repository is scanned");
//      no-test            no block linked at all;
//      unit-only          every linked block is skipped;
//      entry-strict       a strong, unconditional link reaches a strict kind;
//      entry-lenient      a strong, unconditional link reaches a lenient kind;
//      unit-only          only a weak link reaches an entry kind;
//      entry-conditional  only conditional blocks reach an entry kind;
//      unit-only          otherwise.
//    A REVIEWED verdict raises a unit-only or no-test result only; it never
//    lowers what the tests show.
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// One parser for the repository (IX-4): the compiler the gates' source index
// pins, never a second copy of `typescript` imported here.
const { ts } = await import("../packages/gates/dist/index/typescript.js");

export const CLASSES = [
  "entry-strict",
  "entry-lenient",
  "entry-conditional",
  "unit-only",
  "no-test",
  "n/a",
];

/**
 * Verdicts reviewed by hand, each with its reason (C1 entry-points audit). An
 * entry verdict here is a weak link a person read and accepted.
 */
export const REVIEWED = {
  "PM-N10-1": [
    "entry-lenient",
    "pm_long_message.spec.ts posts 20,000 characters over HTTP to the dashboard (its describe is 'PM-N10', not the id)",
  ],
  "RG-S5-13": ["entry-strict", "triage_cli.spec.ts spawns `send-back` and checks the playbook"],
  "RG-S5-17": ["entry-strict", "triage_cli.spec.ts (titled K-N5-6) unparks through the CLI"],
  "PM-N9-2": [
    "entry-lenient",
    "pm_auto_apply.spec.ts lists and undoes the rule over HTTP; the apply is in process",
  ],
  "TEAM-41": ["entry-lenient", "as PM-N9-2: pm_auto_apply.spec.ts over HTTP"],
  "RG-N4-2": [
    "entry-lenient",
    "project_done.spec.ts confirms the release through runWave2Command('release', ['confirm', …])",
  ],
  "MD-N8-1a": [
    "entry-lenient",
    "qualify_template_pin.spec.ts runs qualify, then two queue loads, through the dispatcher",
  ],
  "K-S4-3": ["n/a", "a static property of the production source; a source scan is its test"],
  "SUR-47": ["n/a", "the reference-machine run of DoD §6.7, measured by hand, not a test"],
  // C2d fix round: criteria that state a property of the source or of a
  // table, and name their own test as a search or a walk of it. No door a
  // person uses shows more than the source does; each reason says why.
  "EXT-28a": [
    "n/a",
    "a property of the workspace: its packages and the kernel barrel's exports, enumerated",
  ],
  "SEC-18": [
    "n/a",
    "a property of the source: the modules importing node:child_process, enumerated",
  ],
  "RUN-91": [
    "n/a",
    "a property of the source: the sites FINDINGS REL-03 cites, searched (a source test)",
  ],
  "GT-T2-3": [
    "n/a",
    "a property of the source: one index module, and no import/export regex left (a search test)",
  ],
  "MD-N9-4": [
    "n/a",
    "a property of the source: no adapter constructed outside the scheduler (a search test)",
  ],
  "GT-T2-4": [
    "n/a",
    "the gate run over Sekhemet's own repository with every export treated as added: no command judges every export",
  ],
  "K-N4-4": [
    "n/a",
    "a property of the card column table: one added column reaches the DDL, insert and replay (a fixture-table test)",
  ],
  "MD-N2-5": [
    "n/a",
    "a property of the watchdog's action list: each action has a handler (a walk)",
  ],
  "WL-T3-9": [
    "n/a",
    "a property of the stop-reason table (a walk); each reason's run is its own criterion",
  ],
  "WL-T3-10": [
    "n/a",
    "a property of the stop-reason table (a walk); each reason's run is its own criterion",
  ],
  "WL-N11-1": ["n/a", "a property of the stop-reason table (a walk); disk_low's run is RUN-71's"],
  "WL-N12-1": [
    "n/a",
    "a property of the stop-reason table (a walk); model_unavailable's run is WL-N12-2's, through queue",
  ],
  "DB-N14-3": [
    "n/a",
    "a property of the transition law: the same transitions allowed and refused with and without the Definition of done (the test compares the law)",
  ],
  "K-N9-4": [
    "n/a",
    "a property of the source: no reader of `split` outside display and export (a search test)",
  ],
  // C2d fix round, proposed for the lead's review: a guard no door a person
  // or the product uses can reach. Each names why; a door that could reach
  // it would make the criterion testable, and a finding.
  "K-S4-9": [
    "n/a",
    "no door: no route creates a card in a late status (New issue forces backlog, run_routes.ts; the MCP create has no status); the kernel's refusal guards its own API",
  ],
  "K-N1-3": [
    "n/a",
    "no door: how many events an incremental verification hashed is internal; `sekhemet log` shows the verdict only",
  ],
  "K-N7-9": [
    "n/a",
    "no door: every `restore` starts again from the backup set, so none runs applyErasures twice on one ledger",
  ],
  "CX-M1-11": [
    "n/a",
    "no door: the runner pairs every tool call with its result in order, so no run yields an unclosed or out-of-order trajectory",
  ],
  "SEC-43": [
    "n/a",
    "a property of the CI workflow file: the containment suite on both runners, nothing skipped",
  ],
};

const STATIC_PROPERTY =
  /\b(source|repository|code ?base|production source|web layer)\b[^.]{0,60}\bis searched\b|\bWHEN the (repository|source) is (scanned|grepped)/i;

// ── Ids ─────────────────────────────────────────────────────────────────────

const ID = /\b([A-Z]{1,5}(?:-[A-Z0-9]+)*-\d+[a-z]?)\b/g;
/**
 * `SUR-1–6`, `SUR-1–SUR-6`, `DB-1..DB-12`, `DB-1..12`, and in words
 * `DS-N9-19 to -22`, `SUR-83 to SUR-88`, `SEC-44 through SEC-53` (the word
 * forms need the prefix or a hyphen, so "SEC-12 to 40 seconds" is no range).
 */
const RANGE =
  /\b([A-Z]{1,5}(?:-[A-Z0-9]+)*-)(\d+)[a-z]?(?:\s*(?:[–—]|\.\.)\s*(?:\1)?|\s+(?:to|through)\s+(?:\1|-))(\d+)\b/g;
/** `TEAM-18, -41` and `RG-N5-1 and -8`. */
const SHORTHAND = /\b([A-Z]{1,5}(?:-[A-Z0-9]+)*-)(\d+[a-z]?)((?:\s*(?:,|and|&)\s*-\d+[a-z]?)+)/g;
const CRITERION_LINE = /^\s*- \*\*([A-Z]{1,5}(?:-[A-Z0-9]+)*-\d+[a-z]?)\*\*\s+(.*)$/;

/** Each known id cited in `text`, with the offset of its citation. */
export function citations(text, known) {
  const out = [];
  const add = (id, at) => {
    if (known.has(id)) out.push({ id, at });
  };
  for (const m of text.matchAll(ID)) add(m[1], m.index);
  for (const m of text.matchAll(RANGE)) {
    const [from, to] = [Number(m[2]), Number(m[3])];
    if (to > from && to - from < 40) for (let i = from; i <= to; i++) add(m[1] + i, m.index);
  }
  for (const m of text.matchAll(SHORTHAND)) {
    for (const n of m[3].matchAll(/-(\d+[a-z]?)/g)) add(m[1] + n[1], m.index);
  }
  return out;
}

const idsIn = (text, known) => new Set(citations(text, known).map((c) => c.id));

// ── 1. Criteria and 2. status ───────────────────────────────────────────────

function specFiles(root) {
  const dir = join(root, "docs/design/specs");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md") && f !== "README.md")
    .sort()
    .map((f) => ({ name: f, lines: readFileSync(join(dir, f), "utf8").split("\n") }));
}

function readCriteria(specs) {
  const criteria = new Map();
  for (const { name, lines } of specs) {
    lines.forEach((line, i) => {
      const m = line.match(CRITERION_LINE);
      if (m && !criteria.has(m[1])) {
        criteria.set(m[1], { id: m[1], spec: name, line: i + 1, text: m[2] });
      }
    });
  }
  return criteria;
}

/** Every §4 row's citations: id → [{ spec, line, state, built, tests }]. */
function readStateRows(specs, known) {
  const rows = new Map();
  const cite = (id, row) => {
    if (!rows.has(id)) rows.set(id, []);
    rows.get(id).push(row);
  };
  for (const { name, lines } of specs) {
    let inState = false;
    lines.forEach((line, i) => {
      if (/^## 4\./.test(line)) inState = true;
      else if (/^## /.test(line)) inState = false;
      if (
        !inState ||
        !line.startsWith("|") ||
        /^\|\s*-/.test(line) ||
        /^\|\s*Capability/.test(line)
      )
        return;
      const cells = line.split(/(?<!\\)\|/).map((c) => c.trim());
      const [capability, state] = [cells[1] ?? "", cells[2] ?? ""];
      // | Capability | State | Evidence | Change |: an unescaped pipe inside
      // the evidence splits it into more cells, but the Change cell is always
      // the last, and an id there is the change still to make, not built.
      const change = cells.length > 5 ? (cells[cells.length - 2] ?? "") : "";
      const evidence = cells.slice(3, cells.length > 5 ? -2 : undefined).join(" | ");
      const notYet = evidence.search(/\bNot yet\b|\bnot yet built\b/);
      const builtPart = notYet >= 0 ? evidence.slice(0, notYet) : evidence;
      const notYetPart = `${notYet >= 0 ? evidence.slice(notYet) : ""} ${change}`;
      const built = /^built/i.test(state);
      const tests = [
        ...new Set(
          [...builtPart.matchAll(/([A-Za-z0-9_./-]+\.spec\.ts)/g)].map((m) => basename(m[1])),
        ),
      ];
      for (const id of idsIn(`${builtPart} ${capability}`, known)) {
        cite(id, { spec: name, line: i + 1, capability, state, built, tests });
      }
      for (const id of idsIn(notYetPart, known)) {
        cite(id, {
          spec: name,
          line: i + 1,
          capability,
          state: `${state} (Not yet)`,
          built: false,
          tests: [],
        });
      }
    });
  }
  return rows;
}

// ── 3. Tests and 4. entry kinds ─────────────────────────────────────────────

const STRICT_KINDS = new Set(["cli", "queue", "http", "ui", "mcp"]);

const SIGNS = {
  cliSpawn:
    /\b(spawn|spawnSync|execFile|execFileSync|execa|fork)\(\s*(process\.execPath|["']node["'])\s*,\s*\[[^\]]*\b(BIN|CLI|cli|HARNESS_BIN)\b/,
  cliDist: /apps\/harness\/dist\/index\.js|"apps", "harness", "dist", "index\.js"/,
  scriptSpawn:
    /\b(spawn|spawnSync|execFile|execFileSync|fork)\(\s*(process\.execPath|["']node["'])\s*,\s*\[[^\]]*\b(SCRIPT|SCRIPT_PATH|VAULT_CLI)\b/,
  mainCall: /\bmain\(\s*\[/,
  mainImport: /import\s*\{[^}]*\bmain\b[^}]*\}\s*from\s*["'][^"']*src\/index(\.js)?["']/,
  dispatch: /\brun(Wave2|Measure|Research|ResearchBakeoff)Command\(\s*["'`\w]/,
  socket:
    /\bfetch\(|\bhttp\.(get|request)\(|\b(request|httpRequest|get)\(\s*(\{|[`"']http)|\bcreateConnection\(|\bconnect\(\s*\{?\s*(port|server\.port)|\bpageWriteHeaders\(/,
  page: /\bpage\.(goto|click|locator|getByRole|fill|keyboard|evaluate|waitFor)|\bchromium\.launch/,
  mcpClient: /\bClient\(|callTool\(|listTools\(|InMemoryTransport|StdioClientTransport/,
  dashboardServer: /\bstartDashboardServer\(|\.handle\(\s*req\b/,
  serveSpawn: /["'](serve|dashboard|night)["']/,
  mcpServer: /\bcreateMcpServer\(|\brunMcpStdioServer\(/,
};

/** The entry kinds `text` (a test block or function body) reaches, inside `file`. */
function entryKinds(text, file, helpers) {
  const k = new Set();
  if (SIGNS.cliSpawn.test(text) || SIGNS.cliDist.test(text)) k.add("cli");
  if (SIGNS.mainCall.test(text) && SIGNS.mainImport.test(file)) k.add("cli");
  if (SIGNS.scriptSpawn.test(text)) k.add("script");
  if (/\brunMcpStdioServer\(/.test(text)) k.add("mcp");
  if (/\bcreateMcpServer\(/.test(text) && /\.connect\(/.test(text)) k.add("mcp");
  if (SIGNS.mcpClient.test(text) && SIGNS.mcpServer.test(file)) k.add("mcp");
  if (/\bhandleMcpRequest\(/.test(text)) k.add("mcp-handler");
  if (SIGNS.dispatch.test(text)) k.add("cli-dispatch");
  if (SIGNS.page.test(text)) k.add("ui");
  const servesHttp =
    SIGNS.dashboardServer.test(file) ||
    (k.has("cli") && SIGNS.serveSpawn.test(text)) ||
    (SIGNS.serveSpawn.test(file) && /spawn/.test(file));
  if (SIGNS.socket.test(text) && servesHttp) {
    // A route module mounted on the test's own server is not the dashboard.
    const routeModule = !/startDashboardServer\(/.test(file) && /\.handle\(\s*req\b/.test(file);
    k.add(routeModule ? "http-route-module" : "http");
  }
  for (const [name, kinds] of helpers) {
    if (new RegExp(`\\b${name}\\(`).test(text)) for (const x of kinds) k.add(x);
  }
  if (k.has("cli") && /["']queue["']/.test(text)) k.add("queue");
  return k;
}

function walkTests(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === "dist") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walkTests(p, acc);
    else if (/\.(ts|mts|mjs|js)$/.test(e.name)) acc.push(p);
  }
  return acc;
}

function testDirs(root) {
  const pkgs = join(root, "packages");
  const dirs = [join(root, "apps/harness/tests")];
  if (existsSync(pkgs)) for (const p of readdirSync(pkgs).sort()) dirs.push(join(pkgs, p, "tests"));
  return dirs.filter((d) => existsSync(d));
}

const isSpec = (f) => /\.(spec|test)\.(ts|mjs|js)$/.test(f);

function parse(file, text) {
  const kind = /\.[mc]?js$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
}

/** The bodies of a file's named functions (declarations and `const f = () => …`). */
function functionBodies(sf) {
  const bodies = new Map();
  const visit = (node) => {
    if (ts.isFunctionDeclaration(node) && node.name && node.body) {
      bodies.set(node.name.text, node.body.getText(sf));
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    ) {
      bodies.set(node.name.text, node.initializer.getText(sf));
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return bodies;
}

/** The entry kinds of each function in `bodies`, followed transitively (three passes). */
function helperKinds(bodies, fileText, imported) {
  let kinds = new Map(imported);
  for (let pass = 0; pass < 3; pass++) {
    const next = new Map(imported);
    for (const [name, body] of bodies) {
      const k = entryKinds(body, fileText, kinds);
      if (k.size) next.set(name, k);
    }
    kinds = next;
  }
  return kinds;
}

/** The helper functions a file imports from helper modules: local name → kinds. */
function importedHelpers(sf, file, helperModules) {
  const out = new Map();
  for (const s of sf.statements) {
    if (!ts.isImportDeclaration(s) || !ts.isStringLiteral(s.moduleSpecifier)) continue;
    const spec = s.moduleSpecifier.text;
    if (!spec.startsWith(".")) continue;
    const target = resolve(dirname(file), spec).replace(/\.js$/, "");
    const mod = helperModules.get(target);
    const named = s.importClause?.namedBindings;
    if (!mod || !named || !ts.isNamedImports(named)) continue;
    for (const el of named.elements) {
      const kinds = mod.get((el.propertyName ?? el.name).text);
      if (kinds) out.set(el.name.text, kinds);
    }
  }
  return out;
}

/** Test blocks with their entry kinds, and each id's linked blocks. */
function readTests(root, known) {
  const files = testDirs(root).flatMap((d) => walkTests(d));
  // Helper modules first: their exported functions' kinds, by path without extension.
  const helperModules = new Map();
  for (const file of files.filter((f) => !isSpec(f))) {
    const text = readFileSync(file, "utf8");
    const sf = parse(file, text);
    helperModules.set(
      file.replace(/\.[mc]?[jt]s$/, ""),
      helperKinds(functionBodies(sf), text, new Map()),
    );
  }
  const blocksByFile = new Map();
  const links = new Map(); // id → Map(blockKey → link)
  const STRENGTH = { "in-test": 0, "comment-above": 1, describe: 2, file: 3 };
  for (const file of files.filter(isSpec).sort()) {
    const text = readFileSync(file, "utf8");
    const rel = relative(root, file);
    const sf = parse(file, text);
    const helpers = helperKinds(functionBodies(sf), text, importedHelpers(sf, file, helperModules));
    const { tests, describes } = testBlocks(sf);
    const blocks = tests.map((t) => {
      const body = text.slice(t.start, t.end);
      const outer = t.describeStack.map((i) => describes[i]).find((d) => d.skip);
      return {
        file: rel,
        title: t.title,
        line: t.line,
        start: t.start,
        end: t.end,
        describeStack: t.describeStack,
        skip: t.skip || outer?.skip || "",
        kinds: [...entryKinds(body, text, helpers)],
      };
    });
    blocksByFile.set(rel, blocks);
    for (const { id, at } of citations(text, known)) {
      let targets = blocks.filter((b) => at >= b.start && at < b.end);
      let how = "in-test";
      if (!targets.length) {
        const next = blocks.filter((b) => b.start > at).sort((a, b) => a.start - b.start)[0];
        const inner = describes
          .filter((d) => at >= d.start && at < d.end)
          .sort((a, b) => a.end - a.start - (b.end - b.start))[0];
        if (next && text.slice(at, next.start).split("\n").length <= 4) {
          [targets, how] = [[next], "comment-above"];
        } else if (inner) {
          [targets, how] = [
            blocks.filter((b) => b.describeStack.includes(inner.index)),
            "describe",
          ];
        } else {
          [targets, how] = [blocks, "file"];
        }
      }
      if (!links.has(id)) links.set(id, new Map());
      const byBlock = links.get(id);
      for (const b of targets) {
        const key = `${b.file}:${b.line}`;
        const prev = byBlock.get(key);
        if (!prev || STRENGTH[how] < STRENGTH[prev.how]) byBlock.set(key, { block: b, how });
      }
    }
  }
  return { files: files.filter(isSpec).length, blocksByFile, links };
}

/** `it`/`test` blocks and `describe` blocks, with skip state and nesting. */
function testBlocks(sf) {
  const tests = [];
  const describes = [];
  const callee = (e) => {
    if (ts.isIdentifier(e)) return e.text;
    if (ts.isPropertyAccessExpression(e)) return `${callee(e.expression)}.${e.name.text}`;
    if (ts.isCallExpression(e)) return `${callee(e.expression)}()`;
    return "";
  };
  const skipOf = (name) =>
    /\.(skip|todo)\b/.test(name) ? "skip" : /skipIf|runIf/.test(name) ? "conditional" : "";
  const visit = (node, stack) => {
    if (ts.isCallExpression(node)) {
      const name = callee(node.expression);
      const base = name.split(".")[0].replace("()", "");
      const arg = node.arguments[0];
      const title =
        arg && (ts.isStringLiteralLike(arg) || ts.isTemplateExpression(arg))
          ? arg.getText(sf).slice(1, -1)
          : "";
      const start = node.getStart(sf);
      if ((base === "it" || base === "test") && arg) {
        const line = sf.getLineAndCharacterOfPosition(start).line + 1;
        tests.push({
          title,
          start,
          end: node.getEnd(),
          line,
          skip: skipOf(name),
          describeStack: stack,
        });
        return;
      }
      if (base === "describe" && arg) {
        const d = { start, end: node.getEnd(), skip: skipOf(name), index: describes.length };
        describes.push(d);
        ts.forEachChild(node, (c) => visit(c, [...stack, d.index]));
        return;
      }
    }
    ts.forEachChild(node, (c) => visit(c, stack));
  };
  visit(sf, []);
  return { tests, describes };
}

// ── 5. Classification ───────────────────────────────────────────────────────

const STRONG = new Set(["in-test", "comment-above", "describe"]);

/** The class of one built criterion from its linked blocks (rule 5). */
export function classOf(criterion, linked) {
  const review = REVIEWED[criterion.id];
  if (review?.[0] === "n/a") return { cls: "n/a", reason: review[1] };
  if (STATIC_PROPERTY.test(criterion.text)) {
    return { cls: "n/a", reason: "a static property of the source; a scan is its test" };
  }
  const found = classFromTests(linked);
  if (review && (found === "unit-only" || found === "no-test")) {
    return { cls: review[0], reason: `reviewed: ${review[1]}` };
  }
  return { cls: found, reason: "" };
}

function classFromTests(linked) {
  if (!linked.length) return "no-test";
  const live = linked.filter((l) => l.block.skip !== "skip");
  if (!live.length) return "unit-only";
  const reaches = live.filter((l) => l.block.kinds.length);
  const unconditional = reaches.filter((l) => !l.block.skip);
  const strong = unconditional.filter((l) => STRONG.has(l.how));
  if (strong.some((l) => l.block.kinds.some((k) => STRICT_KINDS.has(k)))) return "entry-strict";
  if (strong.length) return "entry-lenient";
  if (unconditional.length) return "unit-only"; // only a weak link reaches an entry
  if (reaches.length) return "entry-conditional";
  return "unit-only";
}

// ── The report ──────────────────────────────────────────────────────────────

/** The whole report for the repository at `root`. */
export function analyze(root) {
  const specs = specFiles(root);
  const criteria = readCriteria(specs);
  const known = new Set(criteria.keys());
  const rows = readStateRows(specs, known);
  const tests = readTests(root, known);
  const built = [];
  const conflicts = [];
  for (const c of criteria.values()) {
    const cited = rows.get(c.id) ?? [];
    const builtRows = cited.filter((r) => r.built);
    if (!builtRows.length) continue;
    const notBuilt = cited.filter((r) => !r.built);
    if (notBuilt.length) {
      conflicts.push({
        id: c.id,
        built: builtRows.map((r) => `${r.spec}:${r.line}`),
        notBuilt: notBuilt.map((r) => `${r.spec}:${r.line} (${r.state})`),
      });
    }
    let linked = [...(tests.links.get(c.id)?.values() ?? [])];
    const citedByTest = linked.length > 0;
    if (!citedByTest) {
      const named = new Set(builtRows.flatMap((r) => r.tests));
      linked = [...tests.blocksByFile]
        .filter(([rel]) => named.has(basename(rel)))
        .flatMap(([, bs]) => bs.map((block) => ({ block, how: "row-named-file" })));
    }
    const { cls, reason } = classOf(c, linked);
    const order = { "in-test": 0, "comment-above": 1, describe: 2, file: 3, "row-named-file": 4 };
    const best = [...linked].sort(
      (a, b) =>
        order[a.how] - order[b.how] ||
        Number(b.block.kinds.length > 0) - Number(a.block.kinds.length > 0),
    );
    built.push({
      id: c.id,
      spec: c.spec,
      line: c.line,
      text: c.text,
      class: cls,
      reason,
      citedByTest,
      builtRow: `${builtRows[0].spec}:${builtRows[0].line}`,
      tests: best
        .slice(0, 3)
        .map(
          (l) =>
            `${l.block.file}:${l.block.line} [${l.block.kinds.join(",") || "unit"}${l.block.skip ? `; ${l.block.skip}` : ""}] ${l.how}`,
        ),
    });
  }
  const totals = Object.fromEntries(
    CLASSES.map((k) => [k, built.filter((b) => b.class === k).length]),
  );
  const bySpec = {};
  for (const s of specs) {
    const xs = built.filter((b) => b.spec === s.name);
    bySpec[s.name] = Object.fromEntries([
      ["built", xs.length],
      ...CLASSES.map((k) => [k, xs.filter((b) => b.class === k).length]),
    ]);
  }
  // Every criterion, built or not, by the strongest door the tests that cite
  // it reach (rule 5 without a row's named files; a reviewed entry verdict
  // raises it as in the report): the unhappy-path matrix's "covered" (TST-03)
  // is entry-strict or entry-lenient.
  const tested = Object.fromEntries(
    [...criteria.keys()].map((id) => {
      const found = classFromTests([...(tests.links.get(id)?.values() ?? [])]);
      const review = REVIEWED[id];
      const raise = review && review[0] !== "n/a" && (found === "unit-only" || found === "no-test");
      return [id, raise ? review[0] : found];
    }),
  );
  const orphans = [...criteria.values()]
    .filter((c) => !rows.has(c.id))
    .map((c) => ({ id: c.id, spec: c.spec }));
  return {
    criteria: criteria.size,
    builtCount: built.length,
    testFiles: tests.files,
    totals,
    bySpec,
    built,
    conflicts,
    orphans,
    builtUncited: built.filter((b) => !b.citedByTest && b.class !== "n/a").map((b) => b.id),
    tested,
  };
}

const cell = (s) => String(s).replace(/\|/g, "\\|").replace(/\s+/g, " ");

/** docs/reference/ENTRY_POINTS.md. */
export function renderMarkdown(r) {
  const L = [];
  L.push("# Entry points: is every built criterion reached through a door a person uses?");
  L.push("");
  L.push(
    "Generated by `node scripts/entry_points.mjs`; do not edit by hand. The rules are in the script's header. " +
      "`apps/harness/tests/entry_points.spec.ts` fails when these totals are not the tree's, when the unit-only, no-test, " +
      "conflict or orphan count differs from `entry_points_ceiling.json`, or when that file rises above its value at the " +
      "merge base with main (FINISH_LINE_PLAN C2d, §G 14; FINDINGS_C1 TST-01, SPEC-01).",
  );
  L.push("");
  L.push("## Totals");
  L.push("");
  L.push(`${r.criteria} criteria; ${r.builtCount} marked built; ${r.testFiles} test files read.`);
  L.push("");
  L.push("| Class | Built criteria |");
  L.push("| --- | --- |");
  for (const k of CLASSES) L.push(`| ${k} | ${r.totals[k]} |`);
  L.push("");
  L.push("## By spec");
  L.push("");
  L.push(`| Spec | Built | ${CLASSES.join(" | ")} |`);
  L.push(`| --- | --- | ${CLASSES.map(() => "---").join(" | ")} |`);
  for (const [spec, t] of Object.entries(r.bySpec)) {
    L.push(`| ${spec} | ${t.built} | ${CLASSES.map((k) => t[k]).join(" | ")} |`);
  }
  L.push("");
  L.push("## Status truth (SPEC-01)");
  L.push("");
  L.push(
    `${r.conflicts.length} criteria are built in one §4 row and not built in another; ` +
      `${r.orphans.length} criteria are cited by no §4 row; ` +
      `${r.builtUncited.length} built criteria are cited by no test (only a file their row names).`,
  );
  L.push("");
  if (r.conflicts.length) {
    L.push("| Criterion | Built at | Not built at |");
    L.push("| --- | --- | --- |");
    for (const c of r.conflicts)
      L.push(`| ${c.id} | ${c.built.join(", ")} | ${cell(c.notBuilt.join("; "))} |`);
    L.push("");
  }
  const orphansBySpec = {};
  for (const o of r.orphans) {
    orphansBySpec[o.spec] = [...(orphansBySpec[o.spec] ?? []), o.id];
  }
  for (const [spec, ids] of Object.entries(orphansBySpec)) {
    L.push(`- **${spec}**, cited by no row (${ids.length}): ${ids.join(", ")}`);
  }
  if (r.builtUncited.length) L.push(`- **Built, cited by no test:** ${r.builtUncited.join(", ")}`);
  L.push("");
  for (const spec of Object.keys(r.bySpec)) {
    const xs = r.built.filter((b) => b.spec === spec);
    if (!xs.length) continue;
    L.push(`## ${spec}`);
    L.push("");
    L.push("| Criterion | Class | Best test, or the reason |");
    L.push("| --- | --- | --- |");
    for (const b of xs) {
      const evidence = b.reason || b.tests[0] || "—";
      L.push(`| ${b.id} | ${b.class}${b.citedByTest ? "" : " (uncited)"} | ${cell(evidence)} |`);
    }
    L.push("");
  }
  return L.join("\n");
}

function main(argv) {
  const arg = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const root = resolve(arg("--root") ?? join(dirname(fileURLToPath(import.meta.url)), ".."));
  const r = analyze(root);
  console.log(`${r.criteria} criteria, ${r.builtCount} built, ${r.testFiles} test files`);
  for (const k of CLASSES) console.log(`  ${k.padEnd(18)} ${r.totals[k]}`);
  console.log(
    `  conflicts ${r.conflicts.length}, orphans ${r.orphans.length}, built but uncited ${r.builtUncited.length}`,
  );
  if (!argv.includes("--no-write")) {
    const out = join(root, "docs/reference/ENTRY_POINTS.md");
    writeFileSync(out, `${renderMarkdown(r)}\n`);
    console.log(`wrote ${relative(process.cwd(), out)}`);
  }
  const json = arg("--json");
  if (json) writeFileSync(json, JSON.stringify(r, null, 1));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
