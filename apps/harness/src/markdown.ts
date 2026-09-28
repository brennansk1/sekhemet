import { Lexer, type Token, type Tokens } from "marked";

/**
 * Reading project documents as Markdown (DEC-44: `marked`, the one parser
 * for the brief, the requirements, decision records and the design stage's
 * brief). A heading, list or line inside a code block or an HTML comment is
 * not structure, a wrapped list item is one item, and any bullet marker
 * starts a list — as a person's Markdown editor reads the file.
 */
export type { Token, Tokens };

/** A document's top-level blocks, GitHub-flavoured. */
export function markdownBlocks(text: string): Token[] {
  return Lexer.lex(text, { gfm: true });
}

export function isHeading(block: Token): block is Tokens.Heading {
  return block.type === "heading";
}

/** A paragraph's lines, trimmed, with any inline HTML comment left out. */
export function paragraphLines(p: Tokens.Paragraph | Tokens.Text): string[] {
  const text = p.tokens
    ? p.tokens
        .filter((t) => !(t.type === "html" && /^<!--/.test(t.raw)))
        .map((t) => t.raw)
        .join("")
    : p.text;
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

/** A list item's own text on one line: its first block, not a list nested in it. */
export function listItemText(item: Tokens.ListItem): string {
  const first = item.tokens.find((t) => t.type === "text" || t.type === "paragraph") as
    | Tokens.Text
    | Tokens.Paragraph
    | undefined;
  return (first ? paragraphLines(first).join(" ") : item.text.trim()).trim();
}

/**
 * The lines a block says, for a section read line by line: a paragraph's
 * lines, each list item (nested ones too) on one line, a code block's lines
 * as written, a quote's contents; an HTML block (a comment) says nothing.
 */
export function blockLines(block: Token): string[] {
  switch (block.type) {
    case "paragraph":
    case "text":
      return paragraphLines(block as Tokens.Paragraph);
    case "list":
      return (block as Tokens.List).items.flatMap((item) => [
        listItemText(item),
        ...item.tokens.filter((t) => t.type === "list").flatMap(blockLines),
      ]);
    case "code":
      return (block as Tokens.Code).text
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
    case "blockquote":
      return (block as Tokens.Blockquote).tokens.flatMap(blockLines);
    default:
      return [];
  }
}
