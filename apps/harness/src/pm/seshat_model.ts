import type { ModelHold, ModelRegistry } from "@sekhemet/models";
import { effectiveConfig } from "../config_apply.js";
import { UnknownFootprint, describeModel, roleModelName, weightsKey } from "../model_access.js";
import { SeshatNotSetUp } from "./failure.js";
import { DEFAULT_PM_MODEL } from "./service.js";

/**
 * Seshat's model, the Planning model (N0, c6 #2): the person's Planning
 * assignment on this host (models rule 30a, MD-N10-3), else `[models]
 * planner` in config.toml when it names one, else the shipped default — the
 * order the queue resolves the Planning model in, so `plan`, `sekhemet
 * "<spec>"`, `serve`, `ask` and the queue agree.
 */
export function seshatModelName(
  repoPath: string,
  opts: { registry: ModelRegistry; host?: string },
): string {
  const assigned = roleModelName("planner", undefined, opts);
  if (assigned) return assigned;
  let configured: string | undefined;
  try {
    configured = effectiveConfig(repoPath).config.models.planner.trim();
  } catch {
    // An unreadable configuration is the configuration check's to report.
  }
  return configured && configured !== "auto" && configured !== "none"
    ? configured
    : DEFAULT_PM_MODEL;
}

/** Where a person sets Seshat's model up, in the words of where they are asking from. */
export type SetupWhere = "dashboard" | "terminal";

const SET_UP: Readonly<Record<SetupWhere, string>> = {
  dashboard:
    "Your message is kept: choose and verify a Planning model in Configuration › Models, then press Retry.",
  terminal:
    "Your question is kept: choose and verify a Planning model in Configuration › Models, or run `sekhemet doctor` to see what is missing, then ask again.",
};

/**
 * What stops Seshat's model from answering on this machine before anything
 * loads (N0, c6 #3), else undefined. Only what would otherwise hang is said
 * here: on the dashboard, a model the model list does not hold (the shared
 * chat queue cannot size its load and waits for ever, MD-N9-3); anywhere, a
 * listed model Sekhemet cannot run. In the terminal an Ollama tag the list
 * does not hold is asked of Ollama directly, whose own refusals name what is
 * missing (SUR-51). Chat needs no Planning qualification: the queue's
 * planning does (qualify.ts `gateRole`), unchanged.
 */
export function seshatSetupGap(
  name: string,
  registry: ModelRegistry,
  where: SetupWhere,
): string | undefined {
  const plain = name.replace(/^ollama\//, "");
  const listed = registry.get(plain) ?? registry.get(weightsKey(plain));
  if (!listed) {
    const ollamaTag = name.startsWith("ollama/") || /:[\w.-]+$/.test(plain);
    if (where === "terminal" && ollamaTag) return undefined;
    return `Seshat's model, ${plain}, is not set up on this machine: it is not in Sekhemet's model list. ${SET_UP[where]}`;
  }
  try {
    describeModel(plain, "planner", { registry });
  } catch {
    return `Seshat's model, ${plain}, is not set up on this machine: Sekhemet cannot run it. ${SET_UP[where]}`;
  }
  return undefined;
}

/**
 * An `acquire` that says what is missing instead of waiting on a model that
 * cannot load: the gap is checked on each answer, so a model a person sets
 * up while the server runs is used on the next message.
 */
export function setUpBeforeLoading(
  acquire: () => Promise<ModelHold>,
  gap: () => string | undefined,
  where: SetupWhere = "terminal",
): () => Promise<ModelHold> {
  return async () => {
    const missing = gap();
    if (missing) throw new SeshatNotSetUp(missing);
    try {
      return await acquire();
    } catch (err) {
      // A model whose memory cannot be measured would wait for ever (MD-N9-3).
      if (err instanceof UnknownFootprint)
        throw new SeshatNotSetUp(
          `Seshat's model, ${err.model}, is not set up on this machine: Sekhemet cannot measure the memory it needs, so it cannot load it. ${SET_UP[where]}`,
        );
      throw err;
    }
  };
}
