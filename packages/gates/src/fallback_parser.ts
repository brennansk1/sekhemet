import { RERUN_GATES, gateCopy } from "./copy.js";
import type { CompleteGateFailure, GateRung } from "./types.js";

/**
 * One failure from raw output no dedicated parser reads. `minimalRepro` is
 * the command that produced the output; without one, the `check` tool that
 * runs every gate again.
 */
export function parseErrorToGateFailure(
  rung: GateRung,
  exitCode: number,
  rawOutput: string,
  minimalRepro: string = RERUN_GATES,
): CompleteGateFailure {
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

  const excerpt = errorExcerpt || `Gate ${rung} failed with exit code ${exitCode}`;
  const files = Array.from(suggestedFixFiles);
  return {
    rung,
    gate: rung,
    exitCode,
    errorExcerpt: excerpt,
    suggestedFixFiles: files,
    location: { file: files[0] ?? "." },
    expected: `${rung} to exit 0`,
    actual: excerpt.split("\n")[0] ?? excerpt,
    minimalRepro,
    suggestedAction: gateCopy.rerun(minimalRepro),
  };
}
