/**
 * The gates copy module: every remedy a gate sends the model
 * (PROMPT_STANDARD rules 13 and 14; gates rules 17 and 21).
 *
 * A remedy says what happened and the next call to make, completable in one
 * step. No other file in this package holds model-facing remedy text. Changing
 * a sentence here changes the context version and goes through the prompt
 * change steps (PROMPT_STANDARD rule 35).
 */

/** The Worker's tool that runs every gate again: the repro for harness-run layers. */
export const RERUN_GATES = "check";

export const gateCopy = {
  // --- TypeScript -------------------------------------------------------------
  narrow:
    "The value may be undefined (noUncheckedIndexedAccess). Narrow it before use: `const item = items[i]; if (item === undefined) continue;` or loop with `for (const item of items)` / `items.entries()`. Do not use the `!` non-null assertion: lint forbids it.",
  exactOptional:
    "exactOptionalPropertyTypes is on: an optional property may be absent but may not be set to undefined. Omit the property (`{ valid: false, totalEvents: n }`), or add it only when defined: `...(value !== undefined ? { key: value } : {})`.",
  unknownNameGeneric:
    'The name is not in scope. Import it from the module that exports it (`import type { Name } from "./types.js";` for a type), or define it.',
  unknownName: (name: string, file: string, specifier: string, typeOnly = false) =>
    `${name} is not in scope. ${file} exports ${name}: add \`import ${typeOnly ? "type " : ""}{ ${name} } from "${specifier}";\` at the top of the file.`,
  unknownNameNowhere: (name: string) =>
    `${name} is not in scope, and no module under src/ exports it. Define ${name} in this file, or import it from the package that provides it.`,
  unknownNameSearch: (name: string) =>
    `${name} is not in scope. Call grep_search with the query \`${name}\` to find the module that exports it, or define ${name} in this file.`,
  unresolvedImport:
    "The import path does not resolve. Use a relative path with a .js extension (`./types.js`) to a file that exists; read_file on the path shows whether it does.",
  unknownPropertyGeneric:
    "That property is not part of the target type. Remove it, and use only the fields the type declares.",
  unknownPropertyNotFound: (property: string, type: string) =>
    `${property} is not a property of ${type}. Remove it, and use only the fields ${type} declares.`,
  rowsCast:
    "Database rows are untyped records. Map each row to your type field by field (`rows.map((r) => ({ id: String(r.id), seq: Number(r.seq) }))`), or cast through unknown: `stmt.all() as unknown as Row[]`.",
  unrelatedCast:
    "The cast is between unrelated types. Build a value of the target type explicitly, or cast through unknown only if you have checked the shape.",
  missingProperties:
    "An object is missing required properties of its declared type. Add every required field listed (the code below shows the type's members), or change the type if the contract allows.",
  missingExport: (module: string, name: string, exports: string) =>
    `${module} does not export ${name}. It exports exactly: ${exports}. Import one of those, or define ${name} yourself.`,
  missingExportNothing: (module: string, name: string) =>
    `${module} exports nothing yet, so ${name} cannot be imported from it. Define ${name} where you use it; if it belongs in ${module} and that file is outside this card's scope, call note to say so, and finish.`,
  missingExportUnresolved: (module: string, name: string) =>
    `${module} does not export ${name}. Call grep_search with the query \`from "${module}"\` to see the names this project already imports from it, or define ${name} yourself.`,
  unknownMember: (type: string, member: string, members: string) =>
    `${type} has no member ${member}. Its members are exactly: ${members}. Use one of those, or change the approach; there is no need to look the type up.`,
  unknownMemberPartial: (type: string, member: string, members: string) =>
    `${type} has no member ${member}. Its members include: ${members}. Use one of those, or call grep_search with the query \`${type}\` to see how this project uses it.`,
  unknownMemberNotFound: (type: string, member: string) =>
    `${type} has no member ${member}. Call grep_search with the query \`${type}\` to see how this project uses ${type}, or change the approach.`,
  resolveCode: (code: string, file: string, line: string) => `Resolve ${code} at ${file}:${line}.`,

  // --- tests --------------------------------------------------------------------
  testAssertion:
    "Make the implementation satisfy this assertion. Do not modify the test — assertions are immutable to the implementer role.",
  protectedTest: (where: string) =>
    `Reported in ${where}, a protected test you may not edit. The test is the specification: change the implementation it exercises so this assertion holds.`,

  // --- lint and format ----------------------------------------------------------
  lintRule: (rule: string, file: string, line: string) => `Fix ${rule} at ${file}:${line}.`,
  formatFile: (file: string) =>
    `${file} is not formatted the way the project's formatter wants. Change the lines the excerpt marks with - into the lines it marks with +.`,
  noUnusedTemplateLiteral:
    "Replace the backtick string with a plain quoted string: it has no ${} interpolation.",
  noExplicitAny: "Replace `any` with `unknown` and narrow it, or with the precise type.",
  useTemplate: "Replace string concatenation with a template literal.",

  // --- any tool -----------------------------------------------------------------
  rerun: (repro: string) => `Re-run \`${repro}\` after addressing the output above.`,
  /** A gate that could not run (rule 9): not the card's work, never counted against it. */
  gateNotRun: (gate: string) =>
    `The ${gate} gate could not run on this host; that is not the card's work and does not count against it. Fix any other failure shown; when only gates that could not run remain, the card stops for a person.`,
  // SUR-12: the gate's script is missing from the file named, so it never started.
  gateCannotStart: (gate: string, file: string) =>
    `The ${gate} gate could not start: its script is missing from ${file}. That is not the card's work and does not count against it; a person edits ${file}, and when only gates that could not run remain, the card stops for them.`,
  hookBlocked: (reason: string) =>
    `A project hook stopped the gates: ${reason}. That is not the card's work and does not count against it; when nothing else fails, the card stops for a person.`,

  // --- integrity ------------------------------------------------------------------
  integrity:
    "Remove the suppression and fix the underlying problem. A gate passed by switching a check off is not a pass: the reviewer will send it back.",

  // --- bounds: the Worker keeps the change small, or hands the split to a person -----
  boundsFiles: (files: string, limit: string) =>
    `This change touches ${files} files; one card may touch ${limit}. Keep only the files this card needs, or, if it cannot be done in ${limit}, call note with gate "bounds" and why, so a person can split the card.`,
  boundsToolApplied: (tool: string, lines: string, limit: string) =>
    `${tool} changed ${lines} lines for this card; one card may have a tool apply ${limit}. Apply it to fewer files, or, if it cannot be done in ${limit}, call note with gate "bounds" and why, so a person can split the card.`,
  boundsLines: (lines: string, limit: string) =>
    `This change is ${lines} lines; one card may change ${limit}. Keep only the lines this card needs, or, if it cannot be done in ${limit}, call note with gate "bounds" and why, so a person can split the card.`,

  // --- built-in layers --------------------------------------------------------------
  secret:
    "Remove the credential; read it from the environment or a config file outside the repository, and rotate it if it was real.",
  typosquat: (intended: string, dependency: string) =>
    `Use "${intended}" if that was meant. If "${dependency}" is the package this card needs, call note with gate "dependencies" and why, so a person can approve it.`,
  unknownPackage: "Remove it, or name the package that really provides this.",
  newPackage: (dependency: string) =>
    `"${dependency}" is new to its registry. Use an established package, or call note with gate "dependencies" and why this card needs it, so a person can approve it.`,
  vulnerable: (name: string, id: string) => `Upgrade ${name} past ${id}.`,
  staticFinding: (file: string, line: string) =>
    `Change ${file}:${line} so the rule named above no longer matches.`,
  debugStatement: "Remove the debugging statement before the card is reviewed.",
  changelog: "Add a one-line entry under Unreleased describing the change.",
  handCommit:
    "Commits on a card branch are made by the harness's checkpoints; do not commit by hand with run_cmd.",

  // --- visual -----------------------------------------------------------------------
  visualConsole: "Fix the error the page logs or the request that fails.",
  visualLayout: "Change the page's markup or styles so the element named above meets the check.",
  visualBaseline: (page: string) =>
    `No approved screenshot of ${page} exists yet, and only a person approves one. Call note with gate "visual-snapshot" so a person looks at the new screenshot.`,
  visualChanged: (page: string) =>
    `The screenshot of ${page} differs from its approved baseline. If the page should look like this, call note with gate "visual-snapshot" so a person approves the new screenshot; otherwise change the markup or styles back.`,
  visualOverlapFound: (a: string, b: string, width: string, size: string) =>
    `${a} overlaps ${b} @${width}px (${size}px)`,
  visualOverlapExpected: (a: string, b: string) => `${a} and ${b} do not overlap`,
  visualOverlapActual: (size: string) => `their boxes intersect over ${size}px`,
  visionAnswered: (width: string, model: string, question: string) =>
    `@${width}px ${model} answered no: ${question}`,
  visualOverlap: (a: string, b: string) =>
    `Change the page's layout so ${a} and ${b} no longer cover each other. If they are meant to overlap, call note with gate "visual-layout" and why, so a person can declare the overlap.`,
  visualDom: (selector: string) =>
    `Change the page so ${selector} is what the card declares: present or absent, its text, or its attribute, as the line above says.`,
  visionNo: (question: string) =>
    `A check of the rendered page answered no to "${question}". Fix what the question describes in the page's markup or styles; if the page is right, call note with gate "visual-vision" and why.`,
  /** The vision checklist (rule 30): yes means the screen is fine. Its version is VISION_CHECKLIST_VERSION. */
  visionChecklist: [
    "Is every piece of text readable, with none cut off or drawn over other text?",
    "Is every element fully inside the screen, with nothing cut off at an edge?",
    "Are the elements free of overlaps that hide part of one another?",
    "Are there no broken images, empty boxes or placeholder text?",
    "Is the screen free of error messages, stack traces and raw code?",
  ] as readonly string[],
  /** The vision model's instruction: the numbered checklist, one yes or no per line. */
  visionAsk: (numbered: string) =>
    `Look at the screenshot and answer each numbered question with yes or no, one line per question, in the form "1. yes".\n${numbered}`,

  // --- change kinds (refactor, upgrade) --------------------------------------------------
  refactorSurface: (file: string) =>
    `A refactor keeps what its files export. Put back the exports named above in ${file}, under their old names; if this card must change them, call note with gate "refactor-surface" and why, so a person can declare the change.`,
  upgradeKept: (test: string) =>
    `${test} passed before the upgrade and must still pass. Change the code that calls the upgraded dependency so it does; do not edit the test.`,

  // --- the claim gate (a research card's report) ----------------------------------------
  claimNoReproduction: "no reproduction and no reason",
  claimNotReproduced: (id: string) =>
    `Claim ${id} did not reproduce. Strike it from the report, or correct it and its script so the script shows what the claim says; if it cannot be run here, mark it unreproducible with the reason.`,
  claimUnsettled: (id: string) =>
    `Claim ${id} is executable but has no script and no reason. Add a script that shows it, or mark it unreproducible with the reason it cannot be run here.`,

  // --- project gates (apps/harness/src/*_gate.ts) ---------------------------------------
  regressionBroken: (file: string, where: string) =>
    `${file} passed on main and fails with this card's change, so the change broke work that was already finished. The fix is in what you changed (${where}): make it keep ${file}'s behaviour while doing what this card asks. Do not edit the test.`,
  regressionRemoved: (file: string, restore: string) =>
    `${file} is a test main already has, and this card removed or emptied it. A test that no longer exists cannot fail, which is why removing one is refused; if it is genuinely obsolete, call note with gate "regression" and why. ${restore}`,
  regressionRestore: (file: string, content: string) =>
    `Restore it in one step: write_file ${file} with exactly this content, as it is on main:\n${content}`,
  regressionTooLong: (file: string, lines: string) =>
    `It is ${lines} lines on main, too long to restore here: call note with gate "regression" to say ${file} was removed and needs restoring.`,
  architectureImport: (from: string, to: string, file: string) =>
    `The brief declares that ${from} does not import ${to}. Remove that import from ${file} and reach what you need another way — pass it in, or move the shared piece below both. If the invariant is wrong for this card, call note with gate "architecture" and why.`,
  architectureHome: (name: string, home: string, file: string) =>
    `${name} has one home: ${home}. Delete the definition in ${file} and import it from ${home} instead. If ${home} lacks something you need, call note with gate "architecture" and what.`,
  licenseNotPermissive: (dependency: string, license: string) =>
    `Choose a permissively licensed alternative to "${dependency}" (${license}). If this card needs it, call note with gate "licenses" and why, so a person can list it in the licence register.`,
  licenseUnknown: (dependency: string) =>
    `Install "${dependency}" so its licence can be read. If that is not possible, call note with gate "licenses" and why, so a person can list it in the licence register.`,
  sourceNotParsed: (gate: string, file: string, reason: string) =>
    `The ${gate} gate cannot judge ${file} until it parses cleanly. Fix the syntax error at ${reason}, then the gate reads it again.`,
  /** Rules 9 and 28b: the reason the source index gives a file it could not read. */
  unreadableReason: (code: string) => `could not be read (${code})`,
  /** Rules 9 and 28b: a changed file the source index could not read at all. */
  sourceUnreadable: (gate: string, file: string, reason: string) =>
    `The ${gate} gate cannot judge ${file}: it ${reason}. Make it readable (its permissions, or a file in its place), then the gate reads it again.`,
  /** Review M2: a partial verdict on a file the card did not change goes to a person. */
  sourceNotParsedForPerson: (gate: string, file: string, reason: string) =>
    `${file} is not this card's file and does not parse cleanly (${reason}), so the ${gate} gate's verdict is partial. Nothing for you to change here: a person decides, or re-baselines the project.`,
  unusedExport: (name: string) =>
    `Nothing uses ${name}. Either wire it into the code that needs it, or remove the export (keep it unexported if it is a local helper). If a later card genuinely needs it, say so with note rather than leaving it dangling.`,
} as const;

/**
 * Whether a partial file's reason is the unreadable one `gateCopy.unreadableReason`
 * writes (not a parse's). A predicate, so it lives beside the copy, not in it:
 * every entry of `gateCopy` is text a person or the model reads.
 */
export const isUnreadableReason = (reason: string): boolean =>
  reason.startsWith("could not be read");
