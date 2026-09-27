import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelRole } from "@sekhemet/models";
import { type AssetLabel, validateAssetLabels, verifyAsset } from "./eval_assets.js";

/**
 * The quick benchmark's screening sets (measurement rules 29–31, 30a;
 * NEW-measurement-5): per role a small, fixed, versioned set under
 * `fixtures/screening/`, run once per candidate model.
 *
 * - **Worker:** 6 frozen-suite cards across kinds, each run from its
 *   reference `main` and capped at 2 minutes (`worker.json`).
 * - **Planner:** 3 golden briefs scored by implicit-requirement recall
 *   (`planner.json`); read only from the registered, person-labelled
 *   golden-briefs asset, so until the owner labels them it is `not_built`.
 * - **Reviewer:** not built until B4.8 (rule 30a).
 * - **Researcher:** the research golden set's first 5 questions, answered
 *   over a cached offline corpus pinned by hash (rules 30a, 31); read only
 *   from the registered, person-labelled research golden set, so until a
 *   person labels it and the corpus is captured it is `not_built`.
 * - **End-to-end check:** 2 cards capped at 3 minutes (`end_to_end.json`).
 *
 * A set short of its size is `not_built`, never scored on part (MS-T11-7,
 * MS-N5-4b). A set's hash covers its file and every file an item names, so
 * a changed acceptance test changes the key its scores are cached under.
 */

export const SCREENING_SET_SIZE: Readonly<Record<ModelRole, number>> = {
  worker: 6,
  planner: 3,
  reviewer: 10,
  researcher: 5,
};

/** The workstream that builds each role's set (rule 30a). */
const BUILT_IN = {
  reviewer: "B4.8, with the seeded defects",
} as const;

export interface ScreeningItem {
  id: string;
  /** Worker and end-to-end cards: the frozen-suite fixture and card. */
  fixture?: string;
  card?: string;
  /** The card's kind (SPIDR), so the set spans kinds. */
  kind?: string;
  /** Acceptance test files under the fixture's `acceptance/`. */
  acceptanceTests?: string[];
  /** How many acceptance tests the card has. */
  tests?: number;
  /** The reference Worker's wall clock on the card in the recorded baseline. */
  referenceSeconds?: number;
  /** Planner briefs: the brief and its annotated requirements. */
  brief?: string;
  requirements?: { id: string; text: string }[];
  /** Researcher questions: the question put to the Researcher, and nothing else of the item. */
  question?: string;
  /** Researcher questions: the golden question, for grading only (its answer is held out). */
  golden?: GoldenQuestion;
  /** Researcher questions: the cached pages it is answered over, relative to the asset. */
  corpus?: string[];
}

export interface ScreeningSet {
  role: ModelRole;
  version: string;
  state: "ready" | "not_built";
  /** Why a set is not built, naming the workstream that builds it. */
  reason?: string;
  capSeconds: number;
  expectedSize: number;
  items: ScreeningItem[];
  /** SHA-256 of the set (rule 29): part of the cache key (rule 33). */
  hash?: string;
}

export interface ScreeningSets {
  roles: Record<ModelRole, ScreeningSet>;
  endToEnd: { version: string; capSeconds: number; items: ScreeningItem[] };
}

interface SetFile {
  role: string;
  version: string;
  capSeconds: number;
  source?: string;
  items: ScreeningItem[];
}

const DEFAULT_CAP: Readonly<Record<ModelRole, number>> = {
  worker: 120,
  planner: 60,
  reviewer: 30,
  researcher: 60,
};

function readSet(root: string, name: string): { file: SetFile; raw: Buffer } | undefined {
  const path = join(root, "fixtures", "screening", `${name}.json`);
  if (!existsSync(path)) return undefined;
  const raw = readFileSync(path);
  return { file: JSON.parse(raw.toString("utf8")) as SetFile, raw };
}

function notBuilt(role: ModelRole, reason: string, file?: SetFile): ScreeningSet {
  return {
    role,
    version: file?.version ?? "0",
    state: "not_built",
    reason,
    capSeconds: file?.capSeconds ?? DEFAULT_CAP[role],
    expectedSize: SCREENING_SET_SIZE[role],
    items: [],
  };
}

/** A card set: every acceptance test it names must exist; the hash covers them. */
function cardSet(root: string, loaded: { file: SetFile; raw: Buffer }) {
  const hash = createHash("sha256").update(loaded.raw);
  for (const item of loaded.file.items) {
    for (const t of item.acceptanceTests ?? []) {
      const path = join(root, "fixtures", item.fixture ?? "", "acceptance", t);
      if (!existsSync(path)) return { missing: `${item.id}: its acceptance test ${t} is missing` };
      hash.update(`\0${item.id}\0${t}\0`).update(readFileSync(path));
    }
  }
  return { hash: hash.digest("hex") };
}

function workerSet(root: string): ScreeningSet {
  const loaded = readSet(root, "worker");
  if (!loaded) return notBuilt("worker", "fixtures/screening/worker.json is missing");
  const { file } = loaded;
  const want = SCREENING_SET_SIZE.worker;
  if (file.items.length !== want)
    return notBuilt(
      "worker",
      `the Worker's set holds ${file.items.length} of ${want} cards; it is not scored on a partial set`,
      file,
    );
  const built = cardSet(root, loaded);
  if ("missing" in built) return notBuilt("worker", built.missing ?? "", file);
  return {
    role: "worker",
    version: file.version,
    state: "ready",
    capSeconds: file.capSeconds,
    expectedSize: want,
    items: file.items,
    hash: built.hash,
  };
}

/**
 * The Planner's set: its brief ids, read from the registered golden-briefs
 * asset with every item labelled by a person (rule 29, MS-T11-4).
 */
function plannerSet(root: string): ScreeningSet {
  const loaded = readSet(root, "planner");
  if (!loaded) return notBuilt("planner", "fixtures/screening/planner.json is missing");
  const { file } = loaded;
  const unlabelled =
    "the golden briefs are drafts until a person labels and registers them (fixtures/golden_briefs/drafts/README.md); the Planner reads not_measured until then";
  let asset: { hash: string };
  try {
    asset = verifyAsset(root, "golden-briefs");
  } catch (err) {
    return notBuilt(
      "planner",
      `${unlabelled}: ${err instanceof Error ? err.message : String(err)}`,
      file,
    );
  }
  const itemsPath = join(root, "fixtures", "golden_briefs", "items.json");
  const briefs = existsSync(itemsPath)
    ? (JSON.parse(readFileSync(itemsPath, "utf8")) as {
        id: string;
        brief?: string;
        implicitRequirements?: { id: string; text: string }[];
        labelledBy?: AssetLabel;
      }[])
    : [];
  const items: ScreeningItem[] = [];
  for (const { id } of file.items) {
    const b = briefs.find((x) => x.id === id);
    if (!b) return notBuilt("planner", `${unlabelled}: brief ${id} is not in the asset`, file);
    const problems = validateAssetLabels([b]);
    if (b.labelledBy?.kind !== "person" || problems.length)
      return notBuilt(
        "planner",
        `${unlabelled}: ${problems[0] ?? `${id} is not labelled by a person`}`,
        file,
      );
    items.push({
      id,
      ...(b.brief ? { brief: b.brief } : {}),
      requirements: b.implicitRequirements ?? [],
    });
  }
  if (items.length !== SCREENING_SET_SIZE.planner)
    return notBuilt(
      "planner",
      `the Planner's set holds ${items.length} of ${SCREENING_SET_SIZE.planner} briefs`,
      file,
    );
  return {
    role: "planner",
    version: file.version,
    state: "ready",
    capSeconds: file.capSeconds,
    expectedSize: SCREENING_SET_SIZE.planner,
    items,
    hash: createHash("sha256")
      .update(loaded.raw)
      .update(`\0golden-briefs\0${asset.hash}`)
      .digest("hex"),
  };
}

// ── the research golden set (DS-N2-9, MD-N11-1, rule 29) ──────────────────

/** The research golden set's size (design-stage DS-N2-9). */
export const RESEARCH_GOLDEN_SIZE = 25;
/** Its name in `fixtures/eval_assets.json`. */
export const RESEARCH_GOLDEN_ASSET = "research-golden-set";
const GOLDEN_PATH = ["fixtures", "research_golden"] as const;

/**
 * One checkable part of an answer. `date`: an ISO date. `licence`: an SPDX
 * id the rubric reads (`LICENCE_NAMES`). `text`: the value or any `accept`
 * form, spaces ignored. Any `conflicts` value stated in the answer makes the
 * part wrong (a hedge between two answers is not an answer).
 */
export interface GoldenPart {
  kind: "date" | "licence" | "text";
  value: string;
  accept?: string[];
  conflicts?: string[];
}

export interface GoldenQuestion {
  id: string;
  category: "api-signature" | "licence" | "release-date";
  /** What the Researcher is asked; it names the pinned version. */
  question: string;
  /** The package or product and the version the answer holds for. */
  pinned: string;
  parts: GoldenPart[];
  /** Where a person checks the answer. */
  source: string;
  labelledBy?: AssetLabel;
  /** `draft` until a person confirms it. */
  status?: string;
}

export interface ResearchGoldenSet {
  state: "ready" | "not_built";
  reason?: string;
  /** The registered asset's version and hash: every result is versioned with them. */
  version?: string;
  hash?: string;
  /** The registered directory the hash covers, relative to the root: its corpus is read from there too. */
  dir?: string;
  items: GoldenQuestion[];
}

/**
 * The licences the rubric reads, by SPDX id, each with the names an answer
 * gives it. A part's value and conflicts must be one of these.
 */
export const LICENCE_NAMES: Readonly<Record<string, RegExp>> = {
  MIT: /(?<![A-Za-z])MIT(?![A-Za-z])|\bExpat licen[cs]e\b/,
  "Apache-2.0": /\bapache(?:[\s-]+licen[cs]e)?[\s,-]*(?:version|v)?\s*2(?:\.0)?\b|\bALv2\b/i,
  "BSD-3-Clause":
    /\bBSD[\s-]*3[\s-]*clause\b|\b3[\s-]*clause[\s-]+BSD\b|\b(?:new|modified|revised)[\s-]+BSD\b/i,
  "BSD-2-Clause": /\bBSD[\s-]*2[\s-]*clause\b|\b2[\s-]*clause[\s-]+BSD\b|\bsimplified[\s-]+BSD\b/i,
  "GPL-2.0":
    /(?<![A-Za-z])GPL[\s-]*v?2(?:\.0)?\b|\bGNU General Public Licen[cs]e,? v(?:ersion)?\s*2\b/i,
  "GPL-3.0":
    /(?<![A-Za-z])GPL[\s-]*v?3(?:\.0)?\b|\bGNU General Public Licen[cs]e,? v(?:ersion)?\s*3\b/i,
  "AGPL-3.0": /\bAGPL[\s-]*v?3(?:\.0)?\b|\bAffero\b/i,
  "MPL-2.0": /\bMPL[\s-]*v?2(?:\.0)?\b|\bMozilla Public Licen[cs]e\b/i,
  ISC: /(?<![A-Za-z])ISC(?![A-Za-z])/,
  "SSPL-1.0": /\bSSPL\b|\bServer Side Public Licen[cs]e\b/i,
  "RSAL-2.0": /\bRSAL(?:v2)?\b|\bRedis Source Available Licen[cs]e\b/i,
  "public-domain": /\bpublic[\s-]+domain\b/i,
  PostgreSQL: /\bPostgreSQL[\s-]+Licen[cs]e\b/i,
};

const MONTHS = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
] as const;
const MONTH =
  "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?";
const ORD = "(\\d{1,2})(?:st|nd|rd|th)?";

const iso = (y: string, m: number, d: string) =>
  `${y}-${String(m).padStart(2, "0")}-${String(Number(d)).padStart(2, "0")}`;
const monthOf = (name: string) => MONTHS.indexOf(name.slice(0, 3).toLowerCase() as never) + 1;

/** Every full date stated in a text, as ISO dates. */
export function datesIn(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) out.add(`${m[1]}-${m[2]}-${m[3]}`);
  for (const m of text.matchAll(new RegExp(`\\b${MONTH}\\s+${ORD},?\\s+(\\d{4})\\b`, "gi")))
    out.add(iso(m[3] as string, monthOf(m[1] as string), m[2] as string));
  for (const m of text.matchAll(
    new RegExp(`\\b${ORD}\\s+(?:of\\s+)?${MONTH},?\\s+(\\d{4})\\b`, "gi"),
  ))
    out.add(iso(m[3] as string, monthOf(m[2] as string), m[1] as string));
  return out;
}

const squash = (t: string) => t.replace(/\s+/g, "");
const VERSION = /^\d+(?:\.\d+)+$/;

/** Whether a text states a `text` value: spaces ignored; a version must stand alone. */
function statesText(body: string, value: string): boolean {
  const hay = squash(body);
  const needle = squash(value);
  if (!needle) return false;
  if (!VERSION.test(needle)) return hay.includes(needle);
  const esc = needle.replace(/\./g, "\\.");
  return new RegExp(`(?<![\\d.])${esc}(?!\\.?\\d)`).test(hay);
}

function states(part: GoldenPart, body: string, value: string): boolean {
  if (part.kind === "date") return datesIn(body).has(value);
  if (part.kind === "licence") return LICENCE_NAMES[value]?.test(body) ?? false;
  return statesText(body, value);
}

/** The answer's body: the text before its References section. */
function bodyOf(text: string): string {
  const at = text.search(/\n#*\s*\**(?:References|Sources):?\**\s*\n/i);
  return at === -1 ? text : text.slice(0, at);
}

/** Why a question cannot be graded as written; empty when it can. */
export function validateGoldenQuestions(items: readonly GoldenQuestion[]): string[] {
  return items.flatMap((i): string[] => {
    const id = i.id || "(no id)";
    if (!i.id) return [`${id}: no id`];
    if (!i.question?.trim()) return [`${id}: no question`];
    if (!i.pinned?.trim()) return [`${id}: no pinned version`];
    if (!i.source?.trim()) return [`${id}: no source`];
    if (!i.parts?.length) return [`${id}: no parts`];
    return i.parts.flatMap((p) => {
      if (!p.value?.trim()) return [`${id}: a part has no value`];
      const values = [p.value, ...(p.conflicts ?? [])];
      if (p.kind === "licence")
        return values
          .filter((v) => !LICENCE_NAMES[v])
          .map((v) => `${id}: licence ${v} is not one the rubric reads`);
      if (p.kind === "date")
        return values
          .filter((v) => !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v)))
          .map((v) => `${id}: ${v} is not an ISO date`);
      if (p.kind !== "text") return [`${id}: unknown part kind ${String(p.kind)}`];
      return [];
    });
  });
}

export interface GoldenGrade {
  /** 0 wrong or unsourced, ½ partly right and sourced, 1 right and sourced (MS-N5-3). */
  grade: 0 | 0.5 | 1;
  /** Answered correctly under the set's rubric: grade 1 (MD-N11-1). */
  correct: boolean;
  partsRight: boolean[];
  /** At least one citation the reference checker verified against text read. */
  sourced: boolean;
}

/**
 * Grade one answer against its golden question (DS-N2-9, MD-N11-1, MS-N5-3),
 * deterministically and with no model: each part is right when the answer's
 * body states its value (or an accepted form) and none of its conflicts; the
 * grade is 1 when every part is right and a verified citation backs it, ½
 * when one is and some parts are right, else 0.
 */
export function gradeResearchAnswer(
  item: GoldenQuestion,
  answer: { text: string; verifiedCitations: number },
): GoldenGrade {
  const body = bodyOf(answer.text);
  const partsRight = item.parts.map(
    (p) =>
      [p.value, ...(p.accept ?? [])].some((v) => states(p, body, v)) &&
      !(p.conflicts ?? []).some((v) => states(p, body, v)),
  );
  const sourced = answer.verifiedCitations > 0;
  const right = partsRight.filter(Boolean).length;
  const grade = !sourced || right === 0 ? 0 : right === partsRight.length ? 1 : 0.5;
  return { grade, correct: grade === 1, partsRight, sourced };
}

const DRAFT_REASON =
  "the research golden set is a draft until a person checks and labels every answer and registers it (fixtures/research_golden/drafts/README.md); nothing is scored against it until then";

/**
 * The research golden set (DS-N2-9, rule 29): read only from the registered
 * asset, every question labelled by a person, 25 questions the rubric can
 * grade; otherwise `not_built`, saying why. Never a partial set.
 */
export function loadResearchGoldenSet(root: string): ResearchGoldenSet {
  let asset: { hash: string; version: string; path: string };
  try {
    asset = verifyAsset(root, RESEARCH_GOLDEN_ASSET);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    return { state: "not_built", reason: `${DRAFT_REASON}: ${why}`, items: [] };
  }
  // The items the manifest's hash pins: read from the registered directory.
  const path = join(root, asset.path, "items.json");
  const items = existsSync(path)
    ? (JSON.parse(readFileSync(path, "utf8")) as GoldenQuestion[])
    : [];
  const unlabelled = items.find((i) => i.labelledBy?.kind !== "person");
  const problems = [
    ...validateAssetLabels(items),
    ...(unlabelled ? [`${unlabelled.id} is not labelled by a person`] : []),
    ...validateGoldenQuestions(items),
  ];
  if (problems.length)
    return { state: "not_built", reason: `${DRAFT_REASON}: ${problems[0]}`, items: [] };
  if (items.length !== RESEARCH_GOLDEN_SIZE)
    return {
      state: "not_built",
      reason: `the research golden set holds ${items.length} of ${RESEARCH_GOLDEN_SIZE} questions; it is not scored on a partial set`,
      items: [],
    };
  return { state: "ready", version: asset.version, hash: asset.hash, items, dir: asset.path };
}

interface CorpusPage {
  id: string;
  url: string;
  file: string;
  sha256: string;
}

/**
 * The Researcher's screening set (rules 30a, 31): the golden set's first 5
 * questions, answered over a cached offline corpus pinned by hash, so nothing
 * leaves the machine. Its hash covers the golden set's and every page's.
 */
function researcherSet(root: string): ScreeningSet {
  const want = SCREENING_SET_SIZE.researcher;
  const golden = loadResearchGoldenSet(root);
  if (golden.state !== "ready")
    return notBuilt("researcher", golden.reason ?? "the research golden set is not built");
  const first = golden.items.slice(0, want);
  const dir = join(root, golden.dir ?? GOLDEN_PATH.join("/"));
  const indexPath = join(dir, "corpus", "index.json");
  const pages = existsSync(indexPath)
    ? (JSON.parse(readFileSync(indexPath, "utf8")) as CorpusPage[])
    : [];
  const hash = createHash("sha256").update(`${RESEARCH_GOLDEN_ASSET}\0${golden.hash}`);
  const items: ScreeningItem[] = [];
  for (const q of first) {
    const mine = pages.filter((p) => p.id === q.id);
    if (!mine.length)
      return notBuilt(
        "researcher",
        `the cached offline corpus has no page for ${q.id} (fixtures/research_golden/corpus/index.json); capturing it fetches pages, which waits on a person (fixtures/research_golden/drafts/README.md)`,
      );
    for (const p of mine) {
      const file = join(dir, "corpus", p.file);
      const body = existsSync(file) ? readFileSync(file) : undefined;
      if (!body || createHash("sha256").update(body).digest("hex") !== p.sha256)
        return notBuilt(
          "researcher",
          `the cached offline corpus's ${p.file} does not match its pinned hash; a changed corpus is a new version of the golden set`,
        );
      hash.update(`\0${p.file}\0${p.sha256}`);
    }
    items.push({
      id: q.id,
      question: q.question,
      golden: q,
      corpus: mine.map((p) => `corpus/${p.file}`),
    });
  }
  return {
    role: "researcher",
    version: golden.version ?? "1",
    state: "ready",
    capSeconds: DEFAULT_CAP.researcher,
    expectedSize: want,
    items,
    hash: hash.digest("hex"),
  };
}

/** Every role's screening set and the end-to-end check's cards, from `fixtures/screening/`. */
export function loadScreeningSets(root: string): ScreeningSets {
  const e2e = readSet(root, "end_to_end");
  return {
    roles: {
      worker: workerSet(root),
      planner: plannerSet(root),
      reviewer: notBuilt(
        "reviewer",
        `the Reviewer's screening set is built in ${BUILT_IN.reviewer}`,
      ),
      researcher: researcherSet(root),
    },
    endToEnd: {
      version: e2e?.file.version ?? "0",
      capSeconds: e2e?.file.capSeconds ?? 180,
      items: e2e?.file.items ?? [],
    },
  };
}
