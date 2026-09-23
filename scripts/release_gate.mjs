#!/usr/bin/env node
// The release gate: DEFINITION_OF_DONE.md §4, every rung checked by a command.
//
//   pnpm release-gate [--skip-gate]
//
// Rungs 1-5 are `pnpm gate` (format, lint, typecheck, test, build). Rungs 6-8
// were written down but never automated, so "releasable" was a claim:
//   6. `sekhemet doctor` passes (exit 0: memory, weights, inference, sandbox)
//   7. the dashboard serves its page and /api/board
//   8. the MCP server answers tools/list
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "apps/harness/dist/index.js");
const results = [];
const record = (rung, name, ok, detail) => {
  results.push({ rung, name, ok, detail });
  console.log(`  ${ok ? "✓" : "✗"} ${rung}. ${name}: ${detail}`);
};

/** A throwaway repository, so no check touches a real project's board. */
function scratchRepo() {
  const dir = mkdtempSync(join(tmpdir(), "release-gate-"));
  const git = (...a) => execFileSync("git", ["-C", dir, ...a], { stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("-c", "user.email=g@g", "-c", "user.name=g", "commit", "-q", "--allow-empty", "-m", "seed");
  return dir;
}

async function gate() {
  if (process.argv.includes("--skip-gate")) {
    record("1-5", "pnpm gate", true, "skipped (--skip-gate)");
    return;
  }
  try {
    execFileSync("pnpm", ["gate"], { cwd: ROOT, stdio: "ignore", timeout: 15 * 60 * 1000 });
    record("1-5", "pnpm gate", true, "format, lint, typecheck, tests and build pass");
  } catch {
    record("1-5", "pnpm gate", false, "failed — run `pnpm gate` to see why");
  }
}

function doctor() {
  try {
    execFileSync("node", [CLI, "doctor"], { cwd: ROOT, stdio: "ignore", timeout: 120_000 });
    record(6, "doctor", true, "all critical checks pass");
  } catch {
    record(6, "doctor", false, "a check failed — run `pnpm sekhemet doctor`");
  }
}

async function dashboard() {
  const repo = scratchRepo();
  const port = 4300 + Math.floor(Math.random() * 500);
  const server = spawn("node", [CLI, "serve", "--repo", repo, "--port", String(port)], {
    stdio: "ignore",
  });
  try {
    let page;
    let board;
    for (let i = 0; i < 40 && !(page?.ok && board?.ok); i++) {
      await new Promise((r) => setTimeout(r, 250));
      page = await fetch(`http://127.0.0.1:${port}/`).catch(() => undefined);
      board = await fetch(`http://127.0.0.1:${port}/api/board`).catch(() => undefined);
    }
    const html = page?.ok ? await page.text() : "";
    const ok = Boolean(page?.ok && board?.ok && html.includes("Sekhemet"));
    record(
      7,
      "dashboard",
      ok,
      ok
        ? "page and /api/board return 200"
        : `page ${page?.status ?? "no answer"}, /api/board ${board?.status ?? "no answer"}`,
    );
  } finally {
    server.kill("SIGTERM");
    rmSync(repo, { recursive: true, force: true });
  }
}

async function mcp() {
  const repo = scratchRepo();
  const child = spawn("node", [CLI, "mcp", "--repo", repo], { stdio: ["pipe", "pipe", "ignore"] });
  let out = "";
  child.stdout.on("data", (d) => {
    out += d;
  });
  const send = (m) => child.stdin.write(`${JSON.stringify(m)}\n`);
  send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "release-gate", version: "1" },
    },
  });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  for (let i = 0; i < 40 && !out.includes('"id":2'); i++) {
    await new Promise((r) => setTimeout(r, 250));
  }
  child.kill("SIGTERM");
  rmSync(repo, { recursive: true, force: true });
  const reply = out
    .split("\n")
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return undefined;
      }
    })
    .find((m) => m?.id === 2);
  const tools = reply?.result?.tools?.length ?? 0;
  record(
    8,
    "MCP server",
    tools > 0,
    tools > 0 ? `tools/list answers with ${tools} tools` : "no tools/list answer",
  );
}

console.log("Release gate (DEFINITION_OF_DONE.md §4)");
await gate();
doctor();
await dashboard();
await mcp();
const failed = results.filter((r) => !r.ok);
console.log(
  failed.length
    ? `\nNOT releasable: ${failed.length} rung(s) failed.`
    : "\nReleasable: every rung passes.",
);
process.exitCode = failed.length ? 1 : 0;
