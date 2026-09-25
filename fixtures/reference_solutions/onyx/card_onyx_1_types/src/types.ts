/** An AES-256-GCM envelope; every field is base64. */
export interface CryptoEnvelope {
  salt: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

export interface SecretRecord {
  project: string;
  key: string;
  value: string;
  updatedAt: number;
}

export interface VaultConfig {
  dbPath: string;
  passphrase: string;
  iterations?: number;
}

export type ScanRule = "private-key" | "aws-access-key" | "github-pat" | "high-entropy";

export interface ScanMatch {
  file: string;
  line: number;
  rule: ScanRule;
  excerpt: string;
}
