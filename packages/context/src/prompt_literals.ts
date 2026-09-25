import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { COPY_MODULE_PATTERN, isCopyModulePath } from "./prompt_tags.js";

/**
 * The model-facing literal inventory (context CX-M1-13; PROMPT_STANDARD
 * rules 13 and 36).
 *
 * Every sentence a model reads should come from its role's copy module (a
 * file registered in `COPY_MODULES`). Every model-facing literal elsewhere is
 * recorded; a test fails when one is added and the record may only shrink.
 *
 * A literal is model-facing when it is prose (three or more words) and is
 * written in one of these places:
 * - the value of a request or tool field (`systemPrompt`, `prompt`, `summary`,
 *   `returns`, `instruction`, `suggestedAction`, `rungDirective`, `directive`);
 * - a `description`, `content`, `text` or `result` beside a field that marks a
 *   model-facing object (`role`, `parameters`, `placement`, `tool`,
 *   `toolCallId`, `required`, `turn`), or under a `parameters` or
 *   `properties` schema;
 * - an argument after the first of an observation constructor (`ok`, `fail`,
 *   `denied`, `untrusted`, `clampObservation`), whose first is the tool name;
 * - a constant named for a prompt (`…_PROMPT`, `…_SYSTEM`, `PREAMBLE`,
 *   `…_NOTE`, `…_INSTRUCTIONS`, `…_BRIEF`, `…_METHOD`, `…_FORMAT`, `…_HEADERS`,
 *   `system`, `prompt`);
 * - the body of a function named for a prompt or refusal (`…Prompt`,
 *   `…PromptFor`, `…Directive`, `…Instructions`, `…Refusal`, `refuse…`);
 * - anywhere in a file on the Worker's prompt path (`MODEL_PATH_FILES`),
 *   where thrown errors and history notes become observations.
 * This is a classifier by position, not by meaning: it misses a prompt
 * assembled far from where it is sent, and it records some text a person
 * reads. Both are acceptable for a record that only has to stop growth.
 */

export interface PromptLiteral {
  /** Repository-relative path with forward slashes. */
  file: string;
  line: number;
  /** Why it counts: the field, call, constant or function it sits in. */
  context: string;
  /** The literal's text, with each `${…}` substitution written as `${}`. */
  text: string;
  hash: string;
}

export interface LiteralInventoryEntry {
  file: string;
  hash: string;
  /** The first 100 characters, for a reader. */
  text: string;
}

export interface LiteralInventory {
  about: string;
  literals: LiteralInventoryEntry[];
}

/** Files whose every prose literal reaches the Worker. */
export const MODEL_PATH_FILES: readonly string[] = [
  "packages/context/src/prompts.ts",
  "packages/context/src/tool_interface.ts",
  "packages/context/src/worker_prompt.ts",
  "packages/loop/src/ladder.ts",
  "packages/loop/src/observation.ts",
  "packages/loop/src/tools.ts",
  "packages/loop/src/working_memory.ts",
];

const FIELDS = new Set([
  "systemPrompt",
  "prompt",
  "summary",
  "returns",
  "instruction",
  "suggestedAction",
  "rungDirective",
  "directive",
]);
const MARKED_FIELDS = new Set(["description", "content", "text", "result"]);
const MARKERS = new Set([
  "role",
  "parameters",
  "placement",
  "tool",
  "toolCallId",
  "required",
  "turn",
]);
const SCHEMA_KEYS = new Set(["parameters", "properties"]);
const CALLS = new Set(["ok", "fail", "denied", "untrusted", "clampObservation"]);
const CONSTANT =
  /(^|_)(PROMPT|SYSTEM|PREAMBLE|NOTE|INSTRUCTIONS?|BRIEF|METHOD|FORMAT|HEADERS)$|^(system|prompt)$/;
const BUILDER = /(Prompt|PromptFor|Directive|Instructions?)$/;
/**
 * A refusal builder (`…Refusal`, `refuse…`) is model-facing: the Worker's
 * refusals come back to it as observations or command output. The builders
 * whose refusal is said to a person on the CLI or the dashboard are named
 * here, one by one, so a new refusal is inventoried until someone decides it
 * is a person's.
 */
const REFUSAL_BUILDER = /Refusal$|^refuse[A-Z]/;
const PERSON_FACING_REFUSALS: ReadonlySet<string> = new Set([
  // apps/harness/src/qualify.ts: "Refusing <model> as the Worker…", on the CLI.
  "qualificationRefusal",
  // apps/harness/src/measure_cmd.ts: "--auto-accept merges cards no person accepted…", on the CLI.
  "autoAcceptRefusal",
]);

function nameOf(node: ts.Node | undefined): string | undefined {
  if (!node) return undefined;
  if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isPrivateIdentifier(node)) {
    return node.text;
  }
  return undefined;
}

function literalText(node: ts.Node): string | undefined {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    return node.head.text + node.templateSpans.map((s) => `\${}${s.literal.text}`).join("");
  }
  return undefined;
}

function isProse(text: string): boolean {
  return (text.replaceAll("${}", " ").match(/[A-Za-z]{2,}/g) ?? []).length >= 3 && /\s/.test(text);
}

function propertyKeys(obj: ts.ObjectLiteralExpression): Set<string> {
  const keys = new Set<string>();
  for (const p of obj.properties) {
    const n = nameOf(p.name);
    if (n) keys.add(n);
  }
  return keys;
}

function underSchema(obj: ts.ObjectLiteralExpression): boolean {
  for (let n: ts.Node | undefined = obj.parent; n; n = n.parent) {
    if (ts.isPropertyAssignment(n) && SCHEMA_KEYS.has(nameOf(n.name) ?? "")) return true;
    if (ts.isFunctionLike(n) || ts.isSourceFile(n)) return false;
  }
  return false;
}

function calleeName(call: ts.CallExpression): string | undefined {
  const e = call.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return undefined;
}

function functionName(fn: ts.Node): string | undefined {
  if (ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn)) return nameOf(fn.name);
  if ((ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) && fn.parent) {
    if (ts.isVariableDeclaration(fn.parent)) return nameOf(fn.parent.name);
    if (ts.isPropertyAssignment(fn.parent)) return nameOf(fn.parent.name);
  }
  return undefined;
}

/** Why a literal is model-facing, or undefined when it is not. */
function contextOf(node: ts.Node, modelPath: boolean, path: string): string | undefined {
  let child: ts.Node = node;
  for (let n: ts.Node | undefined = node.parent; n; child = n, n = n.parent) {
    if (ts.isPropertyAssignment(n) && n.initializer === child) {
      const key = nameOf(n.name) ?? "";
      if (FIELDS.has(key)) return key;
      if (MARKED_FIELDS.has(key) && ts.isObjectLiteralExpression(n.parent)) {
        const keys = propertyKeys(n.parent);
        if ([...MARKERS].some((m) => keys.has(m)) || underSchema(n.parent)) return key;
      }
    }
    if (ts.isCallExpression(n) && n.arguments.slice(1).some((a) => a === child)) {
      const callee = calleeName(n);
      if (callee && CALLS.has(callee)) return `${callee}()`;
    }
    if (ts.isVariableDeclaration(n) && n.initializer === child) {
      const name = nameOf(n.name) ?? "";
      if (CONSTANT.test(name)) return name;
    }
    if (ts.isFunctionLike(n)) {
      const name = functionName(n);
      if (name && BUILDER.test(name)) return `${name}()`;
      if (name && REFUSAL_BUILDER.test(name) && !PERSON_FACING_REFUSALS.has(name)) {
        return `${name}()`;
      }
    }
    if (ts.isSourceFile(n)) break;
  }
  return modelPath ? "model path file" : undefined;
}

function hashOf(file: string, text: string): string {
  return createHash("sha256").update(`${file}\u0000${text}`).digest("hex").slice(0, 16);
}

/** The model-facing literals of one source file, in source order. */
export function extractModelFacingLiterals(file: string, source: string): PromptLiteral[] {
  const path = file.replaceAll("\\", "/");
  if (isCopyModulePath(path)) return [];
  const sf = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const modelPath = MODEL_PATH_FILES.includes(path);
  const out: PromptLiteral[] = [];
  const visit = (node: ts.Node): void => {
    const text = literalText(node);
    if (text !== undefined) {
      if (isProse(text)) {
        const context = contextOf(node, modelPath, path);
        if (context) {
          out.push({
            file: path,
            line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
            context,
            text,
            hash: hashOf(path, text),
          });
        }
      }
      // A template's substitutions may hold literals of their own.
      if (!ts.isTemplateExpression(node)) return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names.sort()) {
    if (name === "node_modules" || name === "dist") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (name.endsWith(".ts") && !name.endsWith(".d.ts")) out.push(path);
  }
  return out;
}

function scannedDirs(root: string): string[] {
  return [
    ...readdirSync(join(root, "packages"))
      .sort()
      .map((p) => join(root, "packages", p, "src")),
    join(root, "apps", "harness", "src"),
  ];
}

/** Repository-relative files under the scanned directories shaped like a copy module. */
export function copyModuleShapedFiles(root: string): string[] {
  return scannedDirs(root)
    .flatMap((dir) => sourceFiles(dir))
    .map((f) => relative(root, f).replaceAll("\\", "/"))
    .filter((f) => COPY_MODULE_PATTERN.test(f));
}

/** Scan `packages/*\/src` and `apps/harness/src` under the repository root. */
export function scanModelFacingLiterals(root: string): PromptLiteral[] {
  const dirs = scannedDirs(root);
  return dirs.flatMap((dir) =>
    sourceFiles(dir).flatMap((f) =>
      extractModelFacingLiterals(relative(root, f), readFileSync(f, "utf8")),
    ),
  );
}

export function inventoryOf(literals: readonly PromptLiteral[]): LiteralInventory {
  return {
    about:
      "Model-facing literals outside a copy module (context CX-M1-13, PROMPT_STANDARD rules 13 and 36). This record may only shrink: move a literal into its role's copy module, then rerun the test with SEKHEMET_RECORD_PROMPT_BASELINE=1.",
    literals: literals
      .map((l) => ({ file: l.file, hash: l.hash, text: l.text.slice(0, 100) }))
      .sort((a, b) =>
        a.file === b.file
          ? a.hash < b.hash
            ? -1
            : a.hash > b.hash
              ? 1
              : 0
          : a.file < b.file
            ? -1
            : 1,
      ),
  };
}

/** Literals not in the record (each copy counted) and recorded entries now gone. */
export function compareWithInventory(
  current: readonly PromptLiteral[],
  inventory: LiteralInventory,
): { added: PromptLiteral[]; stale: LiteralInventoryEntry[] } {
  const left = new Map<string, LiteralInventoryEntry[]>();
  for (const e of inventory.literals) left.set(e.hash, [...(left.get(e.hash) ?? []), e]);
  const added: PromptLiteral[] = [];
  for (const l of current) {
    const bucket = left.get(l.hash);
    if (bucket && bucket.length > 0) bucket.pop();
    else added.push(l);
  }
  return { added, stale: [...left.values()].flat() };
}
