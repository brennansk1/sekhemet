import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withReadOnlyMasks } from "../src/srt_engine.js";

// Security item 10a under srt on Linux (C4, from C3's review): the end of
// srt's mounts is found as the unquoted word pair `--dev` `/dev`, read by srt's
// own quoting rules (SRT_VERSION, `utils/shell-quote.js`: a word is bare, or
// single-quoted with each quote written '"'"'). An owner-controlled path that
// holds " --dev /dev " or " --tmpfs <dir> " is one quoted word, never the end
// of the mounts or a mount.

/** A word as srt quotes it. */
const q = (w: string) =>
  /^[A-Za-z0-9_./:@+,-][A-Za-z0-9_./:=@+,-]*$/.test(w) ? w : `'${w.replace(/'/g, `'"'"'`)}'`;

describe("srt on Linux: the end of srt's mounts, read by its quoting rules", () => {
  let top: string;
  beforeEach(() => {
    top = mkdtempSync(join(tmpdir(), "sek-srt-anchor-"));
    mkdirSync(join(top, "masked"));
  });
  afterEach(() => rmSync(top, { recursive: true, force: true }));

  it("an owner path holding ' --dev /dev ' is not the end of the mounts", () => {
    const masked = join(top, "masked");
    const owner = `${top}/proj --dev /dev x`;
    const cmd = [
      "/usr/bin/bwrap --new-session --die-with-parent",
      `--ro-bind / / --bind ${q(owner)} ${q(owner)} --tmpfs ${masked}`,
      "--dev /dev --unshare-pid --proc /proc -- /bin/bash -c x",
    ].join(" ");
    const out = withReadOnlyMasks(cmd, [masked]);
    // The remount goes before the real `--dev /dev`, after srt's tmpfs, and
    // the owner's quoted path is unchanged.
    expect(out).toBe(
      cmd.replace(" --dev /dev --unshare-pid", ` --remount-ro ${masked} --dev /dev --unshare-pid`),
    );
    expect(out).toContain(`--bind ${q(owner)} ${q(owner)} --tmpfs ${masked} --remount-ro`);
  });

  it("a path holding a single quote and ' --dev /dev ' is one word too", () => {
    const masked = join(top, "masked");
    const owner = `${top}/it's --dev /dev 'here`;
    const cmd = `/usr/bin/bwrap --ro-bind ${q(owner)} ${q(owner)} --tmpfs ${masked} --dev /dev -- x`;
    expect(withReadOnlyMasks(cmd, [masked])).toBe(
      cmd.replace(" --dev /dev -- x", ` --remount-ro ${masked} --dev /dev -- x`),
    );
  });

  it("a quoted ' --tmpfs <dir> ' inside a path is not srt's tmpfs for that folder", () => {
    const masked = join(top, "masked");
    const owner = `${top}/a --tmpfs ${masked} b`;
    const cmd = `/usr/bin/bwrap --ro-bind / / --bind ${q(owner)} ${q(owner)} --dev /dev -- x`;
    // The folder exists and srt mounted nothing for it: refused, never left writable.
    expect(() => withReadOnlyMasks(cmd, [masked])).toThrow(/mounted no tmpfs/);
  });

  it("refuses when the unquoted pair is missing, or appears more than once", () => {
    const masked = join(top, "masked");
    const onlyQuoted = `/usr/bin/bwrap --tmpfs ${masked} --bind '/p --dev /dev q' /p -- x`;
    expect(() => withReadOnlyMasks(onlyQuoted, [masked])).toThrow(/end of its mounts/);
    const twice = `/usr/bin/bwrap --tmpfs ${masked} --dev /dev --unshare-pid --dev /dev -- x`;
    expect(() => withReadOnlyMasks(twice, [masked])).toThrow(/more than one end of its mounts/);
  });

  it("an unquoted `--args` before the end means the mounts came through a file", () => {
    const masked = join(top, "masked");
    const quotedArgs = `/usr/bin/bwrap --bind '/p --args 3' /p --tmpfs ${masked} --dev /dev -- x`;
    expect(withReadOnlyMasks(quotedArgs, [masked])).toBe(
      quotedArgs.replace(" --dev /dev", ` --remount-ro ${masked} --dev /dev`),
    );
    const viaFile = `/usr/bin/bwrap --args 3 --tmpfs ${masked} --dev /dev -- x`;
    expect(() => withReadOnlyMasks(viaFile, [masked])).toThrow(/file/);
  });
});
