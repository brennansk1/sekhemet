export interface ThemeTokens {
  bgBase: string;
  bgSurface: string;
  bgRaised: string;
  bgOverlay: string;
  borderSubtle: string;
  textPrimary: string;
  textMuted: string;
  gold: string;
  nile: string;
  ochre: string;
  lapis: string;
}

export type CardStatus = "backlog" | "ready" | "doing" | "review" | "done";
export type CardClass = "feature" | "bug" | "chore" | "spike";
export type GateName = "typecheck" | "lint" | "test" | "bounds" | "visual";
export type GateState = "pass" | "fail" | "pending" | "skipped";

export interface CanvasCard {
  id: string;
  title: string;
  status: CardStatus;
  cardClass: CardClass;
  difficulty: 1 | 2 | 3 | 4 | 5;
  stepsUsed: number;
  stepBudget: number;
  gates: Record<GateName, GateState>;
  dependsOn: string[];
}

export interface DagNode {
  id: string;
  rank: number;
  order: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DagEdge {
  from: string;
  to: string;
  path: string;
}

export const THEME: ThemeTokens = {
  bgBase: "#14120F",
  bgSurface: "#1C1A16",
  bgRaised: "#24211C",
  bgOverlay: "#2C2822",
  borderSubtle: "#2E2A24",
  textPrimary: "#EDE6DA",
  textMuted: "#A39A8C",
  gold: "#C8952A",
  nile: "#4FA36B",
  ochre: "#C9503F",
  lapis: "#4C8ED9",
};

export const GATE_ORDER: GateName[] = ["typecheck", "lint", "test", "bounds", "visual"];

/** camelCase to a CSS custom property: bgBase -> --bg-base. */
export function cssVarName(token: string): string {
  return `--${token.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
}

export function tokensToCss(theme: ThemeTokens): string {
  const lines = Object.entries(theme).map(([key, value]) => `  ${cssVarName(key)}: ${value};`);
  return `:root {\n${lines.join("\n")}\n}\n`;
}
