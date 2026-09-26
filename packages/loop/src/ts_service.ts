import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { ts } from "@sekhemet/gates";

/**
 * Semantic symbol lookup for TypeScript and JavaScript (L9), through the
 * TypeScript language service in-process: the same engine
 * typescript-language-server wraps, without a server to install. It
 * resolves references through imports, re-exports and renames, where a
 * whole-word grep matches every same-named identifier in the tree.
 */
export interface SymbolLocation {
  /** Worktree-relative path. */
  path: string;
  /** 1-based. */
  line: number;
  column: number;
  text: string;
  isDefinition: boolean;
}

const TS_FILE = /\.(?:[cm]?[jt]sx?)$/;

export function isTypeScriptLike(path: string): boolean {
  return TS_FILE.test(path) && !path.endsWith(".d.ts");
}

export class TsSymbolService {
  private versions = new Map<string, string>();
  private service: ts.LanguageService;
  private options: ts.CompilerOptions;

  constructor(
    private root: string,
    private files: () => string[],
  ) {
    this.options = this.readCompilerOptions();
    const host: ts.LanguageServiceHost = {
      getScriptFileNames: () => this.files().filter((f) => TS_FILE.test(f)),
      getScriptVersion: (f) => {
        try {
          return String(statSync(f).mtimeMs);
        } catch {
          return "0";
        }
      },
      getScriptSnapshot: (f) => {
        if (!existsSync(f)) return undefined;
        return ts.ScriptSnapshot.fromString(readFileSync(f, "utf8"));
      },
      getCurrentDirectory: () => this.root,
      getCompilationSettings: () => this.options,
      getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
      fileExists: ts.sys.fileExists,
      readFile: ts.sys.readFile,
      readDirectory: ts.sys.readDirectory,
      directoryExists: ts.sys.directoryExists,
      getDirectories: ts.sys.getDirectories,
    };
    this.service = ts.createLanguageService(host, ts.createDocumentRegistry());
  }

  private readCompilerOptions(): ts.CompilerOptions {
    const base: ts.CompilerOptions = {
      allowJs: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      noEmit: true,
    };
    const config = join(this.root, "tsconfig.json");
    if (!existsSync(config)) return base;
    const parsed = ts.readConfigFile(config, ts.sys.readFile);
    if (parsed.error) return base;
    const opts = ts.parseJsonConfigFileContent(parsed.config, ts.sys, dirname(config)).options;
    return { ...base, ...opts, noEmit: true };
  }

  /** Declarations named `symbol` in `file` (or anywhere when `file` is omitted). */
  private declarationPositions(symbol: string, file?: string): { file: string; pos: number }[] {
    const program = this.service.getProgram();
    if (!program) return [];
    const out: { file: string; pos: number }[] = [];
    const candidates = file
      ? [program.getSourceFile(file)].filter((s): s is ts.SourceFile => !!s)
      : program
          .getSourceFiles()
          .filter((s) => !s.isDeclarationFile && s.fileName.startsWith(this.root));
    for (const sf of candidates) {
      const visit = (node: ts.Node): void => {
        const name = (node as { name?: ts.Node }).name;
        if (
          name &&
          ts.isIdentifier(name) &&
          name.text === symbol &&
          (ts.isFunctionDeclaration(node) ||
            ts.isClassDeclaration(node) ||
            ts.isInterfaceDeclaration(node) ||
            ts.isTypeAliasDeclaration(node) ||
            ts.isEnumDeclaration(node) ||
            ts.isVariableDeclaration(node) ||
            ts.isMethodDeclaration(node) ||
            ts.isPropertyDeclaration(node) ||
            ts.isPropertySignature(node) ||
            ts.isMethodSignature(node))
        ) {
          out.push({ file: sf.fileName, pos: name.getStart(sf) });
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }
    return out;
  }

  private toLocation(file: string, start: number, isDefinition: boolean): SymbolLocation {
    const sf = this.service.getProgram()?.getSourceFile(file);
    const lc = sf ? sf.getLineAndCharacterOfPosition(start) : { line: 0, character: 0 };
    const lineText = sf ? (sf.text.split("\n")[lc.line] ?? "") : "";
    return {
      path: relative(this.root, file),
      line: lc.line + 1,
      column: lc.character + 1,
      text: lineText.trim(),
      isDefinition,
    };
  }

  /**
   * Every reference to the symbol declared as `symbol` (in `inFile` when
   * given), definitions included, through imports and re-exports.
   * Undefined when no declaration of that name exists.
   */
  public references(symbol: string, inFile?: string): SymbolLocation[] | undefined {
    const decls = this.declarationPositions(symbol, inFile ? join(this.root, inFile) : undefined);
    if (decls.length === 0) return undefined;
    const seen = new Set<string>();
    const out: SymbolLocation[] = [];
    for (const d of decls) {
      for (const group of this.service.findReferences(d.file, d.pos) ?? []) {
        for (const ref of group.references) {
          const key = `${ref.fileName}:${ref.textSpan.start}`;
          if (seen.has(key) || !ref.fileName.startsWith(this.root)) continue;
          seen.add(key);
          out.push(this.toLocation(ref.fileName, ref.textSpan.start, ref.isDefinition === true));
        }
      }
    }
    return out.sort((a, b) => (a.path === b.path ? a.line - b.line : a.path < b.path ? -1 : 1));
  }

  /**
   * Every site a rename of the symbol declared as `symbol` (in `inFile`)
   * changes, as absolute file, 0-based offset and length (WL-N6-1), with the
   * text around the new name that keeps a shorthand property or a
   * destructuring binding's shape (`{ foo }` becomes `{ bar: foo }`).
   * Undefined when no declaration of that name exists.
   */
  public renameLocations(
    symbol: string,
    inFile?: string,
  ):
    | { file: string; start: number; length: number; prefixText?: string; suffixText?: string }[]
    | undefined {
    const decls = this.declarationPositions(symbol, inFile ? join(this.root, inFile) : undefined);
    const decl = decls[0];
    if (!decl) return undefined;
    const locations =
      this.service.findRenameLocations(decl.file, decl.pos, false, false, {
        providePrefixAndSuffixTextForRename: true,
      }) ?? [];
    return locations
      .filter((l) => l.fileName.startsWith(this.root))
      .map((l) => ({
        file: l.fileName,
        start: l.textSpan.start,
        length: l.textSpan.length,
        ...(l.prefixText ? { prefixText: l.prefixText } : {}),
        ...(l.suffixText ? { suffixText: l.suffixText } : {}),
      }));
  }

  /** Where `symbol` is declared, with its type as the compiler sees it. */
  public definition(symbol: string, inFile?: string): (SymbolLocation & { type: string })[] {
    const decls = this.declarationPositions(symbol, inFile ? join(this.root, inFile) : undefined);
    return decls.map((d) => {
      const info = this.service.getQuickInfoAtPosition(d.file, d.pos);
      return {
        ...this.toLocation(d.file, d.pos, true),
        type: info ? ts.displayPartsToString(info.displayParts) : "",
      };
    });
  }
}
