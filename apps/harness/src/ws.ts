import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

/**
 * A minimal WebSocket endpoint (RFC 6455) for the dashboard's live stream
 * (H1), so editors, the SDK and other tools can subscribe without SSE.
 *
 * It carries exactly what the SSE stream carries: the server writes SSE
 * frames ("event: x\ndata: {...}\n\n") to every client, and this adapter
 * turns each into one text message {"event": "x", "data": {...}}.
 *
 * Only loopback origins may connect. A browser lets any site open a
 * WebSocket to 127.0.0.1, and the board is private, so a page from elsewhere
 * must not be able to read it (cross-site WebSocket hijacking). Clients that
 * send no Origin (the SDK, curl) are local processes and are allowed.
 */

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export interface StreamClient {
  write(chunk: string): unknown;
  end(): unknown;
}

export function acceptKey(key: string): string {
  return createHash("sha1")
    .update(key + GUID)
    .digest("base64");
}

export function originAllowed(origin: string | undefined): boolean {
  if (!origin) return true;
  try {
    const host = new URL(origin).hostname;
    return host === "127.0.0.1" || host === "localhost" || host === "[::1]" || host === "::1";
  } catch {
    return false;
  }
}

/** One server-to-client frame: FIN, text or close opcode, unmasked. */
export function encodeFrame(payload: Buffer, opcode = 0x1): Buffer {
  const len = payload.length;
  const head =
    len < 126
      ? Buffer.from([0x80 | opcode, len])
      : len < 65536
        ? Buffer.from([0x80 | opcode, 126, len >> 8, len & 0xff])
        : Buffer.concat([
            Buffer.from([0x80 | opcode, 127]),
            (() => {
              const b = Buffer.alloc(8);
              b.writeBigUInt64BE(BigInt(len));
              return b;
            })(),
          ]);
  return Buffer.concat([head, payload]);
}

/** Client frames: masked. Returns complete frames and the unconsumed rest. */
export function decodeFrames(buf: Buffer): {
  frames: { opcode: number; payload: Buffer }[];
  rest: Buffer;
} {
  const frames: { opcode: number; payload: Buffer }[] = [];
  let at = 0;
  while (buf.length - at >= 2) {
    const b0 = buf[at] as number;
    const b1 = buf[at + 1] as number;
    let len = b1 & 0x7f;
    let off = at + 2;
    if (len === 126) {
      if (buf.length < off + 2) break;
      len = buf.readUInt16BE(off);
      off += 2;
    } else if (len === 127) {
      if (buf.length < off + 8) break;
      len = Number(buf.readBigUInt64BE(off));
      off += 8;
    }
    const masked = (b1 & 0x80) !== 0;
    const maskLen = masked ? 4 : 0;
    if (buf.length < off + maskLen + len) break;
    const mask = masked ? buf.subarray(off, off + 4) : undefined;
    const payload = Buffer.from(buf.subarray(off + maskLen, off + maskLen + len));
    if (mask)
      for (let i = 0; i < payload.length; i++)
        payload[i] = (payload[i] as number) ^ (mask[i % 4] as number);
    frames.push({ opcode: b0 & 0x0f, payload });
    at = off + maskLen + len;
  }
  return { frames, rest: buf.subarray(at) };
}

/** SSE text to messages: each "event:/data:" block becomes {event, data}. */
export function sseToMessages(chunk: string): string[] {
  const out: string[] = [];
  for (const block of chunk.split("\n\n")) {
    const event = /^event: (.*)$/m.exec(block)?.[1];
    const data = /^data: (.*)$/m.exec(block)?.[1];
    if (!event || data === undefined) continue;
    let parsed: unknown = data;
    try {
      parsed = JSON.parse(data);
    } catch {
      // Keep as text.
    }
    out.push(JSON.stringify({ event, data: parsed }));
  }
  return out;
}

/**
 * Complete the upgrade and return a client the SSE broadcaster can write to,
 * or undefined when refused (bad origin, not a WebSocket request).
 */
export function acceptWebSocket(
  req: IncomingMessage,
  socket: Duplex,
  onClose: (client: StreamClient) => void,
): StreamClient | undefined {
  const key = req.headers["sec-websocket-key"];
  if (typeof key !== "string" || req.headers.upgrade?.toLowerCase() !== "websocket") {
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    return undefined;
  }
  if (!originAllowed(req.headers.origin)) {
    socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    return undefined;
  }
  socket.write(
    `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`,
  );
  let open = true;
  const client: StreamClient = {
    write(chunk: string) {
      if (!open) throw new Error("closed");
      for (const m of sseToMessages(chunk)) socket.write(encodeFrame(Buffer.from(m)));
      return true;
    },
    end() {
      if (!open) return;
      open = false;
      try {
        socket.end(encodeFrame(Buffer.alloc(0), 0x8));
      } catch {
        // Already gone.
      }
    },
  };
  let pending = Buffer.alloc(0);
  socket.on("data", (data: Buffer) => {
    const { frames, rest } = decodeFrames(Buffer.concat([pending, data]));
    pending = Buffer.from(rest);
    for (const f of frames) {
      if (f.opcode === 0x9) socket.write(encodeFrame(f.payload, 0xa)); // ping -> pong
      if (f.opcode === 0x8) {
        client.end();
        onClose(client);
      }
    }
  });
  const gone = () => {
    open = false;
    onClose(client);
  };
  socket.on("close", gone);
  socket.on("error", gone);
  return client;
}
