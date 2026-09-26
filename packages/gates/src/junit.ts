import { XMLParser } from "fast-xml-parser";

/**
 * One JUnit XML path for every test runner that writes the format (DEC-44):
 * Vitest `--reporter=junit`, pytest `--junitxml`, gotestsum, cargo-nextest,
 * surefire. The acceptance-test checks (gates rules 6, 6a; NEW-gates-6) read
 * each test's own result from it, so "failed at an assertion" is judged the
 * same way whatever the runner.
 */

/** One test case as the report states it. */
export interface JUnitCase {
  /** The suite's file as the report names it (Vitest: the file path; pytest: the `file` attribute when present). */
  file: string;
  /** The `classname` attribute (pytest: the dotted module path). */
  classname: string;
  name: string;
  /**
   * `failure`: the test ran and failed; `error`: the runner could not run it
   * (pytest's collection and setup errors); `skipped`; `passed`.
   */
  status: "passed" | "failure" | "error" | "skipped";
  /** The failure's or error's `type` attribute (`AssertionError`, `TypeError`). */
  type?: string;
  /** The failure's `message` attribute, else the first line of its text. */
  message?: string;
  /** The failure's text: the stack and diff. */
  text?: string;
  /**
   * A case the runner reports for the file itself rather than for a test:
   * Vitest names a file that failed to import or whose `beforeAll` threw
   * with the file's own path.
   */
  fileLevel: boolean;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  textNodeName: "#text",
  // Always arrays, so one suite and many suites read the same.
  isArray: (name) => ["testsuite", "testcase", "failure", "error", "skipped"].includes(name),
  parseAttributeValue: false,
  trimValues: true,
});

type Node = Record<string, unknown>;

function asNodes(v: unknown): Node[] {
  return Array.isArray(v) ? (v as Node[]) : v && typeof v === "object" ? [v as Node] : [];
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : undefined;
}

/** A failure or error element: its type, message and text. */
function detail(el: unknown): { type?: string; message?: string; text?: string } {
  if (typeof el === "string") {
    const first = el.split("\n").find((l) => l.trim());
    return { text: el, ...(first ? { message: first.trim() } : {}) };
  }
  const n = (el ?? {}) as Node;
  const text = str(n["#text"]);
  const type = str(n.type);
  const message =
    str(n.message) ??
    text
      ?.split("\n")
      .find((l) => l.trim())
      ?.trim();
  return {
    ...(type ? { type } : {}),
    ...(message ? { message } : {}),
    ...(text ? { text } : {}),
  };
}

/**
 * Parse a JUnit XML report into its test cases. Throws on text that is not
 * XML or holds no `testsuite`, so a caller never mistakes an unreadable
 * report for an empty run.
 */
export function parseJUnit(xml: string): JUnitCase[] {
  const doc = parser.parse(xml) as Node;
  const root = (doc.testsuites ?? doc) as Node;
  const suites = asNodes(root.testsuite);
  if (suites.length === 0 && !("testsuites" in doc)) {
    throw new Error("not a JUnit report: no testsuite element");
  }
  const out: JUnitCase[] = [];
  const visit = (suite: Node): void => {
    const suiteName = str(suite.name) ?? "";
    const suiteFile = str(suite.file);
    for (const c of asNodes(suite.testcase)) {
      const classname = str(c.classname) ?? suiteName;
      const name = str(c.name) ?? "";
      const file = str(c.file) ?? suiteFile ?? (classname.includes("/") ? classname : suiteName);
      const failure = asNodes(c.failure)[0] ?? (typeof c.failure === "string" ? c.failure : null);
      const error = asNodes(c.error)[0] ?? (typeof c.error === "string" ? c.error : null);
      const skipped = c.skipped !== undefined;
      const status: JUnitCase["status"] =
        c.failure !== undefined
          ? "failure"
          : c.error !== undefined
            ? "error"
            : skipped
              ? "skipped"
              : "passed";
      const d =
        c.failure !== undefined ? detail(failure) : c.error !== undefined ? detail(error) : {};
      out.push({
        file,
        classname,
        name,
        status,
        ...d,
        fileLevel: name === classname && name === file && name.length > 0,
      });
    }
    // Nested suites (some runners group by describe block).
    for (const inner of asNodes(suite.testsuite)) visit(inner);
  };
  for (const s of suites) visit(s);
  return out;
}
