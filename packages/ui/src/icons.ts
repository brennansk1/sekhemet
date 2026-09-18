/**
 * The icon set (FRONTEND_DESIGN §3.4): one weight, 1.5px stroke, 24 viewBox,
 * round caps and joins, `currentColor`. No filled icons except `dot`, no
 * duotone, no emoji, and no Unicode check marks anywhere in the product.
 *
 * The body of each icon is SVG child markup. `icon()` wraps it; the browser
 * imports this compiled module directly, so it carries no runtime imports.
 */
export const ICONS = {
  /** Brand: a pylon gate with a sun disc (§3.8). */
  glyph:
    '<path d="M3 20 5.5 9H10v11M21 20 18.5 9H14v11M2 20h20"/><circle cx="12" cy="5.5" r="2.25"/>',
  review:
    '<path d="M4 13 6.5 6h11L20 13v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z"/><path d="M4 13h4.5l1 2h5l1-2H20"/><path d="m9.5 9.5 1.8 1.8 3.4-3.6"/>',
  board: '<path d="M4.5 4.5h4v15h-4zM10 4.5h4v9h-4zM15.5 4.5h4v12h-4z"/>',
  runs: '<path d="M8 5l9 6-9 6z"/><path d="M4 20h16"/>',
  inbox:
    '<path d="M4 13 6.5 6h11L20 13v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z"/><path d="M4 13h4.5l1 2h5l1-2H20"/><path d="M12 3v7M9.5 7.5 12 10l2.5-2.5"/>',
  ledger:
    '<path d="M4 6h11M4 12h11M4 18h7"/><circle cx="18.5" cy="17" r="2.5"/><path d="M18.5 8v6.5"/>',
  playbook:
    '<path d="M3 5.5c2-1 5-1 9 1 4-2 7-2 9-1V19c-2-1-5-1-9 1-4-2-7-2-9-1z"/><path d="M12 6.5V20"/>',
  machine:
    '<path d="M7 7h10v10H7zM10 10h4v4h-4zM9 3v4M15 3v4M9 17v4M15 17v4M3 9h4M3 15h4M17 9h4M17 15h4"/>',
  settings:
    '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  minus: '<path d="M6 12h12"/>',
  ring: '<path d="M12 3a9 9 0 1 1-9 9"/>',
  dot: '<circle cx="12" cy="12" r="6" fill="currentColor" stroke="none"/>',
  pause: '<path d="M9 6v12M15 6v12"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  lock: '<rect x="5.5" y="11" width="13" height="9" rx="1.5"/><path d="M8.5 11V8a3.5 3.5 0 0 1 7 0v3"/>',
  alert: '<path d="M12 4 2.5 20h19z"/><path d="M12 10v4M12 17h.01"/>',
  merge:
    '<circle cx="6" cy="6" r="2"/><circle cx="6" cy="18" r="2"/><circle cx="18" cy="12" r="2"/><path d="M6 8v8M6 8c0 3 3 4 10 4"/>',
  "send-back": '<path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>',
  park: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M10 9v6M14 9v6"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  file: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/>',
  "file-diff": '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M12 10v5M9.5 12.5h5M9.5 17.5h5"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="1.5"/><path d="M16 8V5.5A1.5 1.5 0 0 0 14.5 4h-9A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16H8"/>',
  "chevron-right": '<path d="m9 6 6 6-6 6"/>',
  "chevron-down": '<path d="m6 9 6 6 6-6"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>',
  keyboard: '<path d="M3 7h18v10H3zM7 11h.01M11 11h.01M15 11h.01M7 14h10"/>',
  memory: '<path d="M3 8h18v8H3zM7 8v8M11 8v8M15 8v8M6 16v3M18 16v3"/>',
  pencil: '<path d="M4 20l4-1 11-11-3-3L5 16z"/>',
  undo: '<path d="M8 5 4 9l4 4"/><path d="M4 9h11a5 5 0 0 1 0 10H9"/>',
  external:
    '<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  more: '<path d="M6 12h.01M12 12h.01M18 12h.01"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  "check-circle": '<circle cx="12" cy="12" r="8.5"/><path d="m8.5 12.5 2.5 2.5 4.5-5"/>',
  "arrow-down": '<path d="M12 5v14M6 13l6 6 6-6"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 5v6h-6"/>',
  // Priority (PM_DESIGN §3.1): bars read as bars through a CSS stroke on
  // `.prio`; unlit bars carry class `off`, coloured by the stylesheet.
  "priority-none": '<path d="M5 12h3M10.5 12h3M16 12h3"/>',
  "priority-low": '<path d="M6 19v-5"/><path class="off" d="M12 19v-9M18 19V6"/>',
  "priority-medium": '<path d="M6 19v-5M12 19v-9"/><path class="off" d="M18 19V6"/>',
  "priority-high": '<path d="M6 19v-5M12 19v-9M18 19V6"/>',
  "priority-urgent":
    '<rect x="3.5" y="3.5" width="17" height="17" rx="3.5"/><path d="M12 7.5v5.5M12 16.5h.01"/>',
  chat: '<path d="M4 5.5h16v10.5H10l-6 4z"/><path d="M8 9.5h8M8 12.5h5"/>',
  insights: '<path d="M4 4v16h16"/><path d="m7.5 15 4-5 3 3 5-6"/>',
  plug: '<path d="M9 3v4M15 3v4M6 7h12v3a6 6 0 0 1-12 0zM12 16v5"/>',
  split: '<path d="M4 12h6l4-6h6M10 12l4 6h6"/><path d="m18 4 2 2-2 2M18 16l2 2-2 2"/>',
  "arrow-right": '<path d="M5 12h14M13 6l6 6-6 6"/>',
  list: '<path d="M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01"/>',
  filter: '<path d="M4 5h16l-6 7.5V19l-4-2v-4.5z"/>',
  cycle: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5a4.5 4.5 0 0 1 4.5 4.5H12z"/>',
  layers: '<path d="m12 4 8 4-8 4-8-4z"/><path d="m4 12 8 4 8-4M4 16l8 4 8-4"/>',
  send: '<path d="M4 12 20 4l-5 16-3-7z"/><path d="m12 13 8-9"/>',
  expand: '<path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7"/>',
  tag: '<path d="M4 4h7l9 9-7 7-9-9z"/><path d="M8 8h.01"/>',
  calendar:
    '<rect x="4" y="5.5" width="16" height="14" rx="1.5"/><path d="M4 10h16M8 3.5v4M16 3.5v4"/>',
  user: '<circle cx="12" cy="8.5" r="3.5"/><path d="M5 20a7 7 0 0 1 14 0"/>',
  download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
  upload: '<path d="M12 15V4M7 9l5-5 5 5M5 20h14"/>',
} as const;

export type IconName = keyof typeof ICONS;

/** An inline SVG string for `name`, sized in CSS pixels, decorative by default. */
export function icon(name: IconName, size = 16, className = "ic"): string {
  const body = ICONS[name] ?? "";
  return `<svg class="${className}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;
}
