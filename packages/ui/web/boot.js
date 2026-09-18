// Applies the saved theme before first paint. A classic, blocking script on
// purpose: modules run after the first frame, which would flash Basalt at a
// Sand user. Everything else lives in ES modules.
(() => {
  try {
    const saved = localStorage.getItem("sekhemet-theme");
    const light = window.matchMedia?.("(prefers-color-scheme: light)").matches;
    const theme = saved === "sand" || saved === "basalt" ? saved : light ? "sand" : "basalt";
    document.documentElement.dataset.theme = theme;
  } catch {
    // Private mode: stay on the default.
  }
})();
