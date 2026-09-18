import { describe, expect, it } from "vitest";
import { DEFAULT_ITERATIONS, decrypt, deriveKey, encrypt } from "../src/crypto.js";
import type { CryptoEnvelope } from "../src/types.js";

/** Low iteration count so the suite stays fast; the default is checked separately. */
const FAST = 1000;

/** Return a copy of a base64 field with one bit of byte `index` flipped. */
function flipBit(b64: string, index = 0): string {
  const bytes = Buffer.from(b64, "base64");
  bytes[index] = (bytes[index] ?? 0) ^ 0x01;
  return bytes.toString("base64");
}

describe("onyx crypto: key derivation", () => {
  it("matches the published PBKDF2-HMAC-SHA256 test vector", () => {
    const key = deriveKey("password", Buffer.from("salt"), 1);
    expect(key.toString("hex")).toBe(
      "120fb6cffcf8b32c43e7225256c4f837a86548c92ccc35480805987cb70be17b",
    );
  });

  it("derives a 32-byte key and defaults to 100000 iterations", () => {
    expect(DEFAULT_ITERATIONS).toBe(100000);
    const salt = Buffer.from("onyx-salt-000000");
    const byDefault = deriveKey("pw", salt);
    expect(byDefault.length).toBe(32);
    expect(byDefault.equals(deriveKey("pw", salt, 100000))).toBe(true);
  });

  it("produces different keys for a different salt or passphrase", () => {
    const a = deriveKey("pw", Buffer.from("salt-a"), FAST).toString("hex");
    expect(deriveKey("pw", Buffer.from("salt-b"), FAST).toString("hex")).not.toBe(a);
    expect(deriveKey("pW", Buffer.from("salt-a"), FAST).toString("hex")).not.toBe(a);
  });
});

describe("onyx crypto: AES-256-GCM envelopes", () => {
  it("round-trips ASCII and multi-byte UTF-8 plaintext", () => {
    const ascii = encrypt("sk_live_123", "correct horse", FAST);
    expect(decrypt(ascii, "correct horse", FAST)).toBe("sk_live_123");
    const unicode = encrypt("pässwörd-密码-🔑", "correct horse", FAST);
    expect(decrypt(unicode, "correct horse", FAST)).toBe("pässwörd-密码-🔑");
  });

  it("round-trips an empty string", () => {
    const env = encrypt("", "pw", FAST);
    expect(Buffer.from(env.ciphertext, "base64").length).toBe(0);
    expect(decrypt(env, "pw", FAST)).toBe("");
  });

  it("uses a 16-byte salt, 12-byte IV, 16-byte tag and unpadded ciphertext", () => {
    const env = encrypt("hello world", "pw", FAST);
    expect(Object.keys(env).sort()).toEqual(["ciphertext", "iv", "salt", "tag"]);
    expect(Buffer.from(env.salt, "base64").length).toBe(16);
    expect(Buffer.from(env.iv, "base64").length).toBe(12);
    expect(Buffer.from(env.tag, "base64").length).toBe(16);
    expect(Buffer.from(env.ciphertext, "base64").length).toBe(11);
  });

  it("never reuses a salt or IV and never emits the plaintext", () => {
    const a = encrypt("same secret", "pw", FAST);
    const b = encrypt("same secret", "pw", FAST);
    expect(a.iv).not.toBe(b.iv);
    expect(a.salt).not.toBe(b.salt);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(JSON.stringify(a).includes("same secret")).toBe(false);
  });

  it("rejects the wrong passphrase", () => {
    const env = encrypt("secret", "right", FAST);
    expect(() => decrypt(env, "wrong", FAST)).toThrow("decryption failed");
  });

  it("rejects a mismatched iteration count", () => {
    const env = encrypt("secret", "pw", FAST);
    expect(() => decrypt(env, "pw", FAST + 1)).toThrow("decryption failed");
  });

  it("detects a single flipped bit in the ciphertext", () => {
    const env = encrypt("transfer 100", "pw", FAST);
    const tampered: CryptoEnvelope = { ...env, ciphertext: flipBit(env.ciphertext, 3) };
    expect(() => decrypt(tampered, "pw", FAST)).toThrow("decryption failed");
  });

  it("detects a single flipped bit in the auth tag", () => {
    const env = encrypt("transfer 100", "pw", FAST);
    const tampered: CryptoEnvelope = { ...env, tag: flipBit(env.tag, 15) };
    expect(() => decrypt(tampered, "pw", FAST)).toThrow("decryption failed");
  });

  it("detects a flipped bit in the IV or the salt", () => {
    const env = encrypt("transfer 100", "pw", FAST);
    expect(() => decrypt({ ...env, iv: flipBit(env.iv) }, "pw", FAST)).toThrow("decryption failed");
    expect(() => decrypt({ ...env, salt: flipBit(env.salt) }, "pw", FAST)).toThrow(
      "decryption failed",
    );
  });

  it("rejects a truncated auth tag instead of accepting a short one", () => {
    const env = encrypt("transfer 100", "pw", FAST);
    const shortTag = Buffer.from(env.tag, "base64").subarray(0, 8).toString("base64");
    expect(() => decrypt({ ...env, tag: shortTag }, "pw", FAST)).toThrow("decryption failed");
  });

  it("rejects an IV of the wrong length", () => {
    const env = encrypt("transfer 100", "pw", FAST);
    const longIv = Buffer.alloc(16, 7).toString("base64");
    expect(() => decrypt({ ...env, iv: longIv }, "pw", FAST)).toThrow("decryption failed");
  });
});
