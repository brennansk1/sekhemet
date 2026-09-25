import { createHmac, timingSafeEqual } from "node:crypto";
import type { VerificationResult } from "./types.js";

export const DEFAULT_TOLERANCE_SECONDS = 300;

const HEX = /^(?:[0-9a-f]{2})+$/i;

export function computeHmacHex(secret: string, payload: Buffer | string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

/** Constant-time comparison of two hex strings; false for anything that is not even-length hex. */
export function safeEqualHex(a: string, b: string): boolean {
  if (!HEX.test(a) || !HEX.test(b) || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

export function signStripe(secret: string, payload: Buffer | string, timestamp: number): string {
  const signed = Buffer.concat([Buffer.from(`${timestamp}.`), Buffer.from(payload)]);
  return `t=${timestamp},v1=${computeHmacHex(secret, signed)}`;
}

export function signGithub(secret: string, payload: Buffer | string): string {
  return `sha256=${computeHmacHex(secret, payload)}`;
}

const failed = (scheme: "stripe" | "github", reason: string): VerificationResult => ({
  status: "failed",
  scheme,
  reason,
});

export function verifyStripe(
  header: string | undefined,
  payload: Buffer,
  secret: string,
  nowSeconds: number,
  toleranceSeconds: number = DEFAULT_TOLERANCE_SECONDS,
): VerificationResult {
  if (header === undefined || header === "") return failed("stripe", "missing signature header");
  let t: string | undefined;
  const v1: string[] = [];
  for (const part of header.split(",")) {
    const at = part.indexOf("=");
    if (at < 0) continue;
    const key = part.slice(0, at);
    const value = part.slice(at + 1);
    if (key === "t") t = value;
    else if (key === "v1") v1.push(value);
  }
  if (t === undefined || !/^\d+$/.test(t) || v1.length === 0) {
    return failed("stripe", "malformed signature header");
  }
  const timestamp = Number(t);
  if (Math.abs(nowSeconds - timestamp) > toleranceSeconds) {
    return failed("stripe", "timestamp outside tolerance");
  }
  const expected = signStripe(secret, payload, timestamp).slice(`t=${t},v1=`.length);
  if (v1.some((candidate) => safeEqualHex(expected, candidate))) {
    return { status: "verified", scheme: "stripe" };
  }
  return failed("stripe", "signature mismatch");
}

export function verifyGithub(
  header: string | undefined,
  payload: Buffer,
  secret: string,
): VerificationResult {
  if (header === undefined || header === "") return failed("github", "missing signature header");
  if (!header.startsWith("sha256=")) return failed("github", "malformed signature header");
  const expected = computeHmacHex(secret, payload);
  if (safeEqualHex(expected, header.slice("sha256=".length))) {
    return { status: "verified", scheme: "github" };
  }
  return failed("github", "signature mismatch");
}
