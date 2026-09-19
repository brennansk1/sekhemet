import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LifecycleHookEngine, PluginManager, ServiceContainer } from "../src/index.js";

describe("service container and plugin manager (K9, K10)", () => {
  it("gives each service key one owner and names what is missing", () => {
    const c = new ServiceContainer();
    const release = c.register("ctx.board", { board: 1 });
    expect(c.resolve<{ board: number }>("ctx.board").board).toBe(1);
    expect(() => c.register("ctx.board", {})).toThrow(/already provided by core/);
    expect(() => c.resolve("ctx.gates")).toThrow(/No service provides ctx.gates/);
    let built = 0;
    c.provide("ctx.gates", () => ({ n: ++built }));
    expect(built).toBe(0);
    c.resolve("ctx.gates");
    c.resolve("ctx.gates");
    expect(built).toBe(1);
    release();
    expect(c.has("ctx.board")).toBe(false);
  });

  it("mounts reversibly: unmount releases every service and hook the plugin registered", async () => {
    const c = new ServiceContainer();
    const hooks = new LifecycleHookEngine();
    const pm = new PluginManager(c, hooks);
    let disposed = false;
    const info = await pm.mount({
      name: "notifier",
      apply: (ctx) => {
        ctx.provide("ctx.sync", { post: () => "ok" });
        ctx.hook("card/end", () => undefined);
        ctx.onDispose(() => {
          disposed = true;
        });
      },
    });
    expect(info).toEqual({ name: "notifier", provides: ["ctx.sync"], hooks: ["card/end"] });
    expect(c.ownerOf("ctx.sync")).toBe("plugin:notifier");
    expect(hooks.listenerCount("card/end")).toBe(1);
    expect(await pm.unmount("notifier")).toBe(true);
    expect(c.has("ctx.sync")).toBe(false);
    expect(hooks.listenerCount("card/end")).toBe(0);
    expect(disposed).toBe(true);
  });

  it("rolls a failing mount back and refuses one whose requirements are missing", async () => {
    const c = new ServiceContainer();
    const hooks = new LifecycleHookEngine();
    const pm = new PluginManager(c, hooks);
    await expect(
      pm.mount({
        name: "half",
        apply: (ctx) => {
          ctx.provide("ctx.tools", {});
          ctx.hook("pre-tool", () => undefined);
          throw new Error("boom");
        },
      }),
    ).rejects.toThrow(/rolled back: boom/);
    expect(c.has("ctx.tools")).toBe(false);
    expect(hooks.listenerCount("pre-tool")).toBe(0);
    await expect(
      pm.mount({ name: "needy", requires: ["ctx.llm"], apply: () => undefined }),
    ).rejects.toThrow(/needs ctx.llm/);
    expect(pm.list()).toEqual([]);
  });

  it("loads plugins from a directory, reporting the ones that fail", async () => {
    const dir = mkdtempSync(join(tmpdir(), "plugins-"));
    mkdirSync(join(dir, "good"));
    writeFileSync(
      join(dir, "good", "index.mjs"),
      'export default { name: "good", apply(ctx) { ctx.provide("ctx.planner", { plan: true }); } };\n',
    );
    mkdirSync(join(dir, "bad"));
    writeFileSync(join(dir, "bad", "index.mjs"), "export default { apply() {} };\n");
    const c = new ServiceContainer();
    const r = await new PluginManager(c).loadFromDirectory(dir);
    expect(r.mounted.map((m) => m.name)).toEqual(["good"]);
    expect(r.errors).toEqual([expect.stringMatching(/^bad: A plugin needs a name/)]);
    expect(c.resolve<{ plan: boolean }>("ctx.planner").plan).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});
