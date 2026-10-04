import type { CardStore } from "@sekhemet/kernel";

/**
 * `sekhemet dev pause|resume <project>` (runtime item 17a, RUN-48): no new
 * issue of a paused project starts; a running one finishes. Recorded, with
 * the person. `resume` names a project or an issue: `resume <issue>` is the
 * registry's `resume` (`commands/run.ts`), which hands a project's name or
 * id here.
 */

/** The project a `pause` or `resume` names, by id or name. */
export function findProject(cardStore: CardStore, ref: string | undefined) {
  if (!ref) return undefined;
  return cardStore.listProjects().find((p) => p.id === ref || p.name === ref);
}

/** Pause or resume the project; the exit code (2: no such project, 1: refused). */
export async function setProjectRunning(
  cardStore: CardStore,
  verb: "pause" | "resume",
  ref: string | undefined,
): Promise<0 | 1 | 2> {
  const project = findProject(cardStore, ref);
  if (!project) {
    console.error(`Usage: sekhemet dev ${verb} <project id or name>`);
    return 2;
  }
  const status = verb === "pause" ? "paused" : "active";
  try {
    await cardStore.setProjectStatus(project.id, status, "human");
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
  console.log(
    status === "paused"
      ? `Project ${project.name} is paused: no new issue of it starts until you resume it; a running issue finishes.`
      : `Project ${project.name} is active again.`,
  );
  return 0;
}
