import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
});
