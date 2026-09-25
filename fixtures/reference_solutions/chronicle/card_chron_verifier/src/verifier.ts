import { GENESIS_HASH, hashEvent } from "./hasher.js";
import type { AuditReport, ChronicleEvent } from "./types.js";

/** Walk the chain in order and report the first event that breaks it. */
export function verifyChain(events: readonly ChronicleEvent[]): AuditReport {
  let previousHash = GENESIS_HASH;
  let expectedSequence = 1;
  for (const event of events) {
    if (event.sequenceNumber !== expectedSequence) {
      return {
        valid: false,
        totalEvents: events.length,
        corruptedAtSequence: event.sequenceNumber,
      };
    }
    if (event.previousHash !== previousHash) {
      return {
        valid: false,
        totalEvents: events.length,
        corruptedAtSequence: event.sequenceNumber,
        expectedHash: previousHash,
        actualHash: event.previousHash,
      };
    }
    const { hash, ...rest } = event;
    const recomputed = hashEvent(rest);
    if (recomputed !== hash) {
      return {
        valid: false,
        totalEvents: events.length,
        corruptedAtSequence: event.sequenceNumber,
        expectedHash: recomputed,
        actualHash: hash,
      };
    }
    previousHash = hash;
    expectedSequence++;
  }
  return { valid: true, totalEvents: events.length };
}
