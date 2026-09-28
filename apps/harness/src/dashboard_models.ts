import {
  type BenchExec,
  type LocalInferenceAdapter,
  type ModelRegistry,
  type ModelRole,
  QUALIFICATION_BAR,
  SPEED_TTFT_PROMPT,
  llamaBenchBinary,
  llamaBenchExec,
  percentile,
  qualifyModel,
  runLlamaBench,
  thinkingPolicyFromEnv,
  withMeasurementRun,
} from "@sekhemet/models";
import type { ConfigApiDeps, SpeedMeasurement } from "./config_api.js";
import { type ModelAccess, describeModel } from "./model_access.js";
import { qualificationCombination } from "./qualify.js";
import { acquireRunnerLease, leaseRefusal } from "./runner_lease.js";

/**
 * The Configuration page's model actions wired to where models run (B4.1,
 * dashboard NEW-dashboard-6, models rule 20a and 27a):
 *
 * - **Load and Unload** go through the dashboard's one residency scheduler —
 *   the process's shared `ModelAccess`, the one Seshat's chat and the
 *   Researcher queue on — as a queue per role, so a person's Load is one
 *   more request `decide()` serves, evicting only what it proves may go.
 * - **Qualify to assign** runs the role's qualification (rule 27a) on this
 *   host, under the runner lease (one runner at a time) as a measurement
 *   run: the model is unloaded when it ends, even when it fails.
 * - The scheduler's loading state is what the page's background model
 *   hashing yields to (a first USB hash never competes with a model load).
 */

export type DashboardResidency = NonNullable<ConfigApiDeps["residency"]>;

/** The page's Load and Unload through a `ModelAccess` (the shared one in the dashboard). */
export function dashboardResidency(access: () => ModelAccess): DashboardResidency {
  /** The queue each role's Load made, with the model it names. */
  const queues = new Map<ModelRole, { queue: string; model: string }>();
  const queueFor = (role: ModelRole, model: string) => {
    const queue = `config:${role}:${model}`;
    access().ensureQueue({ queue, role, name: model });
    queues.set(role, { queue, model });
    return queue;
  };
  return {
    resident: () => {
      const a = access();
      const names = [...queues.values()].filter((q) => a.isResident(q.queue)).map((q) => q.model);
      return [...new Set([...names, ...a.residentWeights()])];
    },
    loading: () => access().loadingWeights().length > 0,
    load: async (role, model) => {
      const a = access();
      const queue = queueFor(role, model);
      try {
        await a.measure();
        // A person's request (rule 20e): served when `decide()` may, then let go.
        const hold = await a.submitHold(queue, { cls: "interactive" });
        hold.release();
        return { ok: true };
      } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : String(err) };
      }
    },
    unload: async (role) => {
      const q = queues.get(role);
      const a = access();
      if (!q || !a.isResident(q.queue)) return {};
      await a.release(q.queue);
      return a.isResident(q.queue)
        ? { deferred: "It is answering a request now; it unloads when that ends." }
        : {};
    },
  };
}

/** The page's Qualify to assign: the role's qualification on this host (rule 27a). */
export function dashboardQualify(o: {
  repoPath: string;
  registry: ModelRegistry;
  /** The model's adapter for measuring it; `describeModel` (loads nothing until asked). */
  adapterFor?: (model: string, role: ModelRole) => LocalInferenceAdapter;
  /**
   * The residency scheduler: the qualification runs inside one benchmark run
   * of it, alone in memory (its adapter loads unseen by the scheduler).
   */
  access?: () => ModelAccess;
}): NonNullable<ConfigApiDeps["qualify"]> {
  return async (role, model) => {
    const lease = acquireRunnerLease(o.repoPath, { kind: "qualify" });
    if ("holder" in lease) return { qualified: false, reason: leaseRefusal(lease.holder) };
    const alone = <T>(run: () => Promise<T>): Promise<T> =>
      o.access
        ? o.access().benchmarkRun(async (bench) => {
            await bench.exclusive();
            return run();
          })
        : run();
    try {
      const adapter = (
        o.adapterFor ?? ((m: string, r: ModelRole) => describeModel(m, r, { registry: o.registry }))
      )(model, role);
      const combination = () => qualificationCombination(adapter, { registry: o.registry });
      // A measurement run (MS-NM14-3, DEC-42): unloaded at its end, even on failure.
      const { best } = await alone(() =>
        withMeasurementRun(
          {
            releaseAll: async () => {
              await (adapter as { unload?: () => Promise<void> }).unload?.();
            },
          },
          () =>
            qualifyModel(adapter, {
              registry: o.registry,
              bar: QUALIFICATION_BAR,
              combination,
              thinking: thinkingPolicyFromEnv(),
            }),
        ),
      );
      const look = o.registry.lookupQualification(adapter.modelId, combination());
      const qualified = look.status === "qualified" || look.status === "overridden";
      return qualified
        ? { qualified: true }
        : {
            qualified: false,
            reason: `${Math.round(best.passRate * 100)}% of the check that verifies it on this machine passed; it needs ${Math.round(QUALIFICATION_BAR * 100)}%.`,
          };
    } catch (err) {
      return {
        qualified: false,
        reason: `The check that verifies it on this machine could not run: ${err instanceof Error ? err.message : String(err)}`,
      };
    } finally {
      lease.release();
    }
  };
}

/**
 * The page's **Measure speed** (dashboard DB-NM14-3; B4.1 half-B review): a
 * person's confirmed request, under the runner lease and inside one benchmark
 * run of the residency scheduler (no other role loads meanwhile; only what it
 * loaded is unloaded). llama-bench runs one warm-up and five runs at the
 * role's depth; then the model is loaded through the scheduler and the first
 * token is timed on prompts it has not seen (without the prefix cache) and on
 * a prompt it has (with it), the median of `ttftRuns` each.
 */
export function dashboardSpeed(o: {
  repoPath: string;
  access: () => ModelAccess;
  /** Runs llama-bench; the llama.cpp build's own by default. */
  exec?: BenchExec;
  bin?: string;
  /** First-token timings per state; default 3. */
  ttftRuns?: number;
  now?: () => number;
}): NonNullable<ConfigApiDeps["measureSpeed"]> {
  const now = o.now ?? (() => performance.now());
  const runs = Math.max(1, o.ttftRuns ?? 3);
  return async ({ model, path, role, depth }) => {
    const runner = acquireRunnerLease(o.repoPath, { kind: "benchmark" });
    if ("holder" in runner) throw new Error(leaseRefusal(runner.holder));
    try {
      return await o.access().benchmarkRun(async (lease): Promise<SpeedMeasurement> => {
        // llama-bench loads the weights in its own process, unseen by the scheduler.
        await lease.exclusive();
        const out: SpeedMeasurement = {};
        try {
          out.bench = await runLlamaBench({
            modelPath: path,
            depth,
            bin: o.bin ?? llamaBenchBinary(),
            exec: o.exec ?? llamaBenchExec(),
          });
        } catch (err) {
          out.benchError = `llama-bench did not run: ${err instanceof Error ? err.message : String(err)}`;
        }
        try {
          const adapter = await lease.load(role, model);
          const first = async (prompt: string): Promise<number> => {
            const t0 = now();
            let at: number | undefined;
            await adapter.generate({
              prompt,
              toolArm: "arm_a_flat",
              temperature: 0,
              maxTokens: 1,
              onToken: () => {
                at ??= now();
              },
            });
            return (at ?? now()) - t0;
          };
          const cold: number[] = [];
          const warm: number[] = [];
          let last = "";
          // A new first line each time: nothing of it is cached.
          for (let i = 0; i < runs; i++) {
            last = `Run ${i + 1} at ${Date.now()}.\n${SPEED_TTFT_PROMPT}`;
            cold.push(await first(last));
          }
          for (let i = 0; i < runs; i++) warm.push(await first(last));
          out.ttft = {
            withoutCacheMs: { value: Math.round(percentile(cold, 0.5)), grade: "measured" },
            withCacheMs: { value: Math.round(percentile(warm, 0.5)), grade: "measured" },
            runs,
          };
        } catch (err) {
          out.ttftError = `The first token could not be timed: ${err instanceof Error ? err.message : String(err)}`;
        } finally {
          await lease.release(role, model);
        }
        return out;
      });
    } finally {
      runner.release();
    }
  };
}
