import crypto from "node:crypto";

export function issue(user: string) {
  // ruleid: sekhemet.js-insecure-random-secret
  const resetToken = Math.random().toString(36).slice(2);
  // ruleid: sekhemet.js-insecure-random-secret
  const session = { sessionId: Math.random().toString(16).slice(2), user };
  // ruleid: sekhemet.js-insecure-random-secret
  const apiKey: string = `k_${Math.floor(Math.random() * 1e16)}`;
  return { resetToken, session, apiKey };
}

export function fine(bucket: { size: number }) {
  // ok: sekhemet.js-insecure-random-secret
  const token = crypto.randomBytes(32).toString("hex");
  // ok: sekhemet.js-insecure-random-secret
  const delayMs = 100 + Math.random() * 50;
  // ok: sekhemet.js-insecure-random-secret
  const jitter = Math.random() * bucket.size;
  return { token, delayMs, jitter };
}
