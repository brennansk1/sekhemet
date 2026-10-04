import { ROLE_WORDS } from "./assignments.js";

/**
 * Ollama's cloud models (models rule 14c, NEW-models-20, DEC-55, DEC-03). A
 * tag ending in `:cloud` or `-cloud`, or a model whose details from Ollama
 * name a remote host, runs on Ollama's cloud service: the harness's request
 * goes to Ollama on loopback and the prompt leaves the machine where the
 * network policy cannot see it. Such a model is refused for every role.
 */

/** Whether an Ollama tag names one of Ollama's cloud models (`:cloud`, `-cloud`). */
export function isOllamaCloudTag(tag: string): boolean {
  return /[:-]cloud$/i.test(tag.trim().replace(/^ollama\//i, ""));
}

/**
 * The remote host Ollama's details for a model name (`/api/tags` entries and
 * `/api/show` carry `remote_host` for a cloud model); undefined for a local one.
 */
export function ollamaRemoteHost(details: unknown): string | undefined {
  if (!details || typeof details !== "object") return undefined;
  const d = details as { remote_host?: unknown; remote_model?: unknown };
  if (typeof d.remote_host === "string" && d.remote_host.trim()) return d.remote_host.trim();
  if (typeof d.remote_model === "string" && d.remote_model.trim()) return "Ollama's cloud";
  return undefined;
}

/** The refusal's words (MD-N20-1, MD-N20-2): the model, and that its prompts would leave. */
export function ollamaCloudRefusal(model: string, role?: string, remoteHost?: string): string {
  const name = model.replace(/^ollama\//i, "");
  const who = role ? ` as the ${ROLE_WORDS[role] ?? role}` : "";
  const where = remoteHost && remoteHost !== "Ollama's cloud" ? ` (${remoteHost})` : "";
  return `Refusing ${name}${who}: it runs on Ollama's cloud service${where}, so its prompts would leave this machine. Sekhemet runs local models only; choose a model that runs here.`;
}

export class OllamaCloudRefusal extends Error {
  constructor(
    public readonly model: string,
    role?: string,
    remoteHost?: string,
  ) {
    super(ollamaCloudRefusal(model, role, remoteHost));
    this.name = "OllamaCloudRefusal";
  }
}

/** Throws `OllamaCloudRefusal` for a cloud tag; returns otherwise. */
export function assertNotOllamaCloud(model: string, role?: string): void {
  if (isOllamaCloudTag(model)) throw new OllamaCloudRefusal(model, role);
}
