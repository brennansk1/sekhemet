import type { ServerResponse } from "node:http";

/** One server-sent event frame; the data is JSON on a single line. */
export function formatSseEvent(event: string, data: unknown, id?: number): string {
  if (event === "" || /[\r\n]/.test(event)) throw new Error("invalid event name");
  const idLine = id === undefined ? "" : `id: ${id}\n`;
  return `${idLine}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** The connected SSE clients, and a broadcast to all of them. */
export class SseBus {
  private readonly clients = new Set<ServerResponse>();

  get clientCount(): number {
    return this.clients.size;
  }

  addClient(res: ServerResponse): () => void {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.write(": connected\n\n");
    this.clients.add(res);
    const remove = (): void => {
      this.clients.delete(res);
    };
    res.on("close", remove);
    return remove;
  }

  broadcast(event: string, data: unknown, id?: number): number {
    const frame = formatSseEvent(event, data, id);
    for (const client of this.clients) client.write(frame);
    return this.clients.size;
  }

  closeAll(): void {
    for (const client of this.clients) client.end();
    this.clients.clear();
  }
}
