import type { ToolDefinition } from "@sekhemet/models";
import { estimateTokens } from "./tokens.js";
import { assertNoBannedPlaceholders, assertToolInterfaceBudget } from "./zones.js";

/**
 * Tool interface rendering for Zone 1 (Design §405-416, §1107).
 *
 * Until now the model was never told which tools exist: `InferenceRequest.tools`
 * was never populated and no textual interface was emitted, so a small model
 * had to guess tool names. This renders a compact, byte-stable description that
 * lives in the cache prefix alongside the system prompt.
 *
 * The rendering deliberately avoids bracketed placeholders (CHRONICLE §5
 * gotcha 1) — argument lists are parenthesised signatures with real names and
 * types, and requirements are numbered.
 */

export type ToolParameterType = "string" | "number" | "integer" | "boolean" | "array" | "object";

export interface ToolParameterSpec {
  name: string;
  type: ToolParameterType;
  required: boolean;
  description: string;
  /** Allowed values, when the parameter is an enumeration. */
  enumValues?: string[];
}

export interface ToolInterfaceSpec {
  name: string;
  /** One line. The full contract lives in the parameter list. */
  summary: string;
  parameters: ToolParameterSpec[];
  /** What the tool returns, one line. */
  returns?: string;
}

export const TOOL_INTERFACE_HEADER = "=== TOOL INTERFACE ===";

const PREAMBLE = [
  "Emit tool calls, not prose. One call per step.",
  "1. Arguments marked with a trailing asterisk are required.",
  "2. Pass arguments as JSON values of the declared type.",
  "3. Call only the tools named below. No other tool exists.",
].join("\n");

function compareParameters(a: ToolParameterSpec, b: ToolParameterSpec): number {
  if (a.required !== b.required) return a.required ? -1 : 1;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

const MAX_PARAM_DESCRIPTION_CHARS = 60;

function renderParameter(param: ToolParameterSpec): string {
  const marker = param.required ? "*" : "";
  const values = param.enumValues?.length ? ` one of ${param.enumValues.join("|")}` : "";
  const description = param.description.trim();
  const note = description
    ? ` (${
        description.length > MAX_PARAM_DESCRIPTION_CHARS
          ? `${description.slice(0, MAX_PARAM_DESCRIPTION_CHARS - 3)}...`
          : description
      })`
    : "";
  return `${param.name}${marker}: ${param.type}${values}${note}`;
}

function renderTool(tool: ToolInterfaceSpec): string {
  const params = [...tool.parameters].sort(compareParameters).map(renderParameter).join(", ");
  const signature = `${tool.name}(${params})`;
  const returns = tool.returns ? ` -> ${tool.returns}` : "";
  return `${signature}${returns}\n  ${tool.summary}`;
}

/**
 * Renders the tool interface. Deterministic for a given tool set: tools are
 * sorted by name and parameters by (required, name), so the bytes never depend
 * on registration or filesystem order.
 */
export function renderToolInterface(tools: ToolInterfaceSpec[]): string {
  if (tools.length === 0) return "";

  const sorted = [...tools].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const body = sorted.map(renderTool).join("\n");
  const rendered = `${TOOL_INTERFACE_HEADER}\n${PREAMBLE}\n\n${body}`;

  assertNoBannedPlaceholders(rendered, "tool interface");
  assertToolInterfaceBudget(rendered);
  return rendered;
}

/** Name plus one-line summary only — the `tool_search` compact form (§224). */
export function renderToolIndex(tools: ToolInterfaceSpec[]): string {
  if (tools.length === 0) return "";
  const sorted = [...tools].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return sorted.map((t) => `${t.name}: ${t.summary}`).join("\n");
}

function normalizeType(value: unknown): ToolParameterType {
  const type = typeof value === "string" ? value : "string";
  switch (type) {
    case "number":
    case "integer":
    case "boolean":
    case "array":
    case "object":
      return type;
    default:
      return "string";
  }
}

interface JsonSchemaProperty {
  type?: unknown;
  description?: unknown;
  enum?: unknown;
}

/**
 * Derives specs from the JSON-schema `parameters` carried by
 * `@sekhemet/models` `ToolDefinition`s, so one tool registry can feed both the
 * grammar-constrained decode path and the textual Zone 1 interface.
 */
export function toolInterfaceFromDefinitions(definitions: ToolDefinition[]): ToolInterfaceSpec[] {
  return definitions.map((def) => {
    const schema = def.parameters as {
      properties?: Record<string, JsonSchemaProperty>;
      required?: unknown;
    };
    const required = new Set(
      Array.isArray(schema?.required) ? schema.required.filter((r) => typeof r === "string") : [],
    );
    const properties = schema?.properties ?? {};

    const parameters: ToolParameterSpec[] = Object.entries(properties).map(([name, prop]) => {
      const enumValues = Array.isArray(prop?.enum)
        ? prop.enum.filter((v): v is string => typeof v === "string")
        : undefined;
      return {
        name,
        type: normalizeType(prop?.type),
        required: required.has(name),
        description: typeof prop?.description === "string" ? prop.description : "",
        ...(enumValues && enumValues.length > 0 ? { enumValues } : {}),
      };
    });

    return { name: def.name, summary: def.description, parameters };
  });
}

export interface ToolInterfaceReport {
  rendered: string;
  tokens: number;
  budget: number;
  toolCount: number;
}

export function measureToolInterface(tools: ToolInterfaceSpec[]): ToolInterfaceReport {
  const rendered = renderToolInterface(tools);
  const report = assertToolInterfaceBudget(rendered);
  return {
    rendered,
    tokens: estimateTokens(rendered),
    budget: report.budget,
    toolCount: tools.length,
  };
}
