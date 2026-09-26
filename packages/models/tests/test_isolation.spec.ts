import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultMachineProfilePath, defaultRegistryPath, sekhemetConfigDir } from "../src/index.js";

// MD-N4-5: tests write no file under the user's home `.sekhemet`: the test
// configuration points the user directory, the model registry and the
// machine profile elsewhere, for every test file.

describe("MD-N4-5: tests never touch the home directory's .sekhemet", () => {
  it("resolves the user directory, the registry and the machine profile outside it", () => {
    const home = join(homedir(), ".sekhemet");
    for (const p of [sekhemetConfigDir(), defaultRegistryPath(), defaultMachineProfilePath()]) {
      expect(p.startsWith(home)).toBe(false);
    }
  });
});
