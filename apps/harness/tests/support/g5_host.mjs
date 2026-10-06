// The host as the models entry-point tests (C2d, group G5) need it, loaded
// into the spawned binary with `node --import` after `g2_model.ts`'s scripted
// model. Each part is off unless its variable is set:
//
//   G5_PRESSURE    a JSON file {"kernel": 1|2|4, "swapMb": n} the test rewrites
//                  while the command runs: the kernel's memory-pressure level and
//                  the swap in use, as `sysctl` (macOS) or /proc (Linux) report
//                  them to the memory watchdog and the run guard. Nothing else
//                  the host reports is changed.
//   G5_TOTALMEM_GB the installed memory `os.totalmem()` reports.
//   G5_HOLD_FILE   the Worker's first reply is held until this file exists (the
//                  request is answered by the scripted model, recorded, then
//                  returned once the file appears): a step boundary the test
//                  controls.
//   G5_TAGS        a JSON object {model: bytes}: the models Ollama's /api/tags
//                  lists, with their sizes (the scripted model answers every
//                  chat whatever its name).
//   G5_PROMPT_TOKENS the prompt size the engine reports for each Worker request
//                  (`prompt_eval_count`), as a long-context run's would be.
import { createRequire, syncBuiltinESMExports } from "node:module";

const require = createRequire(import.meta.url);
const cp = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");

const realRead = fs.readFileSync;
const realExists = fs.existsSync;
const pressureFile = process.env.G5_PRESSURE;
const state = () => {
  try {
    return JSON.parse(realRead(pressureFile, "utf8"));
  } catch {
    return {};
  }
};

if (pressureFile) {
  const realExecFileSync = cp.execFileSync;
  cp.execFileSync = function execFileSync(cmd, args, opts, ...rest) {
    if (cmd === "sysctl" && Array.isArray(args)) {
      const s = state();
      const text = (t) => (opts && typeof opts === "object" && opts.encoding ? t : Buffer.from(t));
      if (args.includes("kern.memorystatus_vm_pressure_level")) return text(`${s.kernel ?? 1}\n`);
      if (args.includes("vm.swapusage")) {
        const used = Number(s.swapMb ?? 100).toFixed(2);
        return text(`total = 8192.00M  used = ${used}M  free = 4096.00M  (encrypted)\n`);
      }
    }
    return realExecFileSync.call(this, cmd, args, opts, ...rest);
  };
  fs.readFileSync = function readFileSync(path, ...rest) {
    if (path === "/proc/pressure/memory") {
      const k = state().kernel ?? 1;
      const some = k >= 4 ? 50 : k >= 2 ? 15 : 0;
      const t = `some avg10=${some}.00 avg60=0.00 avg300=0.00 total=0\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n`;
      return rest[0] ? t : Buffer.from(t);
    }
    if (path === "/proc/meminfo") {
      const real = String(realRead.call(this, path, "utf8"));
      const total = 8 * 1024 * 1024;
      const free = total - Number(state().swapMb ?? 100) * 1024;
      const t = real
        .replace(/SwapTotal:\s+\d+/, `SwapTotal:      ${total}`)
        .replace(/SwapFree:\s+\d+/, `SwapFree:       ${free}`);
      return rest[0] ? t : Buffer.from(t);
    }
    return realRead.call(this, path, ...rest);
  };
}

if (process.env.G5_TOTALMEM_GB) {
  const bytes = Number(process.env.G5_TOTALMEM_GB) * 1024 ** 3;
  os.totalmem = () => bytes;
}

syncBuiltinESMExports();

const hold = process.env.G5_HOLD_FILE;
const promptTokens = process.env.G5_PROMPT_TOKENS;
const tags = process.env.G5_TAGS;
if (hold || promptTokens || tags) {
  const inner = globalThis.fetch;
  let workerReplies = 0;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (tags && /^http:\/\/127\.0\.0\.1:11434\/api\/(tags|ps)$/.test(url)) {
      // The models this Ollama holds, with their sizes in bytes.
      const models = Object.entries(JSON.parse(tags)).map(([name, size]) => ({
        name,
        model: name,
        size,
      }));
      return new Response(JSON.stringify({ models }), {
        headers: { "content-type": "application/json" },
      });
    }
    let res = await inner(input, init);
    if (!url.startsWith("http://127.0.0.1:11434/api/chat")) return res;
    const tools = (() => {
      try {
        return (JSON.parse(String(init?.body ?? "{}")).tools ?? []).map(
          (t) => t.function?.name ?? t.name,
        );
      } catch {
        return [];
      }
    })();
    if (!tools.includes("finish_card")) return res;
    if (promptTokens) {
      // The Worker's prompt size as the engine reports it.
      const text = await res.text();
      const lines = text
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.stringify({ ...JSON.parse(l), prompt_eval_count: Number(promptTokens) }));
      res = new Response(`${lines.join("\n")}\n`, { headers: res.headers });
    }
    if (!hold || workerReplies++ > 0) return res;
    while (!realExists(hold)) await new Promise((r) => setTimeout(r, 50));
    return res;
  };
}
