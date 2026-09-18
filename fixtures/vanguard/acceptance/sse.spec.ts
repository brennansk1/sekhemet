import { type IncomingMessage, type Server, createServer, get } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SseBus, formatSseEvent } from "../src/sse.js";

describe("vanguard formatSseEvent", () => {
  it("formats id, event and JSON data lines followed by a blank line", () => {
    expect(formatSseEvent("webhook", { id: 3, source: "stripe" }, 3)).toBe(
      'id: 3\nevent: webhook\ndata: {"id":3,"source":"stripe"}\n\n',
    );
  });

  it("omits the id line when no id is given but keeps an id of 0", () => {
    expect(formatSseEvent("ping", null)).toBe("event: ping\ndata: null\n\n");
    expect(formatSseEvent("ping", "hi", 0)).toBe('id: 0\nevent: ping\ndata: "hi"\n\n');
  });

  it("keeps multi-line string data on one data line via JSON encoding", () => {
    expect(formatSseEvent("log", "a\nb")).toBe('event: log\ndata: "a\\nb"\n\n');
  });

  it("rejects an empty event name or one containing a line break", () => {
    expect(() => formatSseEvent("", 1)).toThrow("invalid event name");
    expect(() => formatSseEvent("a\nb", 1)).toThrow("invalid event name");
    expect(() => formatSseEvent("a\rb", 1)).toThrow("invalid event name");
  });
});

interface Client {
  res: IncomingMessage;
  text: () => string;
  waitFor: (needle: string) => Promise<string>;
  ended: Promise<void>;
}

function connect(url: string): Promise<Client> {
  return new Promise((resolve, reject) => {
    get(url, (res) => {
      let buffer = "";
      const waiters: { needle: string; done: (s: string) => void }[] = [];
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        buffer += chunk;
        for (const w of [...waiters]) {
          if (buffer.includes(w.needle)) {
            waiters.splice(waiters.indexOf(w), 1);
            w.done(buffer);
          }
        }
      });
      const ended = new Promise<void>((done) => res.on("end", () => done()));
      resolve({
        res,
        text: () => buffer,
        ended,
        waitFor: (needle) =>
          buffer.includes(needle)
            ? Promise.resolve(buffer)
            : new Promise((done) => waiters.push({ needle, done })),
      });
    }).on("error", reject);
  });
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 5));
}

describe("vanguard SseBus over HTTP", () => {
  let bus: SseBus;
  let server: Server;
  let url: string;
  let removers: (() => void)[];

  beforeEach(async () => {
    bus = new SseBus();
    removers = [];
    server = createServer((_req, res) => {
      removers.push(bus.addClient(res));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/events/stream`;
  });

  afterEach(async () => {
    bus.closeAll();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("returns 0 when broadcasting with no clients", () => {
    expect(bus.clientCount).toBe(0);
    expect(bus.broadcast("webhook", { id: 1 })).toBe(0);
  });

  it("sends SSE headers and a connected comment to a new client", async () => {
    const client = await connect(url);
    expect(client.res.statusCode).toBe(200);
    expect(client.res.headers["content-type"]).toBe("text/event-stream");
    expect(client.res.headers["cache-control"]).toBe("no-cache");
    expect(await client.waitFor("\n\n")).toBe(": connected\n\n");
    expect(bus.clientCount).toBe(1);
  });

  it("delivers each broadcast to every connected client in order", async () => {
    const a = await connect(url);
    const b = await connect(url);
    await until(() => bus.clientCount === 2);
    expect(bus.broadcast("webhook", { id: 1 }, 1)).toBe(2);
    expect(bus.broadcast("webhook", { id: 2 }, 2)).toBe(2);
    const expected =
      ': connected\n\nid: 1\nevent: webhook\ndata: {"id":1}\n\nid: 2\nevent: webhook\ndata: {"id":2}\n\n';
    expect(await a.waitFor('data: {"id":2}\n\n')).toBe(expected);
    expect(await b.waitFor('data: {"id":2}\n\n')).toBe(expected);
  });

  it("forgets a client that disconnects", async () => {
    const client = await connect(url);
    await until(() => bus.clientCount === 1);
    client.res.destroy();
    await until(() => bus.clientCount === 0);
    expect(bus.clientCount).toBe(0);
    expect(bus.broadcast("webhook", {})).toBe(0);
  });

  it("removes a client through the function returned by addClient", async () => {
    await connect(url);
    await until(() => removers.length === 1);
    removers[0]?.();
    expect(bus.clientCount).toBe(0);
    expect(bus.broadcast("webhook", {})).toBe(0);
  });

  it("writes nothing when the event name is invalid", async () => {
    const client = await connect(url);
    await client.waitFor("\n\n");
    expect(() => bus.broadcast("bad\nname", {})).toThrow("invalid event name");
    bus.broadcast("ok", 1);
    expect(await client.waitFor("data: 1\n\n")).toBe(": connected\n\nevent: ok\ndata: 1\n\n");
  });

  it("ends every client stream on closeAll", async () => {
    const client = await connect(url);
    await until(() => bus.clientCount === 1);
    bus.closeAll();
    await client.ended;
    expect(bus.clientCount).toBe(0);
    expect(client.text()).toBe(": connected\n\n");
  });
});
