import { createHash } from "node:crypto";
import type { NetworkRequestRecord } from "@sekhemet/sandbox";

/** A query parameter whose value is a credential (an access token, a key, a signature). */
const CREDENTIAL_PARAM = /token|key|secret|sig|auth|pass|credential|code/i;

/**
 * Whether a URL carries a credential the ledger must never hold: a user or
 * password in it, or a query parameter named like a token, key or signature.
 */
export function carriesCredential(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.username || u.password) return true;
    return [...u.searchParams.keys()].some((k) => CREDENTIAL_PARAM.test(k));
  } catch {
    return false;
  }
}

/** A URL as the ledger may hold it when its path or query is the secret: its origin and `/…`. */
export function redactedUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}/…`;
  } catch {
    return "…";
  }
}

/**
 * A request the network policy decided, as a `harness/egress` event: the host,
 * purpose, verdict and a hash of the URL in the chained payload; the URL itself
 * — whose path and query can carry what a person asked — only in the private
 * part, so erasure removes it (kernel rule 33, B4.9 lead review).
 *
 * A URL that is itself a credential — a Slack incoming webhook, a push
 * topic (`redactUrl`), or any URL carrying a token or a password — is
 * recorded as its origin and `/…` only, and hashed so, so no part of the
 * ledger, private or chained, holds or confirms the secret (B4.9 part 2, B1).
 */
export function egressEvent(
  r: NetworkRequestRecord,
  opts: { redactUrl?: boolean } = {},
): {
  type: "harness/egress";
  payload: Omit<NetworkRequestRecord, "url"> & { urlHash: string };
  private: { url: string };
} {
  const { url, ...rest } = r;
  const kept = opts.redactUrl || carriesCredential(url) ? redactedUrl(url) : url;
  return {
    type: "harness/egress",
    payload: { ...rest, urlHash: createHash("sha256").update(kept).digest("hex") },
    private: { url: kept },
  };
}
