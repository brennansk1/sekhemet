// A small anchored picker (PM_DESIGN §3.2–3.3): single or multi select, number
// keys, type to filter, an optional "create" row, and a one-field prompt.
// Shared by filter chips, inline field edits, bulk edits and saved views.
import { esc } from "./dom.js";
import { placeUnder, pushOverlay } from "./overlay.js";

let current = null;

export function closePicker() {
  current?.close();
}

/**
 * options: [{ value, label, html?, detail?, checked? }]
 * multi: checkable list; onChange(values[]) runs on every toggle.
 * single: onPick(value) runs once and closes.
 * create: (text) => void, shows `Create “text”` when nothing matches exactly.
 */
export function openPicker(
  anchor,
  {
    heading = "",
    options = [],
    multi = false,
    onPick,
    onChange,
    create,
    footer = "",
    search,
    wide = false,
  } = {},
) {
  closePicker();
  const node = document.createElement("div");
  node.className = `menu picker-menu${wide ? " wide" : ""}`;
  node.setAttribute("role", "dialog");
  node.setAttribute("aria-label", heading || "Choose");
  const showSearch = search ?? (options.length > 8 || Boolean(create));
  node.innerHTML = `${heading ? `<div class="mh">${esc(heading)}</div>` : ""}${showSearch ? '<input class="pk-q" type="text" aria-label="Filter options" placeholder="Filter…">' : ""}<div class="pk-list" role="listbox" ${multi ? 'aria-multiselectable="true"' : ""}></div>${footer ? `<div class="pk-foot">${esc(footer)}</div>` : ""}`;
  document.getElementById("overlay-root").append(node);
  const list = node.querySelector(".pk-list");
  const q = node.querySelector(".pk-q");
  const checked = new Set(options.filter((o) => o.checked).map((o) => o.value));
  let items = [];
  let active = 0;

  function visible() {
    const text = (q?.value ?? "").trim().toLowerCase();
    const out = options.filter((o) => !text || o.label.toLowerCase().includes(text));
    if (create && text && !options.some((o) => o.label.toLowerCase() === text)) {
      out.push({ value: "__create__", label: `Create “${q.value.trim()}”`, create: true });
    }
    return out;
  }

  function render() {
    items = visible();
    active = Math.min(active, Math.max(0, items.length - 1));
    list.innerHTML =
      items
        .map((o, i) => {
          const on = checked.has(o.value);
          const num = i < 9 ? `<kbd>${i + 1}</kbd>` : "";
          const box =
            multi && !o.create
              ? `<span class="cbx${on ? " on" : ""}" aria-hidden="true"></span>`
              : "";
          return `<button type="button" role="option" data-i="${i}" aria-selected="${multi ? on : i === active}" class="${i === active ? "act" : ""}${!multi && o.checked ? " cur" : ""}">${box}${o.html ?? ""}<span class="pl">${esc(o.label)}${o.detail ? `<small class="${o.plain ? "" : "mono"}">${esc(o.detail)}</small>` : ""}</span>${num}</button>`;
        })
        .join("") || '<div class="pk-none">No match</div>';
  }

  function choose(i) {
    const o = items[i];
    if (!o) return;
    if (o.create) {
      const text = q.value.trim();
      close();
      create(text);
      return;
    }
    if (multi) {
      if (checked.has(o.value)) checked.delete(o.value);
      else checked.add(o.value);
      active = i;
      render();
      onChange?.([...checked]);
      return;
    }
    close();
    onPick?.(o.value);
  }

  function close() {
    if (!current || current.node !== node) return;
    current = null;
    remove();
    node.remove();
    document.removeEventListener("pointerdown", outside, true);
    anchor?.focus?.({ preventScroll: true });
  }

  function outside(e) {
    if (!node.contains(e.target)) close();
  }

  const remove = pushOverlay({
    kind: "menu",
    modal: true,
    close,
    onKey: (e) => {
      if (e.key === "Escape") return false;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        active =
          (active + (e.key === "ArrowDown" ? 1 : -1) + items.length) % Math.max(1, items.length);
        render();
        list.querySelector(".act")?.scrollIntoView({ block: "nearest" });
        e.preventDefault();
        return true;
      }
      if (e.key === "Enter") {
        if (multi && !items[active]?.create && (e.metaKey || e.ctrlKey || !items.length)) {
          close();
          return true;
        }
        choose(active);
        e.preventDefault();
        return true;
      }
      if (e.key === " " && e.target !== q) {
        choose(active);
        e.preventDefault();
        return true;
      }
      if (/^[1-9]$/.test(e.key) && e.target !== q) {
        choose(Number(e.key) - 1);
        e.preventDefault();
        return true;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        return true;
      }
      // Everything else types into the filter box, or is swallowed.
      if (q && e.target !== q && e.key.length === 1 && !e.metaKey && !e.ctrlKey) {
        q.focus();
        return false;
      }
      return e.target !== q;
    },
  });
  current = { node, close };
  list.addEventListener("click", (e) => {
    const b = e.target instanceof Element ? e.target.closest("[data-i]") : null;
    if (b) choose(Number(b.dataset.i));
  });
  q?.addEventListener("input", () => {
    active = 0;
    render();
  });
  render();
  placeUnder(node, anchor, { align: "left" });
  (q ?? list.querySelector("button"))?.focus();
  setTimeout(() => document.addEventListener("pointerdown", outside, true), 0);
  return close;
}

/** A one-field prompt anchored to a button: `Save view as…`. */
export function openPrompt(
  anchor,
  { heading, placeholder = "", value = "", submit = "Save", onSubmit },
) {
  closePicker();
  const node = document.createElement("form");
  node.className = "menu picker-menu prompt";
  node.innerHTML = `<div class="mh">${esc(heading)}</div><input class="pk-q" type="text" value="${esc(value)}" placeholder="${esc(placeholder)}" aria-label="${esc(heading)}"><div class="pk-row"><button class="btn sm primary" type="submit">${esc(submit)}</button></div>`;
  document.getElementById("overlay-root").append(node);
  const input = node.querySelector("input");
  function close() {
    if (!current || current.node !== node) return;
    current = null;
    remove();
    node.remove();
    document.removeEventListener("pointerdown", outside, true);
    anchor?.focus?.({ preventScroll: true });
  }
  function outside(e) {
    if (!node.contains(e.target)) close();
  }
  const remove = pushOverlay({
    kind: "menu",
    modal: true,
    close,
    onKey: (e) => e.key !== "Escape" && e.key !== "Enter" && e.target !== input,
  });
  current = { node, close };
  node.addEventListener("submit", (e) => {
    e.preventDefault();
    const v = input.value.trim();
    if (!v) return input.focus();
    close();
    onSubmit(v);
  });
  placeUnder(node, anchor, { align: "right" });
  input.focus();
  input.select();
  setTimeout(() => document.addEventListener("pointerdown", outside, true), 0);
  return close;
}
