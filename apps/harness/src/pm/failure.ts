/**
 * Why Seshat could not reply, in a plain sentence (FINDINGS PM-01, K3 item
 * 12; dashboard §2.7 item 8: *Seshat couldn't reply.* with `Retry`). The
 * exception's own text — an environment variable, a loopback address, an
 * API path — goes to the server's log, never into the conversation; the
 * cause lets the page link a missing model to Configuration › Models.
 */

export type SeshatFailureCause = "no_model" | "timeout" | "other";

export interface SeshatFailure {
  cause: SeshatFailureCause;
  /** What the person reads: why, and what to do. */
  text: string;
}

const KEPT = "Your message is kept";

const WORDS: Record<SeshatFailureCause, string> = {
  no_model: `No model is answering for Seshat on this machine right now. ${KEPT}: set up a Planning model in Configuration › Models, then press Retry.`,
  timeout: `The Planning model took too long to answer. ${KEPT}: press Retry, or ask a shorter question.`,
  other: `Something went wrong while the Planning model answered. ${KEPT}: press Retry. The details are in the server's log.`,
};

/** The causes that mean no model could be reached or loaded at all. */
const NO_MODEL = [
  /model loads are off/i,
  /ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ECONNRESET/,
  /fetch failed/i,
  /not installed|not in the registry|no such model|unknown model|model .*not found|no weights/i,
  /no model (is )?(configured|assigned|set)/i,
  /could not load|failed to load|server (did not|never) start/i,
];

const TIMEOUT = [/timed? ?out|timeout|ETIMEDOUT|aborted due to timeout|deadline/i];

function codeOf(err: unknown): string {
  const code = (err as { code?: unknown; cause?: { code?: unknown } } | undefined)?.code;
  if (typeof code === "string") return code;
  const inner = (err as { cause?: { code?: unknown } } | undefined)?.cause?.code;
  return typeof inner === "string" ? inner : "";
}

/**
 * Seshat's model is not set up on this machine (N0, c6 #3): what is missing
 * and where to set it up, said before anything loads (`pm/seshat_model.ts`).
 */
export class SeshatNotSetUp extends Error {
  public constructor(public readonly text: string) {
    super(text);
    this.name = "SeshatNotSetUp";
  }
}

/** The worded failure for an error a model call threw. */
export function seshatFailure(err: unknown): SeshatFailure {
  if (err instanceof SeshatNotSetUp) return { cause: "no_model", text: err.text };
  const raw = `${err instanceof Error ? err.message : String(err)} ${codeOf(err)}`;
  const cause: SeshatFailureCause = TIMEOUT.some((r) => r.test(raw))
    ? "timeout"
    : NO_MODEL.some((r) => r.test(raw))
      ? "no_model"
      : "other";
  return { cause, text: WORDS[cause] };
}

/**
 * The failure as its asker reads it (loop sweep 3; teams items 6, 9): a
 * person who cannot change the server's configuration — anyone below Admin
 * in the Team setup — is told an Admin sets the model up, never to do it
 * themselves; what is missing is said to them as to anyone.
 */
export function failureForAsker(f: SeshatFailure, mayConfigure: boolean): SeshatFailure {
  if (mayConfigure || f.cause !== "no_model") return f;
  const at = f.text.indexOf(`${KEPT}:`);
  const why = at >= 0 ? f.text.slice(0, at) : `${f.text} `;
  return {
    ...f,
    text: `${why}${KEPT}: an Admin sets up a Planning model in Configuration › Models; press Retry once they have.`,
  };
}

/** The exception's own text, for the server's log (never the conversation). */
export function failureDetail(err: unknown): string {
  return err instanceof Error ? (err.stack ?? err.message) : String(err);
}
