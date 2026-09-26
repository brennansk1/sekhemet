import crypto, { createHash, scrypt } from "node:crypto";

export function hashPassword(password: string) {
  // ruleid: sekhemet.js-weak-password-hash
  return crypto.createHash("md5").update(password).digest("hex");
}

export function legacyHash(user: { passwordPlain: string }, salt: string) {
  // ruleid: sekhemet.js-weak-password-hash
  return createHash("sha1")
    .update(user.passwordPlain + salt)
    .digest("base64");
}

export function others(body: string, password: string, salt: string) {
  // ok: sekhemet.js-weak-password-hash
  const etag = createHash("md5").update(body).digest("hex");
  // ok: sekhemet.js-weak-password-hash
  scrypt(password, salt, 64, (err, key) => console.log(err, key, etag));
}
