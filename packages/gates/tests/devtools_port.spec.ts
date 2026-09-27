import { describe, expect, it } from "vitest";
import { parseDevToolsPort } from "../src/visual.js";

// Chromium writes DevToolsActivePort in two steps; a read between them saw
// only the port and built "ws://127.0.0.1:<port>undefined" (a flaky
// visual_design run in B4.4's gate). The browser is used only once the file
// holds both lines.
describe("the DevTools port file", () => {
  it("is ready only when it holds a port and a /devtools/ path", () => {
    expect(parseDevToolsPort("")).toBeUndefined();
    expect(parseDevToolsPort("41235")).toBeUndefined();
    expect(parseDevToolsPort("41235\n")).toBeUndefined();
    expect(parseDevToolsPort("41235\n/devtools/brow")).toBeUndefined();
    expect(parseDevToolsPort("41235\n/devtools/browser/0b1c-2d3e\n")).toEqual({
      port: 41235,
      path: "/devtools/browser/0b1c-2d3e",
    });
  });
});
