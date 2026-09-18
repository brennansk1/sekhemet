/** The line terminator a file uses on disk. */
export type Eol = "\n" | "\r\n";

/**
 * Detect a file's dominant line ending.
 *
 * We count rather than sampling the first match so a single stray `\r\n` in an
 * otherwise-LF file does not flip the whole file on the next write.
 */
export function detectEol(source: string): Eol {
  let crlf = 0;
  let lf = 0;
  for (let i = 0; i < source.length; i++) {
    if (source[i] === "\n") {
      if (i > 0 && source[i - 1] === "\r") crlf++;
      else lf++;
    }
  }
  return crlf > lf ? "\r\n" : "\n";
}

/** Convert any mix of CRLF/CR/LF to pure LF, so matching and splitting are uniform. */
export function toLf(source: string): string {
  return source.replace(/\r\n?/g, "\n");
}

/** Re-apply `eol` to an LF-normalized string. */
export function applyEol(source: string, eol: Eol): string {
  return eol === "\n" ? source : source.replace(/\n/g, "\r\n");
}

/**
 * Split into lines without losing a trailing-newline distinction.
 *
 * `"a\nb\n"` and `"a\nb"` both yield `["a","b"]`; `hadTrailingNewline` records
 * which it was so a rejoin is byte-identical to the original.
 */
export function splitLines(source: string): { lines: string[]; hadTrailingNewline: boolean } {
  const normalized = toLf(source);
  const hadTrailingNewline = normalized.endsWith("\n");
  const body = hadTrailingNewline ? normalized.slice(0, -1) : normalized;
  return { lines: body.split("\n"), hadTrailingNewline };
}

/** Inverse of {@link splitLines}, restoring the original terminator style. */
export function joinLines(lines: string[], hadTrailingNewline: boolean, eol: Eol): string {
  const joined = lines.join("\n") + (hadTrailingNewline ? "\n" : "");
  return applyEol(joined, eol);
}

/** The leading whitespace of `line` (tabs or spaces, whichever the file uses). */
export function leadingIndent(line: string): string {
  return /^[ \t]*/.exec(line)?.[0] ?? "";
}

/**
 * Strip the common leading indentation shared by every non-blank line.
 *
 * Model-authored bodies arrive at arbitrary indentation; dedenting first lets
 * {@link reindentBlock} apply the target indentation exactly once.
 */
export function dedentBlock(block: string): string {
  const lines = toLf(block).split("\n");
  const indents = lines.filter((l) => l.trim().length > 0).map((l) => leadingIndent(l).length);

  if (indents.length === 0) return block;
  const common = Math.min(...indents);
  if (common === 0) return lines.join("\n");

  return lines.map((l) => (l.trim().length > 0 ? l.slice(common) : l)).join("\n");
}

/**
 * Re-indent `block` so every non-blank line sits at `indent`.
 *
 * Blank lines stay genuinely empty rather than becoming trailing-whitespace,
 * which keeps the result clean under formatters and lint rules.
 */
export function reindentBlock(block: string, indent: string): string {
  const dedented = dedentBlock(block);
  return dedented
    .split("\n")
    .map((l) => (l.trim().length > 0 ? indent + l : ""))
    .join("\n");
}
