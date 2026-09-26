import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ManagedLlamaServerAdapter } from "../src/llama_server.js";

describe("@sekhemet/models KV slot cache across swaps", () => {
  it("launches with a slot save path and saves/restores slot 0 by model and key (rule 20i)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "slots-"));
    const seen: { url: string; body: string }[] = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => {
        body += c;
      });
      req.on("end", () => {
        seen.push({ url: req.url ?? "", body });
        // The server writes the slot file into its --slot-save-path.
        if (req.url?.includes("action=save"))
          writeFileSync(join(dir, (JSON.parse(body) as { filename: string }).filename), "kv");
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
      slotCacheDir: dir,
    });
    expect(adapter.launchArgs()).toEqual(expect.arrayContaining(["--slot-save-path", dir]));
    expect(await adapter.slotAction("save")).toBe(true);
    expect(await adapter.slotAction("restore")).toBe(true);
    server.close();
    const slots = seen.filter((x) => x.url.startsWith("/slots/"));
    expect(slots.map((x) => x.url)).toEqual(["/slots/0?action=save", "/slots/0?action=restore"]);
    const names = slots.map((x) => (JSON.parse(x.body) as { filename: string }).filename);
    expect(names[0]).toMatch(/^cyber-tiel_iq3\.prefix\.[0-9a-f]{16}\.bin$/);
    expect(names[1]).toBe(names[0]);
  });

  it("does nothing without a slot directory", async () => {
    const adapter = new ManagedLlamaServerAdapter({ modelId: "m", modelPath: "/x.gguf", port: 1 });
    expect(adapter.launchArgs()).not.toContain("--slot-save-path");
    expect(await adapter.slotAction("save")).toBe(false);
  });
});
