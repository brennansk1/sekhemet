// Record a model's context window in the registry the built binary reads
// (SEKHEMET_MODEL_REGISTRY), as `sekhemet models` records one a person sets:
// the planner's INVEST Small reads the resolved Worker's window (PM-13).
//
//   node g3_registry.mjs <model> <contextTokens>
import { ModelRegistry } from "@sekhemet/models";

const [model, window] = process.argv.slice(2);
const registry = new ModelRegistry(process.env.SEKHEMET_MODEL_REGISTRY);
registry.upsert(String(model), { contextWindow: Number(window) });
