import { describe, expect, it } from "vitest";
import { PAYLOAD_SCHEMAS, checkEventPayload } from "../src/payload_registry.js";

// B4.1 part (b), dashboard DB-N6, models rule 4a: adding or removing a model
// folder is a person's recorded act; the folder's path names a person's
// directory, so it is private, never on the chain.

describe("models/folder_added and models/folder_removed", () => {
  it.each(["models/folder_added", "models/folder_removed"])(
    "%s is registered with the path private",
    (type) => {
      expect(PAYLOAD_SCHEMAS[type]).toBeDefined();
      expect(() =>
        checkEventPayload(
          type,
          { principal: "p_owner", includeSubfolders: true },
          { path: "/Users/me/models" },
        ),
      ).not.toThrow();
      expect(() =>
        checkEventPayload(
          type,
          { principal: "p_owner", includeSubfolders: true, path: "/Users/me/models" },
          undefined,
        ),
      ).toThrow(new RegExp(`${type.replace("/", "\\/")}.*\\bpath\\b`));
    },
  );
});
