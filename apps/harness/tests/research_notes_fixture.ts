import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";

/**
 * A real repository for the research packet and notes (design-stage
 * DS-N9-15 to -22): a git repository with a real ledger file, and zod laid
 * out under node_modules as its 3.23.8 release ships it — `index.d.ts`
 * re-exporting `lib/`, `lib/index.d.ts` binding the namespace `z`, and
 * `lib/types.d.ts` with lines taken verbatim from the release (ZodString's
 * checks, the `stringType as string` export list). The adapters read these
 * files as they read any installed package; nothing is mocked.
 */

export const ZOD_TYPES = [
  "export declare abstract class ZodType<Output = any, Def extends ZodTypeDef = ZodTypeDef, Input = Output> {",
  "    parse(data: unknown, params?: Partial<ParseParams>): Output;",
  "    safeParse(data: unknown, params?: Partial<ParseParams>): SafeParseReturnType<Input, Output>;",
  "    optional(): ZodOptional<this>;",
  "}",
  "export declare class ZodString extends ZodType<string, ZodStringDef, string> {",
  "    email(message?: errorUtil.ErrMessage): ZodString;",
  "    url(message?: errorUtil.ErrMessage): ZodString;",
  "    uuid(message?: errorUtil.ErrMessage): ZodString;",
  "    min(minLength: number, message?: errorUtil.ErrMessage): ZodString;",
  "    max(maxLength: number, message?: errorUtil.ErrMessage): ZodString;",
  "}",
  "export declare class ZodNumber extends ZodType<number, ZodNumberDef, number> {",
  "    int(message?: errorUtil.ErrMessage): ZodNumber;",
  "}",
  "declare const stringType: (params?: RawCreateParams & {",
  "    coerce?: true;",
  "}) => ZodString;",
  "declare const numberType: (params?: RawCreateParams & {",
  "    coerce?: boolean;",
  "}) => ZodNumber;",
  "declare const objectType: <T extends ZodRawShape>(shape: T, params?: RawCreateParams) => ZodObject<T>;",
  "export { numberType as number, objectType as object, stringType as string, };",
  "",
].join("\n");

/** The line of `email(` in `lib/types.d.ts`, 1-based. */
export const EMAIL_LINE = 7;

export interface Fixture {
  root: string;
  repo: string;
  db: DatabaseSync;
  log: EventLog;
  cardStore: CardStore;
  cacheDir: string;
  close: () => void;
}

export function writeFiles(repo: string, files: Record<string, string>): void {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, rel)), { recursive: true });
    writeFileSync(join(repo, rel), text);
  }
}

/** zod at `version`, installed and pinned. */
export function installZod(repo: string, version = "3.23.8"): void {
  writeFiles(repo, {
    "package.json": JSON.stringify({ name: "app", dependencies: { zod: `^${version}` } }),
    "pnpm-lock.yaml": `lockfileVersion: '9.0'\n\npackages:\n\n  zod@${version}:\n    resolution: {integrity: sha512-x}\n`,
    "node_modules/zod/package.json": JSON.stringify({
      name: "zod",
      version,
      main: "./lib/index.js",
      types: "./index.d.ts",
    }),
    "node_modules/zod/index.d.ts": 'export * from "./lib";\nexport as namespace Zod;\n',
    "node_modules/zod/lib/index.d.ts":
      'import * as z from "./external";\nexport * from "./external";\nexport { z };\nexport default z;\n',
    "node_modules/zod/lib/external.d.ts": 'export * from "./types";\n',
    "node_modules/zod/lib/types.d.ts": ZOD_TYPES,
  });
}

export function fixture(files: Record<string, string> = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), "sek-notes-"));
  const repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
  installZod(repo);
  writeFiles(repo, {
    "src/schema.ts":
      'import { z } from "zod";\nexport const user = z.object({ name: z.string() });\n',
    ".gitignore": "node_modules\n.sekhemet\n",
    ...files,
  });
  const git = (...a: string[]) => execFileSync("git", a, { cwd: repo, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "e@x");
  git("config", "user.name", "E");
  git("add", "-A");
  git("commit", "-q", "-m", "feat: init");
  mkdirSync(join(repo, ".sekhemet"), { recursive: true });
  const db = new DatabaseSync(join(repo, ".sekhemet", "events.db"));
  initSchema(db);
  const log = new EventLog(db);
  const cacheDir = join(root, "cache");
  return {
    root,
    repo,
    db,
    log,
    cardStore: new CardStore(db, log),
    cacheDir,
    close: () => {
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** A story card with a spec and criteria, as a plan persists it. */
export async function story(
  f: Fixture,
  id: string,
  spec: string,
  acceptanceCriteria: string[] = [],
): Promise<string> {
  await f.cardStore.createCard({
    id,
    tier: "story",
    title: id,
    spec,
    acceptanceCriteria,
    status: "planning",
  });
  return id;
}
