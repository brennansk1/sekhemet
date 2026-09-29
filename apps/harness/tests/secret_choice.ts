import { join } from "node:path";
import { recordCleartextSecretsChoice } from "../src/secret_store.js";

/**
 * SEC-27c: tests run with no secret store (`SEKHEMET_KEYCHAIN=off`, so the
 * owner's keychain is never touched), where a secret is saved only after the
 * person's recorded choice to keep it in a private file. This records that
 * choice in a config.toml under `dir`, through the product's own writer, and
 * points `SEKHEMET_USER_CONFIG` at it; the returned function puts the
 * previous value back.
 */
export function chooseSecretsFile(dir: string): () => void {
  const before = process.env.SEKHEMET_USER_CONFIG;
  const path = join(dir, "config.toml");
  recordCleartextSecretsChoice(true, path);
  process.env.SEKHEMET_USER_CONFIG = path;
  return () => {
    if (before === undefined) Reflect.deleteProperty(process.env, "SEKHEMET_USER_CONFIG");
    else process.env.SEKHEMET_USER_CONFIG = before;
  };
}
