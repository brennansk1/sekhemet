import { createHash } from "node:crypto";
import type { ChronicleEvent } from "./types.js";

/** The previous hash of the first event. */
export const GENESIS_HASH = "0".repeat(64);

/** JSON with object keys sorted at every depth, so equal values serialize identically. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((k) => record[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`).join(",")}}`;
}

/** SHA-256 over the canonical form of an event without its own hash. */
export function hashEvent<T>(event: Omit<ChronicleEvent<T>, "hash">): string {
  return createHash("sha256").update(canonicalJson(event)).digest("hex");
}
