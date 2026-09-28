import { expect, it } from "vitest";
import { scanLine } from "../src/scanner.js";

it("detects OpenSSH and EC private key headers", () => {
  expect(scanLine("-----BEGIN OPENSSH PRIVATE KEY-----")?.rule).toBe("private-key");
  expect(scanLine("-----BEGIN EC PRIVATE KEY-----")?.rule).toBe("private-key");
});
