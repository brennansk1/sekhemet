import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from "node:crypto";
import type { CryptoEnvelope } from "./types.js";

export const DEFAULT_ITERATIONS = 100_000;

/** PBKDF2-HMAC-SHA256, 32 bytes. */
export function deriveKey(
  passphrase: string,
  salt: Buffer,
  iterations: number = DEFAULT_ITERATIONS,
): Buffer {
  return pbkdf2Sync(passphrase, salt, iterations, 32, "sha256");
}

/** Encrypt with a fresh salt and IV under AES-256-GCM. */
export function encrypt(
  plaintext: string,
  passphrase: string,
  iterations: number = DEFAULT_ITERATIONS,
): CryptoEnvelope {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = deriveKey(passphrase, salt, iterations);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

/** Reverse `encrypt`; any failure is reported as "decryption failed". */
export function decrypt(
  envelope: CryptoEnvelope,
  passphrase: string,
  iterations: number = DEFAULT_ITERATIONS,
): string {
  try {
    const salt = Buffer.from(envelope.salt, "base64");
    const iv = Buffer.from(envelope.iv, "base64");
    const tag = Buffer.from(envelope.tag, "base64");
    if (iv.length !== 12 || tag.length !== 16) throw new Error("bad lengths");
    const key = deriveKey(passphrase, salt, iterations);
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new Error("decryption failed");
  }
}
