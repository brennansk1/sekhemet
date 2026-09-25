import { describe, expect, it } from "vitest";
// apodex_loop before researcher, on purpose (and in sorted order, so the
// import sorter keeps it): apodex_loop.js imports researcher.js, which used to
// read APODEX_LOCAL_TOOLS while apodex_loop.js was still evaluating (prompt
// lint review).
import { APODEX_LOCAL_TOOLS } from "../src/research/apodex_loop.js";
import { researchTools } from "../src/research/researcher.js";

describe("research module import order", () => {
  it("gives the researcher its tools whichever module loads first", () => {
    const names = researchTools(false).map((t) => t?.name);
    expect(names).not.toContain(undefined);
    for (const t of APODEX_LOCAL_TOOLS) expect(names).toContain(t.name);
    expect(researchTools(true).length).toBeGreaterThan(researchTools(false).length);
  });
});
