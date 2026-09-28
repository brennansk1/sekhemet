/**
 * The Playbook's and the profile's words (dashboard §2.11, DB-N2-8): every
 * state's text in one pure module the page renders (`playbook.js`,
 * `learning_view.js`), so each is asserted from a fixture. The browser
 * imports the compiled module as `/app/lib/playbook.js`: no runtime imports.
 * DEC-31's words: the Worker is "the agent", gates are "checks".
 */

export const PLAYBOOK_COPY = {
  lede: "Learned from check results and what you do, never from a model grading itself. Everything stays on this machine and is recorded on the ledger. A rule takes effect only after you approve it, and you can edit or retire any of them.",
  headings: { candidates: "Needs your approval", active: "Active", retired: "Retired" },
  empty: {
    candidates:
      "Nothing awaiting approval. New rules come from fixes that took the agent several tries, your send-back notes, and Seshat's review at the end of a run.",
    active: "No active rules.",
    retired: "None retired.",
  },
  seededReadOnly: "Edit in playbook.toml",
  seededTitle: "Seeded rules live in .sekhemet/playbook.toml",
  approve: {
    heading: "Approve for",
    project: { label: "This project", detail: "Only this repository's issues" },
    global: { label: "All projects", detail: "Every repository on this machine" },
    footer:
      "All-projects rules live in ~/.config/sekhemet and apply to every repository on this machine.",
  },
  profile: {
    heading: "What Seshat has learned about you",
    lock: "These stay on this machine, in the project's ledger. Edit a statement to correct it; dismiss it and Seshat stops using it.",
    empty:
      "Nothing yet. Seshat learns from your send-back notes, the proposals you apply or discard, and the fields you change after it sets them. Statements appear here after a run.",
    dismissed: (n: number) => `${n} dismissed`,
  },
  retired: (n: number) => `${n} retired`,
  moreSignals: (n: number) => `${n} more ${n === 1 ? "signal" : "signals"}`,
} as const;

/** Who a rule is given to. */
export function ruleRoleLabel(role: string): string {
  return role === "manager" ? "For Seshat" : "For the agent";
}

/** A rule's reach chip and its tooltip. */
export function ruleReach(reach: string | undefined): { label: string; title: string } {
  return reach === "global"
    ? {
        label: "All projects",
        title: "Lives in ~/.config/sekhemet and applies to every repository on this machine",
      }
    : { label: "This project", title: "Applies to this project only" };
}

/** The sentence on a rule proposed for retirement. */
export function retireSentence(r: { helpful: number; harmful: number }): string {
  return `Proposed for retirement: used ${r.harmful} times on failing first attempts, ${r.helpful} on passing ones.`;
}

interface Groups {
  candidate: readonly unknown[];
  active: readonly unknown[];
  retired: readonly unknown[];
}

/** The note beside each section's heading. */
export function playbookSectionNotes(g: Groups): {
  candidates: string;
  active: string;
  retired: string;
} {
  const n = g.candidate.length;
  return {
    candidates: `${n} ${n === 1 ? "candidate" : "candidates"}`,
    active: `${g.active.length} · given to the agent or Seshat when their scope matches · value rises with each helpful use and decays over time`,
    retired: PLAYBOOK_COPY.retired(g.retired.length),
  };
}

/** The top bar's crumb: the project, then the active and awaiting counts. */
export function playbookCrumb(project: string, g: Groups): string {
  return `${project}${project ? " · " : ""}${g.active.length} active · ${g.candidate.length} awaiting approval`;
}

/** The note beside the profile's heading. */
export function profileHeadingNote(active: number): string {
  return `${active} ${active === 1 ? "statement" : "statements"} Seshat reads when it answers you`;
}

/**
 * The banner when the learning endpoint does not answer: a 404 keeps the
 * seeded rules and send-back suggestions from /api/playbook and names the
 * endpoint; any other status says the playbook file is shown instead.
 */
export function learningMissing(status: number): {
  title: string;
  endpoint?: string;
  detail: string;
} {
  if (status === 404) {
    return {
      title: "Learning isn't on this server yet.",
      endpoint: "GET /api/learning",
      detail:
        "returned 404. Below are the seeded rules and your send-back suggestions; approvals, counts and what Seshat has learned about you arrive with an updated Sekhemet.",
    };
  }
  return {
    title: "Couldn't load what Sekhemet has learned.",
    detail: `The server returned ${status > 0 ? status : "no response"}. Showing the playbook file instead.`,
  };
}
