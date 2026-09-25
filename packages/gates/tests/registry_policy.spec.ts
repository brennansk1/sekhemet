import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ecosystemRegistry } from "../src/builtin.js";

/** SEC-14: registry lookups are the harness's own requests, never `npm view` in the worktree. */
describe("the supply-chain registry lookup", () => {
  it("asks the registry API through the given fetch, whatever the worktree's .npmrc says", async () => {
    const root = mkdtempSync(join(tmpdir(), "sek-npmrc-"));
    writeFileSync(join(root, ".npmrc"), "registry=http://evil.example.com/\n");
    const urls: string[] = [];
    const fetchImpl = (async (input: string | URL) => {
      urls.push(String(input));
      return new Response(
        JSON.stringify({ time: { created: "2015-01-01T00:00:00Z" }, downloads: 5000 }),
        {
          status: 200,
        },
      );
    }) as typeof fetch;
    const lookup = ecosystemRegistry(root, { cacheRoot: join(root, "cache"), fetchImpl });
    const info = await lookup("@scope/left-pad", "npm");
    expect(info).toMatchObject({ exists: true, created: "2015-01-01T00:00:00Z" });
    expect(urls[0]).toBe("https://registry.npmjs.org/@scope%2Fleft-pad");
    expect(urls.some((u) => u.includes("evil.example.com"))).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  it("answers 'does not exist' on a 404", async () => {
    const root = mkdtempSync(join(tmpdir(), "sek-npmrc-"));
    const fetchImpl = (async () => new Response("{}", { status: 404 })) as typeof fetch;
    const lookup = ecosystemRegistry(root, { cacheRoot: join(root, "cache"), fetchImpl });
    expect(await lookup("no-such-package-xyz", "npm")).toEqual({ exists: false });
    rmSync(root, { recursive: true, force: true });
  });
});
