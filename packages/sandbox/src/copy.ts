/**
 * The sandbox's model-facing text (PROMPT_STANDARD rule 13, CX-M1-13): the
 * reasons a fetch is refused, which reach the Worker in a tool result.
 * Registered in `COPY_MODULES` (packages/context/src/prompt_tags.ts).
 */
export const sandboxCopy = {
  policyReason: {
    denied: "in fetch_deny",
    offline: "offline",
    notAllowed: "not in fetch_allow",
    researchOutside: "research outside fetch_allow",
  },
} as const;
