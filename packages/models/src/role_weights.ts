import { basename } from "node:path";
import { currentAssignment } from "./assignments.js";
import { hostFingerprintHash } from "./calibration.js";
import type { ConfigRole, FoundModel } from "./library_types.js";
import { MANAGED_MODEL_FILES } from "./llama_server.js";
import { type ScanFolderInput, scanModelFolders } from "./model_scan.js";
import { resolveModelsDir } from "./models_dir.js";
import { ModelRegistry } from "./registry.js";
import { MODEL_ROLES } from "./types.js";

/**
 * The weights found for each role (B4.1 part b; used by the first run,
 * surface SUR-49, and the page's DB-N6-2): the model folders are scanned —
 * headers and sizes only, subfolders included, nothing loaded or fetched —
 * and a role has weights when a folder holds its managed default's file
 * (by name, wherever it sits, so a copy on internal storage counts), or the
 * model this host's assignment names. `modelsDir` is `--models-dir` (else
 * `SEKHEMET_MODELS_DIR`, else `~/.sekhemet/models`); `folders` adds the
 * Configuration page's `[models] folders`.
 */
export async function findRoleWeights(
  options: {
    modelsDir?: string;
    folders?: readonly string[];
    registry?: ModelRegistry;
    host?: string;
  } = {},
): Promise<Partial<Record<ConfigRole, FoundModel>>> {
  const dirs = [
    resolveModelsDir(options.modelsDir ? { modelsDir: options.modelsDir } : {}),
    ...(options.folders ?? []),
  ];
  const scan = await scanModelFolders(
    [...new Set(dirs)].map(
      (path): ScanFolderInput => ({ path, source: "config", includeSubfolders: true }),
    ),
  );
  const out: Partial<Record<ConfigRole, FoundModel>> = {};
  const managed = MANAGED_MODEL_FILES as Readonly<Record<string, string>>;
  let registry = options.registry;
  for (const role of MODEL_ROLES) {
    const file = managed[role];
    const byFile = file ? scan.models.find((m) => basename(m.path) === basename(file)) : undefined;
    if (byFile) {
      out[role] = byFile;
      continue;
    }
    try {
      registry ??= new ModelRegistry();
      const assigned = currentAssignment(registry, options.host ?? hostFingerprintHash(), role);
      const where = assigned ? registry.preferredWeights(assigned.model) : undefined;
      const hit = scan.models.find(
        (m) => (where && m.path === where) || (assigned && m.name === assigned.model),
      );
      if (hit) out[role] = hit;
    } catch {
      // An unreadable registry: the managed files alone decide.
    }
  }
  return out;
}
