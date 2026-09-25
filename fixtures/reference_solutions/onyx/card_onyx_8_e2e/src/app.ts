import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "./cli.js";
import { encrypt } from "./crypto.js";
import { runWithSecrets } from "./injector.js";
import { scanDiff } from "./scanner.js";
import { Vault } from "./vault.js";

export interface CliIO {
  dbPath: string;
  passphrase: string;
  cwd: string;
  iterations?: number;
  out: (line: string) => void;
  err: (line: string) => void;
}

/** Run one CLI command and return its exit code. */
export async function runCli(argv: string[], io: CliIO): Promise<number> {
  const command = parseArgs(argv);
  if (command.kind === "error") {
    io.err(command.message);
    return 2;
  }
  if (command.kind === "scan") {
    const diff = execFileSync("git", ["diff", "--cached", "--no-color"], {
      cwd: io.cwd,
      encoding: "utf8",
    });
    const matches = scanDiff(diff);
    for (const m of matches) io.out(`${m.file}:${m.line} ${m.rule}`);
    return matches.length > 0 ? 1 : 0;
  }

  try {
    const vault = new Vault({
      dbPath: io.dbPath,
      passphrase: io.passphrase,
      ...(io.iterations !== undefined ? { iterations: io.iterations } : {}),
    });
    try {
      switch (command.kind) {
        case "set":
          vault.set(command.project, command.key, command.value);
          io.out(`set ${command.key}`);
          return 0;
        case "get": {
          const value = vault.get(command.project, command.key);
          if (value === undefined) {
            io.err(`not found: ${command.key}`);
            return 1;
          }
          io.out(value);
          return 0;
        }
        case "list":
          for (const key of vault.list(command.project)) io.out(key);
          return 0;
        case "run": {
          const result = await runWithSecrets(
            command.command,
            command.args,
            vault.env(command.project),
            { cwd: io.cwd },
          );
          if (result.stdout) io.out(result.stdout);
          if (result.stderr) io.err(result.stderr);
          return result.code ?? 1;
        }
        case "export": {
          const secrets = vault.env(command.project);
          const envelope = encrypt(JSON.stringify(secrets), io.passphrase, io.iterations);
          writeFileSync(resolve(io.cwd, command.out), JSON.stringify(envelope));
          io.out(`exported ${Object.keys(secrets).length} secrets to ${command.out}`);
          return 0;
        }
      }
    } finally {
      vault.close();
    }
  } catch (err) {
    io.err(err instanceof Error ? err.message : String(err));
    return 1;
  }
}
