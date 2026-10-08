import { COMMAND_REGISTRY } from "./registry.js";

/**
 * One help table for every command (surface item 19a, NEW-surface-13;
 * FINDINGS_C1 CLI-03, W3 G2–G3): `sekhemet <command> --help` prints what the
 * command does, its synopsis and one example, and `sekhemet dev --help`
 * lists each command on its own line, from here. A registry entry's row is
 * its own (`registry.ts`, item 17), so the two cannot disagree; the commands
 * still dispatched from `main` (strangler fig) have their row below until
 * they move. No row names a spec id (R-12). `cli_help.spec.ts` runs the
 * built binary for every name `main` dispatches and fails for one with no
 * row, no synopsis or no example.
 */
export interface HelpRow {
  /** The command's line in `sekhemet dev --help`. */
  usage: string;
  /** What it does, in one sentence. */
  what: string;
  /** Every form it takes, with its flags. */
  synopsis: string;
  /** One command line a person can run. */
  example: string;
}

/** The rows of the commands still dispatched from `main`, and the board's verbs. */
const MAIN_HELP: Readonly<Record<string, HelpRow>> = {
  tune: {
    usage:
      "tune [--from <repo>…] | tune settings --role <role> [--model <id>] [--yes] | --apply <run>",
    what: "Tune the step budget from recorded runs, or a role's sampling settings on this machine",
    synopsis:
      "sekhemet tune [--from <repo>…]   |   sekhemet tune settings --role worker|reviewer [--model <id>] [--yes]   |   sekhemet tune settings --apply <run id>",
    example: "sekhemet tune settings --role worker",
  },
  explore: {
    usage: "explore [--activate]",
    what: "Learn the project's constraints from its own configuration before any issue runs",
    synopsis: "sekhemet explore [--activate]",
    example: "sekhemet explore --activate",
  },
  log: {
    usage: "log [--rebuild]",
    what: "The Activity log's newest entries and whether its hash chain verifies",
    synopsis: "sekhemet log [--rebuild]",
    example: "sekhemet log",
  },
  serve: {
    usage: "serve [--port <n>] [--host <address>]",
    what: "The web dashboard server for this workspace (Ctrl+C to stop)",
    synopsis:
      "sekhemet serve [--port <n>] [--host <address>] [--yes]   |   sekhemet serve --new-setup-token   |   sekhemet serve --switch-to-solo",
    example: "sekhemet serve --port 4040",
  },
  ui: {
    usage: "ui [--port <n>]",
    what: "The same as serve: the web dashboard server",
    synopsis: "sekhemet ui [--port <n>] [--host <address>]",
    example: "sekhemet ui --port 4040",
  },
  plan: {
    usage: 'plan "<spec>" [--planner <model>|none] [--verbose]',
    what: "Break a description of the work into issues, without running them",
    synopsis:
      'sekhemet plan "<spec>" [--planner <model> | --planner none] [--researcher <model>] [--offline] [--verbose]',
    example: 'sekhemet plan "Add a CSV export of a week"',
  },
  gate: {
    usage: "gate [issue]",
    what: "Run the project's checks, in the issue's own worktree when one exists",
    synopsis: "sekhemet gate [<issue>]",
    example: "sekhemet gate TS-101",
  },
  gates: {
    usage: "gates init [--force] | gates approve-baseline <key> --sha256 <hash>",
    what: "Write the checks file for this project's language, or approve a visual baseline",
    synopsis:
      "sekhemet gates init [--force]   |   sekhemet gates approve-baseline <key> --sha256 <hash> [--card <issue>]",
    example: "sekhemet gates init",
  },
  "gate-host": {
    usage: "gate-host init | gate-host [--port <n>]",
    what: "Run the checks for other machines over mutual TLS; init writes its certificates",
    synopsis: "sekhemet gate-host init   |   sekhemet gate-host [--port <n>]",
    example: "sekhemet gate-host init",
  },
  replay: {
    usage: "replay <issue> [--attempt <n>] [--diff <a,b>] [--as <model>]",
    what: "Replay an issue's attempt step by step from the Activity log",
    synopsis: "sekhemet replay <issue> [--attempt <n>] [--diff <a>,<b>] [--as <model>]",
    example: "sekhemet replay TS-101 --attempt 2",
  },
  "bake-off": {
    usage: "bake-off --workers <a,b> [--fixture <name>]",
    what: "Compare Coding models on the same release checks, each from a clean copy",
    synopsis: "sekhemet bake-off --workers <model>,<model> [--fixture <name>]",
    example: "sekhemet bake-off --workers nail-mtp,cyber-tiel",
  },
  mcp: {
    usage: "mcp",
    what: "The board and Seshat as an MCP server on stdio, for an editor or another agent",
    synopsis: "sekhemet mcp [--repo <folder>]",
    example: "sekhemet mcp --repo ~/code/shop",
  },
  research: {
    usage: 'research "<question>" [--deep] [--web | --offline]',
    what: "Ask the Research model directly; it answers with its sources",
    synopsis:
      'sekhemet research "<question>" [--deep | --effort quick|standard|exhaustive] [--model <name>] [--web | --offline] [--card <issue>] [--fresh] [--json]   |   sekhemet research --batch <file>   |   sekhemet research --status',
    example: 'sekhemet research "How does Express parse cookies?" --deep',
  },
  "research-bakeoff": {
    usage: "research-bakeoff [--models <a,b>] [--pipelines <a,b>] [--adopt] | --adopt-from <run>",
    what: "Compare Research models on the research question set; adopt one only when the comparison allows it",
    synopsis:
      "sekhemet research-bakeoff [--models <a>,<b>] [--pipelines native,tool-loop] [--adopt]   |   sekhemet research-bakeoff --adopt-from <run>",
    example: "sekhemet research-bakeoff --models apodex-1.1-mini,neohorse-1-4b",
  },
  abort: {
    usage: "abort <issue> [reason]",
    what: "Stop a running issue before its next step",
    synopsis: "sekhemet abort <issue> [<reason>]",
    example: 'sekhemet abort TS-101 "wrong approach"',
  },
  rewind: {
    usage: "rewind <issue> <step>",
    what: "Take an issue back to step n; its later state is kept on a branch",
    synopsis: "sekhemet rewind <issue> <step>",
    example: "sekhemet rewind TS-101 4",
  },
  fork: {
    usage: "fork <issue> <step>",
    what: "Branch a new attempt of an issue from step n",
    synopsis: "sekhemet fork <issue> <step> [--attempt <id>]",
    example: "sekhemet fork TS-101 4",
  },
  overnight: {
    usage: "overnight [--until <HH:MM>] [run flags…]",
    what: "Run the queue in rounds while the machine is free and every safeguard holds",
    synopsis:
      "sekhemet overnight [--until <HH:MM>] [--idle-min <n>] [--max-failures <n>] [--round-limit-min <n>] [--calibration-night --permit-loads] [run flags…]",
    example: "sekhemet overnight --until 07:00",
  },
  calibrate: {
    usage:
      "calibrate [--models <m=role,…>] [--buckets <n,…>] [--force] | calibrate --mtp-ab --from <repo,…>",
    what: "Measure each model's speed and memory at each context size on this machine",
    synopsis:
      "sekhemet calibrate [--models <model>=<role>,…] [--buckets <tokens>,…] [--from <repo>,…] [--force]   |   sekhemet calibrate --mtp-ab --from <repo>,… [--max-steps <n>] [--thinking off|surgical|all] [--worker <model>]",
    example: "sekhemet calibrate --models cyber-tiel=worker",
  },
  "prompt-screen": {
    usage: "prompt-screen [--from <repo,…>] [--limit <n>] [--worker <model>]",
    what: "Replay recorded steps against a changed prompt, to screen it before a measured run",
    synopsis: "sekhemet prompt-screen [--from <repo>,…] [--limit <n>] [--worker <model>]",
    example: "sekhemet prompt-screen --from ~/code/shop --limit 20",
  },
  traces: {
    usage: "traces [--since-hours <n>] [--out <file>] [--otlp <url>]",
    what: "Export the run traces as JSON, or send them to an OpenTelemetry collector",
    synopsis: "sekhemet traces [--since-hours <n>] [--out <file.json>] [--otlp <url>]",
    example: "sekhemet traces --since-hours 24 --out traces.json",
  },
  acp: {
    usage: "acp",
    what: "Seshat over the Agent Client Protocol on stdio, for Zed and other editors",
    synopsis: "sekhemet acp [--repo <folder>]",
    example: "sekhemet acp --repo ~/code/shop",
  },
  init: {
    usage: "init [--force]",
    what: "Check the machine and write the project's checks file and configuration",
    synopsis: "sekhemet init [--force]",
    example: "sekhemet init",
  },
  reserve: {
    usage: "reserve [--until <time>] | reserve --release",
    what: "Reserve the machine for yourself now: no unattended issue starts until you release it",
    synopsis: "sekhemet reserve [--until <HH:MM or ISO time>]   |   sekhemet reserve --release",
    example: "sekhemet reserve --until 18:00",
  },
  pause: {
    usage: "pause <project>",
    what: "Pause a project: none of its issues starts until it is resumed",
    synopsis: "sekhemet pause <project id or name>",
    example: "sekhemet pause shop",
  },
  trust: {
    usage: "trust [--yes] | trust --approve <file>",
    what: "Show what this repository would run and trust it; or approve another agent's config file",
    synopsis: "sekhemet trust [--yes]   |   sekhemet trust --approve <file>",
    example: "sekhemet trust",
  },
  ask: {
    usage: 'ask "<question>"',
    what: "Ask Seshat from the terminal; the reply prints here",
    synopsis: 'sekhemet ask "<question>"',
    example: 'sekhemet ask "What is left before the release?"',
  },
  "take-over": {
    usage: "take-over [--yes] | take-over --approve TOP-<n> [--project <id>]",
    what: "Take over an unfinished project: trust it, survey it, then propose what runs",
    synopsis:
      "sekhemet take-over [--yes]   |   sekhemet take-over --approve TOP-<n> [--project <id>]",
    example: "sekhemet take-over",
  },
  benchmark: {
    usage: "benchmark estimate|quick|overnight|status|stop|report",
    what: "Benchmark this machine's models from the terminal, as Configuration › Models does",
    synopsis:
      "sekhemet benchmark estimate|quick --worker <model> --planner <model> [--reviewer <model>] [--researcher <model>] [--yes]   |   sekhemet benchmark overnight|status|stop|report",
    example: "sekhemet benchmark estimate --worker nail-mtp --planner qwen3:8b",
  },
  export: {
    usage: "export --ledger [--no-private] [--out <file>] | export --out <dir>",
    what: "Write the Activity log as NDJSON a verifier checks alone; with a folder, its projections, blobs and evidence too",
    synopsis:
      "sekhemet export --ledger [--no-private] [--out <file.ndjson>]   |   sekhemet export --out <dir> [--no-private]",
    example: "sekhemet export --ledger --out ledger.ndjson",
  },
  erase: {
    usage: "erase --secret --rotated | erase --events <id,…>",
    what: "Erase a secret found after the fact, or chosen entries, leaving a recorded gap",
    synopsis:
      "sekhemet erase --secret [--secret-file <file>] --rotated   |   sekhemet erase --events <id>,…",
    example: "sekhemet erase --secret --secret-file leaked.txt --rotated",
  },
  project: {
    usage: "project list [--json] | project move <id> <path> [--yes]",
    what: "List the workspace's projects, or record that a project's repository moved",
    synopsis:
      "sekhemet project list [--json]   |   sekhemet project move <project id or name> <new folder> [--yes]",
    example: "sekhemet project list",
  },
  airgap: {
    usage: "airgap mirror|manifest|verify-models|docs|export-docs|import-docs|sign|update|selftest",
    what: "Prepare and check a machine that never reaches the network",
    synopsis:
      "sekhemet airgap mirror | manifest <models-dir> | verify-models <manifest> <dir> | docs <library or url> | export-docs <out> | import-docs <file> | sign <file> --key <key> | update <bundle> --sig <s> --signers <f> --identity <i> | selftest",
    example: "sekhemet airgap selftest",
  },
  onboard: {
    usage: "onboard [--apply [--yes]] [--models <a,b>] [--no-baseline]",
    what: "Bring an existing repository in: its checks, conventions and a first baseline",
    synopsis: "sekhemet onboard [--apply [--yes]] [--models <a>,<b>] [--no-baseline]",
    example: "sekhemet onboard",
  },
  drift: {
    usage: "drift [--days <n>]",
    what: "What changed in the repository outside Sekhemet in the last days",
    synopsis: "sekhemet drift [--days <n>]",
    example: "sekhemet drift --days 7",
  },
  recurring: {
    usage: "recurring add|list|tick|trigger",
    what: "Issues that come back on a schedule or an event",
    synopsis:
      "sekhemet recurring add <issue> (--cron '<expr>' | --on file:<glob>|release:npm:<package>|webhook:<name>) [--urgent]   |   sekhemet recurring list | tick | trigger <name>",
    example: "sekhemet recurring add TS-101 --cron '0 6 * * 1'",
  },
  register: {
    usage: "register check | licenses | advance <id> <state>",
    what: "The project's provenance and research records: check them, list licences, or move an entry on",
    synopsis:
      "sekhemet register check   |   sekhemet register licenses   |   sekhemet register advance <id> <state> [--threshold <t>] [--evidence <e>]",
    example: "sekhemet register check",
  },
  trailers: {
    usage: "trailers [<range>]",
    what: "Check that each commit in a range carries its issue and model trailers",
    synopsis: "sekhemet trailers [<git range>]",
    example: "sekhemet trailers main~10..main",
  },
  fixture: {
    usage: "fixture <language> <dir> [--bug]",
    what: "Write a small practice repository with one issue, optionally with a planted bug",
    synopsis: "sekhemet fixture typescript|python|rust <dir> [--bug]",
    example: "sekhemet fixture typescript /tmp/practice --bug",
  },
  attach: {
    usage: "attach <issue> <image…>",
    what: "Attach screenshots or mock-ups to an issue",
    synopsis: "sekhemet attach <issue> <image>…",
    example: "sekhemet attach TS-101 mockup.png",
  },
  goal: {
    usage: 'goal "<statement>" | goal approve <goal> | goal mark <goal> <criterion> met|unmet',
    what: "A project goal and its criteria: propose one, approve it, or mark a criterion",
    synopsis:
      'sekhemet goal "<statement>"   |   sekhemet goal approve <goal>   |   sekhemet goal mark <goal> <criterion> met|unmet',
    example: 'sekhemet goal "Customers can export a week of hours"',
  },
  decide: {
    usage: "decide [<id> <option>]",
    what: "List the decisions waiting on you, or answer one with an option's number",
    synopsis: "sekhemet decide   |   sekhemet decide <decision> <option number>",
    example: "sekhemet decide dec_3f9a1c2b7e 2",
  },
  assume: {
    usage: "assume [list] | keep <id> | override <id> [--answer <text>]",
    what: "The assumptions the plan made: list them, keep one, or override it with your answer",
    synopsis:
      'sekhemet assume [list]   |   sekhemet assume keep <id>   |   sekhemet assume override <id> [--answer "<text>"]',
    example: "sekhemet assume list",
  },
  m0: {
    usage: "m0 --worker <model> [--runs <n>]",
    what: "The first-run benchmark a newly adopted Coding model owes",
    synopsis: "sekhemet m0 --worker <model> [--runs <n>] [--budgets <a>,<b>] [--max-commits <n>]",
    example: "sekhemet m0 --worker nail-mtp",
  },
  qualify: {
    usage: "qualify --models <a,b> [--role <role>] | qualify --override <model> --by <name>",
    what: "Verify models for a role on this machine, or record an override with its reason",
    synopsis:
      "sekhemet qualify --models <a>,<b> [--role worker|planner|reviewer|researcher] [--speculative on] [--check]   |   sekhemet qualify --override <model> [--role <role>] --by <name>",
    example: "sekhemet qualify --models nail-mtp",
  },
  improve: {
    usage: "improve [--mutants | --gate-rule <id> | --validate-tools]",
    what: "Improve the checks: propose rules from past runs, test the tests with mutants, or check mined tools",
    synopsis:
      "sekhemet improve   |   sekhemet improve --mutants [--limit <n>] [--max-mutants <n>]   |   sekhemet improve --gate-rule <id> [--fixtures <a>,<b>] [--worker <model>]   |   sekhemet improve --validate-tools",
    example: "sekhemet improve --mutants --limit 3",
  },
  skills: {
    usage: "skills [list] | approve <name> [--user] | revoke <name> [--user]",
    what: "The project's skills: list them, or approve or revoke one",
    synopsis:
      "sekhemet skills [list]   |   sekhemet skills approve <name> [--user]   |   sekhemet skills revoke <name> [--user]",
    example: "sekhemet skills list",
  },
  release: {
    usage: "release [brief|accept|cut|extend|revise|confirm|report|docs] …",
    what: "The current release slice: its status, acceptance, scope changes, report and docs",
    synopsis:
      "sekhemet release [--confirm <slice>]   |   sekhemet release brief <brief.json> | accept <slice> | cut <requirement> [--reason <text>] | extend <slice> [--cards <n>] [--hours <h>] | revise <requirement> <revision.json> | confirm <requirement> <issue|test> <ref> | report <slice> | docs [export|show|proposals|apply <id>|dismiss <id>]",
    example: "sekhemet release",
  },
  ci: {
    usage: "ci [--job <id>] [--workflow <file>]",
    what: "Run the project's own CI workflow locally, as a check",
    synopsis: "sekhemet ci [--job <id>] [--workflow <file>]",
    example: "sekhemet ci --job test",
  },
  measure: {
    usage: "measure footprint | compare | watch | rescore | promote | rule-credit | admit",
    what: "Measurement tooling: the harness's footprint, paired comparisons and a rule's credit",
    synopsis:
      "sekhemet measure footprint [--out <file>]   |   sekhemet measure compare <baseline.json> <candidate.json>   |   sekhemet measure watch <change> --kind budget|harness --with <a,b> --without <c,d>   |   sekhemet measure rescore <result.json> --work <dir> [--out <file>]   |   sekhemet measure promote <issue> [--because <change>]   |   sekhemet measure rule-credit <rule>   |   sekhemet measure admit",
    example: "sekhemet measure compare base.json candidate.json",
  },
  models: {
    usage: "models list | assign <role> <model> | restore <role> | add <file> | fetch <model>",
    what: "The models on this machine: list, assign a role, restore the default, add a GGUF, or download",
    synopsis:
      "sekhemet models list   |   sekhemet models assign <worker|planner|reviewer|researcher> <model> [--baseline | --default --bake-off <event>]   |   sekhemet models restore <role>   |   sekhemet models add <file.gguf> [--id <id>] [--sampling <settings>]   |   sekhemet models fetch <model> | --role <role> | --recommended [--yes] [--folder <path>]",
    example: "sekhemet models assign worker nail-mtp",
  },
  approve: {
    usage: "approve <issue or epic> [--show]",
    what: "Approve a plan's acceptance criteria, so its issues may leave Planning",
    synopsis: "sekhemet approve <issue or epic> [--show]",
    example: "sekhemet approve TS-100 --show",
  },
  depth: {
    usage: "depth [<type>] [--project <id>]",
    what: "Show the project's type, or choose one: Prototype, Internal tool, Production or Regulated",
    synopsis: "sekhemet depth [prototype|internal|production|regulated] [--project <id>]",
    example: "sekhemet depth production",
  },
  upgrade: {
    usage: "upgrade <package> <from> <to> | upgrade fixes <issue>",
    what: "Upgrade a dependency as a recorded step, then plan issues for the checks it breaks",
    synopsis:
      "sekhemet upgrade <package> <from> <to> [--changelog <file>]   |   sekhemet upgrade fixes <upgrade issue>",
    example: "sekhemet upgrade react 18.3.1 19.0.0",
  },
  // The board's decisions on an issue (surface items 13, 16), run as typed.
  "request-changes": {
    usage: 'request-changes <issue> "<reason>"',
    what: "Send an issue in Review back to the Coding model with what to change",
    synopsis: 'sekhemet request-changes <issue> "<what to change>"',
    example: 'sekhemet request-changes TS-101 "Keep the header row"',
  },
  "send-back": {
    usage: 'send-back <issue> "<reason>"',
    what: "Request changes' former name: send an issue back with what to change",
    synopsis: 'sekhemet send-back <issue> "<what to change>"',
    example: 'sekhemet send-back TS-101 "Keep the header row"',
  },
  park: {
    usage: 'park <issue> "<reason>"',
    what: "Put an issue on hold, with why",
    synopsis: 'sekhemet park <issue> "<reason>"',
    example: 'sekhemet park TS-101 "Waiting for the API key"',
  },
  unpark: {
    usage: "unpark <issue>",
    what: "Take an issue off hold, back where it was",
    synopsis: "sekhemet unpark <issue>",
    example: "sekhemet unpark TS-101",
  },
  reopen: {
    usage: 'reopen <issue> ["<reason>"]',
    what: "Reopen a finished or rejected issue",
    synopsis: 'sekhemet reopen <issue> ["<reason>"]',
    example: 'sekhemet reopen TS-101 "The export drops Sundays"',
  },
  reject: {
    usage: 'reject <issue> "<reason>"',
    what: "Reject an issue: it will not be done",
    synopsis: 'sekhemet reject <issue> "<reason>"',
    example: 'sekhemet reject TS-101 "Out of scope for this release"',
  },
  revert: {
    usage: 'revert <issue> ["<reason>"]',
    what: "Undo an accepted issue's merge with a revert commit, and reopen it",
    synopsis: 'sekhemet revert <issue> ["<reason>"]',
    example: 'sekhemet revert TS-101 "Broke the weekly report"',
  },
  card: {
    usage: "card message|pause|hand-back|take-over <issue> […]",
    what: "Talk to a running issue: send a message, pause it, hand it back, or take it over yourself",
    synopsis:
      'sekhemet card message <issue> "<text>"   |   sekhemet card pause <issue>   |   sekhemet card hand-back <issue>   |   sekhemet card take-over <issue>',
    example: 'sekhemet card message TS-101 "Use the existing date helper"',
  },
};

/** A command's help row: its registry entry's, else `main`'s table's. */
export function helpFor(name: string | undefined): HelpRow | undefined {
  if (!name) return undefined;
  const spec = COMMAND_REGISTRY.find((c) => c.name === name);
  if (spec)
    return { usage: spec.usage, what: spec.what, synopsis: spec.synopsis, example: spec.example };
  return Object.hasOwn(MAIN_HELP, name) ? MAIN_HELP[name] : undefined;
}

/** `sekhemet <name> --help`. */
export function helpLines(row: HelpRow): string[] {
  return [
    row.what,
    "",
    `Usage: ${row.synopsis}`,
    `Example: ${row.example}`,
    "",
    "Also: --repo <folder> runs it on another folder's project.",
  ];
}

/**
 * The commands `sekhemet dev --help` lists, each on its own line: every name
 * with a help row but those on the front door (rule 14), in name order.
 */
export function devHelpRows(frontDoor: ReadonlySet<string>): [string, HelpRow][] {
  const names = new Set<string>([
    ...Object.keys(MAIN_HELP),
    ...COMMAND_REGISTRY.map((c) => c.name),
  ]);
  return [...names]
    .filter((n) => !frontDoor.has(n))
    .sort()
    .map((n) => [n, helpFor(n) as HelpRow]);
}
