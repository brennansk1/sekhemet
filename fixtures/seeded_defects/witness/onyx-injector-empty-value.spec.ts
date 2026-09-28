import { expect, it } from "vitest";
import { buildChildEnv } from "../src/injector.js";

it("keeps a base variable set to the empty string", () => {
  expect(buildChildEnv({ EMPTY: "", A: "1" }, {})).toEqual({ EMPTY: "", A: "1" });
});
