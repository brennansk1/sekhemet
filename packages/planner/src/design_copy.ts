import type { QualityRow } from "@sekhemet/kernel";

/**
 * The design stage's words (design-stage §2.1–2.3, §2.8; NEW-design-stage-1,
 * P14): what it says to a person, the defaults it records as assumptions on
 * every card, the brief's prose, and the quality checklist's requirements —
 * each of which reaches the Worker through a card's dossier or criteria. The
 * one copy module for the design stage (PROMPT_STANDARD rule 13, registered
 * as `design` in `COPY_MODULES`).
 *
 * None of it says "requirements", "phase" or "let me gather" (DS-N1-7), and
 * none of it states that a project complies with a standard (DS-P14-4).
 */

/** An answer to a design question, with the cards it adds (DS-P14-8). */
export interface AnswerCopy {
  readonly answer: string;
  readonly cards: readonly string[];
}

export interface QuestionCopy {
  readonly question: string;
  readonly answers: readonly AnswerCopy[];
}

export const DESIGN_COPY = {
  qualities: {
    fast: "No latency target was given. Assumed: correct first; a benchmark issue measures it, and the target is set from what it shows.",
    secure:
      "Assumed: secrets come only from the environment and never enter the repository, and every input is validated where it enters.",
    scalable:
      "Assumed: one instance, with state kept in storage rather than in memory, so it can run as several later without a rewrite.",
    reliable: "Assumed: every failure path returns a typed error, and each has a test.",
    usable: "Assumed: every command explains itself with --help and every error says what to do.",
  },

  /** What is at stake, and the question that most changes the issues when it is (DS-N1-4). */
  risks: {
    money: {
      riskiest:
        "A charge is correct and happens once: a retried or duplicated request must never charge a customer twice.",
      question: {
        question: "Who takes the money?",
        answers: [
          {
            answer:
              "a payment provider's hosted checkout (Stripe by default); the service stores no card numbers",
            cards: ["Provider checkout session", "Provider webhook, handled once"],
          },
          {
            answer: "invoices only, paid outside the service",
            cards: ["Invoice numbering", "Mark an invoice paid by hand"],
          },
          {
            answer: "card details taken by the service itself",
            cards: ["Card entry form", "Card data kept out of storage and logs"],
          },
        ],
      },
    },
    identity: {
      riskiest:
        "Only the right person gets in: a session cannot be forged, replayed, or kept after logout.",
      question: {
        question: "How do people sign in?",
        answers: [
          {
            answer: "an email address and a password, with a reset link sent by email",
            cards: ["Password hashing", "Password reset by email"],
          },
          {
            answer: "an existing account elsewhere (GitHub or Google)",
            cards: ["OAuth sign-in callback"],
          },
          {
            answer: "a one-time link sent by email",
            cards: ["Magic link sign-in"],
          },
        ],
      },
    },
    personal: {
      riskiest:
        "Personal data never leaves where it is stored, including in logs and error messages.",
      question: {
        question: "Who may see a person's records?",
        answers: [
          {
            answer: "only the person and the staff who look after them",
            cards: ["Access check per record", "Access log"],
          },
          {
            answer: "every signed-in member of staff",
            cards: ["Staff-only access", "Access log"],
          },
        ],
      },
    },
  },

  /** External contracts: hard to change once code depends on them (§2.1). */
  external: {
    sync: {
      question: "When the same item changed on both sides, which wins?",
      answers: [
        {
          answer: "the newer change wins, and the other is kept as a conflict copy",
          cards: ["Conflict copy on both-sides change"],
        },
        {
          answer: "the person is asked each time",
          cards: ["Conflict prompt"],
        },
        { answer: "the local copy always wins", cards: [] },
      ],
    },
    storage: {
      question: "How does it authenticate to the storage provider?",
      answers: [
        {
          answer:
            "the provider's standard credential chain (environment, then profile); the tool stores no credential",
          cards: [],
        },
        {
          answer: "a key the tool keeps in its own configuration",
          cards: ["Key storage in configuration", "Key rotation"],
        },
      ],
    },
    database: {
      question: "Which database?",
      answers: [
        {
          answer: "SQLite in one file, behind an interface that Postgres can implement later",
          cards: ["SQLite storage adapter"],
        },
        {
          answer: "Postgres from the start",
          cards: ["Postgres storage adapter", "Database migrations"],
        },
      ],
    },
    api: {
      question: "Who calls it, and how?",
      answers: [
        {
          answer: "HTTP with JSON, unauthenticated until an issue asks for authentication",
          cards: ["JSON routes"],
        },
        {
          answer: "HTTP with JSON behind an API key",
          cards: ["JSON routes", "API key check"],
        },
      ],
    },
  } satisfies Record<string, QuestionCopy>,

  /** The stack, detected from the request (DS-N1-5, §2.2.7). */
  stacks: {
    typescript: {
      name: "TypeScript on Node with Vitest",
      assumed:
        "TypeScript on Node with Vitest — the stack Sekhemet verifies best. Say otherwise before the first issue runs.",
    },
    python: { name: "Python with pytest", assumed: "Python with pytest, as asked." },
    rust: { name: "Rust with cargo test", assumed: "Rust with cargo test, as asked." },
    go: { name: "Go with go test", assumed: "Go with go test, as asked." },
  },

  /** What a well-known kind of product does, said in the one sentence (DS-N1-3). */
  kinds: {
    calculator: "the four operations — add, subtract, multiply and divide",
    todo: "add, list, complete and delete items",
    timer: "start, pause, resume and reset",
  },

  say: {
    building: (what: string) => `Building ${what}.`,
    buildingKind: (what: string, essentials: string) =>
      `Building ${what}. ${essentials.charAt(0).toUpperCase()}${essentials.slice(1)}.`,
    stackAssumed: (stack: string) => ` Assumed: ${stack}.`,
    stackStated: (stack: string) => ` In ${stack}.`,
    brief: (what: string) =>
      `Building ${what}. Enough is at stake to write the decisions down: .sekhemet/brief.md.`,
    riskiest: (text: string) => `Riskiest assumption: ${text}`,
    firstQuestion: (question: string, dflt: string) =>
      `First, the question that most changes the plan: ${question} Default: ${dflt}.`,
    constraint: (quality: string, dflt: string) => `  ${quality} — ${dflt}`,
    onDefaults:
      "Proceeding on the defaults, recorded as assumptions — say otherwise before those issues run.",
    mustHold: (text: string) => `Must hold: ${text}`,
  },

  brief: {
    intro:
      "Written by Seshat. Every *Assumed* line is a default Sekhemet chose; edit it and the issues that depend on it should be planned again.",
    notStated: "Not stated — assumed:",
    problem: (who: string, what: string) =>
      `For ${who}, who want ${what}. What they do today instead:`,
    problemToday: "by hand or with a general-purpose tool",
    outcome: (who: string, actions: string) =>
      `${who} can ${actions}, end to end, verified by the checks below.`,
    outcomeWhole: (what: string) => `${what} works end to end, verified by the checks below.`,
    nonGoalsAssumed:
      "nothing beyond what the request names — no administration screens, no integrations and no second platform; each is a new issue when asked for.",
    stated: (text: string) => `- ${text} (as stated)`,
    priorArtNone:
      "- Not researched. The Research model answers how this is usually built, with sources, when asked; nothing here is recalled from a model's memory.",
    riskNone: "None identified.",
    done: (gates: string) =>
      `Every issue passes: ${gates}, plus reachability, regression and architecture.`,
    gatesFallback: "the checks in .sekhemet/gates.toml",
    depth: (profile: string, reason: string) => `Depth: ${profile} (proposed) — ${reason}`,
    invariantsComment: [
      "<!-- Checked on every issue. Two forms are enforced:",
      "- `src/db/` does not import `src/cli.ts`",
      "- `Money` is defined only in `src/types.ts`",
      "-->",
    ],
  },

  /** Why each profile is proposed (DS-P14-1); regulated says it claims no compliance (DS-P14-4). */
  depth: {
    regulated: (area: string) =>
      `It names a regulated area (${area}). Regulated selects stricter checks and your approval of every acceptance-test file; it claims no compliance with any standard or regulation.`,
    money:
      "Money changes hands: production marks speed, compatibility and accessibility as Must have too, and you approve the example tables of each.",
    identity:
      "People sign in to it: production marks speed, compatibility and accessibility as Must have too, and you approve the example tables of each.",
    personal:
      "It keeps personal data: production marks speed, compatibility and accessibility as Must have too, and you approve the example tables of each.",
    public:
      "People outside your team will use it: production marks speed, compatibility and accessibility as Must have too, and you approve the example tables of each.",
    prototype:
      "A small new tool with nothing at stake: no quality checklist rows, and test strength advises rather than blocks.",
    prototypeAsked:
      "You called it a prototype: no quality checklist rows, and test strength advises rather than blocks.",
    internal:
      "Something to use yourselves: working, reliable, secure and maintainable are marked Must have, and weak tests block an issue.",
    regulatedNote:
      "The regulated profile selects stricter checks and more of your approval. It claims no compliance with any standard or regulation.",
  },

  /** Each quality-checklist row as a requirement with an acceptance criterion (DS-P14-2). */
  checklist: {
    functional_suitability: {
      title: "Everything the brief names works end to end",
      criterion:
        "WHEN each thing the brief names is used as described THE SYSTEM SHALL produce the described result.",
    },
    performance_efficiency: {
      title: "It responds within a measured budget",
      criterion:
        "WHEN it runs under the stated load THE SYSTEM SHALL meet the latency and throughput target the benchmark issue set.",
    },
    compatibility: {
      title: "It works beside what it is meant to run with",
      criterion:
        "WHEN it runs on each stated platform or beside each stated system THE SYSTEM SHALL work there without changes to them.",
    },
    interaction_capability: {
      title: "People can use it, including with assistive technology",
      criterion:
        "WHEN a person uses it with only a keyboard or a screen reader THE SYSTEM SHALL let them finish each main task, and each error SHALL say what to do next.",
    },
    reliability: {
      title: "Failures are handled and saved data survives a restart",
      criterion:
        "WHEN an operation fails or the process stops part-way THE SYSTEM SHALL return a typed error, keep what was saved, and recover on the next start.",
    },
    security: {
      title: "Secrets stay out of the code and every input is checked",
      criterion:
        "WHEN input arrives from outside THE SYSTEM SHALL validate it where it enters, and SHALL read secrets only from the environment.",
    },
    maintainability: {
      title: "The code stays easy to change",
      criterion:
        "WHEN an issue is accepted THE SYSTEM SHALL pass the project's lint, typecheck and architecture checks.",
    },
    flexibility: {
      title: "It moves to a new environment without code changes",
      criterion:
        "WHEN it is installed in a new environment THE SYSTEM SHALL take every environment-specific value from configuration.",
    },
    safety: {
      title: "It fails safe",
      criterion:
        "WHEN an unsafe or unexpected state is detected THE SYSTEM SHALL stop the affected operation, leave stored data unchanged, and tell a person.",
    },
  } satisfies Record<QualityRow, { title: string; criterion: string }>,

  comparables: {
    notSearched: (why: string) =>
      `Comparable products were not searched: ${why}. The quality checklist and this conversation are a start, not complete coverage.`,
    none: (query: string) =>
      `No comparable projects came back for "${query}"; the quality checklist and this conversation are not complete coverage.`,
    found: (n: number, query: string) =>
      `${n} comparable project${n === 1 ? "" : "s"} for "${query}":`,
    item: (name: string, url: string) => `  ${name} — ${url}`,
    common: (feature: string, foundIn: number, of: number) =>
      `  Proposed: ${feature} (in ${foundIn} of ${of}) — accept, edit or reject it.`,
    tooFew: "Too few comparables to call any feature common; nothing proposed from them.",
  },

  walkthrough: {
    step: (role: string, action: string) => `${article(role)} ${role} can ${action}`,
    walked: (role: string, steps: number, stuck: number) =>
      `Walked the story map as ${article(role, false)} ${role}: ${steps} steps, ${stuck} with nothing planned — proposed for you to accept or reject.`,
  },

  /** Steps every user of such a product takes, where they get stuck if nothing supports them (DS-P14-7). */
  implied: {
    always: ["start for the first time, with nothing saved yet", "recover after a mistake"],
    identity: ["sign in again on a later visit", "sign out", "recover a forgotten password"],
    saving: ["find what they saved on a later visit", "remove something they saved"],
    money: ["see what they were charged and why", "get a refund when something went wrong"],
  },

  /**
   * A take-over plan's cards, planned through the one pipeline (DS-TO-14,
   * PM-P1-1): each card's spec is its evidence, and its criteria say what
   * the evidence shows done.
   */
  takeover: {
    epic: (proposalId: string) => `Take-over plan ${proposalId}`,
    approved: (proposalId: string, cards: number, defaults: number) =>
      `Approved ${proposalId}: ${cards} card${cards === 1 ? "" : "s"} planned, ${defaults} open question${defaults === 1 ? "" : "s"} took the default. Approve each card's criteria with: sekhemet approve <card>`,
    usage: "Usage: sekhemet dev take-over --approve TOP-<n> [--project <id>]",
    evidence: "Evidence:",
    finding: (id: string, kind: string, at?: string) =>
      `- finding ${id} (${kind.replace(/_/g, " ")})${at ? ` at ${at}` : ""}`,
    link: (ref: string) => `- ${ref}`,
    claim: (id: string, label: string) =>
      `- claim ${id} of the brief as found (${label.replace(/_/g, " ")})`,
    criteria: {
      build: (command: string) =>
        `\`${command}\` returns exit code 0 on the repository, with no error reported`,
      failingTests: (file: string) =>
        `Every test in \`${file}\` passes: the test runner reports 0 failures for \`${file}\``,
      suite: "The test suite reports 0 failures and returns exit code 0",
      focused: (path: string) =>
        `\`${path}\` has no focused test: the suite runs every test, 0 skipped by focus`,
      rotate: (path: string, commit: string) =>
        `The credential committed in \`${path}\` at \`${commit}\` is rotated: the old value is refused and the new one is stored outside the repository`,
      finish: (path: string, pieces: number) =>
        `\`${path}\` has none of the ${pieces} unfinished piece${pieces === 1 ? "" : "s"} the inventory found, and the build reports 0 errors for \`${path}\``,
      issue: (id: string) =>
        `Issue \`${id}\` is resolved: a test shows the behaviour it asks for, and it passes`,
    },
  },

  /** A further design question, posted as an open decision (DS-N1-4). */
  question: {
    rationale: "The default while the question is open; planning proceeds on it.",
    posted: (id: string, question: string, answer: string) =>
      `Open question ${id}: ${question} Planning proceeds on: ${answer}. Answer with: sekhemet decide ${id} <n>`,
  },

  offer: {
    proposed: (profile: string, reason: string) => `Proposed depth: ${profile}. ${reason}`,
    until: (profile: string) =>
      `Until you choose, issues plan as an internal tool. Choose with: sekhemet depth ${profile}`,
    ask: (profile: string) =>
      `Plan this as ${profile}? Press Enter for yes, or name another (prototype, internal tool, production, regulated): `,
    chosen: (profile: string, rows: number) =>
      `Depth: ${profile}, chosen.${rows > 0 ? ` Added ${rows} quality check${rows === 1 ? "" : "s"} as Must have.` : ""}`,
    inForce: (profile: string, recorded: boolean) =>
      recorded
        ? `Depth: ${profile}, chosen.`
        : `Depth: ${profile} — nobody has chosen one, so the default applies. Choose with: sekhemet depth <prototype|internal tool|production|regulated>`,
    unknown: (name: string) =>
      `No depth profile "${name}": one of prototype, internal tool, production, regulated.`,
  },
} as const;

function article(word: string, capital = true): string {
  const a = /^[aeiou]/i.test(word) ? "an" : "a";
  return capital ? `${a[0]?.toUpperCase()}${a.slice(1)}` : a;
}
