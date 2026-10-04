import { EDITOR_SNIPPETS, editorSnippet, editorSnippetLines } from "../editor_snippets.js";
import type { CommandHandler } from "./registry.js";

/**
 * `sekhemet editors [vscode|cursor|zed]` (extensibility item 25a,
 * NEW-extensibility-7): the snippet that connects an editor to the board and
 * to Seshat, with where it goes. Prints only; writes no file.
 */
export const editorsCommand: CommandHandler = async (args) => {
  const named = args.positionals[0];
  const snippet = named ? editorSnippet(named) : undefined;
  if (named && !snippet) {
    console.error(
      `sekhemet: no snippet for ${named}; sekhemet editors takes vscode, cursor or zed`,
    );
    return 2;
  }
  for (const line of editorSnippetLines(snippet ? [snippet] : EDITOR_SNIPPETS)) console.log(line);
  return 0;
};
