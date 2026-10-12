/**
 * Integrations (dashboard §2.11, DB-N2-7): the page renders what
 * `/api/integrations` returns, grouped by the `tier` the API gives — *Now*,
 * *Next*, *Later* — and nothing else. The page's own copy (what each does,
 * what leaves this machine) fills in words the API does not carry; it never
 * adds an integration or decides a tier. Only *Now* cards have controls.
 */

export type IntegrationTier = "now" | "next" | "later";

/** One `/api/integrations` entry (`apps/harness/src/integrations.ts` `IntegrationEntry`). */
export interface IntegrationEntryLike {
  id: string;
  name: string;
  tier?: string;
  connected: boolean;
  enabled?: boolean;
  detail?: string;
  lastSyncAt?: string;
  via?: string;
  /**
   * Push and email: the last send since connecting, a *Send test* or a
   * notice, as the ledger records it (loop wave 5, A3; W6 review).
   */
  lastSend?: { ok: boolean; at: string; kind?: string; error?: string };
}

/** The page's words for an integration it knows. */
export interface IntegrationCopy {
  id: string;
  name: string;
  mono: string;
  does: string;
  leaves: string;
}

export interface IntegrationCard extends IntegrationEntryLike {
  tier: IntegrationTier;
  mono: string;
  does: string;
  leaves: string;
  /** True for a *Now* card: connect, sync, export and import live only there. */
  controls: boolean;
}

const TIERS: readonly IntegrationTier[] = ["now", "next", "later"];

export function integrationGroups(
  entries: readonly IntegrationEntryLike[],
  copy: readonly IntegrationCopy[],
): Record<IntegrationTier, IntegrationCard[]> {
  const words = new Map(copy.map((c) => [c.id, c]));
  const out: Record<IntegrationTier, IntegrationCard[]> = { now: [], next: [], later: [] };
  for (const e of entries) {
    const tier = TIERS.find((t) => t === e.tier);
    if (!tier) continue;
    const c = words.get(e.id);
    out[tier].push({
      ...e,
      tier,
      name: c?.name ?? e.name,
      mono: c?.mono ?? e.name.slice(0, 2).toUpperCase(),
      does: c?.does ?? "",
      leaves: c?.leaves ?? "",
      controls: tier === "now",
    });
  }
  return out;
}

/** What a card's tag says: on (a check), off, or a connection that is not working. */
export interface IntegrationState {
  tone: "on" | "off" | "fail";
  label: string;
}

/** Integrations that are a file, never a connection (dashboard §2.11). */
const FILE_ONLY = new Set(["jira", "linear"]);

/**
 * A card's state in words (dashboard §2.11; loop wave 5, A1–A3): *Connected*
 * or *On* only for a connection that is there and working. Jira and Linear
 * are files, never connected; *PR on Accept* is on only with GitHub
 * connected; push or email whose last send did not arrive says so.
 */
export function integrationState(e: IntegrationEntryLike): IntegrationState {
  if (FILE_ONLY.has(e.id)) return { tone: "off", label: "Export and import" };
  if (e.id === "github-pr") {
    if (e.enabled && !e.connected) return { tone: "fail", label: "On, but GitHub isn't connected" };
    return e.enabled ? { tone: "on", label: "On" } : { tone: "off", label: "Off" };
  }
  if (e.id === "research-web")
    return e.enabled ? { tone: "on", label: "On" } : { tone: "off", label: "Off" };
  if (!e.connected) return { tone: "off", label: "Not connected" };
  if (e.lastSend && !e.lastSend.ok)
    return {
      tone: "fail",
      label: e.lastSend.kind === "test" ? "Last test failed" : "Last send failed",
    };
  return { tone: "on", label: "Connected" };
}

/** The header's count: connections that are there and working. */
export function connectedCount(entries: readonly IntegrationEntryLike[]): number {
  return entries.filter((e) => integrationState(e).tone === "on").length;
}

/** `GET /api/integrations/secret-store` (`apps/harness/src/secret_store.ts` `SecretStoreStatus`). */
export interface SecretStoreStatusLike {
  store?: string;
  storeName?: string;
  unavailable?: string;
  cleartextChosen: boolean;
  cleartextChosenAt?: string;
  heldInFiles: number;
  message: string;
}

export interface SecretStoreNotice {
  tone: "pass" | "warn";
  /** The server's one plain sentence: where secrets are kept, or why they are not saved. */
  text: string;
  /** True when the person may choose a private file: no store, and no choice yet. */
  offerChoice: boolean;
  /** The words of that choice's button. */
  action?: string;
}

/**
 * What Integrations, where secrets are entered, says about where they are
 * kept (security item 35, SEC-27c): the OS store by name; on a host with
 * none, that secrets are not saved and — until the person chooses — the
 * choice of a private file, which only they make. Nothing for a server that
 * does not report it.
 */
export function secretStoreNotice(
  status: SecretStoreStatusLike | undefined,
): SecretStoreNotice | undefined {
  if (!status || typeof status.message !== "string" || !status.message) return undefined;
  if (status.store) return { tone: "pass", text: status.message, offerChoice: false };
  if (status.cleartextChosen) return { tone: "warn", text: status.message, offerChoice: false };
  return {
    tone: "warn",
    text: status.message,
    offerChoice: true,
    action: "Keep secrets in a private file on this machine",
  };
}
