import { describe, expect, expectTypeOf, it } from "vitest";
import type {
  HmacConfig,
  ReplayRequest,
  ReplayResult,
  SignatureScheme,
  VerificationResult,
  VerificationStatus,
  WebhookEvent,
} from "../src/types.js";

/**
 * Contract tests for card_vang_1_types. A types-only card gated by tsc alone
 * can merge a contract that compiles but is wrong, making later cards
 * unsatisfiable; these only typecheck when the contract is exactly as specified.
 */
describe("vanguard contract", () => {
  it("restricts the status and scheme unions to the named members", () => {
    expectTypeOf<VerificationStatus>().toEqualTypeOf<"verified" | "failed" | "unsigned">();
    expectTypeOf<SignatureScheme>().toEqualTypeOf<"stripe" | "github" | "none">();
  });

  it("makes only reason optional on VerificationResult", () => {
    const result: VerificationResult = { status: "verified", scheme: "github" };
    expect(result.reason).toBeUndefined();
    expectTypeOf<VerificationResult["reason"]>().toEqualTypeOf<string | undefined>();
  });

  it("makes every HmacConfig field optional", () => {
    const empty: HmacConfig = {};
    expect(empty).toEqual({});
    expectTypeOf<HmacConfig["toleranceSeconds"]>().toEqualTypeOf<number | undefined>();
  });

  it("types WebhookEvent.body as raw bytes and every other field as required", () => {
    const event: WebhookEvent = {
      id: 1,
      source: "stripe",
      method: "POST",
      path: "/ingest/stripe",
      headers: { "content-type": "application/json" },
      body: new Uint8Array([123, 125]),
      receivedAt: 1700000000000,
      verification: "unsigned",
    };
    expect(event.body.length).toBe(2);
    expectTypeOf<WebhookEvent["body"]>().toEqualTypeOf<Uint8Array>();
    expectTypeOf<WebhookEvent["headers"]>().toEqualTypeOf<Record<string, string>>();
    expectTypeOf<WebhookEvent["verification"]>().toEqualTypeOf<VerificationStatus>();
  });

  it("makes only headerOverrides optional on ReplayRequest and types ReplayResult exactly", () => {
    const request: ReplayRequest = { eventId: 1, targetUrl: "http://127.0.0.1:1/hook" };
    expect(request.headerOverrides).toBeUndefined();
    expectTypeOf<ReplayResult>().toEqualTypeOf<{
      eventId: number;
      status: number;
      durationMs: number;
      responseBody: string;
    }>();
  });
});
