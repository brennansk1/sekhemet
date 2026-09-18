import type { CardRecord, CardStatus } from "@sekhemet/kernel";

export interface CanvasDimensions {
  viewportWidth: number;
  viewportHeight: number;
  totalColumns: number;
  columnWidth: number;
  rowHeight: number;
}

export interface VirtualCardNode {
  card: CardRecord;
  column: CardStatus;
  x: number;
  y: number;
  width: number;
  height: number;
  isVisible: boolean;
}

export interface BasaltThemeTokens {
  surfaceBackground: "#121214";
  surfaceRaised: "#18181b";
  surfaceOverlay: "#27272a";
  borderSubtle: "#3f3f46";
  textPrimary: "#fafafa";
  textMuted: "#a1a1aa";
  accentGreen: "#22c55e";
  accentRed: "#ef4444";
  accentAmber: "#f59e0b";
}
