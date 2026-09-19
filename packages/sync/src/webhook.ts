import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Webhook intake (Y13, design "Intake triggers"): verify the HMAC-SHA256
 * signature in constant time, then map the five triggers to typed intents.
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
      issue: number;
      title: string;
      body: string;
      url: string;
      subIssues: number[];
    }
  | {
      kind: "card_command";
      issue: number;
      command: "plan" | "split" | "estimate" | "review";
      args: string;
      commentId: number;
    }
  | { kind: "external_review"; pr: number; headSha: string; url: string }
  | { kind: "verify_dependency_pr"; pr: number; author: string; headSha: string }
  | { kind: "enqueue_run"; ref: string; inputs: Record<string, string> }
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
      pull_request?: unknown;
    };
    comment?: { id: number; body: string };
    pull_request?: {
      number: number;
      html_url: string;
      head: { sha: string };
      user?: { login: string };
    };
    ref?: string;
    inputs?: Record<string, string>;
  };
  if (event === "issues" && p.action === "labeled" && p.label?.name === "sekhemet" && p.issue) {
    return {
      kind: "create_card",
      issue: p.issue.number,
      title: untrusted(p.issue.title),
      body: untrusted(p.issue.body ?? ""),
      url: p.issue.html_url,
      subIssues: (p.issue.sub_issues ?? []).map((s) => s.number),
    };
  }
  if (event === "issue_comment" && p.action === "created" && p.issue && p.comment) {
    const m = /(?:^|\s)\/(plan|split|estimate|review)\b(.*)$/m.exec(p.comment.body);
    // X15: `/review` on a pull request the harness did not open asks for an
    // external review card (the head is resolved at checkout).
    if (m && m[1] === "review" && p.issue.pull_request) {
      return { kind: "external_review", pr: p.issue.number, headSha: "", url: p.issue.html_url };
    }
    if (m) {
      return {
        kind: "card_command",
        issue: p.issue.number,
        command: m[1] as "plan",
        args: untrusted((m[2] ?? "").trim()),
        commentId: p.comment.id,
      };
    }
    return { kind: "ignored", reason: "comment without a command" };
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
    if (p.action === "opened" && BOTS.test(p.pull_request.user?.login ?? "")) {
      return {
        kind: "verify_dependency_pr",
        pr: p.pull_request.number,
        author: p.pull_request.user?.login ?? "",
        headSha: p.pull_request.head.sha,
      };
    }
  }
  if (event === "workflow_dispatch") {
    return { kind: "enqueue_run", ref: p.ref ?? "refs/heads/main", inputs: p.inputs ?? {} };
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
