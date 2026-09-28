import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { parseToml } from "@sekhemet/kernel";
import { describe, expect, it } from "vitest";
import {
  gitleaksRuleSet,
  goRegexToJs,
  parseGitleaksRules,
  rulesNotRunNote,
} from "../src/gitleaks_rules.js";
import { SECRET_RULES, redactSecrets, scanDiffForSecrets, scanSecrets } from "../src/secrets.js";

// DEC-43, DEC-44: the bundled offline secret rule set is gitleaks' own
// vendored rule file, so the built-in scan and the gitleaks program report
// the same rule ids. Every fake below is built at run time, so this file
// holds no credential shape a scanner would flag.

const DATA = new URL("../data/gitleaks/gitleaks.toml", import.meta.url);
const ALNUM = "A1b2C3d4E5f6G7h8J9k0";
const fake = (prefix: string, n: number) => `${prefix}${ALNUM.repeat(10).slice(0, n)}`;
const GH = fake("ghp_", 36);
const PEM_BODY = Array.from({ length: 4 }, (_, i) => `${ALNUM}${i}${ALNUM}`.slice(0, 40)).join(
  "\n",
);
const PRIVATE_KEY = `-----BEGIN RSA ${"PRIVATE"} KEY-----\n${PEM_BODY}\n-----END RSA ${"PRIVATE"} KEY-----`;

describe("DEC-44: the bundled rules are gitleaks' vendored rule file", () => {
  it("runs every [[rules]] of the file under gitleaks' own id, and names none as not run", () => {
    const text = readFileSync(DATA, "utf8");
    const ids = [...text.matchAll(/^\[\[rules\]\]\nid = "([^"]+)"$/gm)].map((m) => m[1]);
    expect(ids.length).toBe(222);
    const set = gitleaksRuleSet();
    expect(set.total).toBe(222);
    expect(set.notRun).toEqual([]);
    expect(rulesNotRunNote()).toBeUndefined();
    expect(SECRET_RULES.map((r) => r.id)).toEqual(ids);
    // The hand-written ids are gone; gitleaks' stand in their place.
    const got = new Set(SECRET_RULES.map((r) => r.id));
    for (const old of ["github-token", "generic-secret", "openai-key", "anthropic-key"]) {
      expect(got.has(old)).toBe(false);
    }
    for (const id of ["github-pat", "generic-api-key", "private-key", "aws-access-token"]) {
      expect(got.has(id)).toBe(true);
    }
  });

  it("gives each rule a short name a person can read", () => {
    const byId = new Map(SECRET_RULES.map((r) => [r.id, r.description]));
    expect(byId.get("github-pat")).toBe("GitHub Personal Access Token");
    expect(byId.get("aws-access-token")).toBe("credential (aws-access-token)");
    for (const r of SECRET_RULES) expect(r.description.length, r.id).toBeLessThanOrEqual(60);
  });

  it("names a rule whose pattern JavaScript cannot run, and runs the rest", () => {
    const set = parseGitleaksRules(
      [
        "[[rules]]",
        'id = "ungreedy"',
        "regex = '''(?U)a+b'''",
        "[[rules]]",
        'id = "unicode-class"',
        "regex = '''\\p{Greek}+'''",
        "[[rules]]",
        'id = "fine"',
        "regex = '''tok_[a-z]{8}'''",
        "",
      ].join("\n"),
    );
    expect(set.rules.map((r) => r.id)).toEqual(["fine"]);
    expect(set.notRun.map((r) => r.id)).toEqual(["ungreedy", "unicode-class"]);
    expect(set.notRun[0]?.reason).toMatch(/\(\?U\)/);
    expect(rulesNotRunNote(set)).toMatch(
      /^2 of 3 bundled secret rules not run \(ungreedy, unicode-class\)/,
    );
  });
});

describe("goRegexToJs: Go (RE2) syntax as JavaScript with the same meaning", () => {
  const js = (src: string) => {
    const r = goRegexToJs(src);
    if ("error" in r) throw new Error(r.error);
    return new RegExp(r.source, r.flags);
  };

  it("scopes a bare (?i) to the rest of its group, across each alternative", () => {
    expect(js("\\b(LTAI(?i)[a-z0-9]{4})").test("LTAIabCD")).toBe(true);
    expect(js("\\b(LTAI(?i)[a-z0-9]{4})").test("ltaiabcd")).toBe(false);
    // Go: a(?i)b|c is (a(?i:b))|(?i:c), never a(b|c).
    const alt = js("a(?i)b|c");
    expect(alt.test("C")).toBe(true);
    expect(alt.test("AB")).toBe(false);
    expect(js("(?i)^true|false|null$").test("NULL")).toBe(true);
  });

  it("keeps Go's inline flags exact with no modifier group: (?-i:, (?s:, (?i: on classes and names", () => {
    const mixed = js("(?i)abc(?-i:DEF)g");
    expect(mixed.test("ABCDEFG")).toBe(true);
    expect(mixed.test("abcdefg")).toBe(false);
    expect(js("a(?s:.)b").test("a\nb")).toBe(true);
    expect(js("a.b").test("a\nb")).toBe(false);
    const inner = js("x(?i:[a-c]y)");
    expect(inner.test("xBY")).toBe(true);
    expect(inner.test("XBY")).toBe(false);
    expect(js("(?i)[[:lower:]]{2}").test("AB")).toBe(true);
    expect(js("q(?i)[^a-c]").test("qB")).toBe(false);
    expect(js("q(?i)[^a-c]").test("qD")).toBe(true);
    expect(js("q(?i)\\x41").test("qa")).toBe(true);
    expect(js("q(?i)(?P<Tok>ab)").exec("qAB")?.groups?.Tok).toBe("AB");
    for (const src of ["(?i)abc(?-i:DEF)", "a(?s:.)b", "x(?i:[a-c]y)", "a(?i)b|c"]) {
      const r = goRegexToJs(src);
      if ("error" in r) throw new Error(r.error);
      expect(r.source, src).not.toMatch(/\(\?(?:[a-z]+-?[a-z]*|-[a-z]+):/);
    }
  });

  it("rewrites (?P<name>, \\z, POSIX classes, a ] first in a class and Go's \\s", () => {
    expect(js("(?P<x>ab)").exec("ab")?.groups?.x).toBe("ab");
    expect(js("a\\z").test("a\n")).toBe(false);
    expect(js("pat[[:alnum:]]{3}").test("patA1z")).toBe(true);
    expect(js("\\[[^]]+]").test("[abc]")).toBe(true);
    expect(js("a\\sb").test("a\vb")).toBe(false);
    expect(js("a\\sb").test("a\tb")).toBe(true);
  });

  it("refuses what it cannot rewrite exactly", () => {
    for (const src of [
      "(?U)a+",
      "(?m)^a",
      "a(?m)b",
      "\\p{L}",
      "\\Qa.b\\E",
      "\\x{41}",
      "(a",
      "a)",
      "[a",
    ]) {
      expect("error" in goRegexToJs(src), src).toBe(true);
    }
  });
});

describe("C2b: the bundled rules run on the declared Node floor (V8 without RegExp modifiers)", () => {
  it("compiles all 222 rules and every allowlist where RegExp modifier groups are refused", () => {
    // Node 22 ships V8 12.4; RegExp modifiers arrived in V8 12.5. Every Go
    // pattern of the vendored file, rewritten, must compile there too.
    type Raw = Record<string, unknown>;
    const doc = parseToml(readFileSync(DATA, "utf8")) as Raw;
    const go: string[] = [];
    const list = (v: unknown) =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
    const allow = (a: Raw) => go.push(...list(a.regexes), ...list(a.paths));
    for (const r of doc.rules as Raw[]) {
      for (const k of ["regex", "path"])
        if (typeof r[k] === "string" && r[k]) go.push(r[k] as string);
      for (const a of (r.allowlists as Raw[] | undefined) ?? []) allow(a);
    }
    allow(doc.allowlist as Raw);
    expect(go.length).toBeGreaterThan(222);
    const rewritten = go.map((src) => {
      const r = goRegexToJs(src);
      if ("error" in r) throw new Error(`${src}: ${r.error}`);
      return r;
    });
    const script = `
      let refused = false;
      try { new RegExp("(?i:a)"); } catch { refused = true; }
      const input = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
      const bad = [];
      for (const r of input) { try { new RegExp(r.source, r.flags); } catch (e) { bad.push(r.source + ": " + e.message); } }
      process.stdout.write(JSON.stringify({ refused, bad }));
    `;
    const run = spawnSync(process.execPath, ["--no-js-regexp-modifiers", "-e", script], {
      input: JSON.stringify(rewritten),
      encoding: "utf8",
    });
    expect(run.status, run.stderr).toBe(0);
    const out = JSON.parse(run.stdout) as { refused: boolean; bad: string[] };
    // The switch really refuses modifier groups, so the check is not vacuous.
    expect(out.refused).toBe(true);
    expect(out.bad).toEqual([]);
  });
});

describe("the bundled scan finds what gitleaks finds, under the same ids", () => {
  it("reports gitleaks' ids for common credential shapes", () => {
    const text = [
      `export const token = "${GH}";`,
      `aws_access_key_id = "ASIAY34FZKBOKMUTVV7A"`,
      `const stripe = "${fake("sk_live_", 24)}";`,
      `const gl = "${fake("glpat-", 20)}";`,
      `const plain = "hello world";`,
    ].join("\n");
    expect(scanSecrets(text, "src/config.ts").map((f) => [f.rule, f.line])).toEqual([
      ["github-pat", 1],
      ["aws-access-token", 2],
      ["stripe-access-token", 3],
      ["gitlab-pat", 4],
    ]);
  });

  it("finds a private key spread over lines, at the line it begins", () => {
    const text = `// config\nconst key = \`${PRIVATE_KEY}\`;\n`;
    const found = scanSecrets(text, "src/key.ts", 10);
    expect(found.map((f) => [f.rule, f.line])).toEqual([["private-key", 11]]);
    expect(found[0]?.redacted).not.toContain(ALNUM);
  });

  it("honours gitleaks' allowlists: AWS's documented example, the global paths, gitleaks:allow", () => {
    expect(scanSecrets('key = "AKIAIOSFODNN7EXAMPLE"', "a.py")).toEqual([]);
    expect(scanSecrets(`t = "${GH}"`, "node_modules/x/index.js")).toEqual([]);
    expect(scanSecrets(`t = "${GH}"`, "pnpm-lock.yaml")).toEqual([]);
    expect(scanSecrets(`t = "${GH}" // gitleaks:allow`, "a.ts")).toEqual([]);
    // Low entropy is not a secret (gitleaks' entropy threshold).
    expect(scanSecrets('const password = "aaaaaaaaaaaaaaaaaaaaaaaa";', "x")).toEqual([]);
  });

  it("reports a generic key, and drops the generic finding where a specific rule found the secret", () => {
    const generic = scanSecrets('api_key = "x9Kq2LmZ7vB4nR8tW1pY"', "settings.py");
    expect(generic.map((f) => f.rule)).toEqual(["generic-api-key"]);
    const specific = scanSecrets(`github_token = "${GH}"`, "settings.py");
    expect(specific.map((f) => f.rule)).toEqual(["github-pat"]);
  });

  it("judges a PKCS #12 file by its path alone, in a scan and in a diff", () => {
    expect(scanSecrets("", "certs/client.p12").map((f) => f.rule)).toEqual(["pkcs12-file"]);
    const diff =
      "diff --git a/certs/client.pfx b/certs/client.pfx\nnew file mode 100644\nBinary files /dev/null and b/certs/client.pfx differ\n";
    expect(scanDiffForSecrets(diff).map((f) => [f.rule, f.file])).toEqual([
      ["pkcs12-file", "certs/client.pfx"],
    ]);
  });

  it("scans a diff hunk by hunk, with each added line's own number, and a key added over lines", () => {
    const body = PRIVATE_KEY.split("\n").map((l) => `+${l}`);
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,0 +1,2 @@",
      "+const ok = 1;",
      `+const key = "${GH}";`,
      "@@ -9,0 +20,6 @@",
      ...body,
      "",
    ].join("\n");
    expect(scanDiffForSecrets(diff).map((f) => [f.rule, f.file, f.line])).toEqual([
      ["github-pat", "src/a.ts", 2],
      ["private-key", "src/a.ts", 20],
    ]);
  });

  it("redaction ignores the rules' allowlists: a documentation key is still masked, though the scan allows it (DS-N5-1)", () => {
    // gitleaks' aws-access-token rule allowlists keys ending in EXAMPLE, so the
    // scan reports nothing; text the harness persists or sends to the Research
    // model is masked anyway, as it is for a line with an allow marker.
    const key = "AKIAIOSFODNN7EXAMPLE";
    const text = `aws_access_key_id = ${key}`;
    expect(scanSecrets(text, "config/aws.ini")).toEqual([]);
    expect(redactSecrets(text)).not.toContain(key);
  });

  it("redacts with the same rules, a key over lines included, and leaves ordinary text alone", () => {
    const text = `token ${GH} and\n${PRIVATE_KEY}\nend`;
    const out = redactSecrets(text);
    expect(out).not.toContain(GH.slice(4, 20));
    expect(out).not.toContain(ALNUM);
    expect(out.endsWith("\nend")).toBe(true);
    const ordinary =
      "src/app.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'.\n  const apiVersion = config.get('api.version');";
    expect(redactSecrets(ordinary)).toBe(ordinary);
    // A path rule runs only on its files: a Terraform password field, not Python.
    const field = 'administrator_login_password = "Zx81kQ02Lm"';
    expect(scanSecrets(field, "infra/main.tf").map((f) => f.rule)).toEqual([
      "hashicorp-tf-password",
    ]);
    expect(scanSecrets(field, "app/settings.py").map((f) => f.rule)).not.toContain(
      "hashicorp-tf-password",
    );
    expect(redactSecrets('PASSWORD_FIELD = "password"')).toBe('PASSWORD_FIELD = "password"');
  });

  it("redacts a key spread over lines line by line: its body masked, the code between two headers kept", () => {
    // A real key: every body line masked, the header and footer kept, the line count unchanged.
    const key = redactSecrets(`const k = \`${PRIVATE_KEY}\`;\nnext();`);
    expect(key).not.toContain(ALNUM.slice(0, 8));
    expect(key.split("\n")).toHaveLength(PRIVATE_KEY.split("\n").length + 1);
    expect(key).toContain(`-----BEGIN RSA ${"PRIVATE"} KEY-----`);
    expect(key.endsWith("next();")).toBe(true);
    // A test that names two headers: gitleaks' pattern spans the code between
    // them, which is no key material, so a reader still sees the code.
    const code = [
      `expect(scan("-----BEGIN RSA ${"PRIVATE"} KEY-----")).toEqual({`,
      '  rule: "private-key",',
      `  excerpt: "-----BEGIN RSA ${"PRIVATE"} KEY-----",`,
      "});",
    ].join("\n");
    expect(redactSecrets(code)).toBe(code);
    // A key written as concatenated strings: each string's material masked.
    const joined = PRIVATE_KEY.split("\n")
      .map((l) => `  "${l}\\n" +`)
      .join("\n");
    const masked = redactSecrets(`const k =\n${joined}\n  "";`);
    expect(masked).not.toContain(ALNUM.slice(0, 8));
    expect(masked).toContain('  "****\\n" +');
  });

  it("keeps a large history's scan fast: 4 MB of ordinary source in a few seconds", () => {
    const lines = [
      "export function handler(req: Request): Response {",
      "  const apiVersion = config.get('api.version');",
      "  const token = req.headers.get('authorization') ?? '';",
      "  if (!token) return new Response('missing key', { status: 401 });",
      "  // the secret store is read once at start-up",
      "  return json({ ok: true, access: user.access, auth: session.auth });",
      "}",
    ];
    const text = Array.from({ length: 12_000 }, () => lines.join("\n")).join("\n");
    expect(text.length).toBeGreaterThan(4_000_000);
    const start = performance.now();
    // In fragments, as the history scan reads hunks.
    const chunk = 400 * lines.length;
    const all = text.split("\n");
    let found = 0;
    for (let i = 0; i < all.length; i += chunk) {
      found += scanSecrets(all.slice(i, i + chunk).join("\n"), "src/handler.ts").length;
    }
    const ms = performance.now() - start;
    expect(found).toBe(0);
    expect(ms).toBeLessThan(10_000);
  });
});
