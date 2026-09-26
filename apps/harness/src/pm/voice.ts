/**
 * Seshat's voice, enforced where every reply is written (planner-pm §2.8.2,
 * §2.18.3, PM-N9-4): the prompt asks for it, and this makes it so whatever
 * the model wrote. No flattery or filler, no exclamation marks, and no
 * sentence that claims a person's authority — "I've assigned", "I've
 * decided", "I approved" — or tells a person what they should do.
 * Code (fenced blocks and inline spans) is kept exactly as written.
 */

/** The phrases no reply contains (PM-N9-4). */
export const BANNED_PHRASES = [
  "I've assigned",
  "I've decided",
  "I approved",
  "You should",
  "Great question",
  "happy to help",
] as const;

/** Sentences that are only filler: dropped whole. */
const FILLER = /(great question|happy to help|glad to help|hope this helps)/i;

/** Claims of a person's authority, restated as what they are. */
const REWRITES: [RegExp, string][] = [
  [/\bI(?:'ve| have) assigned\b/gi, "I've suggested assigning"],
  [/\bI(?:'ve| have) decided\b/gi, "My read is"],
  [/\bI(?:'ve| have)? approved\b/gi, "I suggested approving"],
  [/\bI(?:'ve| have) changed\b/gi, "I've proposed changing"],
  [/\bYou should\b/g, "Suggested:"],
  [/\byou should\b/gi, "the suggestion is to"],
];

function prose(text: string): string {
  // Sentence by sentence, keeping each one's own ending and spacing.
  const sentences = text.match(/[^.!?\n]*(?:[.!?]+|\n|$)\s*/g) ?? [text];
  let out = sentences.filter((s) => !FILLER.test(s)).join("");
  for (const [pattern, replacement] of REWRITES) {
    // Capitalised only where a sentence starts.
    out = out.replace(pattern, (_m, offset: number, all: string) => {
      const starts = /(?:^|[.?:!\n])\s*$/.test(all.slice(0, offset));
      return starts
        ? `${replacement.charAt(0).toUpperCase()}${replacement.slice(1)}`
        : `${replacement.charAt(0).toLowerCase()}${replacement.slice(1)}`.replace(/^i'/, "I'");
    });
  }
  // No exclamation marks: "?!" is a question, "!!" or "!" a full stop.
  out = out.replace(/\?!+/g, "?").replace(/!+(?![=[])/g, ".");
  return out.replace(/(?<!\.)\.\.(?!\.)/g, ".");
}

/** The reply as Seshat may say it. */
export function voiceGuard(text: string): string {
  if (!text) return text;
  // Split out code: ``` fences and `inline` spans stay byte for byte.
  const parts = text.split(/(```[\s\S]*?```|`[^`\n]*`)/g);
  const out = parts.map((p, i) => (i % 2 === 1 ? p : prose(p))).join("");
  return out.replace(/^\s+/, "").replace(/[ \t]+\n/g, "\n");
}

/** What in a reply breaks the voice rules, for tests and the evaluation (PM-N9-4). */
export function voiceProblems(text: string): string[] {
  const outsideCode = text.replace(/```[\s\S]*?```|`[^`\n]*`/g, "");
  const found: string[] = BANNED_PHRASES.filter((p) =>
    outsideCode.toLowerCase().includes(p.toLowerCase()),
  );
  if (/!(?![=[])/.test(outsideCode)) found.push("an exclamation mark");
  return found;
}
