import { createHash } from "node:crypto";

/**
 * The reuse survey's labelled set (design-stage DS-P7-7): about forty needs,
 * each phrased the way a capability reaches the survey, with the packages a
 * professional would reach for first — any one of them counts — or "none"
 * when the right answer is silence: the language covers it (decided from the
 * built-in words, no query sent), or it is the project's own rule, which is
 * searched and must come back empty. Half the none needs are searched, so
 * the correct-silence rate is not the built-in word list checked against
 * itself. The runner (`reuse_eval.ts`) scores precision@1 on the labelled
 * needs, the correct-silence rate on the none needs, and silence on the
 * searched none needs apart. Changing a label changes the set's
 * hash, so a run is only ever compared with a baseline on the same labels.
 * Package names are compared normalised (PEP 503: lower case, runs of
 * `-`, `_` and `.` as one `-`).
 */
export interface LabelledNeed {
  id: string;
  need: string;
  stack: "typescript" | "python";
  expect: readonly string[] | "none";
}

export const REUSE_LABELLED_SET: readonly LabelledNeed[] = [
  // npm: a well-known answer each.
  {
    id: "npm-cli-args",
    need: "parses command line arguments",
    stack: "typescript",
    expect: ["commander", "yargs", "minimist", "meow", "cac"],
  },
  {
    id: "npm-json-schema",
    need: "validates json against a schema",
    stack: "typescript",
    expect: ["ajv", "zod", "joi"],
  },
  {
    id: "npm-dates",
    need: "parses and formats dates",
    stack: "typescript",
    expect: ["date-fns", "dayjs", "luxon", "moment"],
  },
  { id: "npm-smtp", need: "sends email over smtp", stack: "typescript", expect: ["nodemailer"] },
  {
    id: "npm-csv",
    need: "parses csv files",
    stack: "typescript",
    expect: ["csv-parse", "papaparse", "fast-csv", "csv-parser"],
  },
  { id: "npm-ids", need: "generates unique ids", stack: "typescript", expect: ["uuid", "nanoid"] },
  {
    id: "npm-passwords",
    need: "hashes passwords",
    stack: "typescript",
    expect: ["bcrypt", "bcryptjs", "argon2"],
  },
  {
    id: "npm-jwt",
    need: "signs and verifies json web tokens",
    stack: "typescript",
    expect: ["jsonwebtoken", "jose"],
  },
  {
    id: "npm-markdown",
    need: "renders markdown to html",
    stack: "typescript",
    expect: ["marked", "markdown-it", "remark", "showdown"],
  },
  { id: "npm-watch", need: "watches files for changes", stack: "typescript", expect: ["chokidar"] },
  {
    id: "npm-http",
    need: "makes http requests",
    stack: "typescript",
    expect: ["axios", "got", "undici", "node-fetch", "ky"],
  },
  {
    id: "npm-retry",
    need: "retries failed operations with backoff",
    stack: "typescript",
    expect: ["p-retry", "async-retry", "retry", "exponential-backoff"],
  },
  {
    id: "npm-colour",
    need: "colours terminal output",
    stack: "typescript",
    expect: ["chalk", "picocolors", "kleur", "colorette"],
  },
  {
    id: "npm-yaml",
    need: "parses yaml documents",
    stack: "typescript",
    expect: ["yaml", "js-yaml"],
  },
  { id: "npm-images", need: "resizes images", stack: "typescript", expect: ["sharp", "jimp"] },
  {
    id: "npm-pdf",
    need: "generates pdf documents",
    stack: "typescript",
    expect: ["pdfkit", "pdf-lib", "jspdf", "pdfmake"],
  },
  {
    id: "npm-rate-limit",
    need: "rate limits api requests",
    stack: "typescript",
    expect: ["express-rate-limit", "rate-limiter-flexible", "bottleneck"],
  },
  {
    id: "npm-glob",
    need: "matches file paths with glob patterns",
    stack: "typescript",
    expect: ["glob", "fast-glob", "globby", "minimatch", "picomatch", "micromatch"],
  },
  {
    id: "npm-cron",
    need: "schedules cron jobs",
    stack: "typescript",
    expect: ["node-cron", "cron", "croner", "node-schedule"],
  },
  { id: "npm-semver", need: "compares semantic versions", stack: "typescript", expect: ["semver"] },
  {
    id: "npm-websocket",
    need: "serves websocket connections",
    stack: "typescript",
    expect: ["ws", "socket.io", "uWebSockets.js"],
  },
  {
    id: "npm-postgres",
    need: "queries a postgres database",
    stack: "typescript",
    expect: ["pg", "postgres", "knex", "kysely", "drizzle-orm", "prisma"],
  },
  // PyPI, found through GitHub and verified by name.
  {
    id: "py-http",
    need: "makes http requests",
    stack: "python",
    expect: ["requests", "httpx", "aiohttp", "urllib3"],
  },
  {
    id: "py-yaml",
    need: "parses yaml documents",
    stack: "python",
    expect: ["pyyaml", "ruamel-yaml"],
  },
  {
    id: "py-models",
    need: "validates data models",
    stack: "python",
    expect: ["pydantic", "marshmallow", "attrs"],
  },
  {
    id: "py-html",
    need: "parses html pages",
    stack: "python",
    expect: ["beautifulsoup4", "lxml", "selectolax", "parsel"],
  },
  {
    id: "py-excel",
    need: "reads and writes excel spreadsheets",
    stack: "python",
    expect: ["openpyxl", "xlsxwriter", "pandas"],
  },
  {
    id: "py-pdf",
    need: "generates pdf documents",
    stack: "python",
    expect: ["reportlab", "fpdf2", "weasyprint"],
  },
  { id: "py-images", need: "resizes images", stack: "python", expect: ["pillow"] },
  {
    id: "py-passwords",
    need: "hashes passwords",
    stack: "python",
    expect: ["bcrypt", "argon2-cffi", "passlib"],
  },
  {
    id: "py-dates",
    need: "parses and formats dates",
    stack: "python",
    expect: ["python-dateutil", "arrow", "pendulum"],
  },
  {
    id: "py-retry",
    need: "retries failed operations with backoff",
    stack: "python",
    expect: ["tenacity", "backoff"],
  },
  {
    id: "py-colour",
    need: "colours terminal output",
    stack: "python",
    expect: ["rich", "colorama", "termcolor"],
  },
  {
    id: "py-jwt",
    need: "signs and verifies json web tokens",
    stack: "python",
    expect: ["pyjwt", "python-jose", "authlib"],
  },
  // None: the language covers it, so the right answer is no package. The
  // survey decides these from its built-in words, without a query.
  { id: "none-calculator", need: "a calculator", stack: "typescript", expect: "none" },
  { id: "none-add", need: "adds two numbers", stack: "typescript", expect: "none" },
  { id: "none-reverse", need: "reverses a string", stack: "typescript", expect: "none" },
  { id: "none-count-words", need: "counts words in a sentence", stack: "python", expect: "none" },
  { id: "none-prime", need: "checks whether a number is prime", stack: "python", expect: "none" },
  // None, searched: the project's own rules, which no package implements.
  // These send a real query and must come back silent through the relevance,
  // popularity and licence filters (the live survey recommended an Amazon
  // scraper for "handles refunds", domain08 §1).
  { id: "none-greet", need: "greets the user by name", stack: "typescript", expect: "none" },
  {
    id: "none-refund",
    need: "works out the refund owed on a returned order",
    stack: "typescript",
    expect: "none",
  },
  {
    id: "none-loyalty",
    need: "tracks stamps on a bakery loyalty card",
    stack: "typescript",
    expect: "none",
  },
  {
    id: "none-volunteers",
    need: "assigns volunteers to shifts at the community garden",
    stack: "python",
    expect: "none",
  },
  {
    id: "none-houseplants",
    need: "records which houseplants were watered this week",
    stack: "python",
    expect: "none",
  },
];

/** A package name compared as PyPI does (PEP 503), which is also right for npm. */
export const normalisedPackage = (name: string): string =>
  name.toLowerCase().replace(/[-_.]+/g, "-");

/** The set's identity: its needs and labels, so a run is compared only on the same set. */
export function reuseSetHash(set: readonly LabelledNeed[]): string {
  const canonical = set.map((n) => [
    n.id,
    n.need,
    n.stack,
    n.expect === "none" ? "none" : [...n.expect].map(normalisedPackage).sort(),
  ]);
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}
