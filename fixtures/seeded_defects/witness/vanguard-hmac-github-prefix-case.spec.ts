import { expect, it } from "vitest";
import { computeHmacHex, verifyGithub } from "../src/hmac.js";

it("treats an upper-case SHA256= prefix as malformed", () => {
  const payload = Buffer.from('{"action":"opened"}');
  const header = `SHA256=${computeHmacHex("gh_w", payload)}`;
  expect(verifyGithub(header, payload, "gh_w")).toEqual({
    status: "failed",
    scheme: "github",
    reason: "malformed signature header",
  });
});
