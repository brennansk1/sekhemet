import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// DEC-43, DEC-44: gitleaks' own rule file is vendored as the bundled offline
// rule set. The file is the one its README records (version, hash, rule
// count), unmodified, with its MIT licence beside it and attributed in NOTICE.

const DATA = new URL("../data/gitleaks/", import.meta.url);
const ROOT = new URL("../../../", import.meta.url);

describe("the vendored gitleaks rule file", () => {
  it("is the file the README records, with its licence beside it and attributed in NOTICE", () => {
    const raw = readFileSync(new URL("gitleaks.toml", DATA));
    const readme = readFileSync(new URL("README.md", DATA), "utf8");
    const licence = readFileSync(new URL("LICENSE", DATA));
    expect(readme).toContain(createHash("sha256").update(raw).digest("hex"));
    expect(readme).toContain(createHash("sha256").update(licence).digest("hex"));
    const rules = raw.toString("utf8").match(/^\[\[rules\]\]$/gm) ?? [];
    expect(readme).toContain(`(${rules.length} \`[[rules]]\`)`);
    expect(rules.length).toBe(222);
    expect(readme).toMatch(/v8\.30\.1/);
    expect(licence.toString("utf8")).toMatch(/^MIT License/);
    expect(licence.toString("utf8")).toMatch(/Copyright \(c\) 2019 Zachary Rice/);
    const notice = readFileSync(new URL("NOTICE", ROOT), "utf8");
    expect(notice).toMatch(/gitleaks[\s\S]*v8\.30\.1[\s\S]*MIT License/);
  });
});
