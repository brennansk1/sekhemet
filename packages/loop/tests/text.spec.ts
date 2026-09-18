import { describe, expect, it } from "vitest";
import {
  applyEol,
  dedentBlock,
  detectEol,
  joinLines,
  leadingIndent,
  reindentBlock,
  splitLines,
  toLf,
} from "../src/text.js";

describe("@sekhemet/loop text handling", () => {
  it("detects the dominant line ending rather than the first one seen", () => {
    expect(detectEol("a\nb\nc\n")).toBe("\n");
    expect(detectEol("a\r\nb\r\nc\r\n")).toBe("\r\n");
    // One stray CRLF must not flip an otherwise-LF file on the next write.
    expect(detectEol("a\nb\nc\r\nd\ne\n")).toBe("\n");
    expect(detectEol("")).toBe("\n");
  });

  it("normalizes CR, CRLF and LF to LF", () => {
    expect(toLf("a\r\nb\rc\nd")).toBe("a\nb\nc\nd");
  });

  it("round-trips a CRLF file byte-for-byte", () => {
    const original = "line 1\r\nline 2\r\nline 3\r\n";
    const eol = detectEol(original);
    const { lines, hadTrailingNewline } = splitLines(original);

    expect(lines).toEqual(["line 1", "line 2", "line 3"]);
    expect(hadTrailingNewline).toBe(true);
    // The critical property: no stray \r survives on any line, and the rejoin
    // reproduces the original exactly.
    expect(lines.every((l) => !l.includes("\r"))).toBe(true);
    expect(joinLines(lines, hadTrailingNewline, eol)).toBe(original);
  });

  it("preserves the absence of a trailing newline", () => {
    const original = "a\nb";
    const { lines, hadTrailingNewline } = splitLines(original);
    expect(hadTrailingNewline).toBe(false);
    expect(joinLines(lines, hadTrailingNewline, "\n")).toBe(original);
  });

  it("distinguishes an empty file from a single blank line", () => {
    expect(splitLines("").lines).toEqual([""]);
    expect(splitLines("\n").lines).toEqual([""]);
    expect(splitLines("\n").hadTrailingNewline).toBe(true);
    expect(splitLines("").hadTrailingNewline).toBe(false);
  });

  it("reads leading indentation of tabs and spaces", () => {
    expect(leadingIndent("    x")).toBe("    ");
    expect(leadingIndent("\t\tx")).toBe("\t\t");
    expect(leadingIndent("x")).toBe("");
  });

  it("dedents by the common indent, ignoring blank lines", () => {
    expect(dedentBlock("    a\n\n      b\n    c")).toBe("a\n\n  b\nc");
  });

  it("reindents to a target indent and leaves blank lines truly empty", () => {
    const out = reindentBlock("a\n\n  b", "    ");
    expect(out).toBe("    a\n\n      b");
    // A blank line must not become trailing whitespace, which formatters strip
    // and lint rules flag.
    expect(out.split("\n")[1]).toBe("");
  });

  it("applies CRLF only on output, never doubling existing carriage returns", () => {
    expect(applyEol("a\nb", "\r\n")).toBe("a\r\nb");
    expect(applyEol(toLf("a\r\nb"), "\r\n")).toBe("a\r\nb");
  });
});
