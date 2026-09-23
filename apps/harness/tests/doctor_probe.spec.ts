import { type Server, createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { probeInference } from "../src/doctor.js";

/**
 * A llama-server answers Ollama's /api/tags with 404, which does not throw,
 * so the probe never reached its /v1/models fallback: no llama-server was
 * ever detected — including the managed Cyber-Tiel server on 8098, a port
 * the probe did not list at all.
 */
describe("the inference probe", () => {
  let server: Server | undefined;
  afterEach(() => server?.close());

  const llamaServer = (): Promise<string> =>
    new Promise((resolve) => {
      server = createServer((req, res) => {
        if (req.url === "/v1/models") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ data: [{ id: "cyber-tiel-coder" }] }));
          return;
        }
        res.writeHead(404);
        res.end();
      }).listen(0, "127.0.0.1", () => {
        const addr = server?.address();
        resolve(`http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`);
      });
    });

  it("finds a llama-server that has no Ollama endpoint", async () => {
    const base = await llamaServer();
    const check = await probeInference([base]);
    expect(check.status).toBe("pass");
    expect(check.detail).toContain("cyber-tiel-coder");
  });

  it("fails honestly when nothing answers", async () => {
    const check = await probeInference(["http://127.0.0.1:1"]);
    expect(check.status).toBe("fail");
  });
});
