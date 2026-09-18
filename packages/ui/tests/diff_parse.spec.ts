import { describe, expect, it } from "vitest";
// The browser module is imported as-is: the same code the page runs.
import {
  annotationsByLine,
  errorCode,
  fileRole,
  globToRegExp,
  parseUnifiedDiff,
  stripLocation,
} from "../web/diff_parse.js";

const HASHER_DIFF = `diff --git a/src/hasher.ts b/src/hasher.ts
index e69de29..a0c4891 100644
--- a/src/hasher.ts
+++ b/src/hasher.ts
@@ -0,0 +1,3 @@
+import { createHash } from "node:crypto";
+
+export const GENESIS_HASH = "0".repeat(64);
diff --git a/tests/hasher.spec.ts b/tests/hasher.spec.ts
new file mode 100644
index 0000000..1111111
--- /dev/null
+++ b/tests/hasher.spec.ts
@@ -0,0 +1,2 @@
+import { hashEvent } from "../src/hasher.js";
+hashEvent({ id: "x" });
`;

const MODIFIED = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -10,4 +10,4 @@ export function f() {
 const a = 1;
-const b = 2;
+const b = 3;
 return a + b;
\\ No newline at end of file
`;

describe("parseUnifiedDiff", () => {
  it("splits files, counts lines and numbers the new side", () => {
    const files = parseUnifiedDiff(HASHER_DIFF);
    expect(files.map((f) => f.path)).toEqual(["src/hasher.ts", "tests/hasher.spec.ts"]);
    expect(files[0]).toMatchObject({ added: 3, removed: 0, status: "modified" });
    expect(files[1]).toMatchObject({ added: 2, status: "added" });
    const lines = files[0]?.hunks[0]?.lines ?? [];
    expect(lines.map((l) => l.newNo)).toEqual([1, 2, 3]);
    expect(lines[1]).toMatchObject({ type: "add", text: "" });
  });

  it("tracks old and new numbers through context, removals and markers", () => {
    const [file] = parseUnifiedDiff(MODIFIED);
    const lines = file?.hunks[0]?.lines ?? [];
    expect(lines.map((l) => l.type)).toEqual(["ctx", "del", "add", "ctx", "meta"]);
    expect(lines[0]).toMatchObject({ oldNo: 10, newNo: 10 });
    expect(lines[1]).toMatchObject({ oldNo: 11 });
    expect(lines[2]).toMatchObject({ newNo: 11 });
    expect(lines[3]).toMatchObject({ oldNo: 12, newNo: 12 });
    expect(file).toMatchObject({ added: 1, removed: 1 });
  });

  it("returns nothing for an empty diff", () => {
    expect(parseUnifiedDiff("")).toEqual([]);
    expect(parseUnifiedDiff(undefined)).toEqual([]);
  });
});

describe("grouping and annotations", () => {
  const ctx = {
    scopeFiles: ["src/hasher.ts"],
    acceptanceTests: ["hasher.spec.ts"],
    protectedGlobs: ["tests/**", "acceptance/**"],
  };

  it("puts scope files under Implementation and staged tests under Acceptance tests", () => {
    expect(fileRole("src/hasher.ts", ctx)).toBe("implementation");
    expect(fileRole("tests/hasher.spec.ts", ctx)).toBe("acceptance");
    expect(fileRole("tests/other.spec.ts", ctx)).toBe("acceptance");
    expect(fileRole("src/ledger.ts", ctx)).toBe("outside");
    expect(fileRole("pnpm-lock.yaml", ctx)).toBe("other");
  });

  it("matches gates.toml globs", () => {
    expect(globToRegExp("tests/**").test("tests/a/b.ts")).toBe(true);
    expect(globToRegExp("**/*.spec.ts").test("a/b/c.spec.ts")).toBe(true);
    expect(globToRegExp("**/*.spec.ts").test("c.spec.ts")).toBe(true);
    expect(globToRegExp("src/*.ts").test("src/a/b.ts")).toBe(false);
    expect(globToRegExp(".sekhemet/gates.toml").test(".sekhemet/gatesXtoml")).toBe(false);
  });

  it("keys failures by file and line, for annotations after lines 25, 58 and 59", () => {
    const failures = [25, 58, 59].map((line) => ({
      rung: "typecheck",
      errorExcerpt: `tests/hasher.spec.ts:${line}:7 TS2353: Object literal may only specify known properties.`,
      location: { file: "tests/hasher.spec.ts", line, column: 7 },
    }));
    const map = annotationsByLine(failures);
    expect([...map.keys()]).toEqual([
      "tests/hasher.spec.ts:25",
      "tests/hasher.spec.ts:58",
      "tests/hasher.spec.ts:59",
    ]);
    const first = failures[0];
    expect(errorCode(first?.errorExcerpt)).toBe("TS2353");
    expect(stripLocation(first?.errorExcerpt, first?.location)).toBe(
      "Object literal may only specify known properties.",
    );
    // Text that does not start with the location stays verbatim.
    expect(stripLocation("FAIL tests/a.ts", { file: "tests/a.ts" })).toBe("FAIL tests/a.ts");
  });
});
