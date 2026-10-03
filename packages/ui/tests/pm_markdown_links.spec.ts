import { describe, expect, it } from "vitest";
import { renderPmMarkdown } from "../src/pm.js";

// FINDINGS PM-04 (C2b): Seshat's messages never print Markdown link source.
// A web link is a link, opened apart from the dashboard; a file in the
// repository is its name; anything else — `javascript:`, `data:` — is its
// text only, never a link.

describe("PM-04: Markdown links in Seshat's messages", () => {
  it("renders a web link as a link that opens apart, with no bracketed source", () => {
    const html = renderPmMarkdown("Read [Linear's triage guide](https://linear.app/docs/triage).");
    expect(html).toContain(
      '<a href="https://linear.app/docs/triage" target="_blank" rel="noopener noreferrer nofollow">Linear&#39;s triage guide</a>',
    );
    expect(html).not.toContain("](");
  });

  it("names a repository file by its label and path, as code, never as a link", () => {
    const html = renderPmMarkdown(
      "The [brief](docs/product/brief.md) and [docs/product/requirements.md](docs/product/requirements.md).",
    );
    expect(html).toBe(
      "<p>The brief (<code>docs/product/brief.md</code>) and <code>docs/product/requirements.md</code>.</p>",
    );
  });

  it("never makes a link of any other scheme, and escapes everything", () => {
    for (const bad of ["javascript:alert(1)", "data:text/html,<b>x</b>", "vbscript:x"]) {
      const html = renderPmMarkdown(`[x](${bad})`);
      expect(html, bad).not.toContain("<a");
      expect(html, bad).not.toContain("](");
    }
    expect(renderPmMarkdown('[<img src=x onerror="1">](https://e.example)')).not.toContain("<img");
  });
});
