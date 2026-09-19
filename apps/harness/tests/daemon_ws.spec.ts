import { mkdtempSync } from "node:fs";
import { request } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { daemonStart, daemonStatus, daemonStop, readDaemon } from "../src/daemon.js";
import { startDashboardServer } from "../src/server.js";
import { acceptKey, decodeFrames, encodeFrame, originAllowed, sseToMessages } from "../src/ws.js";

describe("WebSocket framing (H1)", () => {
  it("computes the RFC 6455 accept key", () => {
    // The worked example from RFC 6455 section 1.3.
    expect(acceptKey("dGhlIHNhbXBsZSBub25jZQ==")).toBe("s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
  });

  it("encodes server frames and decodes masked client frames, across lengths", () => {
    for (const n of [5, 300, 70_000]) {
      const payload = Buffer.alloc(n, 97);
      const frame = encodeFrame(payload);
      expect(frame[0]).toBe(0x81);
      // Mask it as a client would and decode.
      const mask = Buffer.from([1, 2, 3, 4]);
      const headLen = n < 126 ? 2 : n < 65536 ? 4 : 10;
      const head = Buffer.from(frame.subarray(0, headLen));
      head[1] = (head[1] as number) | 0x80;
      const body = Buffer.from(payload.map((b, i) => b ^ (mask[i % 4] as number)));
      const { frames, rest } = decodeFrames(Buffer.concat([head, mask, body, Buffer.from([0x81])]));
      expect(frames[0]?.payload.equals(payload)).toBe(true);
      expect(rest.length).toBe(1); // an incomplete next frame waits
    }
  });

  it("turns SSE frames into messages and allows only loopback origins", () => {
    expect(sseToMessages('event: append\ndata: {"a":1}\n\nevent: machine\ndata: {"m":2}\n\n')).toEqual([
      '{"event":"append","data":{"a":1}}',
      '{"event":"machine","data":{"m":2}}',
    ]);
    expect(originAllowed(undefined)).toBe(true);
    expect(originAllowed("http://127.0.0.1:4040")).toBe(true);
    expect(originAllowed("http://localhost:3000")).toBe(true);
    expect(originAllowed("https://evil.example")).toBe(false);
  });
});

describe("live stream over WebSocket", () => {
  let server: { port: number; close: () => Promise<void> };
  let cards: CardStore;
  beforeAll(async () => {
    const db = new DatabaseSync(":memory:");
    initSchema(db);
    const log = new EventLog(db);
    cards = new CardStore(db, log);
    server = await startDashboardServer({
      db,
      log,
      cardStore: cards,
      boardService: new BoardServiceImpl(cards),
      repoPath: mkdtempSync(join(tmpdir(), "ws-")),
      port: 0,
      streamIntervalMs: 50,
    });
  });
  afterAll(async () => server.close());

  const handshake = (origin?: string) =>
    new Promise<{ status: string; socket: ReturnType<typeof connect>; data: Buffer[] }>((resolve) => {
      const socket = connect(server.port, "127.0.0.1");
      const data: Buffer[] = [];
      let status = "";
      socket.on("data", (d: Buffer) => {
        if (!status) status = d.toString().split("\r\n")[0] ?? "";
        data.push(d);
        resolve({ status, socket, data });
      });
      socket.write(
        `GET /api/ws HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n${origin ? `Origin: ${origin}\r\n` : ""}\r\n`,
      );
    });

  it("refuses a foreign origin", async () => {
    const { status, socket } = await handshake("https://evil.example");
    expect(status).toMatch(/403/);
    socket.destroy();
  });

  it("upgrades and streams ledger appends as JSON messages", async () => {
    const { status, socket, data } = await handshake("http://127.0.0.1");
    expect(status).toMatch(/101/);
    await cards.createCard({ id: "card_ws", tier: "task", title: "Streamed", status: "backlog" });
    const deadline = Date.now() + 3000;
    let text = "";
    while (Date.now() < deadline && !text.includes("card_ws")) {
      await new Promise((r) => setTimeout(r, 50));
      const all = Buffer.concat(data);
      const at = all.indexOf("\r\n\r\n") + 4;
      text = decodeFrames(all.subarray(at)).frames.map((f) => f.payload.toString()).join("\n");
    }
    const msg = JSON.parse(text.split("\n").find((l) => l.includes("card_ws")) ?? "{}");
    expect(msg.event).toBe("append");
    expect(JSON.stringify(msg.data.events)).toContain("card_ws");
    socket.destroy();
  });

  it("answers 404 for other upgrade paths", async () => {
    const res = await new Promise<number>((resolve) => {
      const req = request({ port: server.port, host: "127.0.0.1", path: "/nope", headers: { Connection: "Upgrade", Upgrade: "websocket" } });
      req.on("upgrade", () => resolve(101));
      req.on("response", (r) => resolve(r.statusCode ?? 0));
      req.on("error", () => resolve(-1));
      req.end();
    });
    expect(res).not.toBe(101);
  });
});

describe("sekhemet daemon (H1)", () => {
  it("starts once, reports status, refuses a second start, and stops", async () => {
    const repo = mkdtempSync(join(tmpdir(), "daemon-"));
    const pid = process.pid; // an alive pid stands in for the detached server
    const launched: string[][] = [];
    const deps = {
      launch: (args: string[]) => {
        launched.push(args);
        return pid;
      },
      fetch: (async () => new Response("{}")) as typeof fetch,
      waitMs: 500,
      kill: () => {},
    };
    const first = await daemonStart(repo, 4999, deps);
    expect(first.started).toBe(true);
    expect(launched[0]).toEqual(["serve", "--repo", repo, "--port", "4999"]);
    expect(readDaemon(repo)?.port).toBe(4999);
    expect((await daemonStart(repo, 4999, deps)).message).toMatch(/Already running/);
    expect(await daemonStatus(repo, deps)).toMatch(/Running .* answering\. Live stream: ws:\/\/127\.0\.0\.1:4999\/api\/ws/);
    // Stopping a process that stays alive (our own pid) still clears the record.
    expect(await daemonStop(repo, deps)).toMatch(/Stopped/);
    expect(readDaemon(repo)).toBeUndefined();
  });
});
