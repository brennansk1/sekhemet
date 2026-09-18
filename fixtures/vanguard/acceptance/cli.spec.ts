import { describe, expect, it } from "vitest";
import { formatEventLine, parseArgs } from "../src/cli.js";

describe("vanguard parseArgs: start", () => {
  it("defaults to port 4040 and vanguard.db", () => {
    expect(parseArgs(["start"])).toEqual({ kind: "start", port: 4040, db: "vanguard.db" });
  });

  it("accepts --port and --db, including the port boundaries 0 and 65535", () => {
    expect(parseArgs(["start", "--port", "0", "--db", "/tmp/v.db"])).toEqual({
      kind: "start",
      port: 0,
      db: "/tmp/v.db",
    });
    expect(parseArgs(["start", "--port", "65535"])).toEqual({
      kind: "start",
      port: 65535,
      db: "vanguard.db",
    });
  });

  it("rejects out-of-range and non-numeric ports", () => {
    expect(parseArgs(["start", "--port", "65536"])).toEqual({
      kind: "error",
      message: "invalid port: 65536",
    });
    expect(parseArgs(["start", "--port", "abc"])).toEqual({
      kind: "error",
      message: "invalid port: abc",
    });
    expect(parseArgs(["start", "--port", "-1"])).toEqual({
      kind: "error",
      message: "invalid port: -1",
    });
  });
});

describe("vanguard parseArgs: list and tail", () => {
  it("defaults list to every source and a limit of 20", () => {
    expect(parseArgs(["list"])).toEqual({ kind: "list", source: null, limit: 20 });
  });

  it("accepts --source and --limit", () => {
    expect(parseArgs(["list", "--source", "github", "--limit", "5"])).toEqual({
      kind: "list",
      source: "github",
      limit: 5,
    });
  });

  it("rejects a zero or non-numeric limit", () => {
    expect(parseArgs(["list", "--limit", "0"])).toEqual({
      kind: "error",
      message: "invalid limit: 0",
    });
    expect(parseArgs(["list", "--limit", "ten"])).toEqual({
      kind: "error",
      message: "invalid limit: ten",
    });
  });

  it("parses tail and rejects positional arguments", () => {
    expect(parseArgs(["tail"])).toEqual({ kind: "tail" });
    expect(parseArgs(["tail", "stripe"])).toEqual({
      kind: "error",
      message: "usage: vanguard tail",
    });
    expect(parseArgs(["list", "extra"])).toEqual({
      kind: "error",
      message: "usage: vanguard list",
    });
  });
});

describe("vanguard parseArgs: replay", () => {
  it("parses an id, a target and repeated -H headers with lower-cased names", () => {
    expect(
      parseArgs([
        "replay",
        "12",
        "--to",
        "http://127.0.0.1:3000/api/webhook",
        "-H",
        "Stripe-Signature: t=1,v1=x",
        "-H",
        "X-Origin: http://a:8080",
      ]),
    ).toEqual({
      kind: "replay",
      id: 12,
      to: "http://127.0.0.1:3000/api/webhook",
      headers: { "stripe-signature": "t=1,v1=x", "x-origin": "http://a:8080" },
    });
  });

  it("requires exactly one id and --to", () => {
    const usage = { kind: "error", message: "usage: vanguard replay ID --to URL" };
    expect(parseArgs(["replay", "12"])).toEqual(usage);
    expect(parseArgs(["replay", "--to", "http://x"])).toEqual(usage);
    expect(parseArgs(["replay", "1", "2", "--to", "http://x"])).toEqual(usage);
  });

  it("rejects an id that is not a positive integer", () => {
    expect(parseArgs(["replay", "abc", "--to", "http://x"])).toEqual({
      kind: "error",
      message: "invalid event id: abc",
    });
    expect(parseArgs(["replay", "0", "--to", "http://x"])).toEqual({
      kind: "error",
      message: "invalid event id: 0",
    });
  });

  it("rejects a header without a name and colon", () => {
    expect(parseArgs(["replay", "1", "--to", "http://x", "-H", "novalue"])).toEqual({
      kind: "error",
      message: "invalid header: novalue",
    });
    expect(parseArgs(["replay", "1", "--to", "http://x", "-H", ": x"])).toEqual({
      kind: "error",
      message: "invalid header: : x",
    });
  });
});

describe("vanguard parseArgs: general errors", () => {
  it("reports usage for an empty argv and an unknown command", () => {
    expect(parseArgs([])).toEqual({
      kind: "error",
      message: "usage: vanguard start|list|replay|tail",
    });
    expect(parseArgs(["serve", "--port"])).toEqual({
      kind: "error",
      message: "unknown command: serve",
    });
  });

  it("reports a flag with no value and a flag the command does not accept", () => {
    expect(parseArgs(["start", "--port"])).toEqual({
      kind: "error",
      message: "missing value for --port",
    });
    expect(parseArgs(["list", "--port", "1"])).toEqual({
      kind: "error",
      message: "unknown option: --port",
    });
  });
});

describe("vanguard formatEventLine", () => {
  it("formats id, source, method, path, verification, byte count and ISO time", () => {
    expect(
      formatEventLine({
        id: 7,
        source: "stripe",
        method: "POST",
        path: "/ingest/stripe",
        headers: {},
        body: Buffer.from("héllo"),
        receivedAt: Date.UTC(2026, 8, 18, 12, 0, 0),
        verification: "verified",
      }),
    ).toBe("#7 stripe POST /ingest/stripe verified 6B 2026-09-18T12:00:00.000Z");
  });

  it("reports 0B for an empty body", () => {
    expect(
      formatEventLine({
        id: 1,
        source: "github",
        method: "POST",
        path: "/ingest/github",
        headers: {},
        body: Buffer.alloc(0),
        receivedAt: 0,
        verification: "failed",
      }),
    ).toBe("#1 github POST /ingest/github failed 0B 1970-01-01T00:00:00.000Z");
  });
});
