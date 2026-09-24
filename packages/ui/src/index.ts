import { fileURLToPath } from "node:url";

export * from "./tokens.js";
export * from "./types.js";
export * from "./vocabulary.js";
export * from "./icons.js";
export * from "./pm.js";

/**
 * The dashboard's static ES modules and stylesheets (`packages/ui/web`).
 * Resolved from this file so it holds from `src/` and from `dist/` alike.
 */
export const UI_WEB_DIR = fileURLToPath(new URL("../web/", import.meta.url));

/**
 * Compiled pure modules the browser imports as-is (`vocabulary.js`, `icons.js`, `pm.js`),
 * so a label is computed by the same code on the server and in the page.
 */
export const UI_LIB_DIR = fileURLToPath(new URL("./", import.meta.url));
export const UI_LIB_MODULES = ["vocabulary.js", "icons.js", "pm.js"] as const;
