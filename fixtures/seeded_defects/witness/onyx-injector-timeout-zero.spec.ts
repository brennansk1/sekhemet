import { expect, it } from "vitest";
import { runWithSecrets } from "../src/injector.js";

it("kills the child at once when timeoutMs is 0", async () => {
  const result = await runWithSecrets(
    process.execPath,
    ["-e", "setTimeout(() => {}, 1500)"],
    {},
    {
      timeoutMs: 0,
    },
  );
  expect(result.signal).toBe("SIGTERM");
  expect(result.code).toBeNull();
});
