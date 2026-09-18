export function extractSymbolOutline(filePath: string, source: string): string {
  const lines = source.split("\n");
  const symbolLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i] ?? "";
    const trimmed = rawLine.trim();

    // Check for exports and top-level definitions
    if (
      trimmed.startsWith("export interface ") ||
      trimmed.startsWith("export type ") ||
      trimmed.startsWith("export enum ")
    ) {
      symbolLines.push(`  ${trimmed.replace(/\{$/, "").trim()}`);
    } else if (trimmed.startsWith("export class ") || trimmed.startsWith("class ")) {
      symbolLines.push(`  ${trimmed.replace(/\{$/, "").trim()}`);
    } else if (trimmed.startsWith("export function ") || trimmed.startsWith("function ")) {
      const sig = trimmed.split("{")[0]?.trim() ?? trimmed;
      symbolLines.push(`  ${sig}`);
    } else if (
      trimmed.startsWith("public ") ||
      trimmed.startsWith("private ") ||
      trimmed.startsWith("protected ")
    ) {
      if (trimmed.includes("(") && trimmed.includes(")")) {
        const sig = trimmed.split("{")[0]?.trim() ?? trimmed;
        symbolLines.push(`    ${sig}`);
      }
    } else if (trimmed.startsWith("export const ") || trimmed.startsWith("export let ")) {
      const decl = trimmed.split("=")[0]?.trim() ?? trimmed;
      symbolLines.push(`  ${decl}`);
    }
  }

  if (symbolLines.length === 0) {
    return `${filePath}: (no exported symbols)`;
  }

  return `${filePath}:\n${symbolLines.join("\n")}`;
}
