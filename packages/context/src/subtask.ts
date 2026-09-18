import type { ChatTurn, LocalInferenceAdapter, ToolCall, ToolDefinition } from "@sekhemet/models";
import { estimatePromptTokens } from "./allocator.js";

/**
 * Subtask branching (C16, design "Subtask branching"). A side question
 * ("which file defines the retry policy?", "what does this error mean?") is
 * answered in a child context that starts empty except for what the parent
 * hands it, may use read-only tools for a few steps, and returns only a
 * bounded summary. The parent's context grows by the summary, never by the
 * child's exploration: the context-rot defense applied to delegation.
 */
export interface SubtaskOptions {
  adapter: LocalInferenceAdapter;
  question: string;
  /** What the parent hands down: file excerpts, the failing error. */
  context?: string;
  /** Read-only tools the child may call. */
  tools?: ToolDefinition[];
  /** Runs one tool call for the child; its output never reaches the parent. */
  executeTool?: (call: ToolCall) => Promise<string>;
  maxSteps?: number;
  /** Cap on the summary returned to the parent. Default 200 tokens. */
  maxSummaryTokens?: number;
}

export interface SubtaskResult {
  summary: string;
  steps: number;
  /** Tokens the child spent; none of them enter the parent's prompt. */
  childTokens: number;
  toolCalls: number;
  stopReason: "answered" | "step_budget" | "no_answer";
}

const SYSTEM = [
  "You answer ONE sub-question for a parent coding agent.",
  "Use the tools only to look things up; never change files.",
  "When you know the answer, reply with a line starting 'ANSWER:' followed by a short, factual answer (file paths, symbol names, line numbers). No preamble.",
].join("\n");

function clampTokens(text: string, max: number): string {
  if (estimatePromptTokens(text) <= max) return text;
  let out = text.slice(0, Math.max(0, max * 3));
  while (out.length > 0 && estimatePromptTokens(`${out}…`) > max) out = out.slice(0, -20);
  return `${out}…`;
}

export async function runSubtask(options: SubtaskOptions): Promise<SubtaskResult> {
  const maxSteps = options.maxSteps ?? 4;
  const maxSummary = options.maxSummaryTokens ?? 200;
  const turns: ChatTurn[] = [
    {
      role: "user",
      content: [
        `Sub-question: ${options.question}`,
        options.context ? `Context from the parent:\n${options.context}` : "",
      ]
        .filter(Boolean)
        .join("\n\n"),
    },
  ];
  let childTokens = 0;
  let toolCalls = 0;
  let lastText = "";
  for (let step = 1; step <= maxSteps; step++) {
    const res = await options.adapter.generate({
      systemPrompt: SYSTEM,
      prompt: "",
      messages: turns,
      toolArm: "arm_a_flat",
      temperature: 0,
      reasoning: "off",
      maxTokens: 600,
      ...(options.tools?.length && options.executeTool ? { tools: options.tools } : {}),
    });
    childTokens += res.usage.promptTokens + res.usage.completionTokens;
    lastText = res.text;
    const answer = /ANSWER:\s*([\s\S]*)/i.exec(res.text)?.[1]?.trim();
    const calls = options.executeTool ? res.toolCalls : [];
    if (answer && calls.length === 0) {
      return {
        summary: clampTokens(answer, maxSummary),
        steps: step,
        childTokens,
        toolCalls,
        stopReason: "answered",
      };
    }
    if (calls.length === 0) {
      turns.push({ role: "assistant", content: res.text });
      turns.push({ role: "user", content: "Reply with 'ANSWER:' and the answer now." });
      continue;
    }
    turns.push({ role: "assistant", content: res.text, toolCalls: calls });
    for (const call of calls) {
      toolCalls++;
      const out = await (options.executeTool as (c: ToolCall) => Promise<string>)(call);
      turns.push({ role: "tool", toolCallId: call.id, content: clampTokens(out, 1500) });
    }
  }
  const fallback = lastText.trim();
  return {
    summary: fallback ? clampTokens(fallback, maxSummary) : "(the subtask found no answer)",
    steps: maxSteps,
    childTokens,
    toolCalls,
    stopReason: fallback ? "step_budget" : "no_answer",
  };
}
