import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import ts from "typescript";
import type {
  DeclarationFact,
  DeclarationKind,
  ExportFact,
  ImportBinding,
  ImportFact,
  LanguageAdapter,
  OperatorFact,
  ReExportFact,
  ReferenceFact,
  ResolvedModule,
  SourceFacts,
  TestBlockFact,
} from "./facts.js";

/**
 * The TypeScript adapter of the source index (gates rule 28, T2), and the
 * only module in Sekhemet that imports `typescript` (IX-4). TypeScript and
 * JavaScript files are parsed here with the TypeScript compiler's own parser;
 * every other module reads their facts through the index, and the few
 * analyses that need the syntax tree itself (the test-smell lint, the parse
 * gate, the language service behind the symbol tools, the mutation
 * operators, prompt literals) take the compiler API from `ts` below, so one
 * version, pinned in one manifest, parses everything.
 */
export { ts };

/** The parser version stamped on every fact, and part of every cache key (IX-3). */
export const TYPESCRIPT_PARSER_VERSION: string = ts.version;

const TS_EXT = /\.(?:ts|tsx|mts|cts)$/;
const JS_EXT = /\.(?:js|jsx|mjs|cjs)$/;
/** Extensions tried, in order, when a relative specifier names no file as written. */
const RESOLVE_EXT = [".ts", ".tsx", ".mts", ".cts", ".d.ts", ".js", ".jsx", ".mjs", ".cjs"];

function scriptKind(file: string): ts.ScriptKind {
  const ext = extname(file).toLowerCase();
  switch (ext) {
    case ".tsx":
      return ts.ScriptKind.TSX;
    case ".js":
    case ".mjs":
    case ".cjs":
      return ts.ScriptKind.JS;
    case ".jsx":
      return ts.ScriptKind.JSX;
    default:
      return ts.ScriptKind.TS;
  }
}

/** A syntax tree for `text`, parents set; the one place a source file is parsed. */
export function parseSyntax(file: string, text: string): ts.SourceFile {
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind(file));
}

/** The parser's own syntax errors for a tree (the "recovered" in `parseStatus`). */
export function syntaxErrors(sf: ts.SourceFile): readonly ts.Diagnostic[] {
  return (sf as unknown as { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
}

const lineOf = (sf: ts.SourceFile, pos: number): number =>
  sf.getLineAndCharacterOfPosition(pos).line + 1;

const hasModifier = (node: ts.Node, kind: ts.SyntaxKind): boolean =>
  ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((m) => m.kind === kind);

/** The offset of a declaration's first token that is not a decorator. */
function startAfterDecorators(node: ts.Node, sf: ts.SourceFile): number {
  const mods = (node as { modifiers?: ts.NodeArray<ts.ModifierLike> }).modifiers;
  if (!mods?.length) return node.getStart(sf);
  const first = mods.find((m) => !ts.isDecorator(m));
  if (first) return first.getStart(sf);
  const last = mods[mods.length - 1] as ts.Node;
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, sf.languageVariant, sf.text);
  scanner.resetTokenState(last.end);
  scanner.scan();
  return scanner.getTokenStart();
}

/** The `{` and `}` tokens directly inside `node`, or -1 for each when it has none. */
function braces(node: ts.Node, sf: ts.SourceFile): [number, number] {
  let open = -1;
  let close = -1;
  for (const child of node.getChildren(sf)) {
    if (child.kind === ts.SyntaxKind.OpenBraceToken && open === -1) open = child.getStart(sf);
    else if (child.kind === ts.SyntaxKind.CloseBraceToken) close = child.getStart(sf);
  }
  return open !== -1 && close !== -1 ? [open, close] : [-1, -1];
}

function unwrap(expr: ts.Expression): ts.Expression {
  let e = expr;
  while (
    ts.isParenthesizedExpression(e) ||
    ts.isAsExpression(e) ||
    ts.isSatisfiesExpression(e) ||
    ts.isTypeAssertionExpression(e)
  ) {
    e = e.expression;
  }
  return e;
}

/** The braces of a declaration's body, the way the symbol tools address it. */
function bodyOf(node: ts.Node, sf: ts.SourceFile): [number, number] {
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isConstructorDeclaration(node)
  ) {
    return node.body ? [node.body.getStart(sf), node.body.end - 1] : [-1, -1];
  }
  if (
    ts.isClassDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isEnumDeclaration(node)
  ) {
    return braces(node, sf);
  }
  if (ts.isModuleDeclaration(node)) {
    return node.body && ts.isModuleBlock(node.body) ? braces(node.body, sf) : [-1, -1];
  }
  if (ts.isTypeAliasDeclaration(node)) {
    return ts.isTypeLiteralNode(node.type) || ts.isMappedTypeNode(node.type)
      ? braces(node.type, sf)
      : [-1, -1];
  }
  if (ts.isVariableDeclaration(node) && node.initializer) {
    const init = unwrap(node.initializer);
    if ((ts.isArrowFunction(init) || ts.isFunctionExpression(init)) && ts.isBlock(init.body)) {
      return [init.body.getStart(sf), init.body.end - 1];
    }
    if (ts.isObjectLiteralExpression(init) || ts.isClassExpression(init)) return braces(init, sf);
  }
  return [-1, -1];
}

/** The first line of the JSDoc comment directly before `node`, if any. */
function docOf(node: ts.Node): string | undefined {
  const docs = (node as { jsDoc?: ts.JSDoc[] }).jsDoc;
  const comment = docs?.[0]?.comment;
  const text = typeof comment === "string" ? comment : ts.getTextOfJSDocComment(comment);
  const first = text?.split("\n")[0]?.trim();
  return first ? first : undefined;
}

function nameText(name: ts.Node | undefined): string | undefined {
  if (!name) return undefined;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isPrivateIdentifier(name)) {
    return name.text;
  }
  return undefined;
}

function variableKind(list: ts.VariableDeclarationList): DeclarationKind {
  if (list.flags & ts.NodeFlags.Const) return "const";
  if (list.flags & ts.NodeFlags.Let) return "let";
  return "var";
}

/** The nearest named declaration enclosing `node`. */
function containerOf(node: ts.Node): ts.Node | undefined {
  for (let p = node.parent; p; p = p.parent) {
    if (
      ts.isClassLike(p) ||
      ts.isInterfaceDeclaration(p) ||
      ts.isFunctionLike(p) ||
      ts.isModuleDeclaration(p) ||
      ts.isVariableDeclaration(p)
    ) {
      if (nameText((p as { name?: ts.Node }).name)) return p;
    }
  }
  return undefined;
}

/** The fact kind of a declaration node, for a container. */
function kindOf(node: ts.Node): DeclarationKind | undefined {
  if (ts.isClassLike(node)) return "class";
  if (ts.isInterfaceDeclaration(node)) return "interface";
  if (ts.isModuleDeclaration(node)) return "namespace";
  if (ts.isVariableDeclaration(node) && ts.isVariableDeclarationList(node.parent)) {
    return variableKind(node.parent);
  }
  if (
    ts.isMethodDeclaration(node) ||
    ts.isMethodSignature(node) ||
    ts.isConstructorDeclaration(node)
  )
    return "method";
  if (ts.isFunctionLike(node)) return "function";
  return undefined;
}

/**
 * The facts of one statement list: a file's top level, or a
 * `declare module "x"` block's body, whose declarations are all exported.
 */
function collect(
  sf: ts.SourceFile,
  statements: readonly ts.Statement[],
  scope: ts.Node,
  ambient: boolean,
): Omit<
  SourceFacts,
  | "file"
  | "contentHash"
  | "language"
  | "parser"
  | "parserVersion"
  | "parseStatus"
  | "parseReason"
  | "doc"
> {
  const imports: ImportFact[] = [];
  const exports: ExportFact[] = [];
  const reExports: ReExportFact[] = [];
  const declarations: DeclarationFact[] = [];
  const testBlocks: TestBlockFact[] = [];
  const ambientModules: SourceFacts["ambientModules"] = [];
  const references: ReferenceFact[] = [];
  const declarationNames = new Set<ts.Node>();
  const localExports = new Set<string>();

  const exportOf = (node: ts.Node, name: string | undefined, typeOnly: boolean): void => {
    if (!ambient && !hasModifier(node, ts.SyntaxKind.ExportKeyword)) return;
    const line = lineOf(sf, startAfterDecorators(node, sf));
    if (hasModifier(node, ts.SyntaxKind.DefaultKeyword)) {
      exports.push({ name: "default", ...(name ? { local: name } : {}), typeOnly, line });
    } else if (name) {
      exports.push({ name, typeOnly, line });
    }
  };

  for (const s of statements) {
    const line = lineOf(sf, s.getStart(sf));
    if (ts.isImportDeclaration(s) && ts.isStringLiteral(s.moduleSpecifier)) {
      const specifier = s.moduleSpecifier.text;
      const clause = s.importClause;
      if (!clause) {
        imports.push({ specifier, kind: "side-effect", bindings: [], line });
        continue;
      }
      const typeOnly = clause.isTypeOnly;
      const fact: ImportFact = { specifier, kind: typeOnly ? "type" : "value", bindings: [], line };
      if (clause.name) {
        fact.bindings.push({ imported: "default", local: clause.name.text, typeOnly });
      }
      const nb = clause.namedBindings;
      if (nb && ts.isNamespaceImport(nb)) {
        fact.kind = "namespace";
        fact.namespace = { local: nb.name.text, members: [], escapes: false };
      } else if (nb) {
        for (const el of nb.elements) {
          fact.bindings.push({
            imported: (el.propertyName ?? el.name).text,
            local: el.name.text,
            typeOnly: typeOnly || el.isTypeOnly,
          });
        }
      }
      imports.push(fact);
      continue;
    }
    if (
      ts.isImportEqualsDeclaration(s) &&
      ts.isExternalModuleReference(s.moduleReference) &&
      ts.isStringLiteral(s.moduleReference.expression)
    ) {
      imports.push({
        specifier: s.moduleReference.expression.text,
        kind: "require",
        bindings: [],
        namespace: { local: s.name.text, members: [], escapes: false },
        line,
      });
      continue;
    }
    if (ts.isExportDeclaration(s)) {
      const typeOnly = s.isTypeOnly;
      if (s.moduleSpecifier && ts.isStringLiteral(s.moduleSpecifier)) {
        const specifier = s.moduleSpecifier.text;
        if (!s.exportClause) {
          reExports.push({ specifier, kind: "star", names: [], line });
        } else if (ts.isNamespaceExport(s.exportClause)) {
          reExports.push({
            specifier,
            kind: "namespace",
            names: [],
            namespace: nameText(s.exportClause.name) ?? "",
            line,
          });
        } else {
          reExports.push({
            specifier,
            kind: "named",
            names: s.exportClause.elements.map((el) => ({
              imported: nameText(el.propertyName ?? el.name) ?? "",
              exported: nameText(el.name) ?? "",
              typeOnly: typeOnly || el.isTypeOnly,
            })),
            line,
          });
        }
      } else if (s.exportClause && ts.isNamedExports(s.exportClause)) {
        for (const el of s.exportClause.elements) {
          const name = nameText(el.name) ?? "";
          const local = el.propertyName ? nameText(el.propertyName) : undefined;
          localExports.add(local ?? name);
          exports.push({
            name,
            ...(local && local !== name ? { local } : {}),
            typeOnly: typeOnly || el.isTypeOnly,
            line: lineOf(sf, el.getStart(sf)),
          });
        }
      }
      continue;
    }
    if (ts.isExportAssignment(s)) {
      const expr = unwrap(s.expression);
      exports.push({
        name: s.isExportEquals ? "export=" : "default",
        ...(ts.isIdentifier(expr) ? { local: expr.text } : {}),
        typeOnly: false,
        line,
      });
      continue;
    }
    if (ts.isModuleDeclaration(s) && ts.isStringLiteral(s.name)) {
      if (s.body && ts.isModuleBlock(s.body)) {
        const inner = collect(sf, s.body.statements, s.body, true);
        ambientModules.push({
          name: s.name.text,
          facts: {
            ...inner,
            file: sf.fileName,
            contentHash: "",
            ...provenance(sf.fileName),
            parseStatus: "ok",
          },
        });
      }
      continue;
    }
    if (ts.isVariableStatement(s)) {
      const bound: string[] = [];
      const bind = (name: ts.BindingName): void => {
        if (ts.isIdentifier(name)) bound.push(name.text);
        else for (const el of name.elements) if (!ts.isOmittedExpression(el)) bind(el.name);
      };
      for (const d of s.declarationList.declarations) bind(d.name);
      for (const name of bound) exportOf(s, name, false);
    } else if (
      ts.isFunctionDeclaration(s) ||
      ts.isClassDeclaration(s) ||
      ts.isInterfaceDeclaration(s) ||
      ts.isTypeAliasDeclaration(s) ||
      ts.isEnumDeclaration(s) ||
      ts.isModuleDeclaration(s)
    ) {
      exportOf(s, nameText(s.name), ts.isInterfaceDeclaration(s) || ts.isTypeAliasDeclaration(s));
    } else if (
      !ambient &&
      ts.isExpressionStatement(s) &&
      ts.isCallExpression(s.expression) &&
      ts.isIdentifier(s.expression.expression) &&
      ["describe", "it", "test"].includes(s.expression.expression.text)
    ) {
      const title = s.expression.arguments[0];
      if (title && (ts.isStringLiteral(title) || ts.isNoSubstitutionTemplateLiteral(title))) {
        testBlocks.push({ callee: s.expression.expression.text, title: title.text, line });
      }
    }
  }

  // Declarations at every depth, dynamic imports, `require` calls and references.
  const topLevelOf = (node: ts.Node): boolean => {
    const holder = ts.isVariableDeclaration(node) ? node.parent.parent : node;
    return holder.parent === scope;
  };
  const declare = (
    node: ts.Node,
    name: string,
    kind: DeclarationKind,
    extra: Partial<DeclarationFact>,
  ) => {
    const stmt = ts.isVariableDeclaration(node)
      ? (node.parent.parent as ts.VariableStatement)
      : node;
    const list =
      ts.isVariableDeclaration(node) && ts.isVariableDeclarationList(node.parent)
        ? node.parent.declarations
        : undefined;
    const firstInList = !list || list[0] === node;
    const start = firstInList ? startAfterDecorators(stmt, sf) : node.getStart(sf);
    const [bodyOpen, bodyClose] = bodyOf(node, sf);
    const end = bodyOpen !== -1 ? bodyClose + 1 : list && list.length > 1 ? node.end : stmt.end;
    const topLevel = topLevelOf(node);
    const exported =
      ambient && topLevel
        ? true
        : hasModifier(stmt, ts.SyntaxKind.ExportKeyword) || (topLevel && localExports.has(name));
    const holder = topLevel ? undefined : containerOf(node);
    const container = holder ? nameText((holder as { name?: ts.Node }).name) : undefined;
    const containerKind = holder ? kindOf(holder) : undefined;
    const doc = docOf(stmt);
    const visibility = hasModifier(node, ts.SyntaxKind.PrivateKeyword)
      ? "private"
      : hasModifier(node, ts.SyntaxKind.ProtectedKeyword)
        ? "protected"
        : hasModifier(node, ts.SyntaxKind.PublicKeyword)
          ? "public"
          : ts.isPrivateIdentifier((node as { name?: ts.Node }).name ?? node)
            ? "private"
            : undefined;
    declarations.push({
      name,
      kind,
      topLevel,
      exported,
      isDefault: hasModifier(stmt, ts.SyntaxKind.DefaultKeyword),
      exportedAtDeclaration:
        ambient && topLevel ? true : hasModifier(stmt, ts.SyntaxKind.ExportKeyword),
      typeOnly: kind === "interface" || kind === "type",
      line: lineOf(sf, start),
      start,
      end,
      bodyOpen,
      bodyClose,
      ...(container ? { container } : {}),
      ...(containerKind ? { containerKind } : {}),
      ...(visibility ? { visibility } : {}),
      ...(ts.isGetAccessorDeclaration(node) ? { accessor: "get" as const } : {}),
      ...(ts.isSetAccessorDeclaration(node) ? { accessor: "set" as const } : {}),
      ...(ts.isMethodSignature(node) ? { signatureOnly: true } : {}),
      ...(doc ? { doc } : {}),
      ...extra,
    });
  };

  const visit = (node: ts.Node): void => {
    // An ambient module's body is its own set of facts (`ambientModules`).
    if (ts.isModuleDeclaration(node) && ts.isStringLiteral(node.name)) return;
    const name = (node as { name?: ts.Node }).name;
    if (ts.isFunctionDeclaration(node) && node.name) {
      declarationNames.add(node.name);
      declare(node, node.name.text, "function", {});
    } else if (ts.isClassDeclaration(node) && node.name) {
      declarationNames.add(node.name);
      declare(node, node.name.text, "class", {});
    } else if (ts.isInterfaceDeclaration(node)) {
      declarationNames.add(node.name);
      declare(node, node.name.text, "interface", {});
    } else if (ts.isTypeAliasDeclaration(node)) {
      declarationNames.add(node.name);
      declare(node, node.name.text, "type", {});
    } else if (ts.isEnumDeclaration(node)) {
      declarationNames.add(node.name);
      declare(node, node.name.text, "enum", {});
    } else if (ts.isModuleDeclaration(node) && ts.isIdentifier(node.name)) {
      declarationNames.add(node.name);
      declare(node, node.name.text, "namespace", {});
    } else if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      ts.isVariableDeclarationList(node.parent) &&
      ts.isVariableStatement(node.parent.parent)
    ) {
      declarationNames.add(node.name);
      const init = node.initializer ? unwrap(node.initializer) : undefined;
      declare(node, node.name.text, variableKind(node.parent), {
        ...(init && ts.isArrowFunction(init) ? { arrow: true } : {}),
      });
    } else if (
      (ts.isMethodDeclaration(node) ||
        ts.isMethodSignature(node) ||
        ts.isGetAccessorDeclaration(node) ||
        ts.isSetAccessorDeclaration(node)) &&
      nameText(name)
    ) {
      declarationNames.add(name as ts.Node);
      declare(node, nameText(name) as string, "method", {});
    } else if (ts.isConstructorDeclaration(node)) {
      declare(node, "constructor", "method", {});
    } else if (ts.isCallExpression(node)) {
      const arg = node.arguments[0];
      const spec = arg && ts.isStringLiteralLike(arg) ? arg.text : undefined;
      if (spec !== undefined && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        imports.push({
          specifier: spec,
          kind: "dynamic",
          ...dynamicUse(node),
          line: lineOf(sf, node.getStart(sf)),
        });
      } else if (
        spec !== undefined &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "require" &&
        node.arguments.length === 1
      ) {
        imports.push({
          specifier: spec,
          kind: "require",
          bindings: [],
          line: lineOf(sf, node.getStart(sf)),
        });
      }
    } else if (ts.isIdentifier(node) && !declarationNames.has(node)) {
      const parent = node.parent;
      const start = node.getStart(sf);
      const at = sf.getLineAndCharacterOfPosition(start);
      references.push({
        name: node.text,
        line: at.line + 1,
        column: at.character + 1,
        start,
        member:
          (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
          (ts.isQualifiedName(parent) && parent.right === node),
      });
    }
    ts.forEachChild(node, visit);
  };
  for (const s of statements) visit(s);

  // What each namespace import's local name is used for: members, or whole.
  // A dynamic import bound to a name is a namespace too (GT-T2-5); two bound
  // to one name cannot be told apart by name, so both count as used whole.
  const namespaces = imports.filter((i) => i.namespace);
  if (namespaces.length > 0) {
    const byLocal = new Map<string, ImportFact>();
    for (const i of namespaces) {
      const local = i.namespace?.local ?? "";
      const seen = byLocal.get(local);
      if (seen?.namespace && i.namespace) {
        seen.namespace.escapes = true;
        i.namespace.escapes = true;
      } else byLocal.set(local, i);
    }
    const members = new Map<string, Set<string>>();
    const walk = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && byLocal.has(node.text)) {
        const parent = node.parent;
        const own =
          ts.isNamespaceImport(parent) ||
          ts.isImportEqualsDeclaration(parent) ||
          (byLocal.get(node.text)?.kind === "dynamic" &&
            ts.isVariableDeclaration(parent) &&
            parent.name === node) ||
          (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
          (ts.isQualifiedName(parent) && parent.right === node);
        if (!own) {
          const fact = byLocal.get(node.text) as ImportFact;
          const set = members.get(node.text) ?? new Set<string>();
          members.set(node.text, set);
          if (ts.isPropertyAccessExpression(parent) && parent.expression === node) {
            set.add(parent.name.text);
          } else if (ts.isQualifiedName(parent) && parent.left === node) {
            set.add(parent.right.text);
          } else if (fact.namespace) {
            fact.namespace.escapes = true;
          }
        }
      }
      ts.forEachChild(node, walk);
    };
    for (const s of statements) walk(s);
    for (const [local, set] of members) {
      const fact = byLocal.get(local);
      if (fact?.namespace) fact.namespace.members = [...set].sort();
    }
  }

  return {
    imports,
    exports,
    reExports,
    declarations,
    references,
    operators: [],
    testBlocks,
    ambientModules,
  };
}

/**
 * Which names a dynamic `import()` reads (GT-T2-5): the names it is
 * destructured into, the member read as `(await import()).x`, or, when it is
 * bound to a name, a namespace whose members the namespace walk collects.
 * Anything else (a rest element, `.then(m => ...)`, the module passed on)
 * reads names the index cannot see: no bindings and no namespace, which the
 * consumer takes as the whole surface.
 */
function dynamicUse(call: ts.CallExpression): Pick<ImportFact, "bindings" | "namespace"> {
  let outer: ts.Node = call;
  while (
    ts.isAwaitExpression(outer.parent) ||
    ts.isParenthesizedExpression(outer.parent) ||
    ts.isNonNullExpression(outer.parent) ||
    ts.isAsExpression(outer.parent)
  )
    outer = outer.parent;
  const parent = outer.parent;
  const named = (name: string): ImportBinding => ({ imported: name, local: name, typeOnly: false });
  // `import(x).then(...)` is the promise's method, not the module's member.
  if (
    ts.isPropertyAccessExpression(parent) &&
    parent.expression === outer &&
    !(outer === call && ["then", "catch", "finally"].includes(parent.name.text))
  ) {
    return { bindings: [named(parent.name.text)] };
  }
  if (
    ts.isElementAccessExpression(parent) &&
    parent.expression === outer &&
    ts.isStringLiteralLike(parent.argumentExpression)
  ) {
    return { bindings: [named(parent.argumentExpression.text)] };
  }
  if (ts.isVariableDeclaration(parent) && parent.initializer === outer) {
    if (ts.isIdentifier(parent.name)) {
      return { bindings: [], namespace: { local: parent.name.text, members: [], escapes: false } };
    }
    if (ts.isObjectBindingPattern(parent.name)) {
      const bindings: ImportBinding[] = [];
      for (const el of parent.name.elements) {
        const key = el.propertyName ?? el.name;
        const imported = ts.isIdentifier(key) || ts.isStringLiteralLike(key) ? key.text : undefined;
        if (el.dotDotDotToken || imported === undefined) return { bindings: [] };
        const local = ts.isIdentifier(el.name) ? el.name.text : imported;
        bindings.push({ imported, local, typeOnly: false });
      }
      return { bindings };
    }
  }
  return { bindings: [] };
}

function provenance(file: string): {
  language: string;
  parser: string;
  parserVersion: string;
} {
  return {
    language: JS_EXT.test(file) ? "javascript" : "typescript",
    parser: "typescript",
    parserVersion: TYPESCRIPT_PARSER_VERSION,
  };
}

/** The tokens the mutation operators swap: comparison, arithmetic and logical operators, and booleans. */
const OPERATOR_KINDS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.LessThanToken,
  ts.SyntaxKind.LessThanEqualsToken,
  ts.SyntaxKind.GreaterThanToken,
  ts.SyntaxKind.GreaterThanEqualsToken,
  ts.SyntaxKind.PlusToken,
  ts.SyntaxKind.MinusToken,
  ts.SyntaxKind.AsteriskToken,
  ts.SyntaxKind.AmpersandAmpersandToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.TrueKeyword,
  ts.SyntaxKind.FalseKeyword,
]);

/**
 * The operator tokens of a file, from the compiler's scanner (so never in a
 * string or a comment). The scanner reads a token at a time without the
 * parser's rescans, as the mutation operators always have: `>=` is read as
 * `>` then `=`, and the `<` of a type argument is an operator token too.
 */
function operatorsOf(sf: ts.SourceFile): OperatorFact[] {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    true,
    ts.LanguageVariant.Standard,
    sf.text,
  );
  const out: OperatorFact[] = [];
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
    if (!OPERATOR_KINDS.has(kind)) continue;
    const start = scanner.getTokenStart();
    const at = sf.getLineAndCharacterOfPosition(start);
    out.push({
      text: scanner.getTokenText(),
      line: at.line + 1,
      column: at.character + 1,
      start,
      end: scanner.getTokenEnd(),
    });
  }
  return out;
}

/** The facts of TypeScript or JavaScript source text, as the file `file`. */
function typescriptFacts(file: string, text: string): SourceFacts {
  const sf = parseSyntax(file, text);
  const errors = syntaxErrors(sf);
  const first = errors[0];
  const facts = { ...collect(sf, sf.statements, sf, false), operators: operatorsOf(sf) };
  const firstDoc = sf.statements[0] ? docOf(sf.statements[0]) : undefined;
  return {
    file,
    contentHash: createHash("sha256").update(text).digest("hex"),
    ...provenance(file),
    parseStatus: errors.length > 0 ? "recovered" : "ok",
    ...(first
      ? {
          parseReason: `line ${lineOf(sf, first.start ?? 0)}: ${ts.flattenDiagnosticMessageText(first.messageText, " ")}`,
        }
      : {}),
    ...facts,
    ...(firstDoc ? { doc: firstDoc } : {}),
  };
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Whether `path` lies inside `dir` (or is `dir`). */
function within(dir: string, path: string): boolean {
  const rel = relative(dir, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

const PACKAGE_NAME = /^(?:@[a-z0-9~][\w.~-]*\/)?[a-z0-9~][\w.~-]*$/i;

/**
 * Resolve a module specifier (IX-2). A relative specifier names a file
 * inside `root` — as written, with a TypeScript extension for a `.js` one,
 * or a directory's `index` — or it is `unresolved`. A bare specifier with a
 * valid package name is that package; anything else (a path alias, a
 * subpath import) is `unresolved`, never guessed at.
 */
export function resolveTypeScriptModule(
  importer: string,
  specifier: string,
  root: string,
): ResolvedModule {
  const unresolved: ResolvedModule = { kind: "unresolved", specifier };
  if (specifier.startsWith(".") || specifier.startsWith("/")) {
    const absRoot = resolve(root);
    const base = specifier.startsWith("/")
      ? resolve(absRoot, `.${specifier}`)
      : resolve(absRoot, dirname(importer), specifier);
    if (!within(absRoot, base)) return unresolved;
    const stem = base.replace(/\.(?:m|c)?jsx?$/, "");
    const candidates = [
      base,
      ...RESOLVE_EXT.map((e) => `${stem}${e}`),
      ...RESOLVE_EXT.map((e) => join(stem, `index${e}`)),
      ...(stem !== base ? RESOLVE_EXT.map((e) => join(base, `index${e}`)) : []),
    ];
    const found = candidates.find((c) => within(absRoot, c) && isFile(c));
    return found
      ? { kind: "file", path: relative(absRoot, found).split(sep).join("/") }
      : unresolved;
  }
  if (specifier.startsWith("node:")) return { kind: "package", name: specifier };
  const parts = specifier.split("/");
  const name = specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? "");
  return PACKAGE_NAME.test(name) ? { kind: "package", name } : unresolved;
}

/** The TypeScript and JavaScript adapter (IX-1, IX-2). */
export const typescriptAdapter: LanguageAdapter = {
  language: "typescript",
  parser: "typescript",
  parserVersion: TYPESCRIPT_PARSER_VERSION,
  handles: (file) => TS_EXT.test(file) || JS_EXT.test(file),
  facts: typescriptFacts,
  resolve: resolveTypeScriptModule,
};
