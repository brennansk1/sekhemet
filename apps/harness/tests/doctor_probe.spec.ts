import { type Server, createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { judgeConfinement, probeInference } from "../src/doctor.js";

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

/**
 * R9 (Ubuntu 24.04 in the Lima VM): bubblewrap could not start, so the escape
 * probe exited 1 like every other command, and doctor passed it as
 * "seatbelt active — escape probe refused" on Linux.
 */
describe("the confinement check (SEC-17c)", () => {
  it("fails when the sandbox cannot run even a harmless command", () => {
    const check = judgeConfinement(
      "bubblewrap",
      { exitCode: 1, stderr: "bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted\n" },
      { exitCode: 1, wrote: false },
    );
    expect(check.status).toBe("fail");
    expect(check.detail).toContain("Failed RTM_NEWADDR");
  });

  it("names the mechanism actually in force", () => {
    const check = judgeConfinement(
      "bubblewrap",
      { exitCode: 0, stderr: "" },
      { exitCode: 1, wrote: false },
    );
    expect(check.status).toBe("pass");
    expect(check.detail).toMatch(/^bubblewrap active/);
    expect(check.detail).not.toContain("seatbelt");
  });

  it("fails when the escape wrote outside", () => {
    expect(
      judgeConfinement("seatbelt", { exitCode: 0, stderr: "" }, { exitCode: 0, wrote: true })
        .status,
    ).toBe("fail");
  });

  it("fails when the file exists afterwards, whatever the exit code said", () => {
    const check = judgeConfinement(
      "bubblewrap",
      { exitCode: 0, stderr: "" },
      { exitCode: 1, wrote: true },
    );
    expect(check.status).toBe("fail");
  });

  it("warns with the reason when an installed engine cannot run", () => {
    const check = judgeConfinement(
      "none",
      undefined,
      undefined,
      "/usr/bin/bwrap cannot start a sandbox (x)",
    );
    expect(check.status).toBe("warn");
    expect(check.detail).toContain("/usr/bin/bwrap cannot start a sandbox");
  });
});
