import * as v from "valibot";
import { CARD_STATUSES } from "./transitions.js";

/**
 * The payload schema registry (kernel rule 33, S7: K-S7-4, K-S7-9, K-S7-10).
 *
 * One Valibot schema per event type ([DEC-29] O7), every field marked with
 * its data class. `structural` fields — ids, states, numbers, hashes,
 * enumerations — go in the hashed `payload`; `personal`, `free_text` and
 * `secret_bearing` fields go only in the event's erasable private part. A
 * write that fails its schema, or puts a non-structural field in `payload`,
 * is refused before anything is appended, naming the event type and field.
 *
 * An event type absent from the registry is not checked here (its writer
 * validates it); types are added as their writers route free text to the
 * private part.
 */
export const DATA_CLASSES = ["structural", "personal", "free_text", "secret_bearing"] as const;
export type DataClass = (typeof DATA_CLASSES)[number];

export interface PayloadField {
  dataClass: DataClass;
  schema: v.GenericSchema;
  /** The field may be absent. */
  optional?: boolean;
}

/** One event type's fields, payload and private part together. */
export type PayloadSchema = Readonly<Record<string, PayloadField>>;

const PRINCIPAL = v.pipe(v.string(), v.regex(/^p_[0-9a-z]+$/, "an opaque principal id (p_…)"));
const ID = v.pipe(v.string(), v.minLength(1));
const STATUS = v.picklist(CARD_STATUSES as readonly string[] as string[]);
const DELEGATE = v.nullable(
  v.strictObject({ kind: v.picklist(["worker", "person"]), id: v.optional(PRINCIPAL) }),
);
const TEXT = v.string();

const s = (schema: v.GenericSchema, optional = false): PayloadField => ({
  dataClass: "structural",
  schema,
  ...(optional ? { optional } : {}),
});
const priv = (dataClass: Exclude<DataClass, "structural">, schema: v.GenericSchema) => ({
  dataClass,
  schema,
  optional: true,
});

export const PAYLOAD_SCHEMAS: Readonly<Record<string, PayloadSchema>> = {
  "person/created": {
    principal: s(PRINCIPAL),
    local: s(v.boolean(), true),
    email: priv("personal", TEXT),
    name: priv("personal", TEXT),
  },
  "card/override": {
    id: s(ID),
    from: s(STATUS),
    to: s(STATUS),
    overrode: s(TEXT),
    principal: s(PRINCIPAL, true),
    reason: priv("free_text", TEXT),
  },
  "playbook/candidate": {
    cardId: s(ID),
    reason: priv("free_text", TEXT),
  },
  "card/delegated": { id: s(ID), from: s(DELEGATE), to: s(DELEGATE) },
  "card/owner_changed": {
    id: s(ID),
    from: s(v.nullable(PRINCIPAL)),
    to: s(v.nullable(PRINCIPAL)),
  },
  "card/pr_opened": {
    id: s(ID),
    pr: s(v.pipe(v.number(), v.integer(), v.minValue(1))),
    url: s(TEXT),
    headSha: s(TEXT),
    accepter: s(PRINCIPAL, true),
  },
  "card/pr_closed": {
    id: s(ID),
    pr: s(v.pipe(v.number(), v.integer(), v.minValue(1))),
    merged: s(v.boolean()),
  },
  // NEW-kernel-8: requirement versions and suspect links.
  "requirement/created": {
    id: s(ID),
    version: s(v.pipe(v.number(), v.integer(), v.minValue(1))),
    title: priv("free_text", TEXT),
  },
  "requirement/revised": {
    id: s(ID),
    version: s(v.pipe(v.number(), v.integer(), v.minValue(2))),
    title: priv("free_text", TEXT),
  },
  "trace/linked": {
    requirementId: s(ID),
    version: s(v.pipe(v.number(), v.integer(), v.minValue(1))),
    from: s(v.picklist(["card", "test"])),
    ref: s(ID),
  },
  "trace/confirmed": {
    requirementId: s(ID),
    version: s(v.pipe(v.number(), v.integer(), v.minValue(1))),
    from: s(v.picklist(["card", "test"])),
    ref: s(ID),
  },
};

function objectOf(fields: [string, PayloadField][]): v.GenericSchema {
  return v.strictObject(
    Object.fromEntries(fields.map(([k, f]) => [k, f.optional ? v.optional(f.schema) : f.schema])),
  );
}

function refuse(type: string, part: string, issues: v.BaseIssue<unknown>[]): never {
  const issue = issues[0];
  const field = (issue && v.getDotPath(issue)) ?? issue?.path?.[0]?.key ?? "(payload)";
  throw new Error(
    `A ${type} event's ${part} fails its schema at field ${String(field)}: ${issue?.message ?? "invalid"} (kernel rule 33, K-S7-4)`,
  );
}

/**
 * Check one event against its registered schema (K-S7-4, K-S7-9). Throws,
 * naming the type and the field; returns nothing when the type is unregistered.
 */
export function checkEventPayload(
  type: string,
  payload: unknown,
  privatePart: Record<string, unknown> | undefined,
): void {
  const schema = PAYLOAD_SCHEMAS[type];
  if (!schema) return;
  const entries = Object.entries(schema);
  if (payload !== null && typeof payload === "object" && !Array.isArray(payload)) {
    for (const key of Object.keys(payload)) {
      const field = schema[key];
      if (field && field.dataClass !== "structural") {
        throw new Error(
          `A ${type} event's field ${key} is ${field.dataClass}: it goes in the event's private part, never in the payload (kernel rule 33, K-S7-9)`,
        );
      }
    }
  }
  const structural = entries.filter(([, f]) => f.dataClass === "structural");
  const payloadResult = v.safeParse(objectOf(structural), payload);
  if (!payloadResult.success) refuse(type, "payload", payloadResult.issues);
  if (privatePart !== undefined) {
    const nonStructural = entries.filter(([, f]) => f.dataClass !== "structural");
    const privateResult = v.safeParse(objectOf(nonStructural), privatePart);
    if (!privateResult.success) refuse(type, "private part", privateResult.issues);
  }
}
