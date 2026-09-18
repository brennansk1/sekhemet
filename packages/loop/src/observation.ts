/** The result of one tool execution, as the model will see it. */
export interface ToolObservation {
  tool: string;
  /** False for any failure: bad args, missing file, denial, non-zero exit. */
  ok: boolean;
  /** One compact line retained in long-term turn history. */
  summary: string;
  /** Full text fed back to the model on the turn it was produced. */
  content: string;
  /** True when a permission tier blocked the call rather than it merely failing. */
  denied?: boolean;
  /** The permission rule that refused the call (scope, protected_file, ...). */
  deniedRule?: string;
}

const HEAD_CHARS = 2400;
const TAIL_CHARS = 1200;

/**
 * Clamp a large tool output, keeping the head and tail.
 *
 * Compiler and test output puts the useful signal at both ends — the first
 * errors and the final summary line — so a middle elision preserves more than
 * a simple head truncation would.
 */
export function clampObservation(text: string, label = "output"): string {
  if (text.length <= HEAD_CHARS + TAIL_CHARS) return text;
  const omitted = text.length - HEAD_CHARS - TAIL_CHARS;
  return [
    text.slice(0, HEAD_CHARS),
    `\n... [${omitted} chars of ${label} omitted; ${text.length} total] ...\n`,
    text.slice(-TAIL_CHARS),
  ].join("");
}

export function ok(tool: string, summary: string, content = summary): ToolObservation {
  return { tool, ok: true, summary, content };
}

export function fail(tool: string, summary: string, content = summary): ToolObservation {
  return { tool, ok: false, summary, content };
}

export function denied(tool: string, reason: string): ToolObservation {
  return {
    tool,
    ok: false,
    denied: true,
    summary: `DENIED: ${reason}`,
    content: `PERMISSION DENIED for ${tool}: ${reason}\nDo not retry this call. Choose a different approach within your declared scope.`,
  };
}
