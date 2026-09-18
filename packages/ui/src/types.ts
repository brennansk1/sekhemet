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
  surfaceBackground: string;
  surfaceRaised: string;
  surfaceOverlay: string;
  borderSubtle: string;
  textPrimary: string;
  textMuted: string;
  accentGreen: string;
  accentRed: string;
  accentAmber: string;
}
