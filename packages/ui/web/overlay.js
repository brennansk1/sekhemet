// The Esc stack: drawers, popovers and dialogs register here, and Esc closes
// the topmost one. Modal overlays also receive every key first.
const stack = [];

/**
 * Register an overlay. `onKey(e)` returns true when it handled the key.
 * Returns a function that removes the overlay without calling `close`.
 */
export function pushOverlay(overlay) {
  stack.push(overlay);
  return () => {
    const i = stack.indexOf(overlay);
    if (i >= 0) stack.splice(i, 1);
  };
}

export function topOverlay() {
  return stack[stack.length - 1];
}

export function hasOverlay(kind) {
  return stack.some((o) => o.kind === kind);
}

export function closeTop() {
  const top = stack.pop();
  top?.close?.();
  return Boolean(top);
}

/** Keep Tab inside a modal dialog (§3.9). */
export function trapFocus(root, e) {
  if (e.key !== "Tab") return false;
  const items = Array.from(
    root.querySelectorAll(
      'button:not([disabled]), [href], input:not([disabled]), textarea, select, [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((n) => n.offsetParent !== null);
  if (items.length === 0) return false;
  const first = items[0];
  const last = items[items.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    last.focus();
    e.preventDefault();
    return true;
  }
  if (!e.shiftKey && document.activeElement === last) {
    first.focus();
    e.preventDefault();
    return true;
  }
  return false;
}

/** Position a floating element under an anchor, kept inside the viewport. */
export function placeUnder(node, anchor, { align = "left", gap = 4 } = {}) {
  const r = anchor.getBoundingClientRect();
  const w = node.offsetWidth;
  const h = node.offsetHeight;
  let left = align === "right" ? r.right - w : r.left;
  left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
  let top = r.bottom + gap;
  if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - gap);
  node.style.left = `${left}px`;
  node.style.top = `${top}px`;
}

/** A small menu anchored to a button. `items` are { label, checked, run } or "-" separators. */
export function openMenu(anchor, items, { heading } = {}) {
  closeMenus();
  const menu = document.createElement("div");
  menu.className = "menu";
  menu.setAttribute("role", "menu");
  menu.dataset.menu = "";
  if (heading) {
    const h = document.createElement("div");
    h.className = "mh";
    h.textContent = heading;
    menu.append(h);
  }
  for (const item of items) {
    if (item === "-") {
      menu.append(document.createElement("hr"));
      continue;
    }
    const b = document.createElement("button");
    b.type = "button";
    b.setAttribute("role", item.checked === undefined ? "menuitem" : "menuitemradio");
    if (item.checked !== undefined) b.setAttribute("aria-checked", String(Boolean(item.checked)));
    b.textContent = item.label;
    b.addEventListener("click", () => {
      close();
      item.run();
    });
    menu.append(b);
  }
  document.getElementById("overlay-root").append(menu);
  placeUnder(menu, anchor, { align: "right" });
  const buttons = Array.from(menu.querySelectorAll("button"));
  buttons[0]?.focus();
  const remove = pushOverlay({
    kind: "menu",
    modal: true,
    close: () => {
      menu.remove();
      anchor.focus?.();
    },
    onKey: (e) => {
      const i = buttons.indexOf(document.activeElement);
      if (e.key === "ArrowDown" || e.key === "j") {
        buttons[(i + 1) % buttons.length]?.focus();
        e.preventDefault();
        return true;
      }
      if (e.key === "ArrowUp" || e.key === "k") {
        buttons[(i - 1 + buttons.length) % buttons.length]?.focus();
        e.preventDefault();
        return true;
      }
      return e.key !== "Escape" && e.key !== "Enter" && e.key !== " " && e.key !== "Tab";
    },
  });
  function close() {
    remove();
    menu.remove();
    document.removeEventListener("pointerdown", outside, true);
  }
  function outside(e) {
    if (!menu.contains(e.target)) close();
  }
  setTimeout(() => document.addEventListener("pointerdown", outside, true), 0);
  return close;
}

export function closeMenus() {
  while (topOverlay()?.kind === "menu") closeTop();
}
