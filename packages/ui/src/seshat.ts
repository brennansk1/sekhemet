/**
 * Seshat, one step away (dashboard §2.7, P5: DB-P5-3..7): the words of the
 * panel header and its presence line, the composer's cost line, starters and
 * hint, the palette's *Start a new project* and *Ask Seshat: <query>*, where
 * Seshat opens at a window width, and the walk a non-developer takes from
 * Status to a started project and back (DEFINITION_OF_DONE §6.4). Nothing
 * here names a model, an id or an API path: Configuration names each role's
 * model (owner decision O3).
 *
 * The browser loads the compiled module as `/app/lib/seshat.js`.
 */
import type { NavItem } from "./nav.js";
import { START_ROUTE } from "./start.js";
import { STATUS_COPY } from "./status.js";

export const SESHAT_NAME = "Seshat";

/**
 * What the person's first message starts with (planner-pm PM-P2-1), left for
 * them to finish: the person's own words in the composer, not a model-facing
 * prompt (so it is not named `…_PROMPT`, which the CX-M1-13 scan reads as one).
 */
export const START_PROJECT_OPENING = "Start a new project: ";

/** Every word of the panel and composer this module owns (DEC-31). */
export const SESHAT_COPY = {
  title: "Seshat · Project manager",
  idle: "Replies in about a minute",
  working: "Working",
  notOnServer: "Not on this server yet",
  startProject: "Start a new project",
  askPrefix: "Ask Seshat: ",
  send: "Send",
  /** The proposal's button and Review plan's (review_plan_view.js). */
  reviewPlan: "Review plan",
  createProject: "Create project",
  startHint:
    "Say in a sentence or two what you want built and who it is for. Seshat drafts a plan for you to review; nothing is created until you press Create project.",
} as const;

/** Below this width the panel is hidden and Seshat is the full view (`pm.css`, §2.7.1). */
export const SESHAT_PHONE_BELOW = 768;

/** Where Seshat opens at a window width: the side panel, or the full view on a phone. */
export function seshatOpensIn(width: number): "panel" | "full" {
  return width < SESHAT_PHONE_BELOW ? "full" : "panel";
}

export interface SeshatHeaderInput {
  /** false when the server has no Seshat endpoints. */
  available?: boolean | null;
  /** The reply's phase (`PmStatus.phase`). */
  phase?: string;
  /** The current step's words (`pmSteps`), while Seshat works. */
  current?: string;
}

/** DB-P5-6: *Seshat · Project manager* and the presence line; never a model. */
export function seshatHeader(input: SeshatHeaderInput): {
  title: string;
  line: string;
  busy: boolean;
} {
  const title = SESHAT_COPY.title;
  if (input.available === false) return { title, line: SESHAT_COPY.notOnServer, busy: false };
  if (!input.phase || input.phase === "idle") return { title, line: SESHAT_COPY.idle, busy: false };
  return { title, line: input.current || SESHAT_COPY.working, busy: true };
}

export interface CostLineInput {
  unavailable?: boolean;
  readOnly?: boolean;
  offline?: boolean;
  /** The Agent is working on an issue: the step it is on, of its budget. */
  agent?: { step?: number; budget?: number };
}

/** DB-P5-5: what sending does, in plain words; no API path, no model name or id. */
export function composerCostLine(input: CostLineInput): string {
  if (input.unavailable) return `${SESHAT_NAME} needs a newer Sekhemet server.`;
  if (input.readOnly)
    return `This server is read-only, so ${SESHAT_NAME} can't be asked here. Whoever runs Sekhemet can restart it with sekhemet serve.`;
  if (input.offline) return `Offline. Your message would not reach ${SESHAT_NAME}.`;
  if (input.agent) {
    const { step, budget } = input.agent;
    const when = step
      ? `after step ${step}${budget ? ` of ${budget}` : ""}`
      : "at its first safe step";
    return `The Agent will pause ${when} while ${SESHAT_NAME} answers (about 40s), then carry on.`;
  }
  return `${SESHAT_NAME} runs on this machine. Replies take about a minute.`;
}

export interface Starter {
  label: string;
  /** What pressing it puts in the composer, not sent. */
  text: string;
}

export interface StarterContext {
  /** The issue in focus: its key, whether its checks failed, its points. */
  focused?: { key: string; failed?: boolean; estimate?: number };
}

/** The composer's starters (§2.7 item 6): four, then one for the issue in focus. */
export function composerStarters(ctx: StarterContext = {}): Starter[] {
  const plain = (t: string): Starter => ({ label: t, text: t });
  const out = [
    plain("Standup"),
    plain("What's at risk this week?"),
    plain("Plan the next sprint"),
    { label: SESHAT_COPY.startProject, text: START_PROJECT_OPENING },
  ];
  const f = ctx.focused;
  if (f?.failed) out.push(plain(`Why did @${f.key} fail?`));
  else if (f && (f.estimate ?? 0) > 5) out.push(plain(`Split @${f.key}`));
  return out;
}

/** The line under the composer while a person starts a project (DB-P5-3); empty otherwise. */
export function composerHint(text: string): string {
  return /^\s*start a (?:new )?project\s*:/i.test(text) ? SESHAT_COPY.startHint : "";
}

export interface PaletteSeshatItem {
  kind: "start" | "ask";
  label: string;
  /** What Seshat receives: the start prompt to finish, or the query to send. */
  text: string;
}

const START_WORDS = ["start", "new", "project", "create", "begin", "idea", "build"];

/**
 * DB-P5-4: *Start a new project* for a query made of its words ("new
 * project", "start"); *Ask Seshat: <query>* when nothing else matches.
 */
export function paletteSeshat(query: string, otherMatches: number): PaletteSeshatItem[] {
  const q = query.trim();
  if (!q) return [];
  const words = q.toLowerCase().split(/\s+/);
  const start = q.length >= 3 && words.every((w) => START_WORDS.some((s) => s.startsWith(w)));
  if (start)
    return [{ kind: "start", label: SESHAT_COPY.startProject, text: START_PROJECT_OPENING }];
  if (otherMatches > 0) return [];
  return [{ kind: "ask", label: `${SESHAT_COPY.askPrefix}${q}`, text: q }];
}

export interface WalkStep {
  /** Where the control is: the bottom bar, the sidebar, a page or Seshat. */
  where: string;
  /** The control's on-screen words. */
  press: string;
  /** The route the person is on after pressing it. */
  route: string;
}

/**
 * DB-P5-7 as a layout: the controls a non-developer presses at `width` to
 * start a project and then ask how it is going, each named by the words on
 * screen, from the nav the page shows. Unreachable when Status is not shown.
 */
export function nonDeveloperWalk(
  width: number,
  visible: readonly NavItem[],
): { reachable: boolean; steps: WalkStep[] } {
  const status = visible.find((i) => i.name === "status");
  const phone = seshatOpensIn(width) === "full";
  if (!status || (phone && !visible.some((i) => i.name === "pm")))
    return { reachable: false, steps: [] };
  const nav = phone ? "Bottom bar" : "Sidebar";
  const seshat = phone ? "#/pm" : status.route;
  const toStatus: WalkStep = {
    where: nav,
    press: status.short ?? status.label,
    route: status.route,
  };
  return {
    reachable: true,
    steps: [
      toStatus,
      // design-stage §2.11 (NEW-design-stage-7): a project starts on its own
      // page, the conversation beside the live draft, not in Seshat's panel.
      { where: status.label, press: STATUS_COPY.startProject, route: START_ROUTE },
      { where: SESHAT_NAME, press: SESHAT_COPY.send, route: START_ROUTE },
      { where: SESHAT_NAME, press: SESHAT_COPY.reviewPlan, route: START_ROUTE },
      { where: SESHAT_COPY.reviewPlan, press: SESHAT_COPY.createProject, route: START_ROUTE },
      toStatus,
      { where: status.label, press: STATUS_COPY.ask, route: seshat },
    ],
  };
}

// --- Long messages and attached documents (planner-pm PM-N10) -----------------

/**
 * A message longer than this many characters is more than a comfortable
 * message for Seshat's model: a paste this long is attached as a project
 * document, and a message sent this long is kept whole with the same
 * document made of it (the server's rule, `pm/documents.ts`). Nothing is cut.
 */
export const SESHAT_DOCUMENT_CHARS = 8000;

/** The most one message may carry, words and documents together, as sent (the request cap). */
export const SESHAT_MESSAGE_MAX_BYTES = 1024 * 1024;

/** The most documents one message may carry. */
export const SESHAT_MAX_DOCUMENTS = 10;

/** A message as the composer sends it. */
export interface OutgoingMessage {
  text: string;
  documents?: { name: string; text: string }[];
  context?: Record<string, unknown>;
}

/** A document a message carries, as the thread gives it (no text). */
export interface MessageDocumentLike {
  id?: string;
  name: string;
  chars: number;
  /** Where it is in the repository; absent when it is kept with the conversation only. */
  path?: string;
  /** The document is the message's own text, sent too long for one message. */
  fromMessage?: boolean;
  /** Why it has no path: no commit on the branch yet, or the commit failed. */
  unfiled?: "no_commit" | "commit_failed";
  /** Attached in the composer, not sent yet. */
  pending?: boolean;
}

const thousands = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** A size in plain units: bytes, KB or MB (1,024-based), as a person reads it. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  const mb = bytes / (1024 * 1024);
  return `${Number.isInteger(mb) ? mb : mb.toFixed(1)} MB`;
}

/** A pasted text longer than a comfortable message, as a document to attach; else undefined. */
export function pastedDocument(
  text: string,
  alreadyAttached: number,
): { name: string; text: string } | undefined {
  if (text.length <= SESHAT_DOCUMENT_CHARS) return undefined;
  return { name: documentName(text, alreadyAttached), text };
}

/** The document's name: its first Markdown heading, else "Pasted text", numbered after the first. */
export function documentName(text: string, alreadyAttached = 0): string {
  const heading = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/m.exec(text.slice(0, 2000))?.[1];
  const clean = heading
    ?.replace(/[\\/:*?"<>|`]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  if (clean) return `${clean}.md`;
  return alreadyAttached > 0 ? `Pasted text ${alreadyAttached + 1}.md` : "Pasted text.md";
}

/** The UTF-8 bytes of the request body a message makes. */
export function messageBodyBytes(body: OutgoingMessage): number {
  return new TextEncoder().encode(JSON.stringify(body)).length;
}

/** The sentence refusing a message of `bytes` over the request cap. */
export function messageTooLargeWords(bytes: number | undefined): string {
  const size = bytes === undefined ? "over" : `${formatBytes(bytes)}, over`;
  return `This message is ${size} the ${formatBytes(SESHAT_MESSAGE_MAX_BYTES)} one message to ${SESHAT_NAME} can carry. Nothing was sent. Attach the text in smaller documents, or commit it to the repository and name the file.`;
}

/**
 * Why a message cannot be sent, said before anything is sent (the same rule
 * the server applies): too many documents, or over the request cap.
 */
export function whyNotSendable(body: OutgoingMessage): string | undefined {
  const n = body.documents?.length ?? 0;
  if (n > SESHAT_MAX_DOCUMENTS) {
    return `This message has ${n} documents; one message to ${SESHAT_NAME} can carry at most ${SESHAT_MAX_DOCUMENTS}. Nothing was sent.`;
  }
  const bytes = messageBodyBytes(body);
  return bytes > SESHAT_MESSAGE_MAX_BYTES ? messageTooLargeWords(bytes) : undefined;
}

/** An attached document's chip: its name and size, and where it is kept. */
export function documentChip(d: MessageDocumentLike): { label: string; title: string } {
  return {
    label: `${d.name} · ${thousands(d.chars)} characters`,
    title: d.pending
      ? "Sent with your message and added to the repository as a project document"
      : d.path
        ? `In the repository at ${d.path}`
        : d.unfiled === "commit_failed"
          ? "Kept with the conversation; adding it to the repository failed (the branch moved or was busy). Send it again to add it."
          : "Kept with the conversation; the repository has no commit to add it to yet",
  };
}

/** How long a long message's opening is in the thread. */
const PREVIEW_CHARS = 600;

/**
 * A person's message in the thread: whole, or — when it was sent too long for
 * one message and is its own attached document — its opening and a note
 * naming the document that holds all of it.
 */
export function userMessageView(m: { text: string; documents?: MessageDocumentLike[] }): {
  preview: string;
  note: string;
} {
  const whole = m.documents?.find((d) => d.fromMessage);
  if (!whole || m.text.length <= PREVIEW_CHARS) return { preview: m.text, note: "" };
  const head = m.text.slice(0, PREVIEW_CHARS - 1);
  const cut = head.lastIndexOf(" ");
  return {
    preview: `${cut > PREVIEW_CHARS / 2 ? head.slice(0, cut) : head}…`,
    note: `The whole message, ${thousands(whole.chars)} characters, is attached as ${whole.name}.`,
  };
}
