import { expect, it } from "vitest";
import { scanLine } from "../src/scanner.js";

it("detects a temporary ASIA access key id", () => {
  expect(scanLine("key = ASIAIOSFODNN7EXAMPLE")).toEqual({
    rule: "aws-access-key",
    excerpt: "ASIAIOSFODNN7EXAMPLE",
  });
});
