import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { InferenceRequest, LocalInferenceAdapter } from "@sekhemet/models";

/**
 * OpenTelemetry-shaped spans, stored locally in SQLite (H22).
 *
 * Local-first: spans go to .sekhemet/traces.db, never off the machine unless
 * the user exports them. The shape is OTel's (trace id, span id, parent,
 * name, start and end in nanoseconds, attributes using the GenAI semantic
 * conventions where they exist, status), so `sekhemet traces export` writes
 * OTLP/JSON any OTel tool reads, or posts it to a collector the user names
 * (Jaeger, Tempo, Phoenix, Langfuse's OTLP endpoint).
 *
 * The ledger stays the record of what happened; spans add where the time
 * went: card, turn, model call, gates.
 */

export interface SpanRecord {
  traceId: string;
  spanId: string;
  parentSpanId?: string | undefined;
  name: string;
  startNs: bigint;
  endNs?: bigint;
  attributes: Record<string, string | number | boolean>;
  status: "unset" | "ok" | "error";
}

const hex = (bytes: number) => randomBytes(bytes).toString("hex");
/** Wall-clock nanoseconds with sub-millisecond resolution (OTLP wants Unix ns). */
const nowNs = () => BigInt(Math.round((performance.timeOrigin + performance.now()) * 1_000_000));

export class Tracer {
  private db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(`CREATE TABLE IF NOT EXISTS spans (
      trace_id TEXT NOT NULL, span_id TEXT PRIMARY KEY, parent_span_id TEXT,
      name TEXT NOT NULL, start_ns TEXT NOT NULL, end_ns TEXT,
      attributes TEXT NOT NULL, status TEXT NOT NULL)`);
    this.db.exec("CREATE INDEX IF NOT EXISTS spans_trace ON spans(trace_id)");
  }

  static forRepo(repoPath: string): Tracer {
    return new Tracer(join(repoPath, ".sekhemet", "traces.db"));
  }

  /** Start a span; `end` records it. Children pass `parent`. */
  start(
    name: string,
    attributes: SpanRecord["attributes"] = {},
    parent?: { traceId: string; spanId: string },
  ): Span {
    return new Span(this, {
      traceId: parent?.traceId ?? hex(16),
      spanId: hex(8),
      parentSpanId: parent?.spanId,
      name,
      startNs: nowNs(),
      attributes: { ...attributes },
      status: "unset",
    });
  }

  write(s: SpanRecord): void {
    this.db
      .prepare(
        "INSERT OR REPLACE INTO spans (trace_id, span_id, parent_span_id, name, start_ns, end_ns, attributes, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        s.traceId,
        s.spanId,
        s.parentSpanId ?? null,
        s.name,
        s.startNs.toString(),
        s.endNs?.toString() ?? null,
        JSON.stringify(s.attributes),
        s.status,
      );
  }

  spans(filter: { traceId?: string; sinceMs?: number } = {}): SpanRecord[] {
    const rows = (
      filter.traceId
        ? this.db
            .prepare("SELECT * FROM spans WHERE trace_id = ? ORDER BY CAST(start_ns AS INTEGER)")
            .all(filter.traceId)
        : this.db
            .prepare(
              "SELECT * FROM spans WHERE CAST(start_ns AS INTEGER) >= ? ORDER BY CAST(start_ns AS INTEGER)",
            )
            .all(String(BigInt(filter.sinceMs ?? 0) * 1_000_000n))
    ) as Record<string, string | null>[];
    return rows.map((r) => ({
      traceId: String(r.trace_id),
      spanId: String(r.span_id),
      ...(r.parent_span_id ? { parentSpanId: r.parent_span_id } : {}),
      name: String(r.name),
      startNs: BigInt(String(r.start_ns)),
      ...(r.end_ns ? { endNs: BigInt(r.end_ns) } : {}),
      attributes: JSON.parse(String(r.attributes)) as SpanRecord["attributes"],
      status: r.status as SpanRecord["status"],
    }));
  }

  /** Delete spans that started before `beforeMs` (retention, RUN-15); returns how many. */
  prune(beforeMs: number): number {
    const r = this.db
      .prepare("DELETE FROM spans WHERE CAST(start_ns AS INTEGER) < CAST(? AS INTEGER)")
      .run(String(BigInt(Math.floor(beforeMs)) * 1_000_000n));
    return Number(r.changes);
  }

  close(): void {
    this.db.close();
  }
}

/** A span for one tool call, child of its step's span (RUN-45), with its real timing. */
export function toolCallSpan(
  tracer: Tracer,
  step: { traceId: string; spanId: string },
  call: {
    callId: string;
    name: string;
    ok: boolean;
    denied: boolean;
    startedAtMs: number;
    endedAtMs: number;
  },
): void {
  const outcome = call.denied ? "denied" : call.ok ? "ok" : "failed";
  try {
    tracer.write({
      traceId: step.traceId,
      spanId: randomBytes(8).toString("hex"),
      parentSpanId: step.spanId,
      // OpenTelemetry's GenAI convention for a tool execution.
      name: `execute_tool ${call.name}`,
      startNs: BigInt(call.startedAtMs) * 1_000_000n,
      endNs: BigInt(call.endedAtMs) * 1_000_000n,
      attributes: {
        "gen_ai.operation.name": "execute_tool",
        "gen_ai.tool.name": call.name,
        "gen_ai.tool.call.id": call.callId,
        "sekhemet.tool.outcome": outcome,
      },
      status: call.ok ? "ok" : "error",
    });
  } catch {
    // Tracing must never fail the work it observes.
  }
}

export type TraceKind = "Card" | "Step" | "Model request" | "Tool call" | "Other";

export interface TraceRow {
  kind: TraceKind;
  label: string;
  spanId: string;
  parentSpanId?: string;
  startMs: number;
  durationMs: number;
  status: SpanRecord["status"];
  attributes: SpanRecord["attributes"];
}

/**
 * A card's trace as the dashboard shows it (RUN-46): its card, step,
 * model-request and tool-call spans with durations, the step span labelled
 * *Step* (the code's `card.turn`, DEC-26).
 */
export function cardTrace(repoPath: string, cardId: string): TraceRow[] {
  const path = join(repoPath, ".sekhemet", "traces.db");
  if (!existsSync(path)) return [];
  const tracer = new Tracer(path);
  try {
    const all = tracer.spans();
    const traces = new Set(
      all
        .filter((s) => s.name === "card.run" && s.attributes["sekhemet.card.id"] === cardId)
        .map((s) => s.traceId),
    );
    let step = 0;
    return all
      .filter((s) => traces.has(s.traceId))
      .map((s) => {
        const kind: TraceKind =
          s.name === "card.run"
            ? "Card"
            : s.name === "card.turn"
              ? "Step"
              : s.name === "gen_ai.chat"
                ? "Model request"
                : s.name.startsWith("execute_tool ")
                  ? "Tool call"
                  : "Other";
        const label =
          kind === "Card"
            ? cardId
            : kind === "Step"
              ? `Step ${++step}`
              : kind === "Model request"
                ? String(s.attributes["gen_ai.request.model"] ?? "model")
                : kind === "Tool call"
                  ? String(s.attributes["gen_ai.tool.name"] ?? s.name)
                  : s.name;
        const startMs = Number(s.startNs / 1_000_000n);
        const durationMs =
          s.endNs !== undefined ? Math.max(0, Number((s.endNs - s.startNs) / 1_000_000n)) : 0;
        return {
          kind,
          label,
          spanId: s.spanId,
          ...(s.parentSpanId ? { parentSpanId: s.parentSpanId } : {}),
          startMs,
          durationMs,
          status: s.status,
          attributes: s.attributes,
        };
      });
  } finally {
    tracer.close();
  }
}

export class Span {
  constructor(
    private tracer: Tracer,
    readonly record: SpanRecord,
  ) {}

  get context(): { traceId: string; spanId: string } {
    return { traceId: this.record.traceId, spanId: this.record.spanId };
  }

  set(attrs: SpanRecord["attributes"]): this {
    Object.assign(this.record.attributes, attrs);
    return this;
  }

  end(status: "ok" | "error" = "ok"): void {
    this.record.endNs = nowNs();
    this.record.status = status;
    try {
      this.tracer.write(this.record);
    } catch {
      // Tracing must never fail the work it observes.
    }
  }
}

/**
 * Wrap an adapter so every generate() is a span with the GenAI semantic
 * convention attributes (gen_ai.request.model, gen_ai.usage.input_tokens and
 * output_tokens), plus prefill and decode speed and cache reuse.
 */
export function traced<A extends LocalInferenceAdapter>(
  adapter: A,
  tracer: Tracer,
  parent: () => { traceId: string; spanId: string } | undefined,
): A {
  return new Proxy(adapter, {
    get(target, prop, receiver) {
      if (prop !== "generate") return Reflect.get(target, prop, receiver);
      return async (req: InferenceRequest) => {
        const span = tracer.start(
          "gen_ai.chat",
          {
            "gen_ai.system": "llama.cpp",
            "gen_ai.request.model": target.modelId,
            ...(req.maxTokens ? { "gen_ai.request.max_tokens": req.maxTokens } : {}),
            ...(req.temperature !== undefined
              ? { "gen_ai.request.temperature": req.temperature }
              : {}),
            "sekhemet.tools": req.tools?.length ?? 0,
          },
          parent(),
        );
        try {
          const res = await target.generate(req);
          span.set({
            "gen_ai.usage.input_tokens": res.usage.promptTokens,
            "gen_ai.usage.output_tokens": res.usage.completionTokens,
            "sekhemet.tool_calls": res.toolCalls.length,
            ...(res.usage.prefillTokensPerSecond
              ? { "sekhemet.prefill_tps": Math.round(res.usage.prefillTokensPerSecond) }
              : {}),
            ...(res.usage.decodeTokensPerSecond
              ? { "sekhemet.decode_tps": Math.round(res.usage.decodeTokensPerSecond * 10) / 10 }
              : {}),
            ...(res.usage.cacheHitRate !== undefined
              ? { "sekhemet.cache_hit_rate": Math.round(res.usage.cacheHitRate * 100) / 100 }
              : {}),
          });
          span.end("ok");
          return res;
        } catch (err) {
          span.set({
            "error.message": err instanceof Error ? err.message.slice(0, 300) : String(err),
          });
          span.end("error");
          throw err;
        }
      };
    },
  });
}

/** OTLP/JSON (the collector's /v1/traces body) for a set of spans. */
export function toOtlp(spans: SpanRecord[], serviceName = "sekhemet"): unknown {
  const value = (v: string | number | boolean) =>
    typeof v === "string"
      ? { stringValue: v }
      : typeof v === "boolean"
        ? { boolValue: v }
        : Number.isInteger(v)
          ? { intValue: String(v) }
          : { doubleValue: v };
  return {
    resourceSpans: [
      {
        resource: { attributes: [{ key: "service.name", value: { stringValue: serviceName } }] },
        scopeSpans: [
          {
            scope: { name: "sekhemet", version: "1" },
            spans: spans.map((s) => ({
              traceId: s.traceId,
              spanId: s.spanId,
              ...(s.parentSpanId ? { parentSpanId: s.parentSpanId } : {}),
              name: s.name,
              kind: s.name.startsWith("gen_ai") ? 3 : 1,
              startTimeUnixNano: s.startNs.toString(),
              endTimeUnixNano: (s.endNs ?? s.startNs).toString(),
              attributes: Object.entries(s.attributes).map(([key, v]) => ({
                key,
                value: value(v),
              })),
              status: { code: s.status === "ok" ? 1 : s.status === "error" ? 2 : 0 },
            })),
          },
        ],
      },
    ],
  };
}

/** `sekhemet traces [--since-hours N] [--out file.json] [--otlp http://host:4318]`. */
export async function tracesCommand(
  repoPath: string,
  argv: string[],
  deps: { fetch?: typeof fetch; say?: (l: string) => void } = {},
): Promise<number> {
  const say = deps.say ?? ((l: string) => console.log(l));
  const flag = (name: string) => {
    const i = argv.indexOf(name);
    return i === -1 ? undefined : argv[i + 1];
  };
  const tracer = Tracer.forRepo(repoPath);
  try {
    const hours = Number(flag("--since-hours") ?? 24);
    const spans = tracer.spans({ sinceMs: Date.now() - hours * 3_600_000 });
    const out = flag("--out");
    const otlp = flag("--otlp");
    if (out) {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(out, `${JSON.stringify(toOtlp(spans), null, 2)}\n`);
      say(`Wrote ${spans.length} span(s) as OTLP/JSON to ${out}.`);
    }
    if (otlp) {
      const res = await (deps.fetch ?? fetch)(`${otlp.replace(/\/$/, "")}/v1/traces`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(toOtlp(spans)),
        signal: AbortSignal.timeout(15_000),
      });
      say(
        res.ok
          ? `Sent ${spans.length} span(s) to ${otlp}.`
          : `The collector answered ${res.status}.`,
      );
      if (!res.ok) return 1;
    }
    if (!out && !otlp) {
      const ms = (s: SpanRecord) => Number(((s.endNs ?? s.startNs) - s.startNs) / 1_000_000n);
      const byName = new Map<string, { n: number; ms: number }>();
      for (const s of spans) {
        const e = byName.get(s.name) ?? { n: 0, ms: 0 };
        e.n++;
        e.ms += ms(s);
        byName.set(s.name, e);
      }
      say(`Last ${hours} h: ${spans.length} span(s).`);
      for (const [name, e] of byName)
        say(
          `  ${name}: ${e.n}, ${(e.ms / 1000).toFixed(1)} s total, ${(e.ms / e.n / 1000).toFixed(1)} s mean`,
        );
    }
    return 0;
  } finally {
    tracer.close();
  }
}
