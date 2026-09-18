import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { GateResult } from "@sekhemet/gates";
import type { ToolCall } from "@sekhemet/models";
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

  public async abort(reason: string): Promise<void> {
    this.isFinished = true;
  }
}
