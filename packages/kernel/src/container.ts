import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { HookHandler, LifecycleHookEngine, LifecycleHookEvent } from "./hooks.js";

/**
 * The service container (K9, design "Services"): every capability is a
 * service key a component claims (`ctx.events`, `ctx.board`, `ctx.gates`,
 * ...). One owner per key; a second claim is refused rather than silently
 * shadowing the first, and resolving a missing key names it.
 */
export const SERVICE_KEYS = [
  "ctx.events",
  "ctx.board",
  "ctx.cards",
  "ctx.context",
  "ctx.models",
  "ctx.llm",
  "ctx.tools",
  "ctx.loop",
  "ctx.planner",
  "ctx.gates",
  "ctx.sandbox",
  "ctx.sync",
  "ctx.hooks",
] as const;

interface Entry {
  instance?: unknown;
  factory?: (() => unknown) | undefined;
  owner: string;
}

export class ServiceContainer {
  private entries = new Map<string, Entry>();

  /** Claim `token` for `instance`; returns the release function. */
  public register<T>(token: string, instance: T, owner = "core"): () => void {
    this.claim(token, { instance, owner });
    return () => this.release(token, owner);
  }

  /** Claim `token` with a factory run on first resolve. */
  public provide<T>(token: string, factory: () => T, owner = "core"): () => void {
    this.claim(token, { factory, owner });
    return () => this.release(token, owner);
  }

  private claim(token: string, entry: Entry): void {
    const current = this.entries.get(token);
    if (current) {
      throw new Error(`Service ${token} is already provided by ${current.owner}`);
    }
    this.entries.set(token, entry);
  }

  private release(token: string, owner: string): void {
    const current = this.entries.get(token);
    if (current?.owner === owner) this.entries.delete(token);
  }

  public resolve<T>(token: string): T {
    const entry = this.entries.get(token);
    if (!entry) throw new Error(`No service provides ${token}`);
    if (entry.instance === undefined && entry.factory) {
      entry.instance = entry.factory();
      entry.factory = undefined;
    }
    return entry.instance as T;
  }

  public tryResolve<T>(token: string): T | undefined {
    return this.entries.has(token) ? this.resolve<T>(token) : undefined;
  }

  public has(token: string): boolean {
    return this.entries.has(token);
  }

  public ownerOf(token: string): string | undefined {
    return this.entries.get(token)?.owner;
  }

  public tokens(): string[] {
    return [...this.entries.keys()].sort();
  }
}

/** What a plugin may do while mounted; everything it does is undone on unmount. */
export interface PluginContext {
  readonly name: string;
  readonly container: ServiceContainer;
  provide<T>(token: string, instance: T): void;
  resolve<T>(token: string): T;
  hook(event: LifecycleHookEvent, handler: HookHandler): void;
  /** Run on unmount, after the plugin's own registrations are released. */
  onDispose(fn: () => void | Promise<void>): void;
}

export interface SekhemetPlugin {
  name: string;
  /** Services this plugin needs before it can mount. */
  requires?: string[];
  apply(ctx: PluginContext): void | Promise<void>;
}

export interface MountedPlugin {
  name: string;
  provides: string[];
  hooks: LifecycleHookEvent[];
}

/**
 * The plugin manager (K10): mounting is reversible and atomic. Every
 * service claim, hook and disposer a plugin makes through its context is
 * recorded; unmount releases them in reverse order, and a plugin whose
 * `apply` throws is rolled back as if it had never mounted.
 */
export class PluginManager {
  private mounted = new Map<
    string,
    { info: MountedPlugin; undo: (() => void | Promise<void>)[] }
  >();

  constructor(
    private container: ServiceContainer,
    private hooks?: LifecycleHookEngine,
  ) {}

  public list(): MountedPlugin[] {
    return [...this.mounted.values()].map((m) => m.info);
  }

  public async mount(plugin: SekhemetPlugin): Promise<MountedPlugin> {
    if (!plugin?.name || typeof plugin.apply !== "function") {
      throw new Error("A plugin needs a name and an apply(ctx) function");
    }
    if (this.mounted.has(plugin.name)) throw new Error(`Plugin ${plugin.name} is already mounted`);
    const missing = (plugin.requires ?? []).filter((t) => !this.container.has(t));
    if (missing.length > 0) {
      throw new Error(`Plugin ${plugin.name} needs ${missing.join(", ")}, which nothing provides`);
    }
    const undo: (() => void | Promise<void>)[] = [];
    const info: MountedPlugin = { name: plugin.name, provides: [], hooks: [] };
    const owner = `plugin:${plugin.name}`;
    const ctx: PluginContext = {
      name: plugin.name,
      container: this.container,
      provide: (token, instance) => {
        undo.push(this.container.register(token, instance, owner));
        info.provides.push(token);
      },
      resolve: (token) => this.container.resolve(token),
      hook: (event, handler) => {
        if (!this.hooks) throw new Error("No hook engine is available to plugins here");
        undo.push(this.hooks.register(event, handler));
        info.hooks.push(event);
      },
      onDispose: (fn) => {
        undo.push(fn);
      },
    };
    try {
      await plugin.apply(ctx);
    } catch (err) {
      await this.runUndo(undo);
      throw new Error(
        `Plugin ${plugin.name} failed to mount and was rolled back: ${err instanceof Error ? err.message : err}`,
      );
    }
    this.mounted.set(plugin.name, { info, undo });
    return info;
  }

  public async unmount(name: string): Promise<boolean> {
    const m = this.mounted.get(name);
    if (!m) return false;
    this.mounted.delete(name);
    await this.runUndo(m.undo);
    return true;
  }

  public async unmountAll(): Promise<void> {
    for (const name of [...this.mounted.keys()].reverse()) await this.unmount(name);
  }

  private async runUndo(undo: (() => void | Promise<void>)[]): Promise<void> {
    for (const fn of [...undo].reverse()) {
      try {
        await fn();
      } catch {
        // One failing disposer must not strand the others.
      }
    }
  }

  /**
   * Mount every plugin in `<dir>/<name>/index.mjs` (or index.js), the
   * project's `.sekhemet/plugins`. Plugins are trusted local code, like
   * hooks. Returns what mounted and what failed.
   */
  public async loadFromDirectory(
    dir: string,
  ): Promise<{ mounted: MountedPlugin[]; errors: string[] }> {
    const mounted: MountedPlugin[] = [];
    const errors: string[] = [];
    if (!existsSync(dir)) return { mounted, errors };
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = ["index.mjs", "index.js"]
        .map((f) => join(dir, entry.name, f))
        .find((f) => existsSync(f));
      if (!file) continue;
      try {
        const mod = (await import(pathToFileURL(file).href)) as { default?: SekhemetPlugin };
        const plugin = mod.default ?? (mod as unknown as SekhemetPlugin);
        mounted.push(await this.mount(plugin));
      } catch (err) {
        errors.push(`${entry.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return { mounted, errors };
  }
}
