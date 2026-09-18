import { describe, expect, it } from "vitest";
import { ENTROPY_THRESHOLD, scanDiff, scanLine, scanText, shannonEntropy } from "../src/scanner.js";

const RANDOM_24 = "Xk9pQ2mZ7vR4tY8wL3nB6cF1";
const AWS_KEY = "AKIAIOSFODNN7EXAMPLE";
const GITHUB_PAT = `ghp_${"a1B2c3D4e5".repeat(3)}a1B2c3`;

describe("onyx shannonEntropy", () => {
  it("computes exact bits per character", () => {
    expect(shannonEntropy("abcd")).toBe(2);
    expect(shannonEntropy("aabb")).toBe(1);
    expect(shannonEntropy("0123456789abcdef")).toBe(4);
  });

  it("is zero for an empty string and for a single repeated character", () => {
    expect(shannonEntropy("")).toBe(0);
    expect(shannonEntropy("aaaaaaaa")).toBe(0);
  });

  it("uses a threshold of exactly 4 bits", () => {
    expect(ENTROPY_THRESHOLD).toBe(4);
  });
});

describe("onyx scanLine", () => {
  it("detects a private key header", () => {
    expect(scanLine("-----BEGIN RSA PRIVATE KEY-----")).toEqual({
      rule: "private-key",
      excerpt: "-----BEGIN RSA PRIVATE KEY-----",
    });
    expect(scanLine("-----BEGIN PRIVATE KEY-----")?.rule).toBe("private-key");
  });

  it("detects an AWS access key id and reports only the key as the excerpt", () => {
    expect(scanLine(`aws_access_key_id = ${AWS_KEY}`)).toEqual({
      rule: "aws-access-key",
      excerpt: AWS_KEY,
    });
  });

  it("detects a GitHub personal access token", () => {
    expect(GITHUB_PAT.length).toBe(40);
    expect(scanLine(`token: ${GITHUB_PAT}`)).toEqual({ rule: "github-pat", excerpt: GITHUB_PAT });
  });

  it("flags a high-entropy token of 20 or more characters", () => {
    expect(scanLine(`SECRET="${RANDOM_24}"`)).toEqual({
      rule: "high-entropy",
      excerpt: RANDOM_24,
    });
  });

  it("flags a token whose entropy is exactly at the threshold", () => {
    const hex = "0123456789abcdef0123456789abcdef";
    expect(scanLine(`sum ${hex}`)).toEqual({ rule: "high-entropy", excerpt: hex });
  });

  it("ignores high-entropy tokens shorter than 20 characters", () => {
    expect(scanLine(`id=${RANDOM_24.slice(0, 19)}`)).toBeNull();
  });

  it("ignores long low-entropy identifiers and ordinary code", () => {
    expect(scanLine("const this_is_a_perfectly_normal_identifier = 1;")).toBeNull();
    expect(scanLine("aaaaaaaaaabbbbbbbbbbcccc")).toBeNull();
    expect(scanLine("")).toBeNull();
  });

  it("does not match a truncated or lower-case AWS key as aws-access-key", () => {
    expect(scanLine("AKIAIOSFODNN7EXAMPL")).toBeNull();
    expect(scanLine("akiaiosfodnn7example")).toBeNull();
  });

  it("prefers a signature rule over the entropy rule on the same line", () => {
    expect(scanLine(`${RANDOM_24} ${AWS_KEY}`)?.rule).toBe("aws-access-key");
  });
});

describe("onyx scanText", () => {
  it("reports 1-based line numbers and the file name", () => {
    const text = ["# config", `KEY=${AWS_KEY}`, "", `OTHER=${RANDOM_24}`].join("\n");
    expect(scanText(text, "app.env")).toEqual([
      { file: "app.env", line: 2, rule: "aws-access-key", excerpt: AWS_KEY },
      { file: "app.env", line: 4, rule: "high-entropy", excerpt: RANDOM_24 },
    ]);
  });

  it("returns an empty list for clean text", () => {
    expect(scanText("hello\nworld\n", "a.txt")).toEqual([]);
  });
});

describe("onyx scanDiff", () => {
  const diff = [
    "diff --git a/src/config.ts b/src/config.ts",
    "index 1111111..2222222 100644",
    "--- a/src/config.ts",
    "+++ b/src/config.ts",
    "@@ -10,3 +20,4 @@ export const config = {",
    "   region: 'us-east-1',",
    `-  oldKey: '${RANDOM_24}',`,
    "+  retries: 3,",
    `+  accessKey: '${AWS_KEY}',`,
    "   timeout: 30,",
    "diff --git a/.env b/.env",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/.env",
    "@@ -0,0 +1,2 @@",
    "+DEBUG=true",
    `+GITHUB_TOKEN=${GITHUB_PAT}`,
  ].join("\n");

  it("reports added-line secrets with new-file line numbers per file", () => {
    expect(scanDiff(diff)).toEqual([
      { file: "src/config.ts", line: 22, rule: "aws-access-key", excerpt: AWS_KEY },
      { file: ".env", line: 2, rule: "github-pat", excerpt: GITHUB_PAT },
    ]);
  });

  it("ignores secrets on removed and context lines", () => {
    const onlyRemoved = [
      "--- a/x.ts",
      "+++ b/x.ts",
      "@@ -1,2 +1,1 @@",
      ` keep ${AWS_KEY}`,
      `-gone ${RANDOM_24}`,
    ].join("\n");
    expect(scanDiff(onlyRemoved)).toEqual([]);
  });

  it("does not treat the +++ header itself as an added line", () => {
    expect(scanDiff(`--- a/${RANDOM_24}\n+++ b/${RANDOM_24}\n`)).toEqual([]);
  });

  it("returns an empty list for an empty diff", () => {
    expect(scanDiff("")).toEqual([]);
  });
});
