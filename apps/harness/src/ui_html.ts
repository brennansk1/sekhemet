import { generateTokenCss, icon } from "@sekhemet/ui";

/** Stylesheets under `/app/`, in cascade order. */
const STYLES = ["base.css", "shell.css", "board.css", "review.css", "diff.css", "views.css"];

/**
 * The dashboard shell: landmarks, the sidebar frame and a skeleton of the
 * board, plus the module entry point. Everything else is static, build-free ES
 * modules served from `packages/ui/web` (FRONTEND_DESIGN Part 4, Phase 0).
 *
 * Local-first and air-gapped: no framework, no CDN, no inline script. Colours
 * arrive only as token custom properties, inlined here so the first paint is
 * already themed.
 */
export function generateDashboardHtml(): string {
  const skeletonColumns = [3, 1, 2, 1, 1]
    .map(
      (tiles) =>
        `<div class="sk-col">${'<div class="sk sk-h"></div>'}${'<div class="sk sk-tile"></div>'.repeat(tiles)}</div>`,
    )
    .join("");

  return `<!DOCTYPE html>
<html lang="en" data-theme="basalt">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Sekhemet</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>
${generateTokenCss()}
</style>
${STYLES.map((s) => `<link rel="stylesheet" href="/app/${s}">`).join("\n")}
<script src="/app/boot.js"></script>
<script type="module" src="/app/app.js"></script>
</head>
<body>
<a class="skip" href="#view">Skip to content</a>
<nav class="side" id="side" aria-label="Primary">
  <div class="brand">${icon("glyph", 18)}<b class="lbl">Sekhemet</b></div>
</nav>
<main class="main" id="main">
  <header class="top" id="top"><h1 id="view-title">Loading</h1></header>
  <div id="bar" class="bar-slot"></div>
  <div class="view" id="view" tabindex="-1">
    <div class="skeleton" aria-busy="true" aria-label="Loading the board">${skeletonColumns}</div>
    <p class="sk-note" id="sk-note" hidden>Connecting to Sekhemet…</p>
  </div>
</main>
<div id="overlay-root"></div>
<div class="toasts" id="toasts" aria-live="polite"></div>
<div class="sr-only" id="live" aria-live="polite" aria-atomic="true"></div>
<noscript><p class="noscript">The Sekhemet dashboard needs JavaScript. The same data is available from <code>sekhemet board</code>.</p></noscript>
</body>
</html>`;
}
