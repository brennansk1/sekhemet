import { describe, expect, it } from "vitest";
import { goImports, pythonImports } from "../src/ecosystems/imports.js";

// DS-N9-15, DS-N9-2: Python and Go import statements, read word by word in
// one module (the source index has no adapter for these languages; gates
// GT-T2-3 leaves no import regular expression).

describe("pythonImports", () => {
  it("reads module imports, aliases, from-imports and parenthesised lists", () => {
    const text = [
      "import numpy as np, os.path",
      "from requests import Session as S, get  # a comment",
      "from .sessions import (",
      "    Request,",
      "    Response as R,",
      ")",
      "from x import \\",
      "    y",
      "def f():",
      "    import json",
      "from y import *",
    ].join("\n");
    expect(
      pythonImports(text).map((b) => [b.kind, b.module, b.imported, b.local, b.topLevel]),
    ).toEqual([
      ["module", "numpy", undefined, "np", true],
      ["module", "os.path", undefined, "os", true],
      ["from", "requests", "Session", "S", true],
      ["from", "requests", "get", "get", true],
      ["from", ".sessions", "Request", "Request", true],
      ["from", ".sessions", "Response", "R", true],
      ["from", "x", "y", "y", true],
      ["module", "json", undefined, "json", false],
    ]);
  });
});

describe("goImports", () => {
  it("reads single, aliased and grouped imports", () => {
    const text = [
      "package main",
      'import "fmt"',
      'import cobra "github.com/spf13/cobra"',
      "import (",
      '\t"os"',
      '\tv "github.com/spf13/viper" // config',
      '\t_ "embed"',
      ")",
      'import ("strings")',
    ].join("\n");
    expect(goImports(text)).toEqual([
      { path: "fmt" },
      { path: "github.com/spf13/cobra", alias: "cobra" },
      { path: "os" },
      { path: "github.com/spf13/viper", alias: "v" },
      { path: "embed", alias: "_" },
      { path: "strings" },
    ]);
  });
});
