import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { CardRecord, CardStore } from "@sekhemet/kernel";
import type { LocalInferenceAdapter, ModelRegistry } from "@sekhemet/models";

/**
 * Multimodal card input (X3, design "Multimodal input"). Cards accept images
 * (bug screenshots, design mockups, whiteboard diagrams). Each is saved with
 * the card's evidence and analysed by the local vision model, which returns a
 * structured description and a checklist of atomic visual criteria. Text
 * models receive that description through the card's dossier, never raw
 * images. The queue runs the analysis as one batch before the Worker pass
 * (a scheduled swap on tiers without a co-loaded vision model).
 */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export interface Attachment {
  id: string;
  name: string;
  mime: string;
  bytes: number;
  /** Relative to the repository. */
  path: string;
  at: string;
}

export interface VisionDescription {
  attachmentId: string;
  description: string;
  criteria: string[];
}

/** The image type from its magic bytes (the name is not trusted). */
export function sniffImage(buf: Uint8Array): string | undefined {
  const b = Buffer.from(buf.subarray(0, 12));
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.subarray(0, 4).toString("latin1") === "GIF8") return "image/gif";
  if (
    b.subarray(0, 4).toString("latin1") === "RIFF" &&
    b.subarray(8, 12).toString("latin1") === "WEBP"
  )
    return "image/webp";
  return undefined;
}

const dirFor = (repo: string, cardId: string) =>
  join(repo, ".sekhemet", "evidence", "attachments", cardId);

export function listAttachments(repo: string, cardId: string): Attachment[] {
  try {
    return JSON.parse(readFileSync(join(dirFor(repo, cardId), "attachments.json"), "utf8"));
  } catch {
    return [];
  }
}

/** Save an image with the card's evidence and put it on the ledger. */
export async function attachImage(
  repo: string,
  store: Pick<CardStore, "getCard" | "recordEvent">,
  cardId: string,
  input: { name: string; bytes: Uint8Array },
): Promise<Attachment> {
  if (!(await store.getCard(cardId))) throw new Error(`No card ${cardId}`);
  if (input.bytes.length > MAX_IMAGE_BYTES)
    throw new Error(`${input.name} is over ${MAX_IMAGE_BYTES / 1024 / 1024} MB`);
  const mime = sniffImage(input.bytes);
  if (!mime) throw new Error(`${input.name} is not a PNG, JPEG, GIF or WebP image`);
  const id = createHash("sha256").update(input.bytes).digest("hex").slice(0, 12);
  const existing = listAttachments(repo, cardId).find((a) => a.id === id);
  if (existing) return existing;
  const safe =
    basename(input.name)
      .replace(/[^\w.-]+/g, "_")
      .slice(0, 80) || "image";
  const dir = dirFor(repo, cardId);
  mkdirSync(dir, { recursive: true });
  const file = `${id}-${safe}`;
  writeFileSync(join(dir, file), input.bytes);
  const attachment: Attachment = {
    id,
    name: safe,
    mime,
    bytes: input.bytes.length,
    path: join(".sekhemet", "evidence", "attachments", cardId, file),
    at: new Date().toISOString(),
  };
  writeFileSync(
    join(dir, "attachments.json"),
    `${JSON.stringify([...listAttachments(repo, cardId), attachment], null, 2)}\n`,
  );
  await store.recordEvent({
    type: "card/attachment",
    cardId,
    actor: "human",
    payload: { id, name: safe, mime, bytes: attachment.bytes, path: attachment.path },
  });
  return attachment;
}

/**
 * The vision model for the queue: `[models] vision` when set, else the best
 * registry entry with the vision role, else none (images then wait).
 */
export function resolveVisionModel(
  configured: string | undefined,
  registry?: Pick<ModelRegistry, "visionModels">,
): string | undefined {
  if (configured && configured !== "auto") return configured;
  return registry?.visionModels()[0]?.id;
}

const SYSTEM =
  "You describe images attached to a software task for a teammate who cannot see them. Be literal and specific: visible text verbatim, layout, states, errors, values. Then list atomic yes/no visual criteria a finished implementation must meet. Answer with JSON only.";

function parse(text: string): { description: string; criteria: string[] } {
  const clean = text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  try {
    const json = /\{[\s\S]*\}/.exec(clean)?.[0];
    const o = JSON.parse(json ?? "") as { description?: unknown; criteria?: unknown };
    if (typeof o.description === "string")
      return {
        description: o.description.trim(),
        criteria: Array.isArray(o.criteria)
          ? o.criteria.filter((c): c is string => typeof c === "string").slice(0, 12)
          : [],
      };
  } catch {
    // Not JSON: the text itself is the description.
  }
  return { description: clean.slice(0, 2000), criteria: [] };
}

/** Describe the card's images not yet described; the text goes to the dossier. */
export async function describeAttachments(
  repo: string,
  store: Pick<CardStore, "recordDossierEntry" | "recordEvent" | "cardEvents">,
  card: CardRecord,
  model: LocalInferenceAdapter,
): Promise<VisionDescription[]> {
  const done = new Set(
    (await store.cardEvents(card.id, ["card/vision"])).map(
      (e) => (e.payload as { attachmentId?: string }).attachmentId,
    ),
  );
  const out: VisionDescription[] = [];
  for (const a of listAttachments(repo, card.id)) {
    if (done.has(a.id)) continue;
    const data = readFileSync(join(repo, a.path)).toString("base64");
    const res = await model.generate({
      systemPrompt: SYSTEM,
      prompt: `Task: ${card.title}\n${card.spec ?? ""}\n\nImage: ${a.name}\nReturn: {"description":"...","criteria":["..."]}`,
      images: [{ mime: a.mime, data, name: a.name }],
      toolArm: "arm_b_json",
      temperature: 0,
      maxTokens: 900,
    });
    const d = parse(res.text);
    await store.recordDossierEntry({
      cardId: card.id,
      kind: "note",
      actor: "system",
      text: `Attached image ${a.name}, as the vision model (${model.modelId}) describes it: ${d.description}${d.criteria.length ? `\nVisual criteria:\n${d.criteria.map((c) => `- ${c}`).join("\n")}` : ""}`,
    });
    await store.recordEvent({
      type: "card/vision",
      cardId: card.id,
      actor: "system",
      payload: { attachmentId: a.id, model: model.modelId, ...d },
    });
    out.push({ attachmentId: a.id, ...d });
  }
  return out;
}

/** Cards in `cards` with an image the vision model has not described yet. */
export async function cardsNeedingVision(
  repo: string,
  store: Pick<CardStore, "cardEvents">,
  cards: CardRecord[],
): Promise<CardRecord[]> {
  const out: CardRecord[] = [];
  for (const c of cards) {
    const attachments = listAttachments(repo, c.id);
    if (attachments.length === 0) continue;
    const described = new Set(
      (await store.cardEvents(c.id, ["card/vision"])).map(
        (e) => (e.payload as { attachmentId?: string }).attachmentId,
      ),
    );
    if (attachments.some((a) => !described.has(a.id))) out.push(c);
  }
  return out;
}

/**
 * The queue's batch: load the vision model once, describe every pending
 * image, release it. Without a vision model the images wait and are named.
 */
export async function visionPrePass(
  repo: string,
  store: Pick<CardStore, "recordDossierEntry" | "recordEvent" | "cardEvents">,
  cards: CardRecord[],
  deps: {
    modelName?: string;
    load: (name: string) => Promise<LocalInferenceAdapter>;
    release?: (model: LocalInferenceAdapter) => Promise<void>;
    say?: (line: string) => void;
  },
): Promise<number> {
  const pending = await cardsNeedingVision(repo, store, cards);
  if (pending.length === 0) return 0;
  if (!deps.modelName) {
    deps.say?.(
      `${pending.length} card(s) have images but no vision model is configured ([models] vision, or a registry entry with the vision role): ${pending.map((c) => c.id).join(", ")}`,
    );
    return 0;
  }
  const model = await deps.load(deps.modelName);
  let n = 0;
  try {
    for (const card of pending) {
      const d = await describeAttachments(repo, store, card, model);
      n += d.length;
      deps.say?.(`Vision: ${card.id}: ${d.length} image(s) described by ${model.modelId}.`);
    }
  } finally {
    await deps.release?.(model);
  }
  return n;
}

/** An attachment's bytes, for the dashboard. */
export function readAttachment(
  repo: string,
  cardId: string,
  id: string,
): { attachment: Attachment; bytes: Buffer } | undefined {
  const a = listAttachments(repo, cardId).find((x) => x.id === id);
  if (!a || !existsSync(join(repo, a.path))) return undefined;
  return { attachment: a, bytes: readFileSync(join(repo, a.path)) };
}
