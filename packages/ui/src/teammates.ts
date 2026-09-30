/**
 * The AI teammates as a person meets them (teams NEW-teams-5, items 17–19 and
 * 19a; dashboard §2.13.8; DEC-36): Seshat and the Agent listed apart from the
 * people in every picker, under *AI teammates* with the AI badge; their
 * state in DEC-34's six words — queued, working, needs you, paused, done,
 * failed — with a sentence the harness can say before any model loads
 * (TEAM-15); and a Stakeholder's or Viewer's `@Agent` as the request its
 * owner reads in *Needs you* (TEAM-39). Every word here; the server sends
 * facts, the page renders them.
 */

export type AiWho = "agent" | "seshat";
export type AiStateWord = "queued" | "working" | "needs you" | "paused" | "done" | "failed";

/** The two AI identities, by the names people use for them (NAMING, DEC-31). */
export const AI_TEAMMATES: readonly { id: AiWho; name: "Agent" | "Seshat" }[] = [
  { id: "agent", name: "Agent" },
  { id: "seshat", name: "Seshat" },
];

const NAME: Record<AiWho, "Agent" | "Seshat"> = { agent: "Agent", seshat: "Seshat" };

// ---------------------------------------------------------------------------
// Pickers (TEAM-17)
// ---------------------------------------------------------------------------

export interface PickerOption {
  value: string;
  label: string;
  detail?: string;
  /** An AI teammate: shown with the AI badge. */
  ai?: true;
  /** Listed, not pickable: the detail says why. */
  disabled?: true;
}

export interface PickerGroup {
  heading: "Members" | "AI teammates";
  options: PickerOption[];
}

/**
 * The people and the AI teammates, in that order (teams items 18, 23): an
 * AI teammate is listed under *AI teammates*, never under *Members*. In an
 * assignee picker the Agent is the delegate (`worker`), and Seshat is shown
 * but takes no issue — it proposes (DEC-36), so the row says how to ask it.
 * In a mention picker each inserts its `@name`.
 */
export function teammatePicker(input: {
  people: readonly { value: string; label: string; detail?: string }[];
  purpose: "assign" | "mention";
  query?: string;
}): PickerGroup[] {
  const q = (input.query ?? "").trim().toLowerCase();
  const match = (label: string) => !q || label.toLowerCase().includes(q);
  const members: PickerOption[] = input.people
    .filter((p) => match(p.label))
    .map((p) => ({
      value: input.purpose === "mention" ? `@${p.value}` : p.value,
      label: p.label,
      ...(p.detail ? { detail: p.detail } : {}),
    }));
  const ai: PickerOption[] = [];
  if (match("Agent")) {
    ai.push(
      input.purpose === "assign"
        ? {
            value: "worker",
            label: "Agent",
            detail: "Builds the issue against its checks",
            ai: true,
          }
        : { value: "@Agent", label: "Agent", detail: "Starts or guides the Agent", ai: true },
    );
  }
  if (match("Seshat")) {
    ai.push(
      input.purpose === "assign"
        ? {
            value: "seshat",
            label: "Seshat",
            detail: "Proposes only: mention @Seshat in a comment to ask",
            ai: true,
            disabled: true,
          }
        : { value: "@Seshat", label: "Seshat", detail: "Asks the project manager", ai: true },
    );
  }
  const groups: PickerGroup[] = [];
  if (members.length) groups.push({ heading: "Members", options: members });
  if (ai.length) groups.push({ heading: "AI teammates", options: ai });
  return groups;
}

// ---------------------------------------------------------------------------
// Mentions (TEAM-15)
// ---------------------------------------------------------------------------

/**
 * The AI teammates a comment mentions, each once, in the order first
 * written: `@Agent` and `@Seshat` as words of their own, any case — never
 * inside an email address or a longer name.
 */
export function aiMentions(text: string): AiWho[] {
  const out: AiWho[] = [];
  for (const m of text.matchAll(/(^|[^\w@.])@(agent|seshat)(?![\w-])/gi)) {
    const who = (m[2] ?? "").toLowerCase() as AiWho;
    if (!out.includes(who)) out.push(who);
  }
  return out;
}

/**
 * How a person is mentioned (teams item 23): `@` and their name without its
 * spaces, as the mention picker inserts it (`@DanaLee`).
 */
export function mentionHandle(name: string): string {
  return name.replace(/\s+/g, "");
}

/**
 * The people a comment mentions, by principal, each once, in the order first
 * written: `@Name` as a word of its own, any case — never inside an email
 * address or a longer name, and never an AI teammate (`aiMentions`).
 */
export function personMentions(
  text: string,
  people: readonly { principal: string; name: string }[],
): string[] {
  const byHandle = new Map<string, string>();
  for (const p of people) {
    const handle = mentionHandle(p.name).toLowerCase();
    if (handle && handle !== "agent" && handle !== "seshat") byHandle.set(handle, p.principal);
  }
  const out: string[] = [];
  for (const m of text.matchAll(/(^|[^\p{L}\p{N}_@.])@([\p{L}\p{N}_'-]+)/gu)) {
    const who = byHandle.get((m[2] ?? "").toLowerCase());
    if (who && !out.includes(who)) out.push(who);
  }
  return out;
}

// ---------------------------------------------------------------------------
// State (TEAM-15, item 19)
// ---------------------------------------------------------------------------

/** What the harness knows about an AI teammate on an issue, before any model replies. */
export interface AiStateFacts {
  who: AiWho;
  state: AiStateWord;
  /** Queued: its place and estimate, as the queue says it ("2nd in queue, about 6 minutes"). */
  standing?: string;
  /** Needs you or done: what it waits for. */
  waitingFor?: "start" | "answer" | "review";
  /** Whom it waits on, by name ("you" for the reader). */
  waitsOn?: string;
  /** A start request: who asked. */
  requestedBy?: string;
  /** Working: the step it is on, and of how many. */
  step?: number;
  of?: number;
  /** Working: the checks are running on its work. */
  checking?: boolean;
  /** Failed: why it stopped, as a sentence. */
  reason?: string;
}

export interface AiStateLine {
  name: "Agent" | "Seshat";
  label: AiStateWord;
  sentence: string;
}

/**
 * The Agent's state on a board card's tile (teams item 19): its word and
 * sentence from the server's facts, or undefined when the Agent is not on
 * the issue. Seshat takes no issue (DEC-36), so its state is never a tile's.
 */
export function tileAiState(ai: readonly AiStateFacts[] | undefined): AiStateLine | undefined {
  const agent = ai?.find((f) => f.who === "agent");
  return agent ? aiStateLine(agent) : undefined;
}

export function aiStateLine(f: AiStateFacts): AiStateLine {
  const name = NAME[f.who];
  // A name at the start of the sentence may be "you": the sentence starts with a capital.
  const line = (sentence: string): AiStateLine => ({
    name,
    label: f.state,
    sentence: sentence.charAt(0).toUpperCase() + sentence.slice(1),
  });
  switch (f.state) {
    case "queued":
      if (f.standing) return line(`Queued: ${f.standing}.`);
      return line(
        f.who === "agent"
          ? "Queued: it starts when the issue is Ready and its turn comes."
          : "Queued: Seshat answers here when its turn comes.",
      );
    case "working":
      if (f.who === "seshat") return line("Seshat is writing an answer.");
      if (f.checking) return line("The checks are running on the Agent's work.");
      return line(
        f.step ? `Working on step ${f.step}${f.of ? ` of ${f.of}` : ""}.` : "Working on it.",
      );
    case "needs you": {
      const who = f.waitsOn ?? "a person";
      if (f.waitingFor === "start")
        return line(
          `${f.requestedBy ?? "Someone"} asked the Agent to start. Waiting for ${who} to start it.`,
        );
      return line(`Waiting for ${who} to answer a question.`);
    }
    case "paused":
      return line("Paused by a person. Hand it back to resume.");
    case "done":
      if (f.who === "seshat") return line("Answered.");
      return line(
        f.waitingFor === "review"
          ? "Finished. Its work is waiting for review."
          : "Done. Its work is merged.",
      );
    case "failed":
      if (f.who === "seshat") return line("Seshat couldn't answer. Ask again in a moment.");
      return line(`Stopped: ${f.reason ?? "it could not finish."}`);
  }
}

// ---------------------------------------------------------------------------
// A request to start the Agent (TEAM-39, item 19a)
// ---------------------------------------------------------------------------

/** "Dana asked the Agent to work on Login: “…”. Start it?" — with its two answers. */
export function startRequestLine(input: {
  requestedBy: string;
  ask: string;
  title: string;
}): { text: string; start: "Start"; decline: "Decline" } {
  const ask = input.ask.trim().replace(/\s+/g, " ");
  const quoted = ask.length > 140 ? `${ask.slice(0, 139)}…` : ask;
  return {
    text: `${input.requestedBy} asked the Agent to work on ${input.title}${quoted ? `: “${quoted}”` : ""}. Start it?`,
    start: "Start",
    decline: "Decline",
  };
}

// ---------------------------------------------------------------------------
// The comment box (teams items 19, 23; dashboard §2.7.4)
// ---------------------------------------------------------------------------

/** Every word of an issue's comment box. */
export const COMMENT_COPY = {
  label: "Comment",
  hint: "Type @ to mention a person, the Agent or Seshat.",
  empty: "Write a comment first.",
  post: "Comment",
  posted: "Comment posted.",
  mention: "Mention",
  /** What the harness did with an AI teammate's mention, said at once (TEAM-15). */
  reached: (line: AiStateLine) => `${line.name}: ${line.sentence}`,
  /** A long comment to Seshat became a project document on the integration branch (PM-N10-2). */
  documented: "Your comment is in the repository as a project document.",
} as const;

/** One toast, as the dashboard's `toast()` takes it. */
export interface CommentToast {
  text: string;
  detail?: string;
  tone: "info";
  /** Kept until closed: it carries a command to run. */
  sticky?: true;
}

/**
 * What the issue page says once a comment is posted (TEAM-15; PM-N10-2,
 * RG-S5-2): that it was posted, with what each AI teammate it mentions did;
 * then, when the comment was committed as a project document and a checkout
 * is on the branch that moved, how that checkout catches up — kept on screen,
 * since it is a command to run.
 */
export function commentPostedToasts(
  res: { ai?: readonly AiStateFacts[]; notice?: string } | undefined,
): CommentToast[] {
  const said = (res?.ai ?? []).map((a) => COMMENT_COPY.reached(aiStateLine(a)));
  const posted: CommentToast = {
    text: COMMENT_COPY.posted,
    ...(said.length ? { detail: said.join("\n") } : {}),
    tone: "info",
  };
  return res?.notice
    ? [posted, { text: COMMENT_COPY.documented, detail: res.notice, tone: "info", sticky: true }]
    : [posted];
}
