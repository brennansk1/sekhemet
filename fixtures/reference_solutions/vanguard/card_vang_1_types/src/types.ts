export type VerificationStatus = "verified" | "failed" | "unsigned";

export type SignatureScheme = "stripe" | "github" | "none";

export interface VerificationResult {
  status: VerificationStatus;
  scheme: SignatureScheme;
  reason?: string;
}

export interface HmacConfig {
  stripeSecret?: string;
  githubSecret?: string;
  toleranceSeconds?: number;
}

export interface WebhookEvent {
  id: number;
  source: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  /** Raw bytes; a Buffer at run time. */
  body: Uint8Array;
  receivedAt: number;
  verification: VerificationStatus;
}

export interface ReplayRequest {
  eventId: number;
  targetUrl: string;
  headerOverrides?: Record<string, string>;
}

export interface ReplayResult {
  eventId: number;
  status: number;
  durationMs: number;
  responseBody: string;
}
