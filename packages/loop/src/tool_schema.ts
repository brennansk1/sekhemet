import type { ToolInterfaceSpec } from "@sekhemet/context";
import type { ToolDefinition } from "@sekhemet/models";
import { TOOL_CATALOG } from "./tool_catalog.js";

/**
 * A tool as the JSON-Schema definition a request carries: the one builder
 * the session sends its definitions through. A replay does not rebuild them
 * from here — the base catalog lacks a session's variants (note's gate enum,
 * the restricted and progressive sets) — but reads the exact definitions the
 * context pack stored (kernel rule 17, MD-M11-1).
 */
export function toolDefinition(t: ToolInterfaceSpec): ToolDefinition {
  return {
    name: t.name,
    description: t.summary,
    parameters: {
      type: "object",
      properties: Object.fromEntries(
        t.parameters.map((p) => [
          p.name,
          {
            type: p.type,
            description: p.description,
            ...(p.type === "array" ? { items: { type: "string" } } : {}),
            ...(p.enumValues?.length ? { enum: p.enumValues } : {}),
          },
        ]),
      ),
      required: t.parameters.filter((p) => p.required).map((p) => p.name),
    },
  };
}

/**
 * The definitions for tool names a context pack recorded, in its order.
 * A name the catalog no longer has is returned in `missing`, so a replay
 * says what it could not rebuild rather than sending something else.
 */
export function toolDefinitionsByName(
  names: readonly string[],
  catalog: readonly ToolInterfaceSpec[] = TOOL_CATALOG,
): { tools: ToolDefinition[]; missing: string[] } {
  const byName = new Map(catalog.map((t) => [t.name, t]));
  const tools: ToolDefinition[] = [];
  const missing: string[] = [];
  for (const n of names) {
    const t = byName.get(n);
    if (t) tools.push(toolDefinition(t));
    else missing.push(n);
  }
  return { tools, missing };
}
