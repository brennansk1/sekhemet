import { expect, it } from "vitest";
import { signStripe, verifyStripe } from "../src/hmac.js";

it("verifies when the matching v1 is followed by another v1", () => {
  const payload = Buffer.from('{"id":"evt_1"}');
  const now = 1_700_000_000;
  const valid = signStripe("whsec_w", payload, now).split("v1=")[1];
  const header = `t=${now},v1=${valid},v1=${"0".repeat(64)}`;
  expect(verifyStripe(header, payload, "whsec_w", now)).toEqual({
    status: "verified",
    scheme: "stripe",
  });
});
