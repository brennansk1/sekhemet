// Pure diff and path helpers for the diff viewer. No DOM: unit-tested in
// packages/ui/tests/diff_parse.spec.ts and imported as-is by the browser.

/**
 * Parse a unified git diff into files, hunks and numbered lines.
 * @returns {{ path: string, oldPath: string, status: string, binary: boolean,
 *   added: number, removed: number, hunks: { header: string, oldStart: number,
 *   newStart: number, lines: { type: "add"|"del"|"ctx"|"meta", text: string,
 *   oldNo?: number, newNo?: number }[] }[] }[]}
 */
export function parseUnifiedDiff(text) {
  const files = [];
  let file = null;
  let hunk = null;
  let oldNo = 0;
  let newNo = 0;
  const lines = String(text ?? "").split("\n");
  // A trailing newline yields one empty last element that is not a diff line.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  const start = (oldPath, newPath) => {
    file = {
      path: newPath,
      oldPath,
      status: "modified",
      binary: false,
      added: 0,
      removed: 0,
      hunks: [],
    };
    files.push(file);
    hunk = null;
  };

  for (const line of lines) {
    const head = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (head) {
      start(head[1], head[2]);
      continue;
    }
    if (!file && (line.startsWith("--- ") || line.startsWith("@@"))) start("", "");
    if (!file) continue;
    if (!hunk) {
      if (line.startsWith("new file mode")) file.status = "added";
      else if (line.startsWith("deleted file mode")) file.status = "deleted";
      else if (line.startsWith("rename from ")) file.status = "renamed";
      else if (line.startsWith("Binary files")) file.binary = true;
      else if (line.startsWith("--- ")) {
        const p = line.slice(4).replace(/^a\//, "");
        if (p !== "/dev/null") file.oldPath = p;
        else file.status = "added";
        continue;
      } else if (line.startsWith("+++ ")) {
        const p = line.slice(4).replace(/^b\//, "");
        if (p !== "/dev/null") file.path = p;
        else file.status = "deleted";
        continue;
      }
    }
    const h = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(line);
    if (h) {
      oldNo = Number(h[1]);
      newNo = Number(h[3]);
      hunk = { header: line, oldStart: oldNo, newStart: newNo, lines: [] };
      file.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;
    if (line.startsWith("+")) {
      hunk.lines.push({ type: "add", text: line.slice(1), newNo });
      newNo++;
      file.added++;
    } else if (line.startsWith("-")) {
      hunk.lines.push({ type: "del", text: line.slice(1), oldNo });
      oldNo++;
      file.removed++;
    } else if (line.startsWith("\\")) {
      hunk.lines.push({ type: "meta", text: line });
    } else {
      hunk.lines.push({ type: "ctx", text: line.slice(1), oldNo, newNo });
      oldNo++;
      newNo++;
    }
  }
  for (const f of files) if (!f.path) f.path = f.oldPath;
  return files;
}

/** A gates.toml-style glob (`tests/**`, `*.spec.ts`) as a RegExp over a repo path. */
export function globToRegExp(glob) {
  let re = "";
  const g = String(glob);
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*") {
      if (g[i + 1] === "*") {
        re += g[i + 2] === "/" ? "(?:.*/)?" : ".*";
        i += g[i + 2] === "/" ? 2 : 1;
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

export function matchesAny(path, globs = []) {
  return globs.some((g) => globToRegExp(g).test(path));
}

/** An acceptance test named `hasher.spec.ts` is staged as `tests/hasher.spec.ts`. */
export function isAcceptanceTest(path, acceptanceTests = []) {
  return acceptanceTests.some((t) => path === t || path.endsWith(`/${t}`));
}

const GENERATED =
  /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|.*\.min\.(js|css)|.*\.snap)$/;

/**
 * Which group a changed file belongs to (§2.5.5): what the card may edit, the
 * protected acceptance tests, generated files, or outside its scope.
 */
export function fileRole(
  path,
  { scopeFiles = [], acceptanceTests = [], protectedGlobs = [] } = {},
) {
  if (
    scopeFiles.includes(path) ||
    matchesAny(
      path,
      scopeFiles.filter((s) => s.includes("*")),
    )
  ) {
    return "implementation";
  }
  if (isAcceptanceTest(path, acceptanceTests) || matchesAny(path, protectedGlobs))
    return "acceptance";
  if (GENERATED.test(path)) return "other";
  return "outside";
}

/**
 * Whether a changed file's diff renders collapsed (§2.5.5): a person's toggle
 * wins; otherwise generated files and protected tests nobody failed in start
 * closed, and a protected test that failures point into opens on excerpts.
 */
export function groupCollapsed(
  path,
  role,
  { failures = [], open = new Map(), full = new Set() } = {},
) {
  const fileFails = failures.filter((x) => x.location?.file === path && x.location.line);
  const excerpt = role === "acceptance" && fileFails.length > 0 && !full.has(path);
  const def = (role === "acceptance" && !excerpt) || role === "other";
  return !(open.get(path) ?? !def);
}

/**
 * The changed files whose diff the page is showing (RG-N5-5, RG-S6-6): each
 * expanded file in the unified or split reading. The structural reading shows
 * declarations, not the diff, so it shows no file.
 */
export function shownFiles(
  evidence,
  { card, gatesConfig, mode = "unified", open = new Map(), full = new Set() } = {},
) {
  if (!evidence?.diff || mode === "structural") return [];
  const ctx = {
    scopeFiles: card?.scopeFiles ?? [],
    acceptanceTests: card?.acceptanceTests ?? [],
    protectedGlobs: gatesConfig?.protected ?? [],
  };
  const failures = evidence.failures ?? [];
  return parseUnifiedDiff(evidence.diff)
    .map((f) => f.path)
    .filter((path) => !groupCollapsed(path, fileRole(path, ctx), { failures, open, full }));
}

/** Failures keyed by the file and line they point at, for inline annotations. */
export function annotationsByLine(failures = []) {
  const map = new Map();
  for (const f of failures) {
    const file = f.location?.file;
    const line = f.location?.line;
    if (!file || !line) continue;
    const key = `${file}:${line}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(f);
  }
  return map;
}

/** `TS2353` from a tsc excerpt, `E501` style codes, or null. */
export function errorCode(text) {
  return /\b(TS\d{3,5}|[A-Z]{1,4}\d{3,5})\b/.exec(String(text ?? ""))?.[1] ?? null;
}

/**
 * The message without the location and code the header already shows.
 * `tests/a.ts:25:7 TS2353: Object literal…` -> `Object literal…`. Verbatim otherwise.
 */
export function stripLocation(excerpt, location) {
  let text = String(excerpt ?? "");
  if (location?.file && text.startsWith(location.file)) {
    text = text.slice(location.file.length).replace(/^(:\d+)*\s*/, "");
    text = text.replace(/^(TS\d+|[A-Z]{1,4}\d{3,5}):?\s*/, "");
  }
  return text;
}
