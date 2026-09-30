import { describe, expect, it } from "vitest";
import { sourceCites } from "../src/pm.js";
import {
  SESHAT_DOCUMENT_CHARS,
  SESHAT_MAX_DOCUMENTS,
  SESHAT_MESSAGE_MAX_BYTES,
  documentChip,
  formatBytes,
  messageBodyBytes,
  pastedDocument,
  userMessageView,
  whyNotSendable,
} from "../src/seshat.js";

// W2b G1 (planner-pm PM-N10): a long message reaches Seshat whole. A pasted
// document longer than a comfortable message is attached as a project
// document; a message over the request cap is refused with its size, before
// anything is sent.

const long = (n: number, head = "") => head + "x".repeat(Math.max(0, n - head.length));

describe("PM-N10: long messages and attached documents, in the composer", () => {
  it("keeps a paste of a comfortable size in the message, and attaches a longer one whole", () => {
    expect(pastedDocument("A short paste", 0)).toBeUndefined();
    expect(pastedDocument(long(SESHAT_DOCUMENT_CHARS), 0)).toBeUndefined();
    const text = long(20_000, "# Bakery timesheets\n\nThe owner wants weekly timesheets.\n");
    const doc = pastedDocument(text, 0);
    expect(doc?.text).toBe(text);
    expect(doc?.name).toBe("Bakery timesheets.md");
    // No heading: the name says what it is, numbered after the first.
    expect(pastedDocument(long(9_000), 0)?.name).toBe("Pasted text.md");
    expect(pastedDocument(long(9_000), 1)?.name).toBe("Pasted text 2.md");
  });

  it("says sizes in plain units", () => {
    expect(formatBytes(900)).toBe("900 bytes");
    expect(formatBytes(18_392)).toBe("18 KB");
    expect(formatBytes(1_300_000)).toBe("1.2 MB");
    expect(formatBytes(SESHAT_MESSAGE_MAX_BYTES)).toBe("1 MB");
  });

  it("counts what is sent in UTF-8 bytes, words and documents together", () => {
    expect(messageBodyBytes({ text: "é" })).toBe(new TextEncoder().encode('{"text":"é"}').length);
    const body = { text: "hi", documents: [{ name: "a.md", text: long(20_000) }] };
    expect(messageBodyBytes(body)).toBe(new TextEncoder().encode(JSON.stringify(body)).length);
  });

  it("refuses before sending, with the size, only what the server could not take", () => {
    expect(whyNotSendable({ text: long(20_000) })).toBeUndefined();
    const big = { text: "", documents: [{ name: "dump.md", text: long(1_300_000) }] };
    const said = whyNotSendable(big) ?? "";
    expect(said).toContain("1.2 MB");
    expect(said).toContain("1 MB");
    expect(said).toContain("Nothing was sent");
    const many = {
      text: "",
      documents: Array.from({ length: SESHAT_MAX_DOCUMENTS + 1 }, (_, i) => ({
        name: `${i}.md`,
        text: "x",
      })),
    };
    expect(whyNotSendable(many)).toContain(`${SESHAT_MAX_DOCUMENTS + 1}`);
  });

  it("shows an attached document by name and size, and where it is kept", () => {
    const inRepo = documentChip({
      name: "prompt.md",
      chars: 18_392,
      path: "docs/product/inputs/2026-09-29-prompt.md",
    });
    expect(inRepo.label).toBe("prompt.md · 18,392 characters");
    expect(inRepo.title).toBe("In the repository at docs/product/inputs/2026-09-29-prompt.md");
    expect(documentChip({ name: "notes.md", chars: 9_001 }).title).toBe(
      "Kept with the conversation; the repository has no commit to add it to yet",
    );
    expect(documentChip({ name: "notes.md", chars: 9_001, unfiled: "no_commit" }).title).toBe(
      "Kept with the conversation; the repository has no commit to add it to yet",
    );
    // Not added although the repository has commits: said so, and what to do.
    expect(documentChip({ name: "notes.md", chars: 9_001, unfiled: "commit_failed" }).title).toBe(
      "Kept with the conversation; adding it to the repository failed (the branch moved or was busy). Send it again to add it.",
    );
    // Not sent yet: what sending does with it.
    expect(documentChip({ name: "notes.md", chars: 9_001, pending: true }).title).toBe(
      "Sent with your message and added to the repository as a project document",
    );
  });

  it("shows a long message's opening, the whole of it being its attached document", () => {
    const text = long(20_000, "Build a timesheet app. ");
    const view = userMessageView({
      text,
      documents: [{ id: "pmd_1", name: "Message.md", chars: 20_000, fromMessage: true }],
    });
    expect(view.preview.length).toBeLessThanOrEqual(600);
    expect(text.startsWith(view.preview.replace(/…$/, ""))).toBe(true);
    expect(view.note).toBe("The whole message, 20,000 characters, is attached as Message.md.");
    expect(userMessageView({ text: "Short" })).toEqual({ preview: "Short", note: "" });
  });

  it("cites an attached document beside the issues, never among the research sources", () => {
    expect(
      sourceCites([
        { documentId: "pmd_1", label: "Attached document prompt.md" },
        { url: "https://example.org/a", label: "A" },
      ] as never),
    ).toEqual([{ label: "A", href: "https://example.org/a", host: "example.org" }]);
  });
});
