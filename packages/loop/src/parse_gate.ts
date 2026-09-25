import { spawnSync } from "node:child_process";
import { parseToml } from "@sekhemet/kernel";
import { allowlistedEnv, resolveProgram } from "@sekhemet/sandbox";
import ts from "typescript";

export interface SyntaxProblem {
  line: number;
  column: number;
  message: string;
}

const PARSEABLE = /\.(?:[cm]?[jt]sx?)$/;

/**
 * Parse candidate file contents in memory and report syntax errors.
 *
 * This is the design's parse gate (G6): a write that would leave a source file
 * unparseable is refused before it reaches disk. Observed against a real local
 * model, chained `edit` calls on one file progressively broke its brace
 * structure until no later turn could recover it; refusing the first bad edit,
 * with the exact location, keeps the file in a state the next turn can reason
 * about. Only syntax is checked here — types are the typecheck gate's job.
 */
export function checkSyntax(path: string, content: string): SyntaxProblem[] {
  const other = checkOtherLanguage(path, content);
  if (other) return other;
  if (!PARSEABLE.test(path)) return [];

  const result = ts.transpileModule(content, {
    fileName: path,
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      jsx: /x$/.test(path) ? ts.JsxEmit.Preserve : ts.JsxEmit.None,
      isolatedModules: true,
    },
  });

  return (result.diagnostics ?? [])
    .filter((d) => d.category === ts.DiagnosticCategory.Error && d.start !== undefined)
    .slice(0, 3)
    .map((d) => {
      const pos = ts.getLineAndCharacterOfPosition(
        ts.createSourceFile(path, content, ts.ScriptTarget.ES2022),
        d.start ?? 0,
      );
      return {
        line: pos.line + 1,
        column: pos.character + 1,
        message: ts.flattenDiagnosticMessageText(d.messageText, " "),
      };
    });
}

/** 1-based line and column of a character offset. */
function lineCol(content: string, offset: number): { line: number; column: number } {
  const before = content.slice(0, Math.max(0, offset));
  const line = before.split("\n").length;
  return { line, column: offset - before.lastIndexOf("\n") };
}

/**
 * Run an interpreter's own parser over `content` on stdin: the language's
 * real grammar, not a regex. Undefined when the tool is not installed (the
 * gate then says nothing rather than inventing a verdict).
 */
function parseWith(
  command: string,
  args: string[],
  content: string,
  pattern: RegExp,
): SyntaxProblem[] | undefined {
  // Item 20b: the parser by absolute path from the fixed allowlist, never
  // PATH, with the allowlisted environment. It only parses the content.
  const program = resolveProgram(command);
  if (!program) return undefined;
  const r = spawnSync(program, args, {
    input: content,
    encoding: "utf8",
    timeout: 10_000,
    env: allowlistedEnv(),
  });
  if (r.error) return undefined;
  if (r.status === 0) return [];
  const text = `${r.stderr ?? ""}${r.stdout ?? ""}`.trim();
  const m = pattern.exec(text);
  return [
    {
      line: m?.groups?.line ? Number(m.groups.line) : 1,
      column: m?.groups?.col ? Number(m.groups.col) : 1,
      message: (text.split("\n").filter(Boolean).at(-1) ?? "syntax error").slice(0, 200),
    },
  ];
}

/**
 * G6 beyond TypeScript: JSON and TOML through their parsers in-process,
 * Python through its own `ast` module, shell through `bash -n`. Every check
 * runs on the candidate content in memory, before anything is written.
 */
function checkOtherLanguage(path: string, content: string): SyntaxProblem[] | undefined {
  const lower = path.toLowerCase();
  if (lower.endsWith(".json")) {
    try {
      JSON.parse(content);
      return [];
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const pos = /position (\d+)/.exec(message);
      const at = pos ? lineCol(content, Number(pos[1])) : { line: 1, column: 1 };
      return [{ ...at, message }];
    }
  }
  if (lower.endsWith(".toml")) {
    try {
      parseToml(content);
      return [];
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const line = /line (\d+)/i.exec(message);
      return [{ line: line ? Number(line[1]) : 1, column: 1, message }];
    }
  }
  if (lower.endsWith(".py")) {
    return parseWith(
      "python3",
      // -I (SEC-36): no PYTHONPATH, user site or working directory on the path.
      ["-I", "-c", "import ast,sys; ast.parse(sys.stdin.read())"],
      content,
      /line (?<line>\d+)/,
    );
  }
  if (lower.endsWith(".sh") || lower.endsWith(".bash")) {
    return parseWith("bash", ["-n"], content, /line (?<line>\d+)/);
  }
  return undefined;
}
