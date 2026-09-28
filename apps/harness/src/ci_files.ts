import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  type Document,
  LineCounter,
  type Node,
  type Pair,
  type YAMLMap,
  isAlias,
  isMap,
  isScalar,
  isSeq,
  parseDocument,
} from "yaml";

/**
 * The one reader of a repository's CI files (DEC-44: parsed with `yaml`,
 * never a `run:` regex), shared by the gate deriver (`init.ts`), onboarding
 * (`onboard.ts`) and a take-over's recon: GitHub Actions workflows
 * (`.github/workflows/*.yml`) and GitLab CI (`.gitlab-ci.yml`). Each command
 * comes with its file and 1-based line: a block scalar (`|`, `>`) gives one
 * command per line, a trailing `\` joining a line to the next, comment lines
 * skipped, and a shell block (`if … fi`, `for … done`, `case … esac`,
 * `{ … }`) kept as one command at its first line; flow-style steps, anchors
 * and aliases, GitLab's `<<` merges, `extends:` and `!reference` resolve as
 * YAML and GitLab resolve them, and a GitHub Actions step keeps its working
 * directory (the step's, else the job's or the workflow's
 * `defaults.run.working-directory`). A file that is not YAML is one entry
 * with its `error`; what the reader cannot follow — a GitLab `include:`, a
 * `!reference` to a job not in the file — is one entry with its `unread`
 * reason; a job-level `uses:` (a reusable workflow) is an entry marked
 * `reusable`. So a CI file's checks are never lost silently (fix review C2a).
 */
export interface CiCommand {
  file: string;
  /** 1-based line of the command (or of the parse error). */
  line: number;
  command?: string;
  /** A GitHub Actions step's `uses:`. */
  uses?: string;
  /** The step reads a secret (`${{ secrets.… }}`). */
  secret: boolean;
  /** The job declares services (a database, a cache). */
  service: boolean;
  /** The file could not be read as YAML: the parser's first message. */
  error?: string;
  /** Something the reader cannot follow (an include, a missing `!reference`), in words. */
  unread?: string;
  /** GitHub Actions: the directory the step runs in, as written (`./` dropped); absent at the root. */
  directory?: string;
  /** GitHub Actions: `uses` names a reusable workflow a whole job calls, not a step's action. */
  reusable?: boolean;
}

interface Source {
  file: string;
  text: string;
  lines: LineCounter;
  doc: Document.Parsed;
}

const lineOf = (s: Source, offset: number) => s.lines.linePos(offset).line;

/** A node with any alias resolved. */
function resolve(s: Source, node: unknown): Node | undefined {
  if (isAlias(node)) return resolve(s, node.resolve(s.doc));
  return (node as Node | null | undefined) ?? undefined;
}

/** A map's value for `key`: its own, else from its `<<` merges. */
function get(s: Source, map: YAMLMap | undefined, key: string): Node | undefined {
  if (!map) return undefined;
  const own = map.items.find((p: Pair) => isScalar(p.key) && p.key.value === key);
  if (own) return resolve(s, own.value);
  for (const p of map.items) {
    if (!(isScalar(p.key) && p.key.value === "<<")) continue;
    const merged = resolve(s, p.value);
    const sources = isSeq(merged) ? merged.items.map((i) => resolve(s, i)) : [merged];
    for (const m of sources) {
      const v = isMap(m) ? get(s, m, key) : undefined;
      if (v) return v;
    }
  }
  return undefined;
}

function keys(s: Source, map: YAMLMap): string[] {
  return map.items.flatMap((p) => (isScalar(p.key) ? [String(p.key.value)] : []));
}

const sourceOf = (s: Source, node: Node | undefined) =>
  node?.range ? s.text.slice(node.range[0], node.range[1]) : "";

const SECRET = /\$\{\{\s*secrets\./;

/**
 * The shell commands of one scalar, each with its line: one per line of the
 * value, a trailing `\` joining the next, blank and comment lines skipped.
 * `at` is where the scalar is used (an alias's own line).
 */
function commandsOf(
  s: Source,
  node: Node | undefined,
  at: number,
): { line: number; text: string }[] {
  if (!isScalar(node) || node.value === null || node.value === undefined) return [];
  const value = String(node.value);
  const start = node.range ? lineOf(s, node.range[0]) : at;
  const aliased = start !== at;
  const literal = node.type === "BLOCK_LITERAL";
  const folded = node.type === "BLOCK_FOLDED";
  const src = s.text.split("\n");
  // A literal block's value lines are its source lines after the header.
  let search = start; // for other styles: the next source line holding the text
  const out: { line: number; text: string }[] = [];
  let pending: { line: number; text: string } | undefined;
  // An open shell block (`if … fi`): its lines join into one command.
  let block: { line: number; text: string; depth: number } | undefined;
  const emit = (c: { line: number; text: string }) => {
    const depth = (block?.depth ?? 0) + shellDepth(c.text);
    if (!block && depth <= 0) {
      out.push(c);
      return;
    }
    block = block
      ? { line: block.line, text: `${block.text}${joiner(block.text)}${c.text}`, depth }
      : { line: c.line, text: c.text, depth };
    if (block.depth <= 0) {
      out.push({ line: block.line, text: block.text });
      block = undefined;
    }
  };
  value.split("\n").forEach((raw, i) => {
    const t = raw.trim();
    if (!t || t.startsWith("#")) return;
    let line: number;
    if (aliased) line = at;
    else if (literal) line = start + 1 + i;
    else {
      const from = folded ? Math.max(search, start + 1) : search;
      const probe = t.slice(0, 20);
      const k = src.findIndex((l, n) => n + 1 >= from && l.includes(probe));
      line = k === -1 ? start : k + 1;
      search = line + 1;
    }
    const joined = pending
      ? { line: pending.line, text: `${pending.text} ${t}` }
      : { line, text: t };
    if (joined.text.endsWith("\\")) {
      pending = { line: joined.line, text: joined.text.slice(0, -1).trim() };
      return;
    }
    pending = undefined;
    emit(joined);
  });
  if (pending) emit(pending);
  if (block) out.push({ line: block.line, text: block.text });
  return out;
}

/** Shell block openers and closers at a command's start, for joining a block's lines. */
const OPENS =
  /(?:^|[;&|]\s*|\b(?:then|do|else)\s+)(?:if|for|while|until|case|select)\b|(?:^|\s)\{$|\(\)\s*\{/g;
const CLOSES = /(?:^|[;&|]\s*)(?:fi|done|esac|\})(?=$|[\s;&|)<>])/g;

/** How far a line opens (positive) or closes (negative) shell blocks. */
function shellDepth(line: string): number {
  return (line.match(OPENS)?.length ?? 0) - (line.match(CLOSES)?.length ?? 0);
}

/** How a block's next line follows the last: a space after a keyword that expects one, else `; `. */
function joiner(text: string): string {
  return /(?:\bthen|\bdo|\belse|\bin|\{|\||&&|\|\|)$/.test(text) ? " " : "; ";
}

/** A node's own first line. */
function nodeLine(s: Source, node: Node | undefined): number {
  return node?.range ? lineOf(s, node.range[0]) : 1;
}

/** The line where `node` is used: the alias's own position, else the node's. */
function usedAt(s: Source, raw: unknown): number {
  const r = (raw as Node | undefined)?.range;
  return r ? lineOf(s, r[0]) : 1;
}

/** A value of a map entry, keeping the entry's own node (an alias) for its line. */
function entry(map: YAMLMap | undefined, key: string): unknown {
  return map?.items.find((p) => isScalar(p.key) && p.key.value === key)?.value;
}

/** `defaults.run.working-directory` of a workflow or a job. */
function defaultDirectory(s: Source, map: YAMLMap | undefined): Node | undefined {
  const defaults = get(s, map, "defaults");
  const run = isMap(defaults) ? get(s, defaults, "run") : undefined;
  return isMap(run) ? get(s, run, "working-directory") : undefined;
}

/** A working directory as written, `./` and a trailing `/` dropped; undefined for the root. */
function directoryOf(node: Node | undefined): string | undefined {
  if (!isScalar(node) || node.value === null || node.value === undefined) return undefined;
  const d = String(node.value)
    .trim()
    .replace(/^(?:\.\/)+/, "")
    .replace(/\/+$/, "");
  return d === "" || d === "." ? undefined : d;
}

function githubWorkflow(s: Source): CiCommand[] {
  const out: CiCommand[] = [];
  const root = resolve(s, s.doc.contents);
  const jobs = isMap(root) ? get(s, root, "jobs") : undefined;
  if (!isMap(jobs)) return out;
  const workflowDir = defaultDirectory(s, isMap(root) ? root : undefined);
  for (const jobPair of jobs.items) {
    const job = resolve(s, jobPair.value);
    if (!isMap(job)) continue;
    const service = get(s, job, "services") !== undefined;
    const jobSecret = SECRET.test(sourceOf(s, get(s, job, "env")));
    const reusable = get(s, job, "uses");
    if (isScalar(reusable) && reusable.value) {
      // A job that calls a reusable workflow has no steps of its own.
      out.push({
        file: s.file,
        line: usedAt(s, entry(job, "uses")),
        uses: String(reusable.value),
        reusable: true,
        secret: jobSecret || SECRET.test(sourceOf(s, get(s, job, "with"))),
        service,
      });
      continue;
    }
    const jobDir = defaultDirectory(s, job) ?? workflowDir;
    const steps = get(s, job, "steps");
    if (!isSeq(steps)) continue;
    for (const rawStep of steps.items) {
      const step = resolve(s, rawStep);
      if (!isMap(step)) continue;
      const secret = jobSecret || SECRET.test(sourceOf(s, step));
      const uses = get(s, step, "uses");
      if (isScalar(uses) && uses.value) {
        out.push({
          file: s.file,
          line: usedAt(s, entry(step, "uses")),
          uses: String(uses.value),
          secret,
          service,
        });
        continue;
      }
      const node = get(s, step, "run");
      const directory = directoryOf(get(s, step, "working-directory") ?? jobDir);
      for (const c of commandsOf(s, node, usedAt(s, entry(step, "run") ?? node))) {
        out.push({
          file: s.file,
          line: c.line,
          command: c.text,
          secret,
          service,
          ...(directory ? { directory } : {}),
        });
      }
    }
  }
  return out;
}

/** GitLab's top-level keywords that are not jobs. */
const GITLAB_KEYWORDS = new Set([
  "default",
  "include",
  "stages",
  "variables",
  "workflow",
  "image",
  "services",
  "cache",
  "before_script",
  "after_script",
  "types",
]);

function gitlabCi(s: Source): CiCommand[] {
  const out: CiCommand[] = [];
  const root = resolve(s, s.doc.contents);
  if (!isMap(root)) return out;
  const defaults = get(s, root, "default");
  const inherited = (key: string) =>
    get(s, root, key) ?? (isMap(defaults) ? get(s, defaults, key) : undefined);
  const named = (name: string) => {
    const n = get(s, root, name);
    return isMap(n) ? n : undefined;
  };
  // A job's key: its own, else from the templates it `extends`, else the default.
  const jobGet = (job: YAMLMap, key: string, seen = new Set<YAMLMap>()): Node | undefined => {
    const own = get(s, job, key);
    if (own !== undefined) return own;
    seen.add(job);
    const ext = get(s, job, "extends");
    const names = isSeq(ext)
      ? ext.items.map((i) => resolve(s, i)).flatMap((i) => (isScalar(i) ? [String(i.value)] : []))
      : isScalar(ext)
        ? [String(ext.value)]
        : [];
    for (const n of names.reverse()) {
      const parent = named(n);
      if (!parent || seen.has(parent)) continue;
      const v = jobGet(parent, key, seen);
      if (v !== undefined) return v;
    }
    return undefined;
  };
  // `include:` files are not read: each is named, so its checks are not lost silently.
  const include = entry(root, "include");
  const includeNode = resolve(s, include);
  for (const raw of isSeq(includeNode) ? includeNode.items : includeNode ? [include] : []) {
    const it = resolve(s, raw);
    let what = "";
    if (isScalar(it)) what = String(it.value);
    else if (isMap(it)) {
      for (const k of ["local", "template", "remote", "component", "file", "project"]) {
        const v = get(s, it, k);
        if (isScalar(v)) {
          what = `${String(v.value)} (${k})`;
          break;
        }
        if (isSeq(v)) {
          what = `${v.items
            .map((x) => resolve(s, x))
            .flatMap((x) => (isScalar(x) ? [String(x.value)] : []))
            .join(", ")} (${k})`;
          break;
        }
      }
    }
    out.push({
      file: s.file,
      line: usedAt(s, raw),
      unread: `included CI file ${what || sourceOf(s, it).trim()}`,
      secret: false,
      service: false,
    });
  }
  type Item = { raw: unknown; node: Node | undefined } | { unread: string; line: number };
  // A script's items: nested lists flattened, `!reference [job, key, …]` resolved.
  const itemsOf = (node: Node | undefined, raw: unknown, depth = 0): Item[] => {
    if (isSeq(node) && node.tag === "!reference") {
      const path = node.items
        .map((x) => resolve(s, x))
        .flatMap((x) => (isScalar(x) ? [String(x.value)] : []));
      const shown = `!reference [${path.join(", ")}]`;
      const line = usedAt(s, raw ?? node);
      if (depth >= 10) return [{ unread: `${shown}: nested more than 10 deep`, line }];
      const [jobName = "", ...path2] = path;
      let target: Node | undefined = named(jobName);
      if (!target) {
        return [
          {
            unread: `${shown}: ${jobName} is not in this file (it may come from an included file)`,
            line,
          },
        ];
      }
      for (const k of path2) target = isMap(target) ? get(s, target, k) : undefined;
      if (target === undefined) return [{ unread: `${shown}: ${jobName} has no such key`, line }];
      return itemsOf(target, undefined, depth + 1);
    }
    if (isSeq(node)) {
      return node.items.flatMap((i) => {
        const r = resolve(s, i);
        return isSeq(r) ? itemsOf(r, i, depth) : [{ raw: i, node: r }];
      });
    }
    return node ? [{ raw, node }] : [];
  };
  const emitted = new Set<string>();
  for (const name of keys(s, root)) {
    if (GITLAB_KEYWORDS.has(name) || name.startsWith(".")) continue;
    const job = named(name);
    if (!job) continue;
    const service = (jobGet(job, "services") ?? inherited("services")) !== undefined;
    for (const key of ["before_script", "script", "after_script"]) {
      const node = jobGet(job, key) ?? (key === "script" ? undefined : inherited(key));
      for (const raw of itemsOf(node, node)) {
        if ("unread" in raw) {
          const k = `${raw.line}\0${raw.unread}`;
          if (emitted.has(k)) continue;
          emitted.add(k);
          out.push({ file: s.file, line: raw.line, unread: raw.unread, secret: false, service });
          continue;
        }
        // A `!reference`d command keeps its template's line (raw undefined).
        const at = raw.raw === undefined ? undefined : usedAt(s, raw.raw);
        for (const c of commandsOf(s, raw.node, at ?? nodeLine(s, raw.node))) {
          // A template's line shared by several jobs is listed once.
          const k = `${c.line}\0${c.text}`;
          if (emitted.has(k)) continue;
          emitted.add(k);
          out.push({ file: s.file, line: c.line, command: c.text, secret: false, service });
        }
      }
    }
  }
  return out;
}

function read(repo: string, file: string, reader: (s: Source) => CiCommand[]): CiCommand[] {
  let text: string;
  try {
    text = readFileSync(join(repo, file), "utf8");
  } catch (err) {
    return [
      {
        file,
        line: 1,
        secret: false,
        service: false,
        error: err instanceof Error ? err.message : String(err),
      },
    ];
  }
  const lines = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lines, uniqueKeys: false });
  const bad = doc.errors[0];
  if (bad) {
    return [
      {
        file,
        line: bad.linePos?.[0]?.line ?? 1,
        secret: false,
        service: false,
        error: (bad.message.split("\n")[0] ?? "").replace(/ at line \d+, column \d+:?$/, ""),
      },
    ];
  }
  return reader({ file, text, lines, doc });
}

/** Every command of the repository's CI files, in file order. */
export function readCiSteps(repo: string): CiCommand[] {
  const out: CiCommand[] = [];
  const dir = join(repo, ".github", "workflows");
  if (existsSync(dir)) {
    for (const n of readdirSync(dir)
      .filter((f) => /\.ya?ml$/.test(f))
      .sort()) {
      out.push(...read(repo, `.github/workflows/${n}`, githubWorkflow));
    }
  }
  for (const f of [".gitlab-ci.yml", ".gitlab-ci.yaml"]) {
    if (existsSync(join(repo, f))) out.push(...read(repo, f, gitlabCi));
  }
  return out;
}
