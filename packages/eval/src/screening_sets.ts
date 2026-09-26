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
 * - **Reviewer / Researcher:** not built until B4.8 / B4.4 (rule 30a).
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
  researcher: "B4.4, with the research golden set",
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
      researcher: notBuilt(
        "researcher",
        `the Researcher's screening set is built in ${BUILT_IN.researcher}`,
      ),
    },
    endToEnd: {
      version: e2e?.file.version ?? "0",
      capSeconds: e2e?.file.capSeconds ?? 180,
      items: e2e?.file.items ?? [],
    },
  };
}
