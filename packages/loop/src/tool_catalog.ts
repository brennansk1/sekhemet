import { TOOL_SEARCH_SPEC, type ToolInterfaceSpec } from "@sekhemet/context";
import { type CardKind, cardKind } from "@sekhemet/kernel";

/**
 * The tool catalog, declared for the prompt.
 *
 * Until this existed the executor dispatched fifteen tools the model was never
 * told about, so it could only guess at names and argument shapes. The catalog
 * is sorted and static so it contributes a byte-stable Zone 1 block.
 */
export const TOOL_CATALOG: ToolInterfaceSpec[] = [
  {
    name: "read_file",
    summary: "Read a file, optionally a line range. Read before you edit.",
    parameters: [
      {
        name: "path",
        type: "string",
        required: true,
        description: "Path relative to the worktree",
      },
      { name: "start", type: "number", description: "First line, 1-indexed", required: false },
      { name: "end", type: "number", description: "Last line, inclusive", required: false },
    ],
    returns: "The requested lines, each prefixed with its line number",
  },
  {
    name: "write_file",
    summary: "Create a file or replace its entire contents.",
    parameters: [
      {
        name: "path",
        type: "string",
        required: true,
        description: "Path relative to the worktree",
      },
      { name: "content", type: "string", required: true, description: "Complete file contents" },
    ],
  },
  {
    name: "edit",
    summary: "Replace one unique chunk of text. Fails if the chunk is absent or ambiguous.",
    parameters: [
      {
        name: "path",
        type: "string",
        required: true,
        description: "Path relative to the worktree",
      },
      {
        name: "search",
        type: "string",
        required: true,
        description: "Exact text, must occur once",
      },
      { name: "replace", type: "string", required: true, description: "Replacement text" },
    ],
  },
  {
    name: "replace_lines",
    summary: "Replace an inclusive 1-indexed line range.",
    parameters: [
      {
        name: "path",
        type: "string",
        required: true,
        description: "Path relative to the worktree",
      },
      {
        name: "start",
        type: "number",
        required: true,
        description: "First line to replace, 1-indexed",
      },
      {
        name: "end",
        type: "number",
        required: true,
        description: "Last line to replace, inclusive",
      },
      {
        name: "replacement",
        type: "string",
        required: true,
        description: "Lines to insert in their place",
      },
    ],
  },
  {
    name: "read_symbol",
    summary: "Read one named declaration and its body.",
    parameters: [
      {
        name: "path",
        type: "string",
        required: true,
        description: "Path relative to the worktree",
      },
      { name: "symbol", type: "string", required: true, description: "Declaration name" },
    ],
  },
  {
    name: "replace_symbol_body",
    summary: "Replace the body of a named declaration, preserving indentation.",
    parameters: [
      {
        name: "path",
        type: "string",
        required: true,
        description: "Path relative to the worktree",
      },
      { name: "symbol", type: "string", required: true, description: "Declaration name" },
      {
        name: "body",
        type: "string",
        required: true,
        description: "Statements only, without braces",
      },
    ],
  },
  {
    name: "insert_after_symbol",
    summary: "Insert new code immediately after a named declaration.",
    parameters: [
      {
        name: "path",
        type: "string",
        required: true,
        description: "Path relative to the worktree",
      },
      {
        name: "symbol",
        type: "string",
        required: true,
        description: "Declaration to insert after",
      },
      { name: "content", type: "string", required: true, description: "Code to insert" },
    ],
  },
  {
    name: "find_references",
    summary:
      "Find references to a symbol. TypeScript/JavaScript symbols resolve through imports and re-exports; other files fall back to whole-word matches.",
    parameters: [
      { name: "symbol", type: "string", required: true, description: "Symbol name to find" },
      {
        name: "file",
        type: "string",
        required: false,
        description: "File that declares it, when the name is declared in several",
      },
      {
        name: "path",
        type: "string",
        description: "Directory to search, defaults to the worktree",
        required: false,
      },
    ],
  },
  {
    name: "go_to_definition",
    summary:
      "Where a symbol is declared, with its type as the compiler sees it (TypeScript/JavaScript).",
    parameters: [
      { name: "symbol", type: "string", required: true, description: "Symbol name" },
      {
        name: "file",
        type: "string",
        required: false,
        description: "Limit to declarations in this file",
      },
    ],
  },
  {
    name: "subtask",
    summary:
      "Answer a side question (where is X defined? what does this error mean?) in a separate context with read-only tools; only a short answer comes back.",
    parameters: [
      { name: "question", type: "string", required: true, description: "One specific question" },
      {
        name: "context",
        type: "string",
        required: false,
        description: "What the helper needs to know: an excerpt, the error",
      },
    ],
  },
  TOOL_SEARCH_SPEC,
  {
    name: "run_script",
    summary:
      "Run a short JavaScript function over the repository with read-only helpers (read, grep, find, list) and return what it returns: many lookups in one step. No writes, no network, no require.",
    parameters: [
      {
        name: "code",
        type: "string",
        required: true,
        description:
          "Body of a function; helpers: read(path), grep(regex, dir?), find(glob, dir?), list(dir?). Return a string or JSON.",
      },
    ],
  },
  {
    name: "start_process",
    summary:
      "Start a long-running command in the background (a dev server, a watcher). It gets a free port in $PORT and keeps running across steps.",
    parameters: [
      { name: "name", type: "string", required: true, description: "A short handle, e.g. web" },
      { name: "command", type: "string", required: true, description: "The command line" },
    ],
  },
  {
    name: "read_process",
    summary: "Read a background process's latest output and whether it is still running.",
    parameters: [
      { name: "name", type: "string", required: true, description: "Its handle" },
      { name: "lines", type: "number", required: false, description: "Last N lines, default 40" },
    ],
  },
  {
    name: "write_process",
    summary:
      "Type input into a background process (an interactive prompt, a REPL); a newline is added.",
    parameters: [
      { name: "name", type: "string", required: true, description: "Its handle" },
      { name: "input", type: "string", required: true, description: "The line to send" },
    ],
  },
  {
    name: "stop_process",
    summary: "Stop a background process.",
    parameters: [{ name: "name", type: "string", required: true, description: "Its handle" }],
  },
  {
    name: "browse",
    summary:
      "Load a page and return its rendered text: the card's own app on localhost (use its $PORT), or, on research cards, any URL.",
    parameters: [{ name: "url", type: "string", required: true, description: "The URL" }],
  },
  {
    name: "grep_search",
    summary: "Search file contents by regular expression. Skips gitignored files.",
    parameters: [
      { name: "query", type: "string", required: true, description: "Regular expression" },
      {
        name: "path",
        type: "string",
        required: false,
        description: "Directory to search, defaults to the worktree",
      },
      {
        name: "output_mode",
        type: "string",
        required: false,
        description: "content (default), files_with_matches or count",
        enumValues: ["content", "files_with_matches", "count"],
      },
      { name: "context", type: "number", required: false, description: "Lines around each hit" },
      { name: "glob", type: "string", required: false, description: "File filter, e.g. *.ts" },
      { name: "case_insensitive", type: "boolean", required: false, description: "Ignore case" },
    ],
  },
  {
    name: "find_files",
    summary: "List files matching a glob, newest first; .gitignore is respected.",
    parameters: [
      {
        name: "pattern",
        type: "string",
        required: true,
        description: "Glob, for example src/**/*.ts",
      },
      {
        name: "path",
        type: "string",
        required: false,
        description: "Directory to search, defaults to the worktree",
      },
    ],
  },
  {
    name: "list_dir",
    summary: "List the entries of one directory.",
    parameters: [
      {
        name: "path",
        type: "string",
        required: false,
        description: "Directory, defaults to the worktree root",
      },
    ],
  },
  {
    name: "check",
    summary:
      "Run this card's verification gates now WITHOUT finishing. Returns typed failures. Use it instead of running tsc or tests yourself.",
    parameters: [],
    returns: "PASS, or the failing gates with file, line and message",
  },
  {
    name: "run_cmd",
    summary:
      "Run a build, test or project script in the sandbox. Not for cat, grep or sed: use read_file, grep_search, edit.",
    parameters: [
      {
        name: "command",
        type: "string",
        required: true,
        description: "A full command line, e.g. ls src",
      },
      {
        name: "args",
        type: "array",
        description: "Arguments as separate array elements",
        required: false,
      },
      {
        name: "description",
        type: "string",
        required: false,
        description: "What this command is for, in a few words",
      },
    ],
    returns: "Exit code with condensed stdout and stderr",
  },
  {
    name: "docs",
    summary:
      "Search documentation: the project's docs, and a dependency's README and type declarations at the installed version.",
    parameters: [
      { name: "query", type: "string", required: true, description: "Text to look for" },
      {
        name: "library",
        type: "string",
        required: false,
        description: "A dependency to search at its installed version, for example zod",
      },
    ],
  },
  {
    name: "git_history",
    summary:
      "Search this repository's history before solving something: commit messages and code changes that mention a term, or one commit's diff.",
    parameters: [
      {
        name: "query",
        type: "string",
        required: false,
        description: "Term, error code or symbol to search for",
      },
      { name: "sha", type: "string", required: false, description: "Show this commit instead" },
    ],
    returns: "Matching commits, or the commit's diff",
  },
  {
    name: "dependencies",
    summary: "List the packages this project already has, to use instead of writing your own.",
    parameters: [{ name: "query", type: "string", required: false, description: "Filter by name" }],
    returns: "Installed dependencies with versions",
  },
  {
    name: "ask",
    summary:
      "Ask a question about what the card requires instead of guessing. Answered from the card's spec, Done-when list and rules.",
    parameters: [{ name: "question", type: "string", required: true, description: "The question" }],
    returns: "The relevant parts of the card's contract, or guidance to proceed conservatively",
  },
  {
    name: "recall",
    summary:
      "Fetch the full text of an earlier observation that was compacted. Use the EvidenceRef shown in its placeholder.",
    parameters: [
      {
        name: "ref",
        type: "string",
        required: true,
        description: "The EvidenceRef from a compacted observation",
      },
    ],
    returns: "The original observation text",
  },
  {
    name: "note",
    summary: "Record a short note for the human reviewer.",
    parameters: [{ name: "message", type: "string", required: true, description: "Note text" }],
  },
  {
    name: "finish_card",
    summary: "Declare the work complete. Verification gates run immediately.",
    parameters: [],
    returns: "Gate results; a failure returns you to work with the typed error",
  },
];

/**
 * The restricted-mode catalog (S12): read-only inspection. `run_cmd` is
 * stripped from the interface entirely, and so is every tool that writes.
 */
export const RESTRICTED_TOOL_NAMES: readonly string[] = [
  "read_file",
  "read_symbol",
  "find_references",
  "go_to_definition",
  "subtask",
  "tool_search",
  "run_script",
  "grep_search",
  "find_files",
  "list_dir",
  "check",
  "docs",
  "git_history",
  "dependencies",
  "ask",
  "recall",
  "note",
  "finish_card",
];

export function restrictedToolCatalog(
  catalog: ToolInterfaceSpec[] = TOOL_CATALOG,
): ToolInterfaceSpec[] {
  return catalog.filter((t) => RESTRICTED_TOOL_NAMES.includes(t.name));
}

/**
 * Card classes with fixed tool lists (L18, design: "The board is the
 * subagent system; Explore, Plan, and Implement are card classes with fixed
 * tool lists"; "a reviewer gets read, grep, and glob; an implementer adds
 * edit and bash; a researcher gets read and fetch").
 */
export type CardClass = CardKind;

const READ_TOOLS = [
  "read_file",
  "read_symbol",
  "find_references",
  "go_to_definition",
  "grep_search",
  "find_files",
  "list_dir",
  "docs",
  "git_history",
  "dependencies",
  "recall",
  "note",
  "ask",
  "subtask",
  "tool_search",
  "finish_card",
];

/** Every tool in the catalog: the sets that write code keep the whole catalog until M2's fixed set lands. */
const ALL_TOOLS: readonly string[] = TOOL_CATALOG.map((t) => t.name);

/**
 * An explicit tool set for every card class (worker-loop WL-M2-1): a class
 * with no entry fails to start, naming it, rather than falling open to the
 * full catalog. `implement`, `interface`, `data` and `rule` keep the whole
 * catalog until the fixed set of at most twelve (WL-M2-3) is written.
 */
export const CLASS_TOOLS: Readonly<Record<CardKind, readonly string[]>> = {
  spike: [...READ_TOOLS, "run_script"],
  interface: ALL_TOOLS,
  implement: ALL_TOOLS,
  data: ALL_TOOLS,
  rule: ALL_TOOLS,
  review: [
    "read_file",
    "grep_search",
    "find_files",
    "list_dir",
    "note",
    "recall",
    "check",
    "finish_card",
  ],
  research: [
    "read_file",
    "grep_search",
    "find_files",
    "docs",
    "note",
    "recall",
    "browse",
    "finish_card",
  ],
};

/** A card class with no `CLASS_TOOLS` entry (WL-M2-1). */
export class UnknownCardClassError extends Error {
  constructor(public readonly cardClass: string) {
    super(`No tool set for card class "${cardClass}": add it to CLASS_TOOLS.`);
    this.name = "UnknownCardClassError";
  }
}

/**
 * A card's kind, which is what selects its tool set. One definition, in the
 * kernel: a second classifier here is how the build ended up with three
 * incompatible partitions of the same cards.
 */
export function cardClassFor(card: {
  title: string;
  tier?: string;
  labels?: string[] | undefined;
}): CardClass {
  return cardKind(card);
}

/**
 * The tools a card of this class is given. `run_script` only for a Worker the
 * registry marks script-capable (WL-M2-4).
 */
export function toolsForClass(
  cls: CardClass,
  catalog: ToolInterfaceSpec[] = TOOL_CATALOG,
  options: { scriptCapable?: boolean | undefined } = {},
): ToolInterfaceSpec[] {
  const allowed = Object.hasOwn(CLASS_TOOLS, cls) ? CLASS_TOOLS[cls] : undefined;
  if (!allowed) throw new UnknownCardClassError(String(cls));
  return catalog.filter(
    (t) => allowed.includes(t.name) && (t.name !== "run_script" || options.scriptCapable === true),
  );
}
