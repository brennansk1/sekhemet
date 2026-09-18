import type { GateFailure, GateRung } from "./types.js";

export function parseErrorToGateFailure(
  rung: GateRung,
  exitCode: number,
  rawOutput: string,
): GateFailure {
  const lines = rawOutput.split("\n");
  const suggestedFixFiles = new Set<string>();

  // Extract source files referenced in error lines
  const fileRegex = /([a-zA-Z0-9_\-./]+\.(?:ts|tsx|js|jsx|json|md))/g;

  for (const line of lines) {
    let match: RegExpExecArray | null = fileRegex.exec(line);
    while (match !== null) {
      const path = match[1];
      if (
        path &&
        !path.includes("node_modules") &&
        !path.startsWith("/") &&
        !path.includes("dist/")
      ) {
        suggestedFixFiles.add(path);
      }
      match = fileRegex.exec(line);
    }
  }

  // Filter and extract top error lines (up to 10 lines)
  const errorLines: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (
      trimmed.includes("error") ||
      trimmed.includes("Error") ||
      trimmed.includes("FAIL") ||
      trimmed.includes("AssertionError") ||
      trimmed.startsWith("❯") ||
      trimmed.startsWith("×")
    ) {
      errorLines.push(trimmed);
    }
    if (errorLines.length >= 10) break;
  }

  const errorExcerpt =
    errorLines.length > 0
      ? errorLines.join("\n")
      : lines
          .slice(0, 8)
          .map((l) => l.trim())
          .filter(Boolean)
          .join("\n");

  return {
    rung,
    exitCode,
    errorExcerpt: errorExcerpt || `Gate ${rung} failed with exit code ${exitCode}`,
    suggestedFixFiles: Array.from(suggestedFixFiles),
  };
}
