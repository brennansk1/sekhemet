import crypto, { createCipheriv, createDecipheriv } from "node:crypto";

export function legacy(password: string, key: Buffer, iv: Buffer) {
  // ruleid: sekhemet.js-weak-cipher
  const a = crypto.createCipher("aes192", password);
  // ruleid: sekhemet.js-weak-cipher
  const b = createCipheriv("des-ede3-cbc", key, iv);
  // ruleid: sekhemet.js-weak-cipher
  const c = createDecipheriv("aes-128-ecb", key, null);
  // ruleid: sekhemet.js-weak-cipher
  const d = createCipheriv("RC4", key, "");
  return [a, b, c, d];
}

export function modern(key: Buffer, iv: Buffer) {
  // ok: sekhemet.js-weak-cipher
  const e = createCipheriv("aes-256-gcm", key, iv);
  // ok: sekhemet.js-weak-cipher
  const f = createDecipheriv("chacha20-poly1305", key, iv, { authTagLength: 16 });
  return [e, f];
}
