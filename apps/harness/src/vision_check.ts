import {
  VISION_CHECKLIST_VERSION,
  type VisionAdapter,
  type VisionQualification,
  type VisualGateContext,
  gateCopy,
  visionMayBlock,
} from "@sekhemet/gates";
import type { LocalInferenceAdapter, ModelEntry } from "@sekhemet/models";

/**
 * The visual gate's vision checklist on a real model (gates rule 30,
 * GT-N4-2): a model with the registry's vision capability answers it only
 * when the registry records its measurement on the labelled screens for this
 * checklist version and that measurement qualifies it. No qualified vision
 * model, no vision check — and the evidence says so.
 */

/** Each numbered answer, in order; fewer than `n` when the reply cannot be read. */
export function parseChecklistAnswers(text: string, n: number): ("yes" | "no")[] {
  const byNumber = new Map<number, "yes" | "no">();
  for (const line of text.split("\n")) {
    const m = /^\s*(\d+)\s*[.):-]?\s*\**\s*(yes|no)\b/i.exec(line);
    if (!m) continue;
    const i = Number(m[1]);
    if (i >= 1 && i <= n && !byNumber.has(i)) {
      byNumber.set(i, (m[2] as string).toLowerCase() as "yes" | "no");
    }
  }
  const out: ("yes" | "no")[] = [];
  for (let i = 1; i <= n; i++) {
    const a = byNumber.get(i);
    if (!a) return out;
    out.push(a);
  }
  return out;
}

/**
 * A vision model as the checklist's adapter: the screenshot and the numbered
 * questions in one request at temperature 0. The model loads on the first
 * question, so a card whose visual layer never runs never loads it.
 */
export function inferenceVisionAdapter(
  model: string,
  load: () => Promise<LocalInferenceAdapter>,
): VisionAdapter {
  let adapter: LocalInferenceAdapter | undefined;
  return {
    model,
    async answer(png, questions, options) {
      adapter ??= await load();
      const numbered = questions.map((q, i) => `${i + 1}. ${q}`).join("\n");
      const res = await adapter.generate({
        prompt: gateCopy.visionAsk(numbered),
        images: [{ mime: "image/png", data: png.toString("base64"), name: "screen.png" }],
        toolArm: adapter.supportedArms[0] ?? "arm_a_flat",
        temperature: options.temperature,
        maxTokens: 16 * questions.length + 64,
      });
      return parseChecklistAnswers(res.text, questions.length);
    },
  };
}

/** A registry entry's vision measurement as the gate reads it. */
function qualificationOf(entry: ModelEntry): VisionQualification | undefined {
  const q = entry.visionQualification;
  return q
    ? {
        model: entry.id,
        checklistVersion: q.checklistVersion,
        approvedScreens: q.approvedScreens,
        wrongFails: q.wrongFails,
        defectScreens: q.defectScreens,
        falsePasses: q.falsePasses,
      }
    : undefined;
}

/**
 * The vision checklist for a card's visual layer: the first registry model
 * with the vision capability that has qualified on this checklist version,
 * with its adapter; otherwise no checklist and the reason for the evidence.
 */
export function cardVision(
  visionModels: readonly ModelEntry[],
  load: ((model: string) => Promise<LocalInferenceAdapter>) | undefined,
): Pick<VisualGateContext, "vision" | "visionNotRun"> {
  const tried: string[] = [];
  for (const entry of visionModels) {
    const qualification = qualificationOf(entry);
    const may = visionMayBlock(qualification, entry.id);
    if (!may.blocking || !qualification) {
      tried.push(`${entry.id}: ${may.reason}`);
      continue;
    }
    if (!load) {
      return {
        visionNotRun: `${entry.id} has qualified, but no vision model can be loaded in this run`,
      };
    }
    return {
      vision: { adapter: inferenceVisionAdapter(entry.id, () => load(entry.id)), qualification },
    };
  }
  return {
    visionNotRun:
      visionModels.length === 0
        ? `no vision model in the registry has qualified on checklist ${VISION_CHECKLIST_VERSION}`
        : `no vision model has qualified on checklist ${VISION_CHECKLIST_VERSION} (${tried.join("; ")})`,
  };
}
