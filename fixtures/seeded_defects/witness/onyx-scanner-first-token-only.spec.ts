import { expect, it } from "vitest";
import { scanLine } from "../src/scanner.js";

it("tests every long token on a line, not only the first", () => {
  const secret = "Xk9pQ2mZ7vR4tY8wL3nB6cF1";
  expect(scanLine(`const this_is_a_perfectly_normal_identifier = "${secret}";`)).toEqual({
    rule: "high-entropy",
    excerpt: secret,
  });
});
