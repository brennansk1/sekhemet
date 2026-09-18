import { randomUUID } from "node:crypto";
import type { CardRecord } from "@sekhemet/kernel";
import type {
  AmbiguityClassificationResult,
  DecisionRequest,
  PlannerService,
  SPIDRDecomposition,
} from "./types.js";

export class ClarEvalAmbiguityClassifier {
  public async classifyAmbiguity(taskDesc: string): Promise<AmbiguityClassificationResult> {
    const lower = taskDesc.toLowerCase();
    const ambiguousKeywords = [
      "maybe",
      "somehow",
      "either",
      "or",
      "choose",
      "choice",
      "multiple",
      "consider",
      "alternatives",
    ];

    let ambiguityScore = 0.1;
    for (const kw of ambiguousKeywords) {
      if (lower.includes(kw)) {
        ambiguityScore += 0.2;
      }
    }

    if (ambiguityScore >= 0.5) {
      const decision: DecisionRequest = {
        question:
          "Multiple architectural paths detected. Which implementation approach do you prefer?",
        options: [
          "Option A: Strict local-first embedded SQLite storage",
          "Option B: Modular adapter interface allowing pluggable storage engines",
        ],
        previewSketches: [
          "// Option A (Embedded SQLite):\nconst db = new DatabaseSync(':memory:');",
          "// Option B (Pluggable Adapter):\nexport interface StorageAdapter { get(k: string): Promise<v>; }",
        ],
      };

      return {
        askUser: true,
        decision,
      };
    }

    return {
      askUser: false,
    };
  }
}

export class SpidrFeaturePlanner implements PlannerService {
  private classifier = new ClarEvalAmbiguityClassifier();

  public async classifyAmbiguity(taskDesc: string): Promise<AmbiguityClassificationResult> {
    return this.classifier.classifyAmbiguity(taskDesc);
  }

  public async decomposeFeature(epicId: string, description: string): Promise<SPIDRDecomposition> {
    const ambiguity = await this.classifyAmbiguity(description);
    const now = new Date().toISOString();

    const stories: CardRecord[] = [
      {
        id: `story_spidr_${randomUUID().slice(0, 6)}_iface`,
        tier: "story",
        parentId: epicId,
        title: "Define interface contracts and types (SPIDR: Interface)",
        status: "ready",
        scopeFiles: ["src/types.ts"],
        stepBudget: 25,
        stepsUsed: 0,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: `story_spidr_${randomUUID().slice(0, 6)}_data`,
        tier: "story",
        parentId: epicId,
        title: "Implement database schema and persistence (SPIDR: Data)",
        status: "backlog",
        scopeFiles: ["src/schema.ts", "src/store.ts"],
        stepBudget: 35,
        stepsUsed: 0,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: `story_spidr_${randomUUID().slice(0, 6)}_rule`,
        tier: "story",
        parentId: epicId,
        title: "Implement business invariants and gate tests (SPIDR: Rule)",
        status: "backlog",
        scopeFiles: ["src/service.ts", "tests/service.spec.ts"],
        stepBudget: 40,
        stepsUsed: 0,
        createdAt: now,
        updatedAt: now,
      },
    ];

    return {
      stories,
      spikeNeeded: ambiguity.askUser,
      ambiguityScore: ambiguity.askUser ? 0.8 : 0.2,
    };
  }
}
