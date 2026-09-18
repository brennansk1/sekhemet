import { remedyFor } from "@sekhemet/gates";
import type { CardRecord } from "@sekhemet/kernel";
import type { CardRunResult } from "@sekhemet/loop";
import type { LocalInferenceAdapter } from "@sekhemet/models";
import { type LearningStore, similarity } from "./store.js";

/**
 * The Reflector half of the playbook loop (ACE). Everything here starts from
 * an executable signal: a gate that failed and later passed, a first attempt
 * that passed or failed with a rule in its prompt, a note a human wrote. The
 * model only ever phrases and generalises what those signals already show.
 */

const kindOf = (card: CardRecord) => /\(SPIDR:\s*([A-Za-z]+)/.exec(card.title)?.[1];
function scopeOf(
  card: CardRecord,
  errorPattern?: string,
): { kind?: string; errorPattern?: string } {
  const kind = kindOf(card);
  return { ...(kind ? { kind } : {}), ...(errorPattern ? { errorPattern } : {}) };
}
const errorCode = (text: string) => /\b(TS\d{4}|lint\/[\w/]+)\b/.exec(text)?.[1];

/**
 * After every attempt: count helpful/harmful for the rules the prompt carried
 * (first attempts only, so a retry's guidance does not muddy the signal), and
 * turn each failure that survived an edit into a candidate rule.
 */
export async function learnFromAttempt(
  store: LearningStore,
  card: CardRecord,
  result: Pick<CardRunResult, "passed" | "rulesUsed" | "lessons">,
  attempt: number,
): Promise<number> {
  if (attempt === 1) {
    const learned = new Set((await store.rules()).map((r) => r.id));
    await store.recordOutcome(
      result.rulesUsed.filter((id) => learned.has(id)),
      card.id,
      result.passed,
    );
  }
  let proposed = 0;
  for (const s of result.lessons.struggles) {
    const code = errorCode(s.text);
    const message = s.text.replace(/^\S+:\d+:\d+\s*/, "").slice(0, 200);
    const remedy = code ? remedyFor(code, message) : undefined;
    const rule = await store.propose({
      role: "worker",
      text: remedy
        ? `When you see ${code ?? "this error"} ("${message}"): ${remedy}`
        : `"${message}" took ${s.edits + 1} attempts to fix on ${card.title.replace(/\s*\(SPIDR:[^)]*\)/, "")}. Before editing, read the declaration involved and check its real type or API.`,
      scope: scopeOf(card, code),
      source: "struggle",
      evidence: [
        { cardId: card.id, note: `${s.text} survived ${s.edits} edit(s) before it was fixed` },
      ],
    });
    if (rule) proposed++;
  }
  return proposed;
}

/** A human's send-back note is both a rule candidate and evidence about the user. */
export async function learnFromSendBack(
  store: LearningStore,
  card: CardRecord,
  note: string,
): Promise<void> {
  await store.propose({
    role: "worker",
    text: note,
    scope: scopeOf(card),
    source: "send_back",
    evidence: [{ cardId: card.id, note: `sent back: "${note}"` }],
  });
  await store.observe({
    statement: note,
    category: /name|style|format|comment|import|export|type|test/i.test(note)
      ? "code_style"
      : "planning",
    source: "send_back",
    evidence: `sent back ${card.id}`,
  });
}

/** Which kinds of Merit proposal the user applies versus discards. */
export async function learnFromProposalChoices(
  store: LearningStore,
  choices: { kind: string; state: "applied" | "discarded" }[],
): Promise<void> {
  const byKind = new Map<string, { applied: number; discarded: number }>();
  for (const c of choices) {
    const t = byKind.get(c.kind) ?? { applied: 0, discarded: 0 };
    t[c.state]++;
    byKind.set(c.kind, t);
  }
  const label: Record<string, string> = {
    split_card: "splitting cards",
    update_card: "field changes to cards",
    create_card: "new cards",
    move_card: "moving cards",
    park: "parking cards",
    create_cycle: "planned cycles",
  };
  for (const [kind, t] of byKind) {
    const total = t.applied + t.discarded;
    if (total < 3) continue;
    const rate = t.applied / total;
    if (rate > 0.3 && rate < 0.7) continue;
    await store.observe({
      key: `proposals_${kind}`,
      statement:
        rate >= 0.7
          ? `Usually accepts Merit's proposals for ${label[kind] ?? kind} (${t.applied} of ${total}).`
          : `Usually declines Merit's proposals for ${label[kind] ?? kind} (${t.discarded} of ${total}): propose these sparingly and explain why.`,
      category: "planning",
      source: "proposal_choices",
      evidence: `${t.applied} applied, ${t.discarded} discarded`,
    });
  }
}

export interface ReflectionInput {
  card: CardRecord;
  plan: string;
  firstStop: string;
  retryPassed: boolean;
}

/**
 * Merit's end-of-run reflection: the issues it called out in its repair
 * plans, generalised into rules the Worker can reuse, each marked as specific
 * to this project or general enough to carry across projects. Candidates
 * only: a human approves every rule and chooses its reach.
 */
export async function reflectWithManager(
  model: LocalInferenceAdapter,
  store: LearningStore,
  items: ReflectionInput[],
): Promise<number> {
  if (items.length === 0) return 0;
  const cases = items
    .map(
      (it, i) =>
        `Case ${i + 1}: card "${it.card.title}" failed its first attempt (${it.firstStop}); the retry with your plan ${it.retryPassed ? "PASSED" : "also failed"}.\nYour plan:\n${it.plan.slice(0, 1500)}`,
    )
    .join("\n\n");
  const res = await model.generate({
    systemPrompt:
      "You are Merit, the project manager. You turn what went wrong on cards into short, reusable rules for a small coding model. Answer with JSON only.",
    prompt: `${cases}\n\nFor each case whose lesson would help on future cards, write one rule: imperative, one or two sentences, concrete (name the API, type rule or pattern), no card-specific names. Say whether it is "project" (only this codebase) or "global" (any TypeScript project).\nReturn: {"rules":[{"case":1,"text":"...","reach":"project"|"global"}]}`,
    toolArm: "arm_b_json",
    temperature: 0.2,
    maxTokens: 900,
  });
  let parsed: { rules?: { case?: number; text?: string; reach?: string }[] } = {};
  try {
    const json = /\{[\s\S]*\}/.exec(res.text.replace(/<think>[\s\S]*?<\/think>/g, ""))?.[0];
    parsed = json ? JSON.parse(json) : {};
  } catch {
    return 0;
  }
  let proposed = 0;
  for (const r of parsed.rules ?? []) {
    const it = items[(r.case ?? 0) - 1];
    if (!it || typeof r.text !== "string" || r.text.trim().length < 12) continue;
    const kind = kindOf(it.card);
    const rule = await store.propose({
      role: "worker",
      text: r.text.trim().slice(0, 400),
      scope: kind ? { kind } : {},
      source: "reflection",
      evidence: [
        {
          cardId: it.card.id,
          note: `Merit's reflection after ${it.firstStop}; suggested reach: ${r.reach === "global" ? "all projects" : "this project"}`,
        },
      ],
    });
    if (rule) proposed++;
  }
  return proposed;
}

/**
 * Mem0's update step, decided by Merit while its model is resident: for each
 * candidate rule linked to similar existing rules, choose ADD (keep both),
 * UPDATE (merge into one better rule), DELETE (the new rule contradicts an
 * old one) or NOOP (same meaning). Active rules are never removed here: a
 * contradiction is written onto the candidate so the human who approves it
 * sees which rule it replaces. For the profile, a newer contradicting
 * preference dismisses the older one (still visible, and restorable).
 */
export async function consolidateWithManager(
  model: LocalInferenceAdapter,
  store: LearningStore,
): Promise<{ merged: number; contradictions: number; duplicates: number }> {
  const rules = await store.rules();
  const byId = new Map(rules.map((r) => [r.id, r]));
  const pairs = rules
    .filter((r) => r.status === "candidate" && r.related?.length)
    .flatMap((r) =>
      (r.related ?? []).flatMap((id) => {
        const old = byId.get(id);
        return old && old.status !== "retired" ? [{ fresh: r, old }] : [];
      }),
    )
    .slice(0, 8);
  const counts = { merged: 0, contradictions: 0, duplicates: 0 };
  if (pairs.length > 0) {
    const res = await model.generate({
      systemPrompt:
        "You maintain a playbook of rules for a coding model. Decide how each new rule relates to an existing one. Answer with JSON only.",
      prompt: `${pairs
        .map((p, i) => `Pair ${i + 1}\nEXISTING: ${p.old.text}\nNEW: ${p.fresh.text}`)
        .join(
          "\n\n",
        )}\n\nFor each pair choose: "ADD" (different advice, keep both), "UPDATE" (compatible: write one merged rule), "DELETE" (the new rule contradicts the existing one), "NOOP" (same meaning).\nReturn: {"decisions":[{"pair":1,"op":"ADD"|"UPDATE"|"DELETE"|"NOOP","merged":"..."}]}`,
      toolArm: "arm_b_json",
      temperature: 0.1,
      maxTokens: 900,
    });
    let decisions: { pair?: number; op?: string; merged?: string }[] = [];
    try {
      const json = /\{[\s\S]*\}/.exec(res.text.replace(/<think>[\s\S]*?<\/think>/g, ""))?.[0];
      decisions = (json ? JSON.parse(json) : {}).decisions ?? [];
    } catch {
      decisions = [];
    }
    for (const d of decisions) {
      const p = pairs[(d.pair ?? 0) - 1];
      if (!p) continue;
      if (d.op === "NOOP") {
        await store.update(p.fresh.id, { status: "retired" });
        counts.duplicates++;
      } else if (d.op === "UPDATE" && typeof d.merged === "string" && d.merged.trim().length > 12) {
        await store.update(p.fresh.id, {
          text: d.merged.trim().slice(0, 500),
          evidence: [
            ...p.fresh.evidence,
            { note: `merges "${p.old.text.slice(0, 80)}" (${p.old.id})` },
          ],
        });
        counts.merged++;
      } else if (d.op === "DELETE") {
        await store.update(p.fresh.id, {
          evidence: [
            ...p.fresh.evidence,
            {
              note: `contradicts ${p.old.id} ("${p.old.text.slice(0, 80)}"): approving this should retire it`,
            },
          ],
        });
        counts.contradictions++;
      }
    }
  }

  // Profile: newer statements that contradict older ones.
  const profile = (await store.profile()).filter((p) => p.status === "active");
  const prefPairs: { newer: (typeof profile)[number]; older: (typeof profile)[number] }[] = [];
  for (let i = 0; i < profile.length; i++) {
    for (let j = i + 1; j < profile.length; j++) {
      const a = profile[i];
      const b = profile[j];
      if (!a || !b || a.category !== b.category) continue;
      const newerFirst = (a.evidence.at(-1)?.at ?? "") >= (b.evidence.at(-1)?.at ?? "");
      const [newer, older] = newerFirst ? [a, b] : [b, a];
      if (similarity(newer.statement, older.statement) >= 0.35) prefPairs.push({ newer, older });
    }
  }
  if (prefPairs.length > 0) {
    const res = await model.generate({
      systemPrompt: "You keep a profile of what a software lead prefers. Answer with JSON only.",
      prompt: `${prefPairs
        .slice(0, 6)
        .map((p, i) => `Pair ${i + 1}\nOLDER: ${p.older.statement}\nNEWER: ${p.newer.statement}`)
        .join(
          "\n\n",
        )}\n\nDoes the newer statement contradict the older one (the lead changed their mind)? Return: {"contradicts":[1,3]}`,
      toolArm: "arm_b_json",
      temperature: 0.1,
      maxTokens: 200,
    });
    try {
      const json = /\{[\s\S]*\}/.exec(res.text.replace(/<think>[\s\S]*?<\/think>/g, ""))?.[0];
      const list = ((json ? JSON.parse(json) : {}).contradicts ?? []) as number[];
      for (const n of list) {
        const p = prefPairs[n - 1];
        if (p) await store.updateProfile(p.older.id, { status: "dismissed" });
      }
    } catch {
      // A malformed answer changes nothing.
    }
  }
  return counts;
}
