import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_TOLERANCE_SECONDS,
  computeHmacHex,
  safeEqualHex,
  signGithub,
  signStripe,
  verifyGithub,
  verifyStripe,
} from "../src/hmac.js";

/** Spy on node:crypto's timingSafeEqual so the suite can prove it is used. */
const spy = vi.hoisted(() => ({
  timingSafeEqual: undefined as unknown as ReturnType<typeof vi.fn>,
}));
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  spy.timingSafeEqual = vi.fn(actual.timingSafeEqual);
  const patched = { ...actual, timingSafeEqual: spy.timingSafeEqual };
  return { ...patched, default: patched };
});

const SECRET = "whsec_test_secret";
const PAYLOAD = Buffer.from('{"id":"evt_1","type":"payment_intent.succeeded"}');
const NOW = 1_700_000_000;

/** Flip the lowest bit of the first byte. */
function flipFirstBit(buf: Buffer): Buffer {
  const copy = Buffer.from(buf);
  copy[0] = (copy[0] ?? 0) ^ 0x01;
  return copy;
}

beforeEach(() => {
  spy.timingSafeEqual.mockClear();
});

describe("vanguard hmac primitives", () => {
  it("matches the published HMAC-SHA256 test vector", () => {
    expect(computeHmacHex("key", "The quick brown fox jumps over the lazy dog")).toBe(
      "f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8",
    );
  });

  it("gives the same digest for a Buffer and the equivalent string", () => {
    expect(computeHmacHex("k", Buffer.from("abc"))).toBe(computeHmacHex("k", "abc"));
  });

  it("compares equal hex strings as equal using crypto.timingSafeEqual", () => {
    expect(safeEqualHex("00ff", "00FF")).toBe(true);
    expect(spy.timingSafeEqual).toHaveBeenCalled();
  });

  it("returns false instead of throwing when lengths differ", () => {
    expect(safeEqualHex("00ff", "00ff00")).toBe(false);
    expect(safeEqualHex("00ff", "")).toBe(false);
  });

  it("returns false for non-hex input, even though Buffer.from would decode it to empty", () => {
    expect(safeEqualHex("zz", "yy")).toBe(false);
    expect(safeEqualHex("", "")).toBe(false);
    expect(safeEqualHex("abc", "abc")).toBe(false);
  });

  it("signs in the Stripe and GitHub header formats", () => {
    const stripeHex = computeHmacHex(SECRET, Buffer.from(`${NOW}.${PAYLOAD.toString()}`));
    expect(signStripe(SECRET, PAYLOAD, NOW)).toBe(`t=${NOW},v1=${stripeHex}`);
    expect(signGithub(SECRET, PAYLOAD)).toBe(`sha256=${computeHmacHex(SECRET, PAYLOAD)}`);
  });
});

describe("vanguard stripe verification", () => {
  const header = (): string => signStripe(SECRET, PAYLOAD, NOW);

  it("verifies a correctly signed payload with timingSafeEqual", () => {
    expect(verifyStripe(header(), PAYLOAD, SECRET, NOW)).toEqual({
      status: "verified",
      scheme: "stripe",
    });
    expect(spy.timingSafeEqual).toHaveBeenCalled();
  });

  it("rejects a payload with one flipped bit", () => {
    expect(verifyStripe(header(), flipFirstBit(PAYLOAD), SECRET, NOW)).toEqual({
      status: "failed",
      scheme: "stripe",
      reason: "signature mismatch",
    });
  });

  it("rejects the wrong secret", () => {
    expect(verifyStripe(header(), PAYLOAD, "whsec_wrong", NOW).reason).toBe("signature mismatch");
  });

  it("rejects a truncated or non-hex signature without throwing", () => {
    const truncated = header().slice(0, -2);
    expect(verifyStripe(truncated, PAYLOAD, SECRET, NOW).reason).toBe("signature mismatch");
    const garbage = `t=${NOW},v1=${"z".repeat(64)}`;
    expect(verifyStripe(garbage, PAYLOAD, SECRET, NOW).reason).toBe("signature mismatch");
  });

  it("accepts any matching v1 entry when several are present", () => {
    const valid = header().split("v1=")[1];
    const multi = `t=${NOW},v1=${"0".repeat(64)},v1=${valid}`;
    expect(verifyStripe(multi, PAYLOAD, SECRET, NOW).status).toBe("verified");
  });

  it("enforces the timestamp tolerance, inclusive at the boundary", () => {
    expect(DEFAULT_TOLERANCE_SECONDS).toBe(300);
    expect(verifyStripe(header(), PAYLOAD, SECRET, NOW + 300).status).toBe("verified");
    expect(verifyStripe(header(), PAYLOAD, SECRET, NOW + 301)).toEqual({
      status: "failed",
      scheme: "stripe",
      reason: "timestamp outside tolerance",
    });
    expect(verifyStripe(header(), PAYLOAD, SECRET, NOW - 301).reason).toBe(
      "timestamp outside tolerance",
    );
    expect(verifyStripe(header(), PAYLOAD, SECRET, NOW + 1000, 1000).status).toBe("verified");
  });

  it("rejects a replayed signature with a forged fresh timestamp", () => {
    const valid = header().split("v1=")[1];
    const forged = `t=${NOW + 100},v1=${valid}`;
    expect(verifyStripe(forged, PAYLOAD, SECRET, NOW + 100).reason).toBe("signature mismatch");
  });

  it("reports a missing or malformed header", () => {
    expect(verifyStripe(undefined, PAYLOAD, SECRET, NOW).reason).toBe("missing signature header");
    expect(verifyStripe("", PAYLOAD, SECRET, NOW).reason).toBe("missing signature header");
    expect(verifyStripe("garbage", PAYLOAD, SECRET, NOW).reason).toBe("malformed signature header");
    expect(verifyStripe(`t=${NOW}`, PAYLOAD, SECRET, NOW).reason).toBe(
      "malformed signature header",
    );
    expect(verifyStripe("t=abc,v1=00", PAYLOAD, SECRET, NOW).reason).toBe(
      "malformed signature header",
    );
  });
});

describe("vanguard github verification", () => {
  it("verifies a correctly signed payload with timingSafeEqual", () => {
    expect(verifyGithub(signGithub(SECRET, PAYLOAD), PAYLOAD, SECRET)).toEqual({
      status: "verified",
      scheme: "github",
    });
    expect(spy.timingSafeEqual).toHaveBeenCalled();
  });

  it("rejects a payload with one flipped bit and a wrong secret", () => {
    const sig = signGithub(SECRET, PAYLOAD);
    expect(verifyGithub(sig, flipFirstBit(PAYLOAD), SECRET)).toEqual({
      status: "failed",
      scheme: "github",
      reason: "signature mismatch",
    });
    expect(verifyGithub(sig, PAYLOAD, "other").reason).toBe("signature mismatch");
  });

  it("rejects a signature with one flipped hex digit", () => {
    const sig = signGithub(SECRET, PAYLOAD);
    const last = sig.at(-1) === "0" ? "1" : "0";
    expect(verifyGithub(sig.slice(0, -1) + last, PAYLOAD, SECRET).reason).toBe(
      "signature mismatch",
    );
  });

  it("reports a missing header and a header without the sha256= prefix", () => {
    expect(verifyGithub(undefined, PAYLOAD, SECRET).reason).toBe("missing signature header");
    const bare = signGithub(SECRET, PAYLOAD).slice("sha256=".length);
    expect(verifyGithub(bare, PAYLOAD, SECRET).reason).toBe("malformed signature header");
    expect(verifyGithub(`sha1=${bare}`, PAYLOAD, SECRET).reason).toBe("malformed signature header");
  });
});
