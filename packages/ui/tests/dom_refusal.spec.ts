import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { refusedWriteBody } from "../src/account.js";

/**
 * W1 finding (DEC-31): a page that prints a failed write's `error` showed the
 * bare code `csrf`. When the server sends a sentence with a refused CSRF
 * check, the page's requests hand that sentence on as the error; the
 * page-wide notice still sees the code (app.js decides on it).
 */
describe("a refused CSRF check reaches the page as a sentence", () => {
  const sentence =
    "This page is out of date because Sekhemet restarted. Reload the page, then try again.";

  it("gives the server's sentence as the error and keeps the code", () => {
    expect(refusedWriteBody(403, { error: "csrf", refused: "token", message: sentence })).toEqual({
      error: sentence,
      code: "csrf",
      refused: "token",
      message: sentence,
    });
  });

  it("hands any other answer on unchanged", () => {
    const notFound = { error: "Not found." };
    expect(refusedWriteBody(404, notFound)).toBe(notFound);
    const bare = { error: "csrf" };
    expect(refusedWriteBody(403, bare)).toBe(bare);
    expect(refusedWriteBody(403, null)).toBeNull();
  });

  it("every page request goes through it, and the notice gets the server's body", () => {
    const dom = readFileSync(join(import.meta.dirname, "../web/dom.js"), "utf8");
    expect(dom).toContain('from "./lib/account.js"');
    expect(dom.match(/refusedWriteBody\(res\.status, data\)/g)?.length).toBe(2);
    expect(dom.match(/noticeAuth\(res\.status, data\)/g)?.length).toBe(2);
  });
});
