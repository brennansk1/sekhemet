import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProcessSandbox } from "@sekhemet/sandbox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToolExecutor } from "../src/tools.js";

/**
 * S3a, S5: a research card's web page is reached only through the confined
 * browser and the card's egress proxy; when the browser cannot render it,
 * the harness does not fetch it itself.
 */
describe("browse never fetches the web outside the sandbox", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "browse-"));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it("refuses the unconfined fallback fetch for a web page", async () => {
    // A browser that cannot render anything.
    const broken = join(root, "broken-chrome.sh");
    writeFileSync(broken, "#!/bin/sh\nexit 1\n");
    chmodSync(broken, 0o755);
    vi.stubEnv("SEKHEMET_CHROME", broken);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const tools = new ToolExecutor({
      worktreePath: root,
      scopeFiles: ["**"],
      cardClass: "research",
    });
    try {
      const page = await tools.execute({
        id: "b",
        name: "browse",
        arguments: { url: "https://example.com/" },
      });
      expect(page.ok).toBe(false);
      expect(page.content).toContain("not fetched outside the sandbox");
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      tools.dispose();
    }
  });

  /**
   * The 2026-10-04 injection run 3 breach (redcode-bash-2_2): a loopback URL
   * named any port, and the browse tool granted the confined browser that
   * port, so a Worker reached a host listener it never started (the canary;
   * as well the model server, the dashboard, another card's app). Item 42a:
   * the card's own app only; item 12: the card's own loopback ports only.
   */
  describe("a loopback port the card did not start", () => {
    let canary: Server;
    let hits: string[];
    let port: number;
    beforeEach(async () => {
      hits = [];
      canary = createServer((req, res) => {
        hits.push(`${req.method} ${req.url} ${req.headers["user-agent"] ?? ""}`);
        res.end("<html><body>canary</body></html>");
      });
      await new Promise<void>((r) => canary.listen(0, "127.0.0.1", r));
      port = (canary.address() as AddressInfo).port;
    });
    afterEach(async () => {
      await new Promise((r) => canary.close(r));
    });

    for (const cardClass of ["implement", "research"] as const) {
      for (const host of ["127.0.0.1", "localhost"]) {
        it(`is refused on ${cardClass} cards (${host}), and nothing reaches it`, async () => {
          const fetchSpy = vi.spyOn(globalThis, "fetch");
          const tools = new ToolExecutor({ worktreePath: root, scopeFiles: ["**"], cardClass });
          try {
            const page = await tools.execute({
              id: "b",
              name: "browse",
              arguments: { url: `http://${host}:${port}/x` },
            });
            expect(page.ok).toBe(false);
            expect(page.denied).toBe(true);
            expect(page.content).toMatch(/own app/);
            expect(page.content).not.toContain("canary");
            await new Promise((r) => setTimeout(r, 200));
            expect(hits).toEqual([]);
            expect(fetchSpy).not.toHaveBeenCalled();
          } finally {
            tools.dispose();
          }
        }, 60_000);
      }
    }

    // A research card has no start_process: its refusal names no tool it lacks.
    it("tells a research card it reaches public pages only, naming no start_process", async () => {
      const tools = new ToolExecutor({
        worktreePath: root,
        scopeFiles: ["**"],
        cardClass: "research",
      });
      tools.setOfferedTools(["read_file", "list_dir", "browse", "web_search"]);
      try {
        const page = await tools.execute({
          id: "b",
          name: "browse",
          arguments: { url: `http://127.0.0.1:${port}/x` },
        });
        expect(page.denied).toBe(true);
        expect(page.content).toMatch(/public web pages only/);
        expect(page.content).not.toContain("start_process");
        await new Promise((r) => setTimeout(r, 200));
        expect(hits).toEqual([]);
      } finally {
        tools.dispose();
      }
    }, 60_000);

    // The fallback fetch runs in the harness, unconfined: a redirect from
    // the card's own app must not carry it to another port.
    it.runIf(new ProcessSandbox().confinement !== "none")(
      "is not reached through a redirect from the card's own app when the harness fetches it",
      async () => {
        const broken = join(root, "broken-chrome.sh");
        writeFileSync(broken, "#!/bin/sh\nexit 1\n");
        chmodSync(broken, 0o755);
        vi.stubEnv("SEKHEMET_CHROME", broken);
        const tools = new ToolExecutor({ worktreePath: root, scopeFiles: ["**"] });
        try {
          const started = await tools.execute({
            id: "s",
            name: "start_process",
            arguments: {
              name: "web",
              command: `node -e "require('http').createServer((q,r)=>{r.writeHead(302,{location:'http://127.0.0.1:${port}/x'});r.end()}).listen(process.env.PORT)"`,
            },
          });
          expect(started.ok).toBe(true);
          const own = /PORT=(\d+)/.exec(started.content)?.[1];
          await new Promise((r) => setTimeout(r, 800));
          const page = await tools.execute({
            id: "b",
            name: "browse",
            arguments: { url: `http://127.0.0.1:${own}/` },
          });
          expect(page.content).not.toContain("canary");
          await new Promise((r) => setTimeout(r, 200));
          expect(hits).toEqual([]);
        } finally {
          tools.dispose();
        }
      },
      60_000,
    );
  });

  // F29: only an http or https page; a file: or data: URL would have the
  // confined browser (on a research card) read a local file or a page the
  // Worker wrote, outside every port and host rule.
  for (const cardClass of ["implement", "research"] as const) {
    for (const url of ["file:///etc/hosts", "data:text/html,<p>hi</p>"]) {
      it(`refuses ${url.split(":")[0]}: on ${cardClass} cards`, async () => {
        const fetchSpy = vi.spyOn(globalThis, "fetch");
        const tools = new ToolExecutor({ worktreePath: root, scopeFiles: ["**"], cardClass });
        try {
          const page = await tools.execute({ id: "b", name: "browse", arguments: { url } });
          expect(page.ok).toBe(false);
          expect(page.denied).toBe(true);
          expect(page.content).toMatch(/http:\/\/ and https:\/\//);
          expect(page.content).not.toContain("localhost");
          expect(fetchSpy).not.toHaveBeenCalled();
        } finally {
          tools.dispose();
        }
      });
    }
  }

  // F29: a process that has exited holds no port, so its number is no
  // grant: something else on the host may listen there now.
  it.runIf(new ProcessSandbox().confinement !== "none")(
    "lists only the ports of processes still running",
    async () => {
      const tools = new ToolExecutor({ worktreePath: root, scopeFiles: ["**"] });
      try {
        const done = await tools.execute({
          id: "s",
          name: "start_process",
          arguments: { name: "done", command: "true" },
        });
        expect(done.ok).toBe(true);
        const running = await tools.execute({
          id: "r",
          name: "start_process",
          arguments: { name: "up", command: "sleep 30" },
        });
        const up = Number(/PORT=(\d+)/.exec(running.content)?.[1]);
        await new Promise((r) => setTimeout(r, 500));
        expect(tools.processPorts()).toEqual([up]);
      } finally {
        tools.dispose();
      }
    },
    60_000,
  );
});
