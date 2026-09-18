/**
 * Sekhemet design tokens — the single source of truth for the UI.
 *
 * The design's rule is that components never hard-code a color. Everything here
 * is emitted as CSS custom properties and as JSON, so the dashboard, any plugin
 * panel, and future native surfaces all resolve the same values. Depth is built
 * from a surface ladder (base -> surface -> raised -> overlay) and 1px hairlines
 * rather than drop shadows, which is what keeps a dense board legible.
 */

export type ThemeName = "basalt" | "sand";

/** The fifteen semantic color roles, identical in shape across themes. */
export interface ColorTokens {
  bgBase: string;
  bgSurface: string;
  bgRaised: string;
  bgOverlay: string;
  borderSubtle: string;
  borderStrong: string;
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  accent: string;
  statePass: string;
  stateFail: string;
  stateRunning: string;
  stateParked: string;
  stateBlocked: string;
}

/** Dark theme. Warm near-black ground with Egyptian Gold as the only CTA colour. */
export const BASALT: ColorTokens = {
  bgBase: "#14120F",
  bgSurface: "#1C1A16",
  bgRaised: "#24211C",
  bgOverlay: "#2C2822",
  borderSubtle: "#2E2A24",
  borderStrong: "#3D382F",
  textPrimary: "#EDE7DA",
  textSecondary: "#A79E8C",
  textMuted: "#6E6759",
  accent: "#C8952A",
  statePass: "#4FA36B",
  // Red Ochre, lifted from the doc's #C9503F: that value measures 4.19:1 on
  // this ground, below the AA bar the same spec claims it clears.
  stateFail: "#CC5A4A",
  stateRunning: "#4C8ED9",
  stateParked: "#B08A3E",
  stateBlocked: "#8A7F70",
};

/** Light theme. Same roles, re-tuned so contrast ratios hold on a warm paper ground. */
export const SAND: ColorTokens = {
  bgBase: "#F6F3EC",
  bgSurface: "#FFFFFF",
  bgRaised: "#EDE8DD",
  bgOverlay: "#E2DDD0",
  borderSubtle: "#DED8CA",
  borderStrong: "#C6BEAC",
  textPrimary: "#1C1A16",
  textSecondary: "#5E5749",
  textMuted: "#8F8778",
  // Darkened from #9A6E14 (4.11:1) to clear AA on the Sand ground.
  accent: "#8E6512",
  statePass: "#2E7D4A",
  stateFail: "#A63A2B",
  stateRunning: "#2F6FB5",
  stateParked: "#8C6A22",
  // Darkened from #7A7062 (4.39:1) for the same reason.
  stateBlocked: "#756C5E",
};

export const THEMES: Record<ThemeName, ColorTokens> = { basalt: BASALT, sand: SAND };

export const TYPOGRAPHY = {
  fontSans: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  fontMono: "'JetBrains Mono', 'SF Mono', Menlo, Consolas, monospace",
  textXs: "11px",
  textSm: "12.5px",
  textBase: "13px",
  textMd: "15px",
  textLg: "18px",
  textXl: "22px",
  leadingTight: "1.25",
  leadingNormal: "1.45",
  leadingCode: "1.55",
} as const;

/** 2/4/8/12/16/24/32 — no intermediate values, so rhythm stays predictable. */
export const SPACING = ["2px", "4px", "8px", "12px", "16px", "24px", "32px"] as const;

export const RADIUS = {
  /** Form controls and chips. */
  control: "4px",
  /** Card tiles and dialogs. */
  card: "6px",
  /** Full-bleed panel viewports are square by design. */
  panel: "0px",
} as const;

/**
 * 120ms ease-out for interactive state changes only.
 *
 * Layout shifts and streaming text append with zero animation: a board that
 * reflows while you are reading it is harder to use, not livelier.
 */
export const MOTION = {
  duration: "120ms",
  easing: "ease-out",
  transition: "120ms ease-out",
} as const;

/** camelCase token name -> `--kebab-case` custom property. */
function cssVarName(key: string): string {
  return `--${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
}

/** Emit one theme's color roles as CSS custom property declarations. */
export function themeVars(colors: ColorTokens, indent = "  "): string {
  return (Object.entries(colors) as [keyof ColorTokens, string][])
    .map(([key, value]) => `${indent}${cssVarName(key)}: ${value};`)
    .join("\n");
}

/**
 * The complete stylesheet root: both themes, typography, spacing, radius, motion.
 *
 * Dark is the default and light is applied via `[data-theme="sand"]`, so a theme
 * switch is one attribute change with no restyling of individual components.
 */
export function generateTokenCss(): string {
  const spacingVars = SPACING.map((v, i) => `  --space-${i}: ${v};`).join("\n");

  return `:root {
${themeVars(BASALT)}

  --font-sans: ${TYPOGRAPHY.fontSans};
  --font-mono: ${TYPOGRAPHY.fontMono};

  --text-xs: ${TYPOGRAPHY.textXs};
  --text-sm: ${TYPOGRAPHY.textSm};
  --text-base: ${TYPOGRAPHY.textBase};
  --text-md: ${TYPOGRAPHY.textMd};
  --text-lg: ${TYPOGRAPHY.textLg};
  --text-xl: ${TYPOGRAPHY.textXl};

  --leading-tight: ${TYPOGRAPHY.leadingTight};
  --leading-normal: ${TYPOGRAPHY.leadingNormal};
  --leading-code: ${TYPOGRAPHY.leadingCode};

${spacingVars}

  --radius-control: ${RADIUS.control};
  --radius-card: ${RADIUS.card};
  --radius-panel: ${RADIUS.panel};

  --motion: ${MOTION.transition};

  color-scheme: dark;
}

[data-theme="sand"] {
${themeVars(SAND)}
  color-scheme: light;
}`;
}

/** The token file consumed by plugin panels and any non-web surface. */
export function generateTokenJson(): string {
  return JSON.stringify(
    {
      themes: { basalt: BASALT, sand: SAND },
      typography: TYPOGRAPHY,
      spacing: SPACING,
      radius: RADIUS,
      motion: MOTION,
    },
    null,
    2,
  );
}

/**
 * Relative luminance per WCAG 2.1.
 *
 * Present so contrast can be asserted in tests rather than asserted in prose:
 * a palette that claims AA should be able to prove it.
 */
export function relativeLuminance(hex: string): number {
  const value = hex.replace("#", "");
  const channel = (start: number): number => {
    const srgb = Number.parseInt(value.slice(start, start + 2), 16) / 255;
    return srgb <= 0.03928 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
}

/** WCAG contrast ratio between two hex colors, from 1:1 to 21:1. */
export function contrastRatio(foreground: string, background: string): number {
  const a = relativeLuminance(foreground);
  const b = relativeLuminance(background);
  const [light, dark] = a > b ? [a, b] : [b, a];
  return ((light as number) + 0.05) / ((dark as number) + 0.05);
}

/**
 * Legacy alias retained so existing callers keep working.
 *
 * @deprecated Use {@link BASALT} and the `--bg-*` custom properties instead.
 */
export const BASALT_THEME = {
  surfaceBackground: BASALT.bgBase,
  surfaceRaised: BASALT.bgSurface,
  surfaceOverlay: BASALT.bgRaised,
  borderSubtle: BASALT.borderSubtle,
  textPrimary: BASALT.textPrimary,
  textMuted: BASALT.textMuted,
  accentGreen: BASALT.statePass,
  accentRed: BASALT.stateFail,
  accentAmber: BASALT.stateParked,
};
