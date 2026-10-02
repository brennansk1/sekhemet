import { fileURLToPath } from "node:url";

export * from "./tokens.js";
export * from "./types.js";
export * from "./vocabulary.js";
export * from "./icons.js";
export * from "./pm.js";
export * from "./nav.js";
export * from "./account.js";
export * from "./columns.js";
export * from "./tiles.js";
export * from "./storymap.js";
export * from "./burnup.js";
export * from "./create.js";
export * from "./reach.js";
export * from "./live.js";
export * from "./issue.js";
export * from "./review_desk.js";
export * from "./status.js";
export * from "./projects.js";
export * from "./seshat.js";
export * from "./learn.js";
export * from "./strip.js";
export * from "./settings.js";
export * from "./integrations_view.js";
export * from "./machine_tier.js";
export * from "./playbook.js";
export * from "./teammates.js";
export * from "./inbox.js";
export * from "./team_admin.js";
export * from "./switcher.js";
export * from "./readiness.js";
export * from "./start.js";

/**
 * The dashboard's static ES modules and stylesheets (`packages/ui/web`).
 * Resolved from this file so it holds from `src/` and from `dist/` alike.
 */
export const UI_WEB_DIR = fileURLToPath(new URL("../web/", import.meta.url));

/**
 * Compiled pure modules the browser imports as-is (`vocabulary.js`, `icons.js`, `pm.js`, `nav.js`, `account.js`, `columns.js`, `tiles.js`, `storymap.js`, `burnup.js`, `create.js`, `reach.js`, `live.js`, `issue.js`, `review_desk.js`, `status.js`, `projects.js`, `seshat.js`, `learn.js`, `strip.js`, `settings.js`, `integrations_view.js`, `machine_tier.js`, `teammates.js`, `inbox.js`, `team_admin.js`, `switcher.js`, `readiness.js`, `start.js`),
 * so a label is computed by the same code on the server and in the page.
 */
export const UI_LIB_DIR = fileURLToPath(new URL("./", import.meta.url));
export const UI_LIB_MODULES = [
  "vocabulary.js",
  "icons.js",
  "pm.js",
  "nav.js",
  "account.js",
  "columns.js",
  "tiles.js",
  "storymap.js",
  "burnup.js",
  "create.js",
  "reach.js",
  "live.js",
  "issue.js",
  "review_desk.js",
  "status.js",
  "projects.js",
  "seshat.js",
  "learn.js",
  "strip.js",
  "settings.js",
  "integrations_view.js",
  "machine_tier.js",
  "playbook.js",
  "teammates.js",
  "inbox.js",
  "team_admin.js",
  "switcher.js",
  "readiness.js",
  "start.js",
] as const;
