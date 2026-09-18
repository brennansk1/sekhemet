import type { ToolInterfaceSpec } from "@sekhemet/context";

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
    summary: "Find whole-word references to a symbol.",
    parameters: [
      { name: "symbol", type: "string", required: true, description: "Symbol name to find" },
      {
        name: "path",
        type: "string",
        description: "Directory to search, defaults to the worktree",
        required: false,
      },
    ],
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
    summary: "List files matching a glob.",
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
    summary: "Search the project's own documentation.",
    parameters: [
      { name: "query", type: "string", required: true, description: "Text to look for" },
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
