import { createHash } from "node:crypto";

/**
 * Deterministic JSON serialization with recursively sorted object keys.
 *
 * WHY this exists: the event chain hashes the payload, and `JSON.stringify`
 * preserves *insertion* order. Two structurally identical payloads built by
 * different code paths — `{cardId, step}` here, `{step, cardId}` there — then
 * hash differently, so `verifyHashChain()` reports tampering for a payload
 * nobody touched. Worse, the reverse is invisible: a payload read back and
 * re-serialized by a different runtime produces a different byte string for the
 * same value, so the chain is only verifiable by the exact process that wrote
 * it. Sorting keys makes the hash a function of the *value*, not of how the
 * value happened to be constructed.
 *
 * This also unblocks relocating large payloads to `.sekhemet/artifacts/`
 * (design §2044): the stored `payload_hash` stays meaningful once the payload
 * itself lives outside the row, because it is reproducible from the blob alone.
 *
 * Deliberately narrower than RFC 8785: numbers use the JS `Number#toString`
 * form rather than the full JCS grammar. That is sufficient because both ends
 * of this chain are Node, and it keeps the function dependency-free.
 */
export function canonicalJson(value: unknown): string {
  return serialize(value) ?? "null";
}

/** SHA-256 of the canonical serialization, as lowercase hex. */
export function canonicalPayloadHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

/**
 * Returns `undefined` for values JSON omits (undefined, functions, symbols) so
 * callers can drop the containing object property, exactly as `JSON.stringify`
 * does. Any other return is a complete JSON text.
 */
function serialize(value: unknown): string | undefined {
  if (value === null) return "null";

  // Honour `toJSON` (Date, and any domain object that defines one) before
  // inspecting the shape, so a Date hashes as its ISO string rather than as {}.
  if (typeof value === "object" && typeof (value as { toJSON?: unknown }).toJSON === "function") {
    return serialize((value as { toJSON: () => unknown }).toJSON());
  }

  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      // JSON has no NaN/Infinity; JSON.stringify emits null, so we match it.
      return Number.isFinite(value) ? String(value) : "null";
    case "bigint":
      throw new TypeError("canonicalJson: BigInt is not serializable to JSON");
    case "string":
      return JSON.stringify(value);
    case "undefined":
    case "function":
    case "symbol":
      return undefined;
    default:
      break;
  }

  if (Array.isArray(value)) {
    // Array position is semantic, so order is preserved. Holes and
    // non-serializable entries become null, as in JSON.stringify.
    const items = value.map((item) => serialize(item) ?? "null");
    return `[${items.join(",")}]`;
  }

  const entries: string[] = [];
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const serialized = serialize((value as Record<string, unknown>)[key]);
    if (serialized === undefined) continue;
    entries.push(`${JSON.stringify(key)}:${serialized}`);
  }
  return `{${entries.join(",")}}`;
}
