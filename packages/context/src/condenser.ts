import type { TurnHistoryItem } from "./prompts.js";

const ESC = String.fromCharCode(27);
const CSI = String.fromCharCode(155);
const ANSI_REGEX = new RegExp(
  `[${ESC}${CSI}][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]`,
  "g",
);

// Regex to detect progress bar lines
const PROGRESS_BAR_REGEX = /(?:\[[=#\-\s>]+\]|\d+%\s+(?:done|complete)|[\u2800-\u28ff])/i;

/**
 * Condenses command stdout/stderr by stripping ANSI formatting,
 * removing progress bars, and keeping head + tail if line count is high.
 */
export function condenseOutput(raw: string, maxLines = 40): string {
  if (!raw) return "";

  // 1. Strip ANSI codes
  const stripped = raw.replace(ANSI_REGEX, "");

  // 2. Split lines and filter transient progress lines
  const lines = stripped.split("\n").filter((line) => !PROGRESS_BAR_REGEX.test(line));

  if (lines.length <= maxLines) {
    return lines.join("\n").trim();
  }

  // 3. Keep head and tail
  const headCount = Math.floor(maxLines / 2);
  const tailCount = maxLines - headCount;

  const head = lines.slice(0, headCount);
  const tail = lines.slice(lines.length - tailCount);
  const omittedCount = lines.length - maxLines;

  return [...head, `... [${omittedCount} lines omitted for context efficiency] ...`, ...tail]
    .join("\n")
    .trim();
}

/**
 * Applies in-place observation masking: replaces tool outputs older
 * than `keepRecentTurns` with compact semantic pointers (Section 183 of Design v2).
 */
export function maskOlderObservations(
  turns: TurnHistoryItem[],
  keepRecentTurns = 2,
): TurnHistoryItem[] {
  const total = turns.length;
  return turns.map((t, idx) => {
    // If within recent window, keep as is
    if (idx >= total - keepRecentTurns) {
      return t;
    }

    // Older turn: mask verbose results into brief semantic pointers
    const lineCount = t.result.split("\n").length;
    if (lineCount > 3 || t.result.length > 120) {
      return {
        turn: t.turn,
        action: t.action,
        result: `[Output of ${t.action} from Turn ${t.turn} preserved in WAL: ${lineCount} lines omitted]`,
      };
    }

    return t;
  });
}

export const ContextCondenser = {
  condenseOutput,
  maskOlderObservations,
};
