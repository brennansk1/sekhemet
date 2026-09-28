import { expect, it } from "vitest";
import { signStripe, verifyStripe } from "../src/hmac.js";

it("reports a timestamp that is not all digits as malformed", () => {
  const payload = Buffer.from('{"id":"evt_1"}');
  const now = 1_700_000_000;
  const valid = signStripe("whsec_w", payload, now).split("v1=")[1];
  expect(verifyStripe(`t=${now}x,v1=${valid}`, payload, "whsec_w", now).reason).toBe(
    "malformed signature header",
  );
});
