import { createHash } from "node:crypto";
import type { NetworkRequestRecord } from "@sekhemet/sandbox";

/**
 * A request the network policy decided, as a `harness/egress` event: the host,
 * purpose, verdict and a hash of the URL in the chained payload; the URL itself
 * — whose path and query can carry what a person asked — only in the private
 * part, so erasure removes it (kernel rule 33, B4.9 lead review).
 */
export function egressEvent(r: NetworkRequestRecord): {
  type: "harness/egress";
  payload: Omit<NetworkRequestRecord, "url"> & { urlHash: string };
  private: { url: string };
} {
  const { url, ...rest } = r;
  return {
    type: "harness/egress",
    payload: { ...rest, urlHash: createHash("sha256").update(url).digest("hex") },
    private: { url },
  };
}
