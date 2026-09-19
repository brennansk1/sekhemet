import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The provenance and research registers (X17, X18; design "Provenance and
 * license register"): markdown tables under docs/, read and checked by code
 * so they are maintained as part of the build, not as paperwork.
 *
 *   docs/reference/PROVENANCE.md       techniques -> public sources; licences
 *   docs/research/RESEARCH_REGISTER.md  candidate techniques and their lifecycle
 */
export const PROVENANCE_PATH = join("docs", "reference", "PROVENANCE.md");
export const RESEARCH_REGISTER_PATH = join("docs", "research", "RESEARCH_REGISTER.md");

/** The rows of the first table after `## <heading>` (or of the first table at all). */
export function markdownTable(md: string, heading?: string): Record<string, string>[] {
  const lines = md.split("\n");
  let i = 0;
  if (heading) {
    i = lines.findIndex((l) => new RegExp(`^#{2,3}\\s+${heading}\\s*$`, "i").test(l));
    if (i === -1) return [];
  }
  while (i < lines.length && !lines[i]?.trim().startsWith("|")) i++;
  const cells = (l: string) =>
    l
      .trim()
      .replace(/^\||\|$/g, "")
      .split("|")
      .map((c) => c.trim());
  const header = cells(lines[i] ?? "");
  const rows: Record<string, string>[] = [];
  for (let j = i + 2; j < lines.length && lines[j]?.trim().startsWith("|"); j++) {
    const c = cells(lines[j] as string);
    rows.push(Object.fromEntries(header.map((h, k) => [h.toLowerCase(), c[k] ?? ""])));
  }
  return rows;
}

// ----------------------------------------------------------------- provenance

export interface ProvenanceRegister {
  techniques: { technique: string; source: string; verified: string }[];
  licenses: { component: string; license: string; use: string }[];
}

export function readProvenance(root: string): ProvenanceRegister {
  const path = join(root, PROVENANCE_PATH);
  if (!existsSync(path)) return { techniques: [], licenses: [] };
  const md = readFileSync(path, "utf8");
  return {
    techniques: markdownTable(md, "Techniques").map((r) => ({
      technique: r.technique ?? "",
      source: r["public source"] ?? "",
      verified: r["date verified"] ?? "",
    })),
    licenses: markdownTable(md, "Licences").map((r) => ({
      component: r.component ?? "",
      license: r.licence ?? "",
      use: r.use ?? "",
    })),
  };
}

// ------------------------------------------------------------------- research

export const RESEARCH_STATES = [
  "spotted",
  "triaged",
  "shortlisted",
  "benched",
  "adopted",
  "rejected",
] as const;
export type ResearchState = (typeof RESEARCH_STATES)[number];

export interface ResearchEntry {
  id: string;
  technique: string;
  source: string;
  state: string;
  threshold: string;
  thresholdSet: string;
  evidence: string;
  updated: string;
}

const COLUMNS = [
  "ID",
  "Technique",
  "Source",
  "State",
  "Threshold",
  "Threshold set",
  "Evidence",
  "Updated",
];

export function readResearchRegister(root: string): ResearchEntry[] {
  const path = join(root, RESEARCH_REGISTER_PATH);
  if (!existsSync(path)) return [];
  return markdownTable(readFileSync(path, "utf8")).map((r) => ({
    id: r.id ?? "",
    technique: r.technique ?? "",
    source: r.source ?? "",
    state: r.state ?? "",
    threshold: r.threshold ?? "",
    thresholdSet: r["threshold set"] ?? "",
    evidence: r.evidence ?? "",
    updated: r.updated ?? "",
  }));
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const rank = (s: string) => RESEARCH_STATES.indexOf(s as ResearchState);

export function validateResearchRegister(entries: ResearchEntry[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    const at = `${e.id || "(no id)"} ${e.technique}`;
    if (!e.id || seen.has(e.id)) problems.push(`${at}: missing or duplicate id`);
    seen.add(e.id);
    if (rank(e.state) === -1) {
      problems.push(`${at}: unknown state "${e.state}" (${RESEARCH_STATES.join(", ")})`);
      continue;
    }
    if (!e.source) problems.push(`${at}: no source`);
    if (!DATE.test(e.updated)) problems.push(`${at}: "Updated" must be a date`);
    if (rank(e.state) >= rank("shortlisted") && (!e.threshold || !DATE.test(e.thresholdSet)))
      problems.push(`${at}: ${e.state} needs an adoption threshold and the date it was set`);
    if (rank(e.state) >= rank("benched") && !e.evidence)
      problems.push(`${at}: ${e.state} needs evidence`);
    if (DATE.test(e.thresholdSet) && DATE.test(e.updated) && e.thresholdSet > e.updated)
      problems.push(`${at}: the threshold was set after the entry's last move`);
  }
  return problems;
}

function allowed(from: string, to: ResearchState): boolean {
  if (to === "rejected") return from !== "rejected" && from !== "adopted";
  if (to === "adopted") return from === "benched";
  return rank(to) === rank(from) + 1;
}

/** Move an entry (`sekhemet register advance`), refusing an illegal move. */
export function advanceResearchEntry(
  root: string,
  id: string,
  to: string,
  opts: { threshold?: string; evidence?: string; now?: string },
): ResearchEntry {
  const path = join(root, RESEARCH_REGISTER_PATH);
  const md = readFileSync(path, "utf8");
  const entries = readResearchRegister(root);
  const e = entries.find((x) => x.id === id);
  if (!e) throw new Error(`No research entry ${id}`);
  if (rank(to) === -1) throw new Error(`Unknown state ${to}`);
  if (!allowed(e.state, to as ResearchState))
    throw new Error(`Illegal move ${id}: ${e.state} -> ${to}`);
  const now = opts.now ?? new Date().toISOString().slice(0, 10);
  const next: ResearchEntry = { ...e, state: to, updated: now };
  if (opts.threshold && rank(e.state) < rank("benched")) {
    next.threshold = opts.threshold;
    next.thresholdSet = now;
  }
  if (opts.evidence) next.evidence = e.evidence ? `${e.evidence}; ${opts.evidence}` : opts.evidence;
  const problems = validateResearchRegister([next]);
  if (problems.length) throw new Error(problems.join("; "));
  const cell = (s: string) => s.replace(/\|/g, "/").replace(/\n/g, " ");
  const row = (x: ResearchEntry) =>
    `| ${[x.id, x.technique, x.source, x.state, x.threshold, x.thresholdSet, x.evidence, x.updated].map(cell).join(" | ")} |`;
  const lines = md.split("\n");
  const idx = lines.findIndex((l) => new RegExp(`^\\|\\s*${id}\\s*\\|`).test(l));
  lines[idx] = row(next);
  writeFileSync(path, lines.join("\n"));
  return next;
}

/** Both registers, checked (`sekhemet register check`, the doctor, the build). */
export function checkRegisters(root: string): string[] {
  const problems: string[] = [];
  if (!existsSync(join(root, PROVENANCE_PATH))) problems.push(`${PROVENANCE_PATH} is missing`);
  else {
    const p = readProvenance(root);
    if (p.techniques.length === 0) problems.push("PROVENANCE.md: no Techniques table");
    if (p.licenses.length === 0) problems.push("PROVENANCE.md: no Licences table");
    for (const t of p.techniques) {
      if (!t.source) problems.push(`PROVENANCE.md: "${t.technique}" has no public source`);
      if (!DATE.test(t.verified))
        problems.push(`PROVENANCE.md: "${t.technique}" has no verification date`);
    }
    for (const l of p.licenses)
      if (!l.license || !l.use)
        problems.push(`PROVENANCE.md: "${l.component}" needs licence and use`);
  }
  const path = join(root, RESEARCH_REGISTER_PATH);
  if (!existsSync(path)) problems.push(`${RESEARCH_REGISTER_PATH} is missing`);
  else {
    const header = readFileSync(path, "utf8")
      .split("\n")
      .find((l) => l.startsWith("| ID"));
    if (
      header
        ?.split("|")
        .map((c) => c.trim())
        .filter(Boolean)
        .join(",") !== COLUMNS.join(",")
    )
      problems.push(`RESEARCH_REGISTER.md: the header must be ${COLUMNS.join(" | ")}`);
    problems.push(
      ...validateResearchRegister(readResearchRegister(root)).map(
        (p) => `RESEARCH_REGISTER.md: ${p}`,
      ),
    );
  }
  return problems;
}
