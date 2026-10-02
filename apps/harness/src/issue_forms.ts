/**
 * A repository's GitHub issue forms (`.github/ISSUE_TEMPLATE/*.yml`), read for
 * New issue (dashboard §2.4.22, NEW-dashboard-15, DB-N15-3): each form that
 * names one of DEC-31's types gives that type's fields. The forms are
 * repository text: a field's label, options and whether it is required are
 * kept, to be shown as labels; a form's prose (`markdown` blocks) and its
 * descriptions are dropped, and nothing here is sent to a model as instructions.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

export type IssueFormType = "story" | "bug" | "task" | "spike";

export interface IssueFormField {
  id: string;
  label: string;
  kind: "input" | "textarea" | "dropdown";
  options?: string[];
  required?: boolean;
}

export interface IssueForm {
  file: string;
  name: string;
  type: IssueFormType;
  fields: IssueFormField[];
}

const MAX_FORMS = 20;
const MAX_FIELDS = 30;
const MAX_BYTES = 64 * 1024;
const MAX_TEXT = 200;

/** The DEC-31 type a form is for, from its labels, then its name. */
function typeOf(name: string, labels: string[]): IssueFormType | undefined {
  const words = [...labels, name].join(" ").toLowerCase();
  if (/\b(bug|defect|regression)\b/.test(words)) return "bug";
  if (/\b(feature|enhancement|story|request)\b/.test(words)) return "story";
  if (/\b(task|chore)\b/.test(words)) return "task";
  if (/\b(spike|research|investigation)\b/.test(words)) return "spike";
  return undefined;
}

const text = (v: unknown) =>
  typeof v === "string" && v.trim() ? v.trim().replace(/\s+/g, " ").slice(0, MAX_TEXT) : undefined;

/** The issue forms in `repo`, in file order; a file that is not a form is skipped. */
export function readIssueForms(repo: string): IssueForm[] {
  const dir = join(repo, ".github", "ISSUE_TEMPLATE");
  if (!existsSync(dir)) return [];
  const forms: IssueForm[] = [];
  for (const file of readdirSync(dir).sort()) {
    if (forms.length >= MAX_FORMS) break;
    if (!/\.ya?ml$/.test(file) || file === "config.yml" || file === "config.yaml") continue;
    const path = join(dir, file);
    let doc: unknown;
    try {
      if (statSync(path).size > MAX_BYTES) continue;
      doc = parse(readFileSync(path, "utf8"));
    } catch {
      continue;
    }
    if (!doc || typeof doc !== "object" || !Array.isArray((doc as { body?: unknown }).body))
      continue;
    const d = doc as { name?: unknown; labels?: unknown; body: unknown[] };
    const name = text(d.name) ?? file;
    const labels = Array.isArray(d.labels)
      ? d.labels.filter((l): l is string => typeof l === "string")
      : typeof d.labels === "string"
        ? d.labels.split(",")
        : [];
    const type = typeOf(name, labels);
    if (!type) continue;
    const fields: IssueFormField[] = [];
    for (const item of d.body) {
      if (fields.length >= MAX_FIELDS) break;
      if (!item || typeof item !== "object") continue;
      const it = item as {
        type?: unknown;
        id?: unknown;
        attributes?: { label?: unknown; options?: unknown };
        validations?: { required?: unknown };
      };
      if (it.type !== "input" && it.type !== "textarea" && it.type !== "dropdown") continue;
      const label = text(it.attributes?.label);
      if (!label) continue;
      const id =
        (typeof it.id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(it.id) ? it.id : undefined) ??
        `field-${fields.length + 1}`;
      const options =
        it.type === "dropdown" && Array.isArray(it.attributes?.options)
          ? it.attributes.options.map(text).filter((o): o is string => Boolean(o))
          : undefined;
      fields.push({
        id,
        label,
        kind: it.type,
        ...(options?.length ? { options } : {}),
        ...(it.validations?.required === true ? { required: true } : {}),
      });
    }
    if (fields.length) forms.push({ file, name, type, fields });
  }
  return forms;
}
