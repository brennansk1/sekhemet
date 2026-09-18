// Toasts (FRONTEND_DESIGN §2.5.11): bottom-left, at most three, errors stay.
import { esc, icon } from "./dom.js";

const MAX = 3;
const ICONS = {
  pass: "check",
  fail: "alert",
  parked: "pause",
  info: "check",
  merge: "merge",
  undo: "undo",
};

/**
 * Show a toast. Returns a handle with `update()` and `close()`.
 * `tone`: info | pass | fail | parked. `action`: { label, kbd?, run }.
 */
export function toast({
  text,
  detail = "",
  tone = "info",
  iconName,
  action,
  sticky,
  duration = 4000,
}) {
  const root = document.getElementById("toasts");
  const node = document.createElement("div");
  let timer = 0;
  let remaining = duration;
  let started = 0;

  const close = () => {
    clearTimeout(timer);
    node.remove();
  };
  const arm = () => {
    if (sticky || tone === "fail") return;
    started = Date.now();
    timer = setTimeout(close, remaining);
  };
  const render = (opts) => {
    const t = opts.tone ?? tone;
    node.className = `toast ${t}`;
    node.setAttribute("role", t === "fail" ? "alert" : "status");
    const act = opts.action
      ? `<button class="act" type="button" data-act>${esc(opts.action.label)}${opts.action.kbd ? ` <kbd>${esc(opts.action.kbd)}</kbd>` : ""}</button>`
      : "";
    const dismiss =
      t === "fail" || opts.sticky
        ? `<button class="act" type="button" data-close aria-label="Dismiss">${icon("x", 14, "ic s14")}</button>`
        : "";
    node.innerHTML = `${icon(opts.iconName ?? ICONS[t] ?? "check")}<span class="msg">${esc(opts.text)}${opts.detail ? `<small>${esc(opts.detail)}</small>` : ""}</span>${act}${dismiss}`;
    node.querySelector("[data-act]")?.addEventListener("click", () => opts.action.run());
    node.querySelector("[data-close]")?.addEventListener("click", close);
  };

  render({ text, detail, tone, iconName, action, sticky });
  node.addEventListener("mouseenter", () => {
    if (!timer) return;
    clearTimeout(timer);
    timer = 0;
    remaining -= Date.now() - started;
  });
  node.addEventListener("mouseleave", () => {
    if (!timer && remaining > 0 && !sticky && tone !== "fail") arm();
  });
  root.prepend(node);
  while (root.children.length > MAX) root.lastElementChild.remove();
  arm();

  return {
    close,
    update(opts) {
      clearTimeout(timer);
      timer = 0;
      tone = opts.tone ?? tone;
      sticky = opts.sticky ?? false;
      remaining = opts.duration ?? 4000;
      render({ text, detail: "", iconName: undefined, action: undefined, ...opts, tone, sticky });
      arm();
    },
  };
}
