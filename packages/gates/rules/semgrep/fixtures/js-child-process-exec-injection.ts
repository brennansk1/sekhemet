import * as cp from "node:child_process";
import { exec, execFile, execSync } from "node:child_process";

export function gitLog(branch: string) {
  // ruleid: sekhemet.js-child-process-exec-injection
  exec(`git log --oneline ${branch}`, (err, out) => console.log(err, out));
}

export function thumbnail(file: string) {
  // ruleid: sekhemet.js-child-process-exec-injection
  return execSync("convert " + file + " -resize 64x64 thumb.png");
}

export function cleanup(dir: string, baseCommand: string) {
  // ruleid: sekhemet.js-child-process-exec-injection
  cp.exec("rm -rf " + dir);
  // ruleid: sekhemet.js-child-process-exec-injection
  const out = execSync(baseCommand + dir);
  return out;
}

export function safe(line: string, pattern: RegExp) {
  // ok: sekhemet.js-child-process-exec-injection
  execFile("git", ["log", "--oneline", line]);
  // ok: sekhemet.js-child-process-exec-injection
  exec("npm ci");
  // ok: sekhemet.js-child-process-exec-injection
  const m = pattern.exec(line + "\n");
  return m;
}
