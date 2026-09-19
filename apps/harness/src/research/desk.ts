import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { depsGrep, depsOutline, installed, manifestVersions } from "./deps.js";

/**
 * The Research Desk: research that serves an agent which is building
 * something, rather than research that is the work itself.
 *
 * Two ideas carry it. First, **most questions need no model**: the installed
 * dependency's own source answers an API question better and faster than any
 * page on the web. Second, **the fix for latency is to ask earlier, not to
 * answer faster**: a question posted to the inbox does not block the step
 * that asked it, and the planner's open questions are answered while earlier
 * cards are still running.
 *
 * The Desk grades a question before spending anything on it:
 *
 * - `lookup`   — seconds, no model. Answerable from the repository, the
 *                installed packages, or the registry.
 * - `question` — a short tool loop on the slot the executor is already using.
 * - `deep`     — promoted to a research card. The Desk does not block a build
 *                for an hour; it says so and moves on.
 */

export type Grade = "lookup" | "question" | "deep";

export interface Graded {
  grade: Grade;
  why: string;
  /** For a lookup: the answer, already found. */
  answer?: string;
}

const DEEP =
  /\b(compare|comparison|evaluate|assess|survey|trade-?offs?|should we|worth (it|adopting)|literature|state of the art|alternatives to|migrate (from|to)|pros and cons)\b/i;
const LOOKUP_API =
  /\b(signature|exports?|version|licen[cs]e|installed|type of|declared|what changed|changelog|release notes|default value)\b/i;

/** The package this question is about, if the project has it installed. */
function subject(repoPath: string, question: string): string | undefined {
  const quoted = [...question.matchAll(/`([^`]{1,60})`/g)].map((m) => m[1] ?? "");
  const bare = question.split(/[^\w@/.-]+/).filter((w) => w.length > 1);
  for (const candidate of [...quoted, ...bare]) {
    const name = candidate.split(/[.(]/)[0] ?? "";
    if (name && installed(repoPath, name)) return name;
  }
  return undefined;
}

/**
 * Answer from the repository alone, or return nothing. Deliberately narrow:
 * a lookup that guesses is worse than a lookup that declines, because the
 * caller's fallback is a real search that will get it right.
 */
export function lookup(repoPath: string, question: string): string | undefined {
  const pkg = subject(repoPath, question);
  if (!pkg) return undefined;
  const meta = installed(repoPath, pkg);
  if (!meta) return undefined;

  if (/\b(version|installed)\b/i.test(question)) {
    return `${pkg} is at ${meta.version} in this project (${meta.dir}).`;
  }
  if (/\blicen[cs]e\b/i.test(question)) {
    try {
      const { license } = JSON.parse(
        readFileSync(join(meta.dir, "package.json"), "utf8"),
      ) as { license?: string };
      return license
        ? `${pkg}@${meta.version} declares licence ${license}.`
        : `${pkg}@${meta.version} declares no licence field.`;
    } catch {
      return undefined;
    }
  }
  if (/\b(exports?|signature|declared|type of)\b/i.test(question)) {
    // The identifier being asked about, if the question names one.
    const ident = [...question.matchAll(/`([A-Za-z_$][\w$]*)`/g)]
      .map((m) => m[1] ?? "")
      .find((w) => w && w !== pkg);
    const found = ident ? depsGrep(repoPath, pkg, ident, 12) : depsOutline(repoPath, pkg);
    return found.startsWith("No match") ? undefined : found;
  }
  return undefined;
}

/** What this question costs, decided before anything is spent on it. */
export function grade(repoPath: string, question: string): Graded {
  const q = question.trim();
  if (DEEP.test(q) || q.length > 400) {
    return { grade: "deep", why: "open-ended: it wants sources weighed against each other" };
  }
  if (LOOKUP_API.test(q)) {
    const answer = lookup(repoPath, q);
    if (answer) return { grade: "lookup", why: "answered from the project itself", answer };
  }
  const known = manifestVersions(repoPath).length > 0;
  return {
    grade: "question",
    why: known
      ? "needs reading beyond the repository, but is a single question"
      : "no dependency manifest to answer it from",
  };
}

/* ------------------------------------------------------------------ */
/* The research inbox                                                  */
/* ------------------------------------------------------------------ */

export interface InboxItem {
  id: string;
  cardId: string;
  asker: string;
  question: string;
  askedAt: string;
  grade: Grade;
  answer?: string;
  answeredAt?: string;
  /** True once the answer has been handed to the step that asked. */
  delivered?: boolean;
}

interface EventSink {
  append(e: {
    actor: string;
    type: string;
    cardId?: string;
    payload: Record<string, unknown>;
  }): Promise<unknown> | unknown;
}

/**
 * Questions in flight. An agent posts one and keeps working; the answer is
 * picked up at a later step boundary. The file is the queue and the event
 * log is the record, so a restart loses neither.
 */
export class ResearchInbox {
  private readonly path: string;

  constructor(
    private readonly repoPath: string,
    private readonly log?: EventSink,
  ) {
    this.path = join(repoPath, ".sekhemet", "research", "inbox.json");
  }

  private read(): InboxItem[] {
    try {
      return JSON.parse(readFileSync(this.path, "utf8")) as InboxItem[];
    } catch {
      return [];
    }
  }

  private write(items: InboxItem[]): void {
    mkdirSync(join(this.repoPath, ".sekhemet", "research"), { recursive: true });
    writeFileSync(this.path, `${JSON.stringify(items, null, 2)}\n`);
  }

  /** Post a question. Returns at once: nothing blocks on the answer. */
  async post(cardId: string, asker: string, question: string): Promise<InboxItem> {
    const graded = grade(this.repoPath, question);
    const item: InboxItem = {
      id: `q_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      cardId,
      asker,
      question: question.slice(0, 2000),
      askedAt: new Date().toISOString(),
      grade: graded.grade,
      // A lookup is already done by the time the question is posted.
      ...(graded.answer ? { answer: graded.answer, answeredAt: new Date().toISOString() } : {}),
    };
    this.write([...this.read(), item]);
    await this.log?.append({
      actor: asker,
      type: "research/asked",
      cardId,
      payload: { id: item.id, question: item.question, grade: item.grade, why: graded.why },
    });
    return item;
  }

  /** Questions still waiting for an answer, oldest first. */
  pending(grades: Grade[] = ["question", "deep"]): InboxItem[] {
    return this.read().filter((i) => !i.answer && grades.includes(i.grade));
  }

  async answer(id: string, answer: string): Promise<void> {
    const items = this.read();
    const item = items.find((i) => i.id === id);
    if (!item) return;
    item.answer = answer;
    item.answeredAt = new Date().toISOString();
    this.write(items);
    await this.log?.append({
      actor: "researcher",
      type: "research/answered",
      cardId: item.cardId,
      payload: { id, chars: answer.length },
    });
  }

  /**
   * Answers for this card that the asking step has not seen yet, marked as
   * delivered so they are injected once and not on every turn.
   */
  take(cardId: string): InboxItem[] {
    const items = this.read();
    const ready = items.filter((i) => i.cardId === cardId && i.answer && !i.delivered);
    if (!ready.length) return [];
    for (const i of ready) i.delivered = true;
    this.write(items);
    return ready;
  }

  /** The injection text for a step boundary, or nothing when there is none. */
  static inject(items: InboxItem[]): string {
    if (!items.length) return "";
    return [
      "Research you asked for has come back:",
      ...items.map((i) => `\n## ${i.question}\n\n${i.answer ?? ""}`),
    ].join("\n");
  }
}
