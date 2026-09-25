import { existsSync } from "node:fs";
import { basename } from "node:path";
import { GGMLFileQuantizationType, gguf, parseGGUFQuantLabel } from "@huggingface/gguf";

/**
 * A GGUF model's quantisation (e.g. "IQ3_XXS"), for the reproducibility
 * record (MD-M4-5) and the injection pass keyed on it (SEC-37b): the header's
 * `general.file_type`, else the label in the file name, else undefined.
 * Reads only the header.
 */
export async function readQuantisation(modelFile: string): Promise<string | undefined> {
  if (!existsSync(modelFile)) return undefined;
  try {
    const { metadata } = await gguf(modelFile, { allowLocalFile: true });
    const fileType = (metadata as Record<string, unknown>)["general.file_type"];
    const name =
      typeof fileType === "number" || typeof fileType === "bigint"
        ? GGMLFileQuantizationType[Number(fileType)]
        : undefined;
    if (name) return name.replace(/^MOSTLY_/, "");
  } catch {
    // Not a readable GGUF header: the file name may still say.
  }
  return parseGGUFQuantLabel(basename(modelFile))?.toUpperCase();
}
