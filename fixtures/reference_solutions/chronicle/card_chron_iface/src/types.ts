/** One event in the chain. `hash` covers every other field, `previousHash` included. */
export interface ChronicleEvent<T = unknown> {
  id: string;
  sequenceNumber: number;
  timestamp: number;
  type: string;
  payload: T;
  previousHash: string;
  hash: string;
  idempotencyKey?: string;
}

/** The result of verifying a chain; the diagnostic fields name the first break. */
export interface AuditReport {
  valid: boolean;
  totalEvents: number;
  corruptedAtSequence?: number;
  expectedHash?: string;
  actualHash?: string;
}
