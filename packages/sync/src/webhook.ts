import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ExternalRef } from "@sekhemet/kernel";
import { githubIssueId } from "./remote.js";

/**
 * Webhook intake (Y13, design "Intake triggers"): verify the HMAC-SHA256
 * signature in constant time, then map the triggers to typed intents; each
 * delivery is processed at most once (INT-9).
 * Inbound text is untrusted: every string that came from the tracker is
 * wrapped in `<untrusted_content>` before it can reach a prompt.
 */
export function verifySignature(
  secret: string,
  rawBody: string | Buffer,
  header: string | undefined,
): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const expected = Buffer.from(
    `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`,
  );
  const given = Buffer.from(header);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export const untrusted = (text: string): string =>
  `<untrusted_content source="github">\n${text.replace(/<\/?untrusted_content[^>]*>/g, "")}\n</untrusted_content>`;

export type WebhookIntent =
  | {
      kind: "create_card";
      /** The issue's one identity, `owner/repo#n` (INT-1). */
      ref: ExternalRef;
      issue: number;
      title: string;
      body: string;
      url: string;
      subIssues: number[];
      /** The issue's labels, as the tracker holds them — the snapshot's base (INT-3). */
      labels: string[];
      /** The issue's assignee login, a person (INT-36). */
      assignee?: string;
      updatedAt?: string;
    }
  | { kind: "external_review"; pr: number; headSha: string; url: string }
  | { kind: "verify_dependency_pr"; pr: number; author: string; headSha: string }
  /** A pull request closed: merged or not (kernel rule 24's `card/pr_closed`). */
  | {
      kind: "pull_request_closed";
      pr: number;
      merged: boolean;
      /** The merge commit, when merged (INT-13). */
      mergeCommit?: string;
      /** The login of the person who closed or merged it (INT-14). */
      closedBy?: string;
      repo?: string;
    }
  | { kind: "ignored"; reason: string };

const BOTS = /^(dependabot|renovate)(\[bot\])?$/i;

/** Map one event to an intent (the five triggers; everything else is ignored). */
export function intentFor(event: string, payload: Record<string, unknown>): WebhookIntent {
  const p = payload as {
    action?: string;
    label?: { name?: string };
    issue?: {
      number: number;
      title: string;
      body?: string | null;
      html_url: string;
      sub_issues?: { number: number }[];
      labels?: ({ name?: string } | string)[];
      pull_request?: unknown;
      assignee?: { login: string } | null;
      updated_at?: string;
    };
    comment?: { id: number; body: string };
    pull_request?: {
      number: number;
      html_url: string;
      head: { sha: string };
      user?: { login: string };
      merged?: boolean;
      merge_commit_sha?: string | null;
      merged_by?: { login: string } | null;
    };
    repository?: { full_name?: string };
    sender?: { login: string };
  };
  if (event === "issues" && p.action === "labeled" && p.label?.name === "sekhemet" && p.issue) {
    const repo = p.repository?.full_name;
    if (!repo) return { kind: "ignored", reason: "an issue event without its repository" };
    return {
      kind: "create_card",
      ref: { system: "github", id: githubIssueId(repo, p.issue.number), url: p.issue.html_url },
      issue: p.issue.number,
      // As written: the card is linked, so the Worker's prompt tags its text
      // untrusted (S9); wrapped here it would differ from the synced issue.
      title: p.issue.title,
      body: p.issue.body ?? "",
      url: p.issue.html_url,
      subIssues: (p.issue.sub_issues ?? []).map((s) => s.number),
      labels: (p.issue.labels ?? [])
        .map((l) => (typeof l === "string" ? l : (l.name ?? "")))
        .filter(Boolean),
      ...(p.issue.assignee?.login ? { assignee: p.issue.assignee.login } : {}),
      ...(p.issue.updated_at ? { updatedAt: p.issue.updated_at } : {}),
    };
  }
  if (event === "issue_comment" && p.action === "created" && p.issue && p.comment) {
    // X15: `/review` on a pull request the harness did not open asks for an
    // external review card (the head is resolved at checkout). `/plan`,
    // `/split` and `/estimate` are Later (§7): ignored, not recorded (INT-11).
    if (/(?:^|\s)\/review\b/.test(p.comment.body) && p.issue.pull_request) {
      return { kind: "external_review", pr: p.issue.number, headSha: "", url: p.issue.html_url };
    }
    return { kind: "ignored", reason: "comment without /review on a pull request" };
  }
  if (event === "pull_request_review_comment" && p.action === "created" && p.pull_request) {
    if (p.comment && /(?:^|\s)\/review\b/.test(p.comment.body)) {
      return {
        kind: "external_review",
        pr: p.pull_request.number,
        headSha: p.pull_request.head.sha,
        url: p.pull_request.html_url,
      };
    }
    return { kind: "ignored", reason: "review comment without /review" };
  }
  if (event === "pull_request" && p.pull_request) {
    if (p.action === "labeled" && p.label?.name === "sekhemet:review") {
      return {
        kind: "external_review",
        pr: p.pull_request.number,
        headSha: p.pull_request.head.sha,
        url: p.pull_request.html_url,
      };
    }
    if (p.action === "closed") {
      const merged = p.pull_request.merged === true;
      const closedBy = (merged ? p.pull_request.merged_by?.login : undefined) ?? p.sender?.login;
      return {
        kind: "pull_request_closed",
        pr: p.pull_request.number,
        merged,
        ...(merged && p.pull_request.merge_commit_sha
          ? { mergeCommit: p.pull_request.merge_commit_sha }
          : {}),
        ...(closedBy ? { closedBy } : {}),
        ...(p.repository?.full_name ? { repo: p.repository.full_name } : {}),
      };
    }
    if (p.action === "opened" && BOTS.test(p.pull_request.user?.login ?? "")) {
      return {
        kind: "verify_dependency_pr",
        pr: p.pull_request.number,
        author: p.pull_request.user?.login ?? "",
        headSha: p.pull_request.head.sha,
      };
    }
  }
  return { kind: "ignored", reason: `${event}${p.action ? `.${p.action}` : ""} is not a trigger` };
}

/**
 * A node http handler for `POST /webhooks/github` (the dashboard server
 * mounts it). 401 on a bad signature, 202 with the intent otherwise.
 */
export function githubWebhookHandler(options: {
  secret: string;
  onIntent: (intent: WebhookIntent, delivery: string) => void | Promise<void>;
  /**
   * Claim a delivery id for processing: false when it was processed already,
   * and the delivery is then answered 202 and does nothing (INT-9).
   */
  claimDelivery?: (delivery: string) => boolean | Promise<boolean>;
  maxBytes?: number;
}): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let aborted = false;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > (options.maxBytes ?? 5 * 1024 * 1024)) {
        aborted = true;
        res.writeHead(413).end();
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", async () => {
      if (aborted) return;
      const raw = Buffer.concat(chunks);
      const sig = req.headers["x-hub-signature-256"];
      if (!verifySignature(options.secret, raw, Array.isArray(sig) ? sig[0] : sig)) {
        res.writeHead(401, { "content-type": "application/json" }).end('{"error":"bad signature"}');
        return;
      }
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(raw.toString("utf8"));
      } catch {
        res.writeHead(400).end();
        return;
      }
      const event = String(req.headers["x-github-event"] ?? "");
      const delivery = String(req.headers["x-github-delivery"] ?? "");
      const intent = intentFor(event, payload);
      try {
        if (intent.kind !== "ignored" && delivery && options.claimDelivery) {
          if (!(await options.claimDelivery(delivery))) {
            res
              .writeHead(202, { "content-type": "application/json" })
              .end(JSON.stringify({ intent: intent.kind, duplicate: true }));
            return;
          }
        }
        if (intent.kind !== "ignored") await options.onIntent(intent, delivery);
        res
          .writeHead(202, { "content-type": "application/json" })
          .end(JSON.stringify({ intent: intent.kind }));
      } catch (err) {
        res
          .writeHead(500, { "content-type": "application/json" })
          .end(JSON.stringify({ error: String(err) }));
      }
    });
  };
}
