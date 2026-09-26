import { describe, expect, it } from "vitest";
import { generateDashboardHtml } from "../src/ui_html.js";

describe("the dashboard shell (dashboard P11)", () => {
  it("DB-P11-3: has a slot for the phone's bottom bar, a labelled nav landmark", () => {
    const html = generateDashboardHtml();
    expect(html).toContain('<nav class="tabbar" id="tabbar" aria-label="Views"></nav>');
    // The primary sidebar stays the first nav.
    expect(html.indexOf('id="side"')).toBeLessThan(html.indexOf('id="tabbar"'));
  });

  it("DB-P12-4: publishes the control edge role in both themes", () => {
    const html = generateDashboardHtml();
    expect(html.split("--border-control:").length - 1).toBe(2);
  });
});
