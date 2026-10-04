/**
 * The editor snippets (extensibility item 25a, NEW-extensibility-7; DEC-55):
 * VS Code and Cursor reach the board through the MCP server (`sekhemet mcp`,
 * items 18–21); Zed reaches Seshat through ACP (`sekhemet acp`, item 25) as
 * a custom agent server, and the board through MCP. `sekhemet editors`
 * prints them, and the user guide shows the same text (C5). Each goes in the
 * person's own, user-level configuration: a copy committed to the repository
 * (`.vscode/`, `.cursor/`, `.mcp.json`) is configuration another tool runs,
 * which Review flags (security item 41). `editor_snippets.spec.ts` starts
 * each command exactly as written and completes its protocol's `initialize`.
 */

export interface EditorSnippet {
  editor: "vscode" | "cursor" | "zed";
  /** The editor's name as people say it. */
  name: string;
  /** Where the snippet goes: the person's own configuration, never the repository's. */
  where: string;
  /** The snippet, JSON, as it is pasted. */
  text: string;
}

const json = (value: unknown) => JSON.stringify(value, null, 2);

export const EDITOR_SNIPPETS: readonly EditorSnippet[] = [
  {
    editor: "vscode",
    name: "VS Code",
    where:
      "Your user mcp.json: Command Palette › MCP: Open User Configuration. Not .vscode/mcp.json in the repository, which Review flags as code that runs later.",
    text: json({
      servers: {
        sekhemet: {
          type: "stdio",
          command: "sekhemet",
          args: ["mcp", "--repo", "${workspaceFolder}"],
        },
      },
    }),
  },
  {
    editor: "cursor",
    name: "Cursor",
    where:
      "Your user file ~/.cursor/mcp.json. Not .cursor/mcp.json in the repository, which Review flags as code that runs later.",
    text: json({
      mcpServers: {
        sekhemet: {
          command: "sekhemet",
          args: ["mcp", "--repo", "${workspaceFolder}"],
        },
      },
    }),
  },
  {
    editor: "zed",
    name: "Zed",
    where:
      'Your user settings, ~/.config/zed/settings.json (Zed › Settings › Open Settings). To serve one project wherever Zed starts them, add "--repo" and that project\'s folder to both args.',
    text: json({
      agent_servers: {
        Sekhemet: {
          type: "custom",
          command: "sekhemet",
          args: ["acp"],
        },
      },
      context_servers: {
        sekhemet: {
          source: "custom",
          command: "sekhemet",
          args: ["mcp"],
        },
      },
    }),
  },
];

export function editorSnippet(editor: string): EditorSnippet | undefined {
  return EDITOR_SNIPPETS.find((s) => s.editor === editor.toLowerCase());
}

/** `sekhemet editors [editor]`'s lines: each snippet with where it goes. */
export function editorSnippetLines(snippets: readonly EditorSnippet[]): string[] {
  return snippets.flatMap((s, i) => [...(i > 0 ? [""] : []), `${s.name}`, s.where, "", s.text]);
}
