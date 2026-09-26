import { type DeclarationFact, factsOfText } from "@sekhemet/gates";

/**
 * The flat map's outline of one file, from the source index's facts (gates
 * T2, context rule 13b): each declaration's own first line, bodies left out
 * — exported interfaces, types, enums, constants and lets; every top-level
 * class and function; and class methods that declare a visibility.
 */
export function extractSymbolOutline(filePath: string, source: string): string {
  const lines = source.split("\n");
  const firstLine = (d: DeclarationFact) => (lines[d.line - 1] ?? "").trim();
  const symbolLines: string[] = [];
  const shown = new Set<number>();
  const facts = factsOfText(filePath, source);
  for (const d of [...facts.declarations].sort((a, b) => a.start - b.start)) {
    if (shown.has(d.line)) continue;
    const line = firstLine(d);
    let rendered: string | undefined;
    if (d.topLevel && d.exportedAtDeclaration && ["interface", "type", "enum"].includes(d.kind)) {
      rendered = `  ${line.replace(/\{$/, "").trim()}`;
    } else if (d.topLevel && d.kind === "class") {
      rendered = `  ${line.replace(/\{$/, "").trim()}`;
    } else if (d.topLevel && d.kind === "function") {
      rendered = `  ${line.split("{")[0]?.trim() ?? line}`;
    } else if (d.kind === "method" && d.containerKind === "class" && d.visibility) {
      rendered = `    ${line.split("{")[0]?.trim() ?? line}`;
    } else if (d.topLevel && d.exportedAtDeclaration && (d.kind === "const" || d.kind === "let")) {
      rendered = `  ${line.split("=")[0]?.trim() ?? line}`;
    }
    if (!rendered) continue;
    shown.add(d.line);
    symbolLines.push(rendered);
  }

  if (symbolLines.length === 0) {
    return `${filePath}: (no exported symbols)`;
  }

  return `${filePath}:\n${symbolLines.join("\n")}`;
}
