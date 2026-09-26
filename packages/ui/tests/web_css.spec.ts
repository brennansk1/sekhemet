import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The served stylesheets, read as the page loads them, and checked rule by
// rule for the colour roles and layout of dashboard P11 and P12.
const WEB = join(import.meta.dirname, "..", "web");

interface Rule {
  file: string;
  media: string;
  selector: string;
  decls: Map<string, string>;
}

/** A small reader for the flat CSS these files use: rules, optionally inside one @media. */
function readRules(): Rule[] {
  const out: Rule[] = [];
  for (const file of readdirSync(WEB).filter((f) => f.endsWith(".css"))) {
    const css = readFileSync(join(WEB, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    let i = 0;
    const walk = (media: string, end: number): void => {
      while (i < end) {
        const open = css.indexOf("{", i);
        if (open < 0 || open >= end) {
          i = end;
          return;
        }
        const head = css.slice(i, open).trim();
        if (head.startsWith("@media") || head.startsWith("@supports")) {
          // Find the matching close brace of the block.
          let depth = 1;
          let j = open + 1;
          while (depth > 0 && j < css.length) {
            if (css[j] === "{") depth++;
            else if (css[j] === "}") depth--;
            j++;
          }
          i = open + 1;
          walk(head, j - 1);
          i = j;
          continue;
        }
        const close = css.indexOf("}", open);
        if (head.startsWith("@")) {
          // @keyframes and the like: skip the whole block.
          let depth = 1;
          let j = open + 1;
          while (depth > 0 && j < css.length) {
            if (css[j] === "{") depth++;
            else if (css[j] === "}") depth--;
            j++;
          }
          i = j;
          continue;
        }
        const decls = new Map<string, string>();
        for (const d of css.slice(open + 1, close).split(";")) {
          const k = d.indexOf(":");
          if (k > 0) decls.set(d.slice(0, k).trim(), d.slice(k + 1).trim());
        }
        out.push({ file, media, selector: head.replace(/\s+/g, " "), decls });
        i = close + 1;
      }
    };
    walk("", css.length);
  }
  return out;
}

const RULES = readRules();

/** Whether a rule's @media applies at a window width (the max-/min-width queries these files use). */
function applies(media: string, width: number): boolean {
  if (!media) return true;
  if (!/^@media\s*\(/.test(media)) return false;
  const max = /max-width:\s*(\d+)px/.exec(media);
  const min = /min-width:\s*(\d+)px/.exec(media);
  if (!max && !min) return false;
  return (!max || width <= Number(max[1])) && (!min || width >= Number(min[1]));
}

/** The value that wins for one exact selector in one file at a width: the last applicable rule. */
function cascaded(file: string, selector: string, prop: string, width: number): string | undefined {
  let value: string | undefined;
  for (const r of RULES)
    if (r.file === file && r.selector === selector && applies(r.media, width) && r.decls.has(prop))
      value = r.decls.get(prop);
  return value;
}
const selectors = (r: Rule) => r.selector.split(",").map((s) => s.trim());
const where = (r: Rule) => `${r.file} ${r.media} ${r.selector}`;

describe("colour roles in the served stylesheets (dashboard P12)", () => {
  it("reads the stylesheets", () => {
    expect(RULES.length).toBeGreaterThan(500);
    expect(RULES.some((r) => r.selector === ".tile:focus-visible, .tile.focus")).toBe(true);
  });

  it("DB-P12-3: a disabled button has a neutral fill, never faded gold", () => {
    const disabled = RULES.filter((r) =>
      selectors(r).some((s) => /\.btn/.test(s) && /\[disabled\]|:disabled|aria-disabled/.test(s)),
    );
    expect(disabled.length).toBeGreaterThan(0);
    const base = disabled.find((r) => r.file === "base.css" && r.decls.has("background"));
    expect(base?.decls.get("background")).toBe("var(--bg-overlay)");
    expect(base?.decls.get("border-color")).toBe("var(--border-subtle)");
    for (const r of disabled) {
      // Opacity fades the fill it sits on: the gold showed through at 2.1:1.
      expect(r.decls.get("opacity") ?? "1", where(r)).toBe("1");
      for (const v of r.decls.values()) expect(v, where(r)).not.toContain("--accent");
    }
    // The base rule outranks the primary (gold) button it overrides.
    const primary = RULES.findIndex((r) => r.file === "base.css" && r.selector === ".btn.primary");
    expect(RULES.indexOf(base as Rule)).toBeGreaterThan(primary);
  });

  it("DB-P12-4: every input is edged with --border-control", () => {
    // The base rule, at zero specificity so a field inside a wrapper can drop it.
    const baseRule = RULES.find((r) => r.file === "base.css" && r.selector.startsWith(":where("));
    expect(baseRule?.selector).toMatch(/input/);
    expect(baseRule?.selector).toMatch(/textarea/);
    expect(baseRule?.selector).toMatch(/select/);
    expect(baseRule?.decls.get("border")).toBe("1px solid var(--border-control)");

    const field = /(^|[\s>+~(])(input|textarea|select)\b|\.pk-q\b/;
    const fields = RULES.filter(
      (r) => r !== baseRule && selectors(r).some((s) => field.test(s) && !/::placeholder/.test(s)),
    );
    // A field whose own edge is removed sits in a wrapper that carries the edge.
    const WRAPPED: Record<string, string> = {
      ".vbar .q input": ".vbar .q",
      ".pm-compose textarea": ".pm-compose .box",
      ".palette-input input": ".palette-input",
    };
    for (const r of fields) {
      for (const [k, v] of r.decls) {
        if (!/^border(-(top|right|bottom|left))?(-color)?$/.test(k)) continue;
        if (v === "0" || v === "none") {
          const wrapper = WRAPPED[r.selector];
          expect(wrapper, `${where(r)} drops its edge without a wrapper`).toBeTruthy();
          const w = RULES.find((x) => x.selector === wrapper);
          const edge = [...(w?.decls ?? new Map()).entries()].find(([kk]) =>
            kk.startsWith("border"),
          );
          expect(edge?.[1], `${wrapper} edge`).toContain("var(--border-control)");
          continue;
        }
        // An invalid field turns red; every other edge is the control role.
        expect(v, where(r)).toMatch(/var\(--border-control\)|var\(--state-fail\)/);
      }
    }
  });

  it("DB-P12-5: no placeholder and no text a person must read uses --text-muted", () => {
    for (const r of RULES.filter((x) => /::placeholder/.test(x.selector))) {
      expect(r.decls.get("color"), where(r)).toBe("var(--text-secondary)");
    }
    // Decorative only: line numbers, disabled controls, decorative glyphs and marks.
    const DECORATIVE = [
      ".ln .o", // diff line numbers, old
      ".ln .n", // and new
      ".ev-empty .ic", // an empty state's icon
      ".dg-n .dot", // a graph node's dot
      ".ws-seg", // a segment of a proportion bar
      ".lane-row .cell .empty", // the dash in an empty cell
      ".ltbl .none", // the dash for no value
    ];
    for (const r of RULES) {
      const uses = [...r.decls.values()].some((v) => v.includes("--text-muted"));
      if (!uses) continue;
      const ok = selectors(r).every(
        (s) => DECORATIVE.includes(s) || /\[disabled\]|:disabled|aria-disabled/.test(s),
      );
      expect(ok, `${where(r)} uses --text-muted`).toBe(true);
    }
  });

  it("DB-P12-7: a focused tile has the global 1 px outline offset, with room in its column", () => {
    const focus = RULES.find((r) => r.selector === ".tile:focus-visible, .tile.focus");
    expect(focus?.decls.get("outline")).toBe("2px solid var(--accent)");
    expect(focus?.decls.get("outline-offset")).toBe("1px");
    // Outline 2 px + offset 1 px = 3 px outside the tile; the column body pads 8 px.
    const list = RULES.find((r) => r.file === "board.css" && r.selector === ".list");
    expect(list?.decls.get("padding")).toBe("8px");
    // No other rule insets a tile's focus ring.
    for (const r of RULES.filter((x) => /\.tile[^,]*:focus/.test(x.selector)))
      expect(r.decls.get("outline-offset") ?? "1px", where(r)).not.toMatch(/^-/);
  });
});

describe("navigation layout in the served stylesheets (dashboard P11)", () => {
  const narrow = RULES.filter((r) => r.media.includes("max-width: 1279px"));
  const phone = RULES.filter((r) => r.media.includes("max-width: 767px"));

  it("DB-P11-2: from 1024 to 1279 px the sidebar is 176 px and keeps every label", () => {
    expect(cascaded("shell.css", ".side", "width", 1100)).toBe("var(--sidebar-w-narrow)");
    expect(cascaded("shell.css", ".side", "width", 1024)).toBe("var(--sidebar-w-narrow)");
    expect(cascaded("shell.css", ".side", "width", 1440)).toBe("var(--sidebar-w)");
    for (const r of narrow.filter((x) => x.decls.get("display") === "none")) {
      for (const s of selectors(r))
        expect(/\.(side|nav)\b.*\.(lbl|sub)\b|^\.nav\b/.test(s), `${where(r)} hides ${s}`).toBe(
          false,
        );
    }
  });

  it("DB-P11-3: below 768 px the sidebar gives way to a bottom bar with 48 px targets", () => {
    // What wins in the cascade, not just what is written: a later base rule
    // once overrode the phone query and the bar never showed.
    expect(cascaded("shell.css", ".tabbar", "display", 400)).toBe("flex");
    expect(cascaded("shell.css", ".side", "display", 400)).toBe("none");
    for (const w of [800, 1100, 1440]) {
      expect(cascaded("shell.css", ".tabbar", "display", w), `${w}`).toBe("none");
      expect(cascaded("shell.css", ".side", "display", w), `${w}`).not.toBe("none");
    }
    expect(cascaded("shell.css", ".tabbar a", "min-height", 400)).toBe("48px");
  });

  it("DB-P11-6: the cheat sheet is 720 px wide and scrolls inside rather than clipping", () => {
    const cheats = RULES.find((r) => r.file === "shell.css" && r.selector === ".cheats");
    expect(cheats?.decls.get("width")).toBe("720px");
    const grid = RULES.find((r) => r.file === "shell.css" && r.selector === ".cheat-grid");
    // A flex child keeps its content height unless allowed to shrink: without
    // this the dialog's `overflow: hidden` cut the last groups off.
    expect(grid?.decls.get("min-height")).toBe("0");
    expect(grid?.decls.get("overflow-y")).toBe("auto");
  });
});

describe("the web modules (dashboard P11, P12)", () => {
  const source = (f: string) => readFileSync(join(WEB, f), "utf8");
  const modules = readdirSync(WEB).filter((f) => f.endsWith(".js"));

  it("DB-P12-3: no disabled control carries its reason only in a hover title", () => {
    for (const f of modules) expect(source(f), f).not.toMatch(/\bdisabled title=/);
  });

  it("DB-P11-4: no bare `t`, and chords come only from the keymap", () => {
    const keys = source("keys.js");
    expect(keys).not.toMatch(/e\.key === "t"/);
    expect(keys).toContain("chordTarget(");
    expect(keys).not.toMatch(/#\/(review|board|runs|workspace|registry)"/);
  });

  it("DB-P11-6: the cheat sheet and the palette read the one keymap", () => {
    expect(source("cheatsheet.js")).toContain("cheatSheet(currentNav())");
    expect(source("cheatsheet.js")).not.toContain("const SECTIONS");
    expect(source("palette.js")).toContain("paletteGoTo(currentNav())");
  });
});
