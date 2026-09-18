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
    summary: "Search file contents by regular expression.",
    parameters: [
      { name: "query", type: "string", required: true, description: "Regular expression" },
      {
        name: "path",
        type: "string",
        required: false,
        description: "Directory to search, defaults to the worktree",
      },
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
    name: "run_cmd",
    summary: "Run a command in the sandbox. No network access.",
    parameters: [
      { name: "command", type: "string", required: true, description: "Executable name" },
      {
        name: "args",
        type: "array",
        description: "Arguments as separate array elements",
        required: false,
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
