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
