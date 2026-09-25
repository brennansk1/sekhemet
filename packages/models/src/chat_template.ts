import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { gguf } from "@huggingface/gguf";

/**
 * The chat template a model file will run with, read offline (security
 * SEC-34a; the model library's header scan, NEW-models-13): a GGUF file's
 * embedded `tokenizer.chat_template`, read from the header only by
 * Hugging Face's reader (DEC-40); or, for safetensors weights, the template
 * beside them — which can change while the weights stay byte-identical.
 * (For GGUF the weights' SHA-256 already covers the embedded template, so
 * the check there only repeats it.)
 */
export async function readChatTemplate(
  modelFile: string,
): Promise<{ template: string; source: string } | undefined> {
  if (modelFile.endsWith(".gguf")) {
    try {
      const { metadata } = await gguf(modelFile, { allowLocalFile: true });
      const t = (metadata as Record<string, unknown>)["tokenizer.chat_template"];
      return typeof t === "string" ? { template: t, source: modelFile } : undefined;
    } catch {
      return undefined;
    }
  }
  // transformers' own order: a `chat_template.jinja` or `chat_template.json`
  // beside the weights wins over `tokenizer_config.json` (B1 review).
  const dir = dirname(modelFile);
  const jinja = join(dir, "chat_template.jinja");
  if (existsSync(jinja)) return { template: readFileSync(jinja, "utf8"), source: jinja };
  for (const file of ["chat_template.json", "tokenizer_config.json"]) {
    const path = join(dir, file);
    if (!existsSync(path)) continue;
    try {
      const t = (JSON.parse(readFileSync(path, "utf8")) as { chat_template?: unknown })
        .chat_template;
      // A list of named templates is hashed as a whole.
      if (typeof t === "string") return { template: t, source: path };
      if (Array.isArray(t)) return { template: JSON.stringify(t), source: path };
    } catch {
      return undefined;
    }
  }
  return undefined;
}
