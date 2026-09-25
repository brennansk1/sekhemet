import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { freemem, totalmem } from "node:os";
import { basename, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { PlaybookRegistry } from "@sekhemet/context";
import type { EventLog } from "@sekhemet/kernel";
import {
  type MemoryPressureStatus,
  classifyMemoryPressure,
  readKernelPressureLevel,
  readSwapUsedBytes,
} from "@sekhemet/models";
import { PLAYBOOK_CANDIDATE_EVENT } from "./triage.js";

/**
 * Read models behind the dashboard's Phase 3 and 4 endpoints: transcripts,
 * the ledger by card, run history, the machine and the playbook. Everything
 * here only reads; the server wires it to routes.
 */

/* ---------- Ledger ---------- */

interface EventRow {
  seq: number;
  id: string;
  actor: string;
  type: string;
  card_id: string | null;
  payload: string;
  payload_hash: string;
  hash: string;
  prev_hash: string;
  created_at: string;
}

export interface LedgerEvent {
  seq: number;
  id: string;
  actor: string;
  type: string;
  cardId?: string;
  payload: unknown;
  payloadHash: string;
  hash: string;
  prevHash: string;
  createdAt: string;
}

function mapRow(r: EventRow): LedgerEvent {
  let payload: unknown = r.payload;
  try {
    payload = JSON.parse(r.payload);
  } catch {
    // Keep the raw text: the ledger shows what was written.
  }
  return {
    seq: r.seq,
    id: r.id,
    actor: r.actor,
    type: r.type,
    ...(r.card_id ? { cardId: r.card_id } : {}),
    payload,
    payloadHash: r.payload_hash,
    hash: r.hash,
    prevHash: r.prev_hash,
    createdAt: r.created_at,
  };
}

const COLUMNS = "seq, id, actor, type, card_id, payload, payload_hash, hash, prev_hash, created_at";

export interface EventQuery {
  card?: string | undefined;
  type?: string | undefined;
  actor?: string | undefined;
  /** Only events with seq greater than this. */
  since?: number | undefined;
  /** Only events with seq lower than this: the cursor for paging newest-first. */
  before?: number | undefined;
  limit?: number | undefined;
  order?: "asc" | "desc" | undefined;
}

/** A page of the ledger, filtered, newest first by default. */
export function queryEvents(
  db: DatabaseSync,
  q: EventQuery,
): { events: LedgerEvent[]; nextCursor: number | null } {
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (q.card) {
    where.push("card_id = ?");
    args.push(q.card);
  }
  if (q.type) {
    where.push("type = ?");
    args.push(q.type);
  }
  if (q.actor) {
    where.push("actor = ?");
    args.push(q.actor);
  }
  if (q.since !== undefined) {
    where.push("seq > ?");
    args.push(q.since);
  }
  if (q.before !== undefined) {
    where.push("seq < ?");
    args.push(q.before);
  }
  const order = q.order === "asc" ? "ASC" : "DESC";
  const limit = Math.max(1, Math.min(1000, q.limit ?? 200));
  const rows = db
    .prepare(
      `SELECT ${COLUMNS} FROM events ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY seq ${order} LIMIT ?`,
    )
    .all(...args, limit) as unknown as EventRow[];
  const events = rows.map(mapRow);
  const last = events.at(-1);
  return {
    events,
    nextCursor: order === "DESC" && events.length === limit && last ? last.seq : null,
  };
}

/** The latest event of each given type, per card: one query for the whole board. */
export function latestByCard(
  db: DatabaseSync,
  types: string[],
): Map<string, Map<string, LedgerEvent>> {
  const marks = types.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `SELECT ${COLUMNS.split(", ")
        .map((c) => `e.${c}`)
        .join(", ")}
       FROM events e
       JOIN (SELECT card_id, type, MAX(seq) AS seq FROM events
             WHERE type IN (${marks}) AND card_id IS NOT NULL GROUP BY card_id, type) last
         ON e.seq = last.seq`,
    )
    .all(...types) as unknown as EventRow[];
  const out = new Map<string, Map<string, LedgerEvent>>();
  for (const row of rows) {
    const ev = mapRow(row);
    if (!ev.cardId) continue;
    if (!out.has(ev.cardId)) out.set(ev.cardId, new Map());
    out.get(ev.cardId)?.set(ev.type, ev);
  }
  return out;
}

/* ---------- Transcripts ---------- */

export interface TranscriptCall {
  name: string;
  target?: string;
  summary?: string;
  ok?: boolean;
  /** Written content, for write_file steps, so the Steps tab can expand it. */
  content?: string;
}

export interface TranscriptStep {
  turn: number;
  calls: TranscriptCall[];
  gate?: { passed: boolean; failures: string[] };
  usage?: { promptTokens: number; completionTokens: number; durationMs?: number };
  stopReason?: string;
  text?: string;
}

function target(args: Record<string, unknown> | undefined): string | undefined {
  const a = args ?? {};
  const pick = a.path ?? a.file ?? a.command ?? a.cmd ?? a.message ?? a.query;
  if (pick === undefined || pick === null) return undefined;
  const text = typeof pick === "string" ? pick : JSON.stringify(pick);
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

/** Transcript files for a card, oldest first. One file per attempt. */
export function transcriptFiles(repoPath: string, cardId: string): string[] {
  const dir = join(repoPath, ".sekhemet", "transcripts");
  if (!existsSync(dir)) return [];
  const prefix = new RegExp(`^${cardId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-\\d{4}-`);
  return readdirSync(dir)
    .filter((f) => prefix.test(f) && f.endsWith(".jsonl"))
    .sort()
    .map((f) => join(dir, f));
}

/** Parse one attempt's JSONL transcript into steps. */
export function readTranscript(path: string): TranscriptStep[] {
  const steps: TranscriptStep[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const t = JSON.parse(line) as {
        turn: number;
        rawText?: string;
        toolCalls?: { name: string; arguments?: Record<string, unknown> }[];
        observations?: { tool: string; ok: boolean; summary: string }[];
        gate?: { passed: boolean; failures: string[] };
        stopReason?: string;
        usage?: { promptTokens: number; completionTokens: number; durationMs?: number };
      };
      steps.push({
        turn: t.turn,
        calls: (t.toolCalls ?? []).map((c, i) => {
          const obs = t.observations?.[i];
          const tg = target(c.arguments);
          const content =
            c.name === "write_file" && typeof c.arguments?.content === "string"
              ? c.arguments.content.slice(0, 20_000)
              : undefined;
          return {
            name: c.name,
            ...(tg !== undefined ? { target: tg } : {}),
            ...(obs ? { summary: obs.summary, ok: obs.ok } : {}),
            ...(content !== undefined ? { content } : {}),
          };
        }),
        ...(t.gate ? { gate: t.gate } : {}),
        ...(t.usage ? { usage: t.usage } : {}),
        ...(t.stopReason ? { stopReason: t.stopReason } : {}),
        ...(t.rawText?.trim() ? { text: t.rawText.trim().slice(0, 4000) } : {}),
      });
    } catch {
      // A torn line (a crash mid-write) is skipped, not fatal.
    }
  }
  return steps;
}

/** Steps of a running attempt, from `card/step` events since it entered Working. */
export function liveSteps(db: DatabaseSync, cardId: string): TranscriptStep[] {
  const start = db
    .prepare(
      `SELECT MAX(seq) AS seq FROM events WHERE card_id = ? AND type = 'card/status_changed'
       AND json_extract(payload, '$.toStatus') = 'in_progress'`,
    )
    .get(cardId) as { seq: number | null } | undefined;
  const rows = db
    .prepare(
      `SELECT ${COLUMNS} FROM events WHERE card_id = ? AND type = 'card/step' AND seq > ? ORDER BY seq`,
    )
    .all(cardId, start?.seq ?? 0) as unknown as EventRow[];
  return rows.map((r) => {
    const p = mapRow(r).payload as {
      turn: number;
      calls?: TranscriptCall[];
      gate?: { passed: boolean; failed?: string[]; errors?: number };
      usage?: TranscriptStep["usage"];
      stopReason?: string;
    };
    return {
      turn: p.turn,
      calls: p.calls ?? [],
      ...(p.gate
        ? {
            gate: {
              passed: p.gate.passed,
              failures: (p.gate.failed ?? []).map((g) => `${g} failed`),
            },
          }
        : {}),
      ...(p.usage ? { usage: p.usage } : {}),
      ...(p.stopReason ? { stopReason: p.stopReason } : {}),
    };
  });
}

/* ---------- Runs ---------- */

export interface RunListItem {
  id: string;
  startedAt: string;
  model: string;
  managerModel?: string;
  cards: number;
  firstTry: number;
  passAt1: number;
  totalDurationMs: number;
}

export interface QueueReportLike {
  startedAt: string;
  model: string;
  managerModel?: string;
  entries: { cardId: string; attempt?: number; passed: boolean }[];
  passAt1: number;
  totalDurationMs: number;
}

function runItem(id: string, r: QueueReportLike): RunListItem {
  const entries = r.entries ?? [];
  return {
    id,
    startedAt: r.startedAt,
    model: r.model,
    ...(r.managerModel ? { managerModel: r.managerModel } : {}),
    cards: new Set(entries.map((e) => e.cardId)).size,
    firstTry: entries.filter((e) => (e.attempt ?? 1) === 1 && e.passed).length,
    passAt1: r.passAt1,
    totalDurationMs: r.totalDurationMs,
  };
}

/**
 * Every recorded run, newest first (RUN-56): the projection of the ledger's
 * `queue/reported` events, which are the record; the files under
 * `.sekhemet/runs/` are a cache of them. Runs from before the event existed
 * survive only as files, and are listed from there.
 */
export async function listRuns(
  repoPath: string,
  log?: EventLog,
): Promise<{ runs: RunListItem[]; reports: Map<string, QueueReportLike> }> {
  const dir = join(repoPath, ".sekhemet", "runs");
  const reports = new Map<string, QueueReportLike>();
  const runs: RunListItem[] = [];
  const seen = new Set<string>();
  for (const e of log ? await log.getEventsByTypes(["queue/reported"]) : []) {
    const r = (e.payload as { report: QueueReportLike }).report;
    if (!r || seen.has(r.startedAt)) continue;
    const id = r.startedAt.replace(/[:.]/g, "-");
    runs.push(runItem(id, r));
    reports.set(id, r);
    seen.add(r.startedAt);
  }
  if (existsSync(dir)) {
    for (const f of readdirSync(dir).filter((n) => /^[\w.-]+\.json$/.test(n))) {
      try {
        const r = JSON.parse(readFileSync(join(dir, f), "utf8")) as QueueReportLike;
        if (seen.has(r.startedAt)) continue;
        const id = basename(f, ".json");
        runs.push(runItem(id, r));
        reports.set(id, r);
        seen.add(r.startedAt);
      } catch {
        // A half-written report is skipped.
      }
    }
  }
  const latest = join(repoPath, ".sekhemet", "queue_report.json");
  if (existsSync(latest)) {
    try {
      const r = JSON.parse(readFileSync(latest, "utf8")) as QueueReportLike;
      if (!seen.has(r.startedAt)) {
        runs.push(runItem("latest", r));
        reports.set("latest", r);
      }
    } catch {
      // Unreadable latest report: nothing to list.
    }
  }
  runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return { runs, reports };
}

/* ---------- Machine ---------- */

export interface MemorySample {
  usedBytes: number;
  totalBytes: number;
  swapUsedBytes?: number;
  kernelLevel?: number;
}

export function sampleMemory(): MemorySample {
  const total = totalmem();
  const swap = readSwapUsedBytes();
  const kernel = readKernelPressureLevel();
  return {
    usedBytes: total - freemem(),
    totalBytes: total,
    ...(swap !== undefined ? { swapUsedBytes: swap } : {}),
    ...(kernel !== undefined ? { kernelLevel: kernel } : {}),
  };
}

export type MachineMemory = MemoryPressureStatus &
  MemorySample & {
    thresholds: { warning: number; throttle: number; critical: number };
    /**
     * The level the run guard acts on. Where the kernel reports its own
     * pressure level that is the live signal (used/total counts reclaimable
     * file cache as used and reads high on a healthy machine); otherwise it is
     * the ratio-based level.
     */
    guardLevel: MemoryPressureStatus["level"];
    guardSource: "kernel" | "ratio";
  };

const KERNEL_LEVELS: Record<number, MemoryPressureStatus["level"]> = {
  1: "normal",
  2: "warning",
  4: "critical",
};

/** The memory reading the Machine view and the SSE `machine` event carry. */
export function machineMemory(sample: MemorySample): MachineMemory {
  const status = classifyMemoryPressure(sample.usedBytes, sample.totalBytes);
  const kernel = sample.kernelLevel !== undefined ? KERNEL_LEVELS[sample.kernelLevel] : undefined;
  return {
    ...status,
    ...sample,
    thresholds: { warning: 0.85, throttle: 0.9, critical: 0.94 },
    guardLevel: kernel ?? status.level,
    guardSource: kernel ? "kernel" : "ratio",
  };
}

/** Card ids with a worktree on disk. */
export function worktrees(repoPath: string): string[] {
  const dir = join(repoPath, ".sekhemet", "worktrees");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((n) => {
    try {
      return statSync(join(dir, n)).isDirectory();
    } catch {
      return false;
    }
  });
}

/* ---------- Playbook ---------- */

export async function playbookSnapshot(repoPath: string, log: EventLog) {
  const rules = new PlaybookRegistry(repoPath).getAllRules();
  // Candidates are ledger events (K-S7-6), never a side file.
  const candidates: { cardId: string; reason: string; at: string }[] = [];
  for (const e of await log.getEventsByTypes([PLAYBOOK_CANDIDATE_EVENT])) {
    const c = e.payload as { cardId?: string };
    // The note is in the private part (rule 33); an erased note reads as the marker.
    const reason = (e.private as { reason?: string } | undefined)?.reason;
    if (c.cardId && reason) candidates.push({ cardId: c.cardId, reason, at: e.createdAt });
  }
  candidates.sort((a, b) => b.at.localeCompare(a.at));
  return { rules, candidates };
}
