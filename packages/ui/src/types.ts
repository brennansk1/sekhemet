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
  /** Index within its column, not within the overall card list. */
  rowIndex: number;
  x: number;
  y: number;
  width: number;
  height: number;
  isVisible: boolean;
}

export interface ColumnLayout {
  status: CardStatus;
  x: number;
  width: number;
  count: number;
}

export interface VirtualWindow {
  /** Only the nodes intersecting the viewport plus overscan. */
  nodes: VirtualCardNode[];
  columns: ColumnLayout[];
  /** Full scrollable extent, for sizing the scrollbar. */
  content: { width: number; height: number };
  firstRow: number;
  overscan: number;
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
