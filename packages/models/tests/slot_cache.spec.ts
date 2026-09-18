import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { ManagedLlamaServerAdapter } from "../src/llama_server.js";

describe("@sekhemet/models KV slot cache across swaps", () => {
  it("launches with a slot save path and saves/restores slot 0 by model", async () => {
    const seen: { url: string; body: string }[] = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => {
        body += c;
      });
      req.on("end", () => {
        seen.push({ url: req.url ?? "", body });
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    const adapter = new ManagedLlamaServerAdapter({
      modelId: "cyber-tiel/iq3",
      modelPath: "/nonexistent.gguf",
      port,
      slotCacheDir: "/tmp/slots",
    });
    expect(adapter.launchArgs()).toEqual(
      expect.arrayContaining(["--slot-save-path", "/tmp/slots"]),
    );
    expect(await adapter.slotAction("save")).toBe(true);
    expect(await adapter.slotAction("restore")).toBe(true);
    server.close();
    expect(seen).toEqual([
      { url: "/slots/0?action=save", body: JSON.stringify({ filename: "cyber-tiel_iq3.slot" }) },
      { url: "/slots/0?action=restore", body: JSON.stringify({ filename: "cyber-tiel_iq3.slot" }) },
    ]);
  });

  it("does nothing without a slot directory", async () => {
    const adapter = new ManagedLlamaServerAdapter({ modelId: "m", modelPath: "/x.gguf", port: 1 });
    expect(adapter.launchArgs()).not.toContain("--slot-save-path");
    expect(await adapter.slotAction("save")).toBe(false);
  });
});
