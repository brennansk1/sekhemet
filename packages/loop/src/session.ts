import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import type { GateResult } from "@sekhemet/gates";
import type { ToolCall } from "@sekhemet/models";
import { type ExecutionResult, ProcessSandbox } from "@sekhemet/sandbox";
import { OscillationDetector } from "./detector.js";
import type {
  CardExecutionSession,
  ExecutionStopReason,
  SessionOptions,
  TurnResult,
} from "./types.js";

export class CardExecutionSessionImpl implements CardExecutionSession {
  public readonly cardId: string;
  private stepBudget: number;
  private worktreePath: string;
  private stepsUsed = 0;
  private isFinished = false;
  private oscillationDetector = new OscillationDetector(3);
  private sandbox = new ProcessSandbox();

  constructor(private options: SessionOptions) {
    this.cardId = options.cardId;
    this.stepBudget = options.stepBudget;
    this.worktreePath = options.worktreePath;
  }

  public getStepsUsed(): number {
    return this.stepsUsed;
  }

  public async readFile(relativePath: string): Promise<string> {
    const fullPath = join(this.worktreePath, relativePath);
    if (!existsSync(fullPath)) {
      throw new Error(`File not found: ${relativePath}`);
    }
    return readFileSync(fullPath, "utf8");
  }

  public async writeFile(relativePath: string, content: string): Promise<void> {
    const fullPath = join(this.worktreePath, relativePath);
    const parentDir = dirname(fullPath);
    if (!existsSync(parentDir)) {
      mkdirSync(parentDir, { recursive: true });
    }
    writeFileSync(fullPath, content, "utf8");
  }

  public async executeReadFile(
    relativePath: string,
    startLine?: number,
    endLine?: number,
  ): Promise<string> {
    const content = await this.readFile(relativePath);
    if (startLine === undefined && endLine === undefined) {
      return content;
    }

    const lines = content.split("\n");
    const start = Math.max(1, startLine ?? 1) - 1;
    const end = Math.min(lines.length, endLine ?? lines.length);
    return lines.slice(start, end).join("\n");
  }

  public async executeReplaceLines(
    relativePath: string,
    startLine: number,
    endLine: number,
    replacement: string,
  ): Promise<void> {
    const content = await this.readFile(relativePath);
    const lines = content.split("\n");

    const startIdx = Math.max(1, startLine) - 1;
    const endIdx = Math.min(lines.length, endLine);

    const replacementLines = replacement.split("\n");
    lines.splice(startIdx, endIdx - startIdx, ...replacementLines);

    await this.writeFile(relativePath, lines.join("\n"));
  }

  public async executeListDir(relPath = "."): Promise<string[]> {
    const fullPath = join(this.worktreePath, relPath);
    if (!existsSync(fullPath)) {
      return [];
    }
    return readdirSync(fullPath);
  }

  public async executeFindFiles(pattern: string, relDir = "."): Promise<string[]> {
    const fullDir = join(this.worktreePath, relDir);
    const results: string[] = [];

    const walk = (current: string) => {
      if (!existsSync(current)) return;
      const entries = readdirSync(current, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "dist") {
          continue;
        }
        const entryPath = join(current, entry.name);
        if (entry.isDirectory()) {
          walk(entryPath);
        } else if (entry.isFile()) {
          const rel = relative(this.worktreePath, entryPath);
          if (pattern.includes("*")) {
            const ext = pattern.replace("*", "");
            if (rel.endsWith(ext)) {
              results.push(rel);
            }
          } else if (rel.includes(pattern)) {
            results.push(rel);
          }
        }
      }
    };

    walk(fullDir);
    return results;
  }

  public async executeGrepSearch(
    query: string,
    relDir = ".",
  ): Promise<{ file: string; line: number; content: string }[]> {
    const files = await this.executeFindFiles("*", relDir);
    const matches: { file: string; line: number; content: string }[] = [];

    for (const file of files) {
      try {
        const text = await this.readFile(file);
        const lines = text.split("\n");
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i] ?? "";
          if (line.includes(query)) {
            matches.push({
              file,
              line: i + 1,
              content: line.trim(),
            });
          }
        }
      } catch {
        // Skip unreadable files
      }
    }

    return matches;
  }

  public async executeRunCmd(command: string, args: string[] = []): Promise<ExecutionResult> {
    return this.sandbox.execute(command, args, {
      allowedPaths: [this.worktreePath],
      allowNetwork: false,
      timeoutMs: 30000,
      cwd: this.worktreePath,
    });
  }

  public async readSymbol(relativePath: string, symbolName: string): Promise<string> {
    const content = await this.readFile(relativePath);
    const regex = new RegExp(
      `(?:export\\s+)?(?:async\\s+)?(?:function|class|interface|type|const|let|var)\\s+${symbolName}\\b[^;{]*`,
      "m",
    );
    const match = regex.exec(content);
    if (!match) {
      throw new Error(`Symbol "${symbolName}" not found in ${relativePath}`);
    }

    const startIndex = match.index;
    const braceIndex = content.indexOf("{", startIndex);
    const semiIndex = content.indexOf(";", startIndex);

    if (braceIndex !== -1 && (semiIndex === -1 || braceIndex < semiIndex)) {
      let depth = 0;
      let endIndex = -1;
      for (let i = braceIndex; i < content.length; i++) {
        if (content[i] === "{") depth++;
        else if (content[i] === "}") {
          depth--;
          if (depth === 0) {
            endIndex = i + 1;
            break;
          }
        }
      }
      if (endIndex !== -1) {
        return content.slice(startIndex, endIndex);
      }
    }

    if (semiIndex !== -1) {
      return content.slice(startIndex, semiIndex + 1);
    }

    return content.slice(startIndex);
  }

  public async replaceSymbolBody(
    relativePath: string,
    symbolName: string,
    newBody: string,
  ): Promise<void> {
    const content = await this.readFile(relativePath);
    const regex = new RegExp(
      `(?:export\\s+)?(?:async\\s+)?(?:function|class|interface|type|const|let|var)\\s+${symbolName}\\b[^;{]*`,
      "m",
    );
    const match = regex.exec(content);
    if (!match) {
      throw new Error(`Symbol "${symbolName}" not found in ${relativePath}`);
    }

    const startIndex = match.index;
    const braceIndex = content.indexOf("{", startIndex);
    if (braceIndex === -1) {
      throw new Error(`Symbol "${symbolName}" has no body block {...} to replace`);
    }

    let depth = 0;
    let endIndex = -1;
    for (let i = braceIndex; i < content.length; i++) {
      if (content[i] === "{") depth++;
      else if (content[i] === "}") {
        depth--;
        if (depth === 0) {
          endIndex = i;
          break;
        }
      }
    }

    if (endIndex === -1) {
      throw new Error(`Unbalanced braces for symbol "${symbolName}" in ${relativePath}`);
    }

    const updated = `${content.slice(0, braceIndex + 1)}\n    ${newBody.trim()}\n  ${content.slice(endIndex)}`;
    await this.writeFile(relativePath, updated);
  }

  public async findReferences(
    symbolName: string,
    relDir = ".",
  ): Promise<{ file: string; line: number; content: string }[]> {
    return this.executeGrepSearch(symbolName, relDir);
  }

  public async executeTurn(): Promise<TurnResult> {
    this.stepsUsed++;
    const turnIndex = this.stepsUsed;

    // 1. Generate model response
    const response = await this.options.modelAdapter.generate({
      prompt: `Executing card ${this.cardId} turn ${turnIndex}. Proceed with edits.`,
      toolArm: "arm_a_flat",
    });

    const toolCalls = response.toolCalls;

    // 2. Check for oscillation
    if (this.oscillationDetector.recordAndCheck(toolCalls)) {
      return {
        turnIndex,
        toolCalls,
        stopReason: "oscillation_detected",
      };
    }

    // 3. Dispatch tool calls
    let finishRequested = false;
    for (const call of toolCalls) {
      if (call.name === "write_file") {
        const p = call.arguments.path as string;
        const c = call.arguments.content as string;
        if (p && c !== undefined) {
          await this.writeFile(p, c);
        }
      } else if (call.name === "read_file") {
        const p = call.arguments.path as string;
        if (p) {
          await this.executeReadFile(p);
        }
      } else if (call.name === "replace_lines") {
        const p = call.arguments.path as string;
        const s = call.arguments.start as number;
        const e = call.arguments.end as number;
        const r = call.arguments.replacement as string;
        if (p && s !== undefined && e !== undefined && r !== undefined) {
          await this.executeReplaceLines(p, s, e, r);
        }
      } else if (call.name === "run_cmd") {
        const cmd = call.arguments.command as string;
        const args = (call.arguments.args as string[]) || [];
        if (cmd) {
          await this.executeRunCmd(cmd, args);
        }
      } else if (call.name === "list_dir") {
        const p = (call.arguments.path as string) || ".";
        await this.executeListDir(p);
      } else if (call.name === "find_files") {
        const pat = (call.arguments.pattern as string) || "*";
        const p = (call.arguments.path as string) || ".";
        await this.executeFindFiles(pat, p);
      } else if (call.name === "grep_search") {
        const q = call.arguments.query as string;
        const p = (call.arguments.path as string) || ".";
        if (q) {
          await this.executeGrepSearch(q, p);
        }
      } else if (call.name === "read_symbol") {
        const p = call.arguments.path as string;
        const s = call.arguments.symbol as string;
        if (p && s) {
          await this.readSymbol(p, s);
        }
      } else if (call.name === "replace_symbol_body") {
        const p = call.arguments.path as string;
        const s = call.arguments.symbol as string;
        const b = call.arguments.body as string;
        if (p && s && b !== undefined) {
          await this.replaceSymbolBody(p, s, b);
        }
      } else if (call.name === "find_references") {
        const s = call.arguments.symbol as string;
        const p = (call.arguments.path as string) || ".";
        if (s) {
          await this.findReferences(s, p);
        }
      } else if (call.name === "finish_card") {
        finishRequested = true;
      }
    }

    // 4. Run verification gates if finish requested
    let gateResult: GateResult | undefined;
    let stopReason: ExecutionStopReason | undefined;

    if (finishRequested) {
      gateResult = await this.runVerification();
      if (gateResult.passed) {
        this.isFinished = true;
        stopReason = "gate_passed";
      }
    }

    // 5. Check step budget
    if (!stopReason && this.stepsUsed >= this.stepBudget) {
      stopReason = "budget_exhausted";
    }

    const result: TurnResult = {
      turnIndex,
      toolCalls,
    };
    if (gateResult) result.gateResult = gateResult;
    if (stopReason) result.stopReason = stopReason;

    return result;
  }

  public async runVerification(): Promise<GateResult> {
    return this.options.gateRunner.runGates(["typecheck", "test"], this.worktreePath);
  }

  public async abort(_reason: string): Promise<void> {
    this.isFinished = true;
  }
}
