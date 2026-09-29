import type { EventLog } from "@sekhemet/kernel";
import { createTransport } from "nodemailer";
import { decideEgress, egressRecorder } from "./github_transport.js";
import { readSettings, writeSettings } from "./integrations.js";
import type { Notice, NoticeRecord, NotifyEvent } from "./notify.js";
import { PM_EVENTS } from "./pm/types.js";

/**
 * Email, a channel of the one notifier (integrations item 20; teams TEAM-43,
 * the email half; nodemailer under DEC-44). Unlike push and Slack, which
 * everyone reading them shares, email is personal: each notice goes to one
 * person at their own address — the one on their `person/created` record,
 * never another's — and says only what that person's Inbox says of it (no
 * private part: a comment's or an update's text stays in the product).
 *
 * The SMTP server is an integration setting in the user's directory, never
 * the repository; its password is a secret (security item 35): kept in the
 * keychain where there is one, else the 0600 file, never shown by the API,
 * never on the ledger and never in a message the product prints. Each send
 * goes through the one network policy (`decideEgress`, recorded as
 * `harness/egress` with purpose `integration:email` and the server's origin
 * only) and is recorded as `pm/notify {channel: "email", kind, ok, to}` with
 * the person's principal, not their address.
 */

export interface EmailSettings {
  /** The SMTP server's host name or address. */
  host: string;
  port: number;
  /**
   * TLS from the first byte (port 465); otherwise STARTTLS. With a login to a
   * server that is not on this machine's loopback, STARTTLS is required: a
   * server that does not offer it gets no login (`requiresTls`).
   */
  secure?: boolean;
  user?: string;
  /** The SMTP password: a secret (security item 35), never shown, logged or recorded. */
  password?: string;
  /** The sender address every notice comes from. */
  from: string;
  /** The notice kinds email carries; every kind when unset. */
  events?: NotifyEvent[];
  /** Unsolicited emails a day to one person: 3 when unset, never more than 5 (item 23a). */
  dailyBudget?: number;
}

const HOST =
  /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$|^\[?[0-9A-Fa-f:.]+\]?$/;
/** An address: one `@`, no spaces or angle brackets (the server decides the rest). */
export const ADDRESS = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$|^[^\s@<>",;]+@localhost$/;

/** Why these settings cannot be used, in the person's words; undefined when they can. */
export function validateEmail(e: Partial<EmailSettings>): string | undefined {
  if (typeof e.host !== "string" || !e.host.trim() || !HOST.test(e.host.trim()))
    return "Name the SMTP server: a host name or an address";
  if (!Number.isInteger(e.port) || (e.port as number) < 1 || (e.port as number) > 65535)
    return "The SMTP port must be a whole number from 1 to 65535";
  if (typeof e.from !== "string" || !ADDRESS.test(e.from.trim()))
    return "The sender must be an email address";
  if (e.password && !e.user) return "A password needs the user name it belongs to";
  return undefined;
}

/** The email settings, when connected and usable. */
export function readEmail(repoPath: string): EmailSettings | undefined {
  const e = readSettings(repoPath).email;
  return e && !validateEmail(e) ? e : undefined;
}

/** Connect (or, with undefined, disconnect) email; the password goes with the other secrets. */
export function writeEmail(repoPath: string, email: EmailSettings | undefined): void {
  writeSettings(repoPath, { email });
}

/** Whether email carries this kind. */
export function emailAccepts(e: EmailSettings, kind: NotifyEvent): boolean {
  return kind === "test" || !e.events || e.events.includes(kind);
}

/** A notice as one person's email: the subject is its title, the body its line and link. */
export function emailMessage(n: Notice): { subject: string; text: string } {
  const lines = [n.message];
  if (n.click) lines.push("", `Open in Sekhemet: ${n.click}`);
  lines.push("", "Sent by Sekhemet within your daily notification limit.");
  return { subject: n.title.replace(/[\r\n]+/g, " ").slice(0, 200), text: lines.join("\n") };
}

/** This machine's loopback: a login there never crosses a network. */
const isLoopbackHost = (host: string): boolean => {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  return h === "localhost" || h === "::1" || /^127(?:\.\d{1,3}){3}$/.test(h);
};

/**
 * Whether a send must be encrypted before the login (security item 35): a
 * user and password are sent only over TLS unless the server is on this
 * machine's loopback, so a server — or anyone on the path stripping its
 * STARTTLS offer — can never receive the password in plain text.
 */
export function requiresTls(e: Pick<EmailSettings, "host" | "user">): boolean {
  return Boolean(e.user) && !isLoopbackHost(e.host);
}

/** A message with the secret taken out, should a server or library repeat it. */
const withoutSecret = (text: string, secret: string | undefined) =>
  secret ? text.split(secret).join("[secret]") : text;

export interface EmailDeps {
  log?: EventLog | undefined;
  /** Structural fields for the `pm/notify` record: the person, the notice and its day. */
  record?: NoticeRecord;
  /** How long the server may take at each stage before the send counts as failed. */
  timeoutMs?: number;
}

/**
 * Send one notice to one person's own address. `skipped` when email is not
 * connected or does not carry this kind; a refusal by the network policy, a
 * server that is down or refuses the login is `ok: false`, and the caller
 * goes on (INT-20).
 */
export async function sendEmail(
  repoPath: string,
  n: Notice,
  address: string,
  deps: EmailDeps = {},
): Promise<{ ok: boolean; error?: string; skipped?: boolean }> {
  const e = readEmail(repoPath);
  if (!e) return { ok: false, skipped: true, error: "Email is not connected" };
  if (!emailAccepts(e, n.event)) return { ok: false, skipped: true };
  if (!ADDRESS.test(address)) return { ok: false, skipped: true, error: "No address to send to" };
  const origin = `smtp://${e.host.includes(":") && !e.host.startsWith("[") ? `[${e.host}]` : e.host}:${e.port}`;
  const message = emailMessage(n);
  let result: { ok: boolean; error?: string };
  try {
    // Security item 33: the SMTP server is the connected destination, decided
    // and recorded before anything is sent; offline refuses it.
    await decideEgress(
      repoPath,
      egressRecorder(deps.log, { redactUrl: true }),
      origin,
      { url: origin, detail: `${n.event}\n${message.subject}`, recordAllowed: true },
      "integration:email",
    );
    const timeout = deps.timeoutMs ?? 10_000;
    const transport = createTransport({
      host: e.host.replace(/^\[|\]$/g, ""),
      port: e.port,
      secure: e.secure === true,
      // Security item 35: no login in plain text off this machine's loopback.
      requireTLS: e.secure !== true && requiresTls(e),
      ...(e.user ? { auth: { user: e.user, pass: e.password ?? "" } } : {}),
      connectionTimeout: timeout,
      greetingTimeout: timeout,
      socketTimeout: timeout,
      // Never a log line: the login and the addresses stay out of any output.
      logger: false,
      debug: false,
      disableFileAccess: true,
      disableUrlAccess: true,
    });
    try {
      await transport.sendMail({
        from: e.from,
        to: address,
        subject: message.subject,
        text: message.text,
      });
      result = { ok: true };
    } finally {
      transport.close();
    }
  } catch (err) {
    result = {
      ok: false,
      error: withoutSecret(err instanceof Error ? err.message : String(err), e.password),
    };
  }
  await deps.log
    ?.append({
      actor: "harness",
      type: PM_EVENTS.notify,
      ...(n.cardId ? { cardId: n.cardId } : {}),
      payload: {
        channel: "email",
        kind: n.event,
        ok: result.ok,
        ...(deps.record?.to ? { to: deps.record.to } : {}),
        ...(deps.record?.notice ? { notice: deps.record.notice } : {}),
        ...(deps.record?.day ? { day: deps.record.day } : {}),
      },
    })
    .catch(() => undefined);
  return result;
}

/**
 * Each person's own address, from their `person/created` record's private
 * part (the notifier holds no people): the latest one recorded, none once
 * erased. Never written anywhere; read at send time.
 */
export async function personAddresses(log: EventLog): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const e of await log.getEventsByTypes(["person/created"])) {
    const principal = e.principal ?? (e.payload as { principal?: string } | undefined)?.principal;
    if (!principal) continue;
    const email = (e.private as { email?: unknown } | undefined)?.email;
    // A record naming no address leaves the last one; an erased one (`[erased]`) removes it.
    if (email === undefined) {
      if (e.private === undefined) out.delete(principal);
      continue;
    }
    if (typeof email === "string" && ADDRESS.test(email.trim())) out.set(principal, email.trim());
    else out.delete(principal);
  }
  return out;
}
