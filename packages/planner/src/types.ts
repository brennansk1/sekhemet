import type { CardRecord } from "@sekhemet/kernel";

export interface DecisionRequest {
  question: string;
  options: string[];
  previewSketches: string[];
}

export interface AmbiguityClassificationResult {
  askUser: boolean;
  decision?: DecisionRequest;
}

export interface SPIDRDecomposition {
  stories: CardRecord[];
  spikeNeeded: boolean;
  ambiguityScore: number;
}

export interface PlannerService {
  decomposeFeature(epicId: string, description: string): Promise<SPIDRDecomposition>;
  classifyAmbiguity(taskDesc: string): Promise<AmbiguityClassificationResult>;
}
