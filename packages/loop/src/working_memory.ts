import type { GateResult } from "@sekhemet/gates";

interface FailureTrack {
  text: string;
  firstSeen: number;
  /** Verifications this failure survived, after at least one edit. */
  survivedEdits: number;
  /** Files edited while it kept failing. */
  triedFiles: Set<string>;
}

/**
 * What the Worker has learned on this card, kept outside the transcript.
 *
 * Top harnesses compact long histories by summarising them with a model. On a
 * small local model that summary loses exactly what matters (which error was
 * fixed, which fix did not work), and the repair ladder deliberately drops
 * history on some rungs. This is the deterministic alternative: facts are
 * extracted from gate results, never from the model's own account, and they
 * survive every reset and prompt reduction.
 */
export class WorkingMemory {
  private open = new Map<string, FailureTrack>();
  private fixed: string[] = [];
  private editsSinceCheck = new Set<string>();
  private checks = 0;

  public noteWrite(path: string): void {
    this.editsSinceCheck.add(path.replace(/^\.\//, ""));
  }

  public observe(result: GateResult): void {
    this.checks++;
    const now = new Map<string, string>();
    for (const f of result.failures) {
      const line = f.errorExcerpt.split("\n")[0]?.trim() ?? "";
      // Key on the message without its line number: an edit that shifts the
      // line must not look like a new error.
      const key = line.replace(/:\d+:\d+/, "").replace(/\(\d+,\d+\)/, "");
      if (key) now.set(key, line);
    }

    for (const [key, track] of this.open) {
      if (!now.has(key)) {
        this.fixed.push(track.text);
        this.open.delete(key);
      }
    }
    for (const [key, text] of now) {
      const track = this.open.get(key);
      if (!track) {
        this.open.set(key, {
          text,
          firstSeen: this.checks,
          survivedEdits: 0,
          triedFiles: new Set(),
        });
      } else if (this.editsSinceCheck.size > 0) {
        track.survivedEdits++;
        for (const f of this.editsSinceCheck) track.triedFiles.add(f);
        track.text = text;
      }
    }
    this.editsSinceCheck.clear();
    if (this.fixed.length > 6) this.fixed = this.fixed.slice(-6);
  }

  /** Prompt lines, most actionable first. Empty until something is known. */
  public lines(): string[] {
    const out: string[] = [];
    for (const t of [...this.open.values()].sort((a, b) => b.survivedEdits - a.survivedEdits)) {
      if (t.survivedEdits === 0) continue;
      out.push(
        `still failing after ${t.survivedEdits} edit${t.survivedEdits > 1 ? "s" : ""} to ${[...t.triedFiles].join(", ")}: ${clip(t.text)}. That approach is not working: change strategy, do not repeat it.`,
      );
    }
    for (const text of this.fixed.slice(-4)) out.push(`fixed: ${clip(text)} (do not reintroduce)`);
    return out.slice(0, 8);
  }
}

function clip(s: string, n = 160): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
