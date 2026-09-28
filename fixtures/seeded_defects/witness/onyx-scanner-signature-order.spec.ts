import { expect, it } from "vitest";
import { scanLine } from "../src/scanner.js";

it("reports the AWS key before a GitHub token on the same line", () => {
  const pat = `ghp_${"a1B2c3D4e5".repeat(3)}a1B2c3`;
  expect(scanLine(`${pat} AKIAIOSFODNN7EXAMPLE`)).toEqual({
    rule: "aws-access-key",
    excerpt: "AKIAIOSFODNN7EXAMPLE",
  });
});
