import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, resolve, sep } from "node:path";

/** The loopback ports the owner's real model servers listen on: Ollama, the Worker, Hermes. */
const REAL_SERVER_PORTS = new Set([11434, 8098, 8080]);
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/**
 * Why a model load or inference request is refused in this process, or
 * undefined. With `SEKHEMET_MODEL_LOADS=off` (every test run sets it) nothing
 * may reach the real model servers on this machine or start a real llama.cpp
 * binary; a test's fake server on its own port and a fake binary under the
 * temporary directory still run.
 */
export function modelLoadRefusal(target: { url?: string; binary?: string | undefined }):
  | string
  | undefined {
  if (process.env.SEKHEMET_MODEL_LOADS !== "off") return undefined;
  if (target.url !== undefined) {
    let host = "";
    let port = 0;
    try {
      const u = new URL(target.url);
      host = u.hostname;
      port = Number(u.port || (u.protocol === "https:" ? 443 : 80));
    } catch {
      return undefined;
    }
    if (LOOPBACK.has(host) && REAL_SERVER_PORTS.has(port))
      return `Model loads are off in this process (SEKHEMET_MODEL_LOADS=off): refused a request to ${target.url}.`;
    return undefined;
  }
  if ("binary" in target) {
    const bin = target.binary;
    const roots = [resolve(tmpdir())];
    try {
      roots.push(realpathSync(tmpdir()));
    } catch {
      // The plain path is enough.
    }
    const underTmp =
      bin !== undefined &&
      isAbsolute(bin) &&
      roots.some((root) => resolve(bin).startsWith(root + sep));
    if (!underTmp)
      return `Model loads are off in this process (SEKHEMET_MODEL_LOADS=off): refused to start ${bin ?? "llama-server"}.`;
  }
  return undefined;
}

/** Throws the refusal, if any. */
export function assertModelLoadAllowed(target: {
  url?: string;
  binary?: string | undefined;
}): void {
  const why = modelLoadRefusal(target);
  if (why) throw new Error(why);
}
