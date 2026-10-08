/**
 * The source index's fact schema (gates rule 28, IX-1): one language-neutral
 * shape for what a file imports, exports, re-exports, declares and
 * references. Every file's facts carry the language, the parser and its
 * version, and how the parse went, so a consumer can tell a fact read from a
 * clean parse from one read out of a recovered tree (GT-IX-1).
 *
 * The facts are a derived cache (IX-3): rebuilt from a file's text on demand,
 * never a durable store. Per-language adapters supply the parser and the
 * module resolver; TypeScript and JavaScript are the only adapter today
 * (open question 7: `web-tree-sitter` arrives with a Python adapter).
 */

/**
 * How a file's parse went: clean, parsed with errors recovered, no parser for
 * it, or the file could not be read at all (rules 9 and 28b: a verdict on it
 * is partial, never "no exports").
 */
export type ParseStatus = "ok" | "recovered" | "unsupported" | "unreadable";

/** Where a file's facts came from (IX-1). */
export interface FactProvenance {
  language: string;
  parser: string;
  parserVersion: string;
  parseStatus: ParseStatus;
  /** Why the status is not `ok`: the first syntax error, or the missing adapter. */
  parseReason?: string;
}

/**
 * How a module is imported. `value` and `type` are named or default
 * bindings; `namespace` is `import * as ns`; `side-effect` is a bare
 * `import "x"`; `dynamic` is `import("x")`; `require` is `require("x")` or
 * `import x = require("x")`.
 */
export type ImportKind = "value" | "type" | "namespace" | "side-effect" | "dynamic" | "require";

/** One name an import binds: `imported` is the module's name for it (`default` for a default import). */
export interface ImportBinding {
  imported: string;
  local: string;
  typeOnly: boolean;
}

export interface ImportFact {
  specifier: string;
  kind: ImportKind;
  bindings: ImportBinding[];
  /** For a namespace import: the local name, the members read through it, and whether it is used whole. */
  namespace?: { local: string; members: string[]; escapes: boolean };
  line: number;
}

/** `export { a } from`, `export * from` and `export * as ns from`. */
export type ReExportKind = "named" | "star" | "namespace";

export interface ReExportFact {
  specifier: string;
  kind: ReExportKind;
  /** For `named`: each name as the module has it and as this file exports it. */
  names: { imported: string; exported: string; typeOnly: boolean }[];
  /** For `namespace`: the name `export * as ns` gives it. */
  namespace?: string;
  line: number;
}

export type DeclarationKind =
  | "function"
  | "class"
  | "interface"
  | "type"
  | "enum"
  | "const"
  | "let"
  | "var"
  | "namespace"
  | "method";

/**
 * A named declaration, at any depth. Offsets are into the file's text with
 * line endings as given; `bodyOpen`/`bodyClose` are the braces of its body
 * (-1 when it has none).
 */
export interface DeclarationFact {
  name: string;
  kind: DeclarationKind;
  /** A `const`/`let`/`var` whose value is an arrow function. */
  arrow?: boolean;
  topLevel: boolean;
  exported: boolean;
  isDefault: boolean;
  /** A declaration that exists only for the type checker: an `interface` or a `type` alias. */
  typeOnly: boolean;
  /** 1-based line of the declaration keyword (after any decorators). */
  line: number;
  /** Offset of the declaration's first non-decorator token. */
  start: number;
  /** Offset just past the declaration, its statement's `;` included. */
  end: number;
  bodyOpen: number;
  bodyClose: number;
  /** The enclosing declaration's name, for a member or a nested declaration. */
  container?: string;
  /** The enclosing declaration's kind. */
  containerKind?: DeclarationKind;
  /** Exported by a keyword on the declaration itself, not by a later `export { … }` list. */
  exportedAtDeclaration: boolean;
  /** A member's declared visibility, when it declares one (`#name` is private). */
  visibility?: "public" | "private" | "protected";
  /** A getter or setter, among members. */
  accessor?: "get" | "set";
  /** A member declared without a body in a type (an interface's method signature). */
  signatureOnly?: boolean;
  /** The first line of the declaration's documentation comment, if any. */
  doc?: string;
}

/** A name this file exports itself (not by re-export). */
export interface ExportFact {
  /** The exported name; `default` for a default export. */
  name: string;
  /** The local declaration's name, when it differs from `name` (`export default function f`, `export { a as b }`). */
  local?: string;
  typeOnly: boolean;
  line: number;
}

/**
 * One use of a name: every identifier that is not a declaration's own name,
 * with its position (1-based line and column, 0-based offset). `member` is a
 * name read through another value (`obj.name`, `ns.Type`).
 */
export interface ReferenceFact {
  name: string;
  line: number;
  column: number;
  start: number;
  member: boolean;
}

/**
 * One operator or boolean-literal token the mutation operators may swap,
 * outside strings and comments, with its position.
 */
export interface OperatorFact {
  text: string;
  line: number;
  column: number;
  start: number;
  end: number;
}

/** A workspace package's declared entry point, and the source file it resolves to when one does. */
export interface EntryPointFact {
  /** The `exports` subpath (`.` for `main`). */
  subpath: string;
  /** What the manifest names, as written. */
  target: string;
  /** Repository-relative source file; absent when none resolves (never guessed). */
  file?: string;
}

/** One workspace package (IX-5). */
export interface WorkspacePackageFact {
  name: string;
  /** Repository-relative directory. */
  dir: string;
  /** The workspace packages it depends on. */
  deps: string[];
  entryPoints: EntryPointFact[];
}

/** The workspace a repository is (IX-5): its tool and packages, in name order. */
export interface WorkspaceFacts {
  tool: string;
  packages: WorkspacePackageFact[];
}

/** A top-level test block (`describe("…")`, `it`, `test`), for outlines. */
export interface TestBlockFact {
  callee: string;
  title: string;
  line: number;
}

/** Everything the index knows about one file. */
export interface SourceFacts extends FactProvenance {
  /** Repository-relative path, or the name the text was given. */
  file: string;
  /** SHA-256 of the text the facts were read from. */
  contentHash: string;
  imports: ImportFact[];
  exports: ExportFact[];
  reExports: ReExportFact[];
  declarations: DeclarationFact[];
  /** Every use of a name, in source order (not a declaration's own name). */
  references: ReferenceFact[];
  /** Operator and boolean-literal tokens, in source order. */
  operators: OperatorFact[];
  testBlocks: TestBlockFact[];
  /** The first documentation comment in the file, first line only. */
  doc?: string;
  /** `declare module "x" { … }` blocks: each block's own facts. */
  ambientModules: { name: string; facts: SourceFacts }[];
}

/** What a module specifier names (IX-2): a file, an external package, or nothing found — never a guess. */
export type ResolvedModule =
  | { kind: "file"; path: string }
  | { kind: "package"; name: string }
  | { kind: "unresolved"; specifier: string };

/** One language's parser and resolver. */
export interface LanguageAdapter {
  language: string;
  parser: string;
  parserVersion: string;
  /** Whether this adapter reads a file with this name. */
  handles(file: string): boolean;
  /** The facts of `text`, as the file `file`. */
  facts(file: string, text: string): SourceFacts;
  /** Resolve `specifier` as written in `importer` (both repository-relative) inside `root`. */
  resolve(importer: string, specifier: string, root: string): ResolvedModule;
}
