import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import {
  SESHAT_DOCUMENT_CHARS,
  SESHAT_MAX_DOCUMENTS,
  SESHAT_MESSAGE_MAX_BYTES,
  documentName,
  messageTooLargeWords,
} from "@sekhemet/ui";
import { type DocsContext, commitPersonDocuments } from "../project_docs.js";
import type { MessageDocument, PmStore } from "./store.js";
import type { PmContext, PmMessage } from "./types.js";

/**
 * Long messages to Seshat and the documents they carry (planner-pm
 * NEW-planner-pm-10). A message is kept whole, whatever its length, up to
 * the request cap. A message or a pasted document longer than a comfortable
 * message (`SESHAT_DOCUMENT_CHARS`) is a project document: committed on the
 * integration branch as the person sent it (`project_docs.ts`), referenced
 * from the message, and read by Seshat through its context budget
 * (`pm/agent.ts`), never cut. What the server cannot take — a body over
 * `SESHAT_MESSAGE_MAX_BYTES`, more than `SESHAT_MAX_DOCUMENTS` documents —
 * is refused in words naming the size, before anything is recorded; the
 * composer applies the same rule before sending (`@sekhemet/ui` seshat.ts).
 */
export { SESHAT_DOCUMENT_CHARS, SESHAT_MAX_DOCUMENTS, SESHAT_MESSAGE_MAX_BYTES };

/** A refusal with its HTTP status and words; nothing was recorded. */
export class MessageRefused extends Error {
  constructor(
    public readonly status: 400 | 413,
    message: string,
    public readonly detail: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "MessageRefused";
  }
}

/**
 * Read a message's JSON body under the request cap (PM-N10-4): a declared
 * length over it is refused before a byte is read, and a body that grows
 * past it while being read is refused too — in words, with the size.
 */
export async function readMessageBody(
  req: IncomingMessage,
  readJsonBody: (req: IncomingMessage, limit?: number) => Promise<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > SESHAT_MESSAGE_MAX_BYTES) {
    // Drain what the client sends, unread, so it reads the answer rather than a reset.
    req.resume();
    throw new MessageRefused(413, messageTooLargeWords(declared), {
      bytes: declared,
      limitBytes: SESHAT_MESSAGE_MAX_BYTES,
    });
  }
  try {
    return await readJsonBody(req, SESHAT_MESSAGE_MAX_BYTES);
  } catch (err) {
    if (err instanceof Error && /too large/.test(err.message)) {
      req.resume();
      throw new MessageRefused(413, messageTooLargeWords(undefined), {
        limitBytes: SESHAT_MESSAGE_MAX_BYTES,
      });
    }
    if (err instanceof SyntaxError) throw new MessageRefused(400, "The message is not valid JSON.");
    throw err;
  }
}

/** A message as the route reads it: the person's words and the documents they attached. */
export interface IncomingPmMessage {
  /** The person's words, their surrounding whitespace trimmed, as the thread shows them. */
  text: string;
  /** The words as sent, byte for byte: a long message's own document is these (PM-N10-2). */
  sent?: string;
  documents: { name: string; text: string }[];
}

/**
 * The words and documents of a message body. Documents come from the
 * composer (`documents: [{name, text}]`); a message whose own text is longer
 * than a comfortable message becomes its own document too (`fromMessage`),
 * the text kept whole in the message. Refuses, in words, a document with no
 * text, a message with neither words nor documents, and too many documents.
 */
export function parseMessage(body: Record<string, unknown>): IncomingPmMessage {
  const sent = typeof body.text === "string" ? body.text : "";
  const text = sent.trim();
  const raw = body.documents;
  if (raw !== undefined && !Array.isArray(raw)) {
    throw new MessageRefused(400, "Documents are a list of { name, text }.");
  }
  const list = (raw ?? []) as unknown[];
  if (list.length > SESHAT_MAX_DOCUMENTS) {
    throw new MessageRefused(
      400,
      `This message has ${list.length} documents; one message to Seshat can carry at most ${SESHAT_MAX_DOCUMENTS}. Nothing was sent.`,
    );
  }
  const documents = list.map((d, i) => {
    const doc = (d ?? {}) as { name?: unknown; text?: unknown };
    if (typeof doc.text !== "string" || !doc.text.trim()) {
      throw new MessageRefused(400, `Document ${i + 1} has no text. Nothing was sent.`);
    }
    const given = typeof doc.name === "string" ? doc.name.replace(/[\r\n]/g, " ").trim() : "";
    return { name: given.slice(0, 120) || documentName(doc.text, i), text: doc.text };
  });
  if (!text && documents.length === 0) throw new MessageRefused(400, "A message needs text");
  return { text, ...(sent !== text ? { sent } : {}), documents };
}

const sha256 = (t: string) => createHash("sha256").update(t).digest("hex");

/**
 * Record a message's documents as project documents (PM-N10-2): each one
 * committed on the integration branch in one commit, byte for byte, and
 * returned with its reference for the message event, with the notice for a
 * checkout on the branch that moved (RG-S5-2). When the branch has no
 * commit yet, or the commit fails (the branch moved, its lock held), the
 * documents stay with the conversation — the ledger holds them — and their
 * references carry no path but say which (`unfiled`).
 */
export async function attachDocuments(
  ctx: DocsContext,
  documents: readonly { name: string; text: string; fromMessage?: boolean }[],
  principal: string,
): Promise<{ documents: MessageDocument[]; notice?: string }> {
  if (documents.length === 0) return { documents: [] };
  const committed = await commitPersonDocuments(ctx, { documents, principal });
  const notice = "notice" in committed ? committed.notice : undefined;
  // PM-N10-2: why nothing was committed, said in the chip, not dropped.
  const unfiled =
    "skipped" in committed
      ? committed.noCommit
        ? ("no_commit" as const)
        : ("commit_failed" as const)
      : undefined;
  const out = documents.map((d, i): MessageDocument => {
    const path = "paths" in committed ? committed.paths[i] : undefined;
    return {
      ref: {
        id: `pmd_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
        name: d.name,
        chars: d.text.length,
        bytes: Buffer.byteLength(d.text),
        sha256: sha256(d.text),
        ...(path ? { path } : {}),
        ...(d.fromMessage ? { fromMessage: true as const } : {}),
        ...(unfiled ? { unfiled } : {}),
      },
      // The message's own text is not stored twice: it is the message's.
      ...(d.fromMessage ? {} : { text: d.text }),
    };
  });
  return { documents: out, ...(notice ? { notice } : {}) };
}

/**
 * The documents a message carries: the composer's, and — when the person's
 * own words are longer than a comfortable message — those words as one more,
 * named from their first heading, as the bytes they sent (PM-N10-2).
 */
export function documentsToAttach(
  message: IncomingPmMessage,
): { name: string; text: string; fromMessage?: boolean }[] {
  const own =
    message.text.length > SESHAT_DOCUMENT_CHARS
      ? [
          {
            name: documentName(message.text, 0).replace(/^Pasted text/, "Message"),
            text: message.sent ?? message.text,
            fromMessage: true,
          },
        ]
      : [];
  return [...own, ...message.documents];
}

/**
 * A person's message recorded by any door to Seshat other than the
 * dashboard's composer — `sekhemet ask`, the MCP tool, the editor (ACP) — by
 * the same rule (PM-N10-1, -2): kept whole, and when longer than a
 * comfortable message, committed as its own project document too.
 */
export async function appendPersonMessage(
  pmStore: PmStore,
  ctx: DocsContext,
  input: { text: string; context?: PmContext; actor?: string; principal: string },
): Promise<{ message: PmMessage; notice?: string }> {
  const { documents, notice } = await attachDocuments(
    ctx,
    documentsToAttach({ text: input.text, documents: [] }),
    input.principal,
  );
  const message = await pmStore.appendUserMessage(
    input.text,
    input.context,
    input.actor ?? "human",
    documents,
  );
  return { message, ...(notice ? { notice } : {}) };
}
