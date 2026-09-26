import { splitAcrossRepos } from "@sekhemet/sync";
import type { AcceptanceTestSpec, CodebaseRepo, PlannedStory } from "./types.js";

/**
 * A cross-repository change is two cards with a dependency edge, never one
 * card with two worktrees (review-git rule 5, RG-N3-2).
 *
 * A story whose scope spans repositories becomes one story per repository,
 * in the order the repositories are declared (upstream first), each
 * depending on the one before it; a story that depended on the original
 * depends on the last. Each keeps the acceptance tests that live in its
 * repository — a declared file of it, or a path under the top-level
 * directory its files share — and a test that lives in no repository goes to the
 * originating part, the first, never copied to every part (minor 5). A part
 * left with no test of its own is written one, in its own repository, scoped
 * to its share of the story's criterion, so every part is testable and
 * passes INVEST (RG-N3-2); each is labelled `repo:<name>` so it runs in its
 * own repository's worktree.
 */

/** The top-level directory every file of a repository lives under ("" when they do not share one). */
function repoDir(files: readonly string[]): string {
  const tops = new Set(files.map((f) => (f.includes("/") ? (f.split("/")[0] as string) : "")));
  return tops.size === 1 ? ([...tops][0] as string) : "";
}
/**
 * The acceptance test written for a part with none of its own: the story's
 * first criterion scoped to this repository's share, in this repository's
 * test directory, failing until the part is built.
 */
function partTest(
  story: PlannedStory,
  repo: string,
  dir: string,
  scopeFiles: readonly string[],
  otherDirs: readonly string[],
): AcceptanceTestSpec {
  const first = story.acceptanceTests[0];
  let rel = first?.filePath ?? `tests/${story.card.id}.spec.ts`;
  for (const d of otherDirs) if (d && rel.startsWith(`${d}/`)) rel = rel.slice(d.length + 1);
  let filePath = dir ? `${dir}/${rel}` : rel.replace(/(\.[cm]?[jt]sx?)?$/, `_${repo}$1`);
  if (story.acceptanceTests.some((t) => t.filePath === filePath)) {
    filePath = filePath.replace(/(\.spec)?(\.[cm]?[jt]sx?)?$/, `_${repo}$1$2`);
  }
  const criterion = (first?.assertion ?? `${story.card.title}.`).replace(/\.$/, "");
  return {
    filePath,
    assertion: `${criterion}: the ${repo} repository's share, observable through the exported surface of ${scopeFiles[0] ?? repo}.`,
    initiallyFailing: true,
  };
}

export function splitStoriesAcrossRepos(
  stories: readonly PlannedStory[],
  repos: readonly CodebaseRepo[],
): PlannedStory[] {
  if (repos.length < 2) return [...stories];
  const repoOf = (file: string): string | undefined =>
    repos.find((r) => r.files.includes(file))?.name;
  // Where a repository's files live: a test under that directory is its own.
  const roots = repos.map((r) => ({ name: r.name, dir: repoDir(r.files) }));
  const holderOf = (file: string): string | undefined =>
    repoOf(file) ?? roots.find((r) => r.dir && file.startsWith(`${r.dir}/`))?.name;
  const order = repos.map((r) => r.name);
  const renamed = new Map<string, string>();
  const out: PlannedStory[] = [];
  for (const story of stories) {
    const scope = story.card.scopeFiles.map((path) => ({ repo: repoOf(path), path }));
    const named = new Set(scope.map((s) => s.repo).filter((r): r is string => r !== undefined));
    if (named.size < 2) {
      out.push(story);
      continue;
    }
    // A file in no declared repository goes with the first part.
    const first = order.find((r) => named.has(r)) as string;
    const parts = splitAcrossRepos(
      scope.map((s) => ({ repo: s.repo ?? first, path: s.path })),
      order,
    );
    const last = parts.length - 1;
    const ids = parts.map((p) => `${story.card.id}_${p.repo}`);
    parts.forEach((part, i) => {
      // A test goes to the part whose repository holds its path, else to
      // the originating part (minor 5).
      const mine = story.acceptanceTests.filter((t) => {
        const r = holderOf(t.filePath);
        return r === undefined || !parts.some((p) => p.repo === r) ? i === 0 : r === part.repo;
      });
      const dir = roots.find((r) => r.name === part.repo)?.dir ?? "";
      const tests =
        mine.length > 0
          ? mine
          : [
              partTest(
                story,
                part.repo,
                dir,
                part.scopeFiles,
                roots.filter((r) => r.name !== part.repo).map((r) => r.dir),
              ),
            ];
      const dependsOn = i === 0 ? [...story.dependsOn] : [ids[i - 1] as string];
      out.push({
        ...story,
        card: {
          ...story.card,
          id: ids[i] as string,
          title: `${story.card.title} (${part.repo})`,
          scopeFiles: part.scopeFiles,
          labels: [...(story.card.labels ?? []), `repo:${part.repo}`],
          status: dependsOn.length === 0 ? story.card.status : "backlog",
        },
        acceptanceTests: tests,
        dependsOn,
        rationale: `${story.rationale} Part ${i + 1} of ${parts.length}: the ${part.repo} repository's share of a cross-repository change.`,
      });
    });
    renamed.set(story.card.id, ids[last] as string);
  }
  return out.map((s) =>
    s.dependsOn.some((d) => renamed.has(d))
      ? { ...s, dependsOn: s.dependsOn.map((d) => renamed.get(d) ?? d) }
      : s,
  );
}
