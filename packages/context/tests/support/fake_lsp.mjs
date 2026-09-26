// A minimal language server over stdio (Content-Length framing) for tests.
// definition -> the first line in the file containing "export function <word>"
// references -> every line containing the word under the cursor.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

let buf = Buffer.alloc(0);
const docs = new Map();
const send = (msg) => {
  const body = JSON.stringify({ jsonrpc: "2.0", ...msg });
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
};
const wordAt = (text, line, ch) => {
  const l = text.split("\n")[line] ?? "";
  let s = ch;
  let e = ch;
  while (s > 0 && /\w/.test(l[s - 1])) s--;
  while (e < l.length && /\w/.test(l[e])) e++;
  return l.slice(s, e);
};
let initOptions = null;
let root = process.cwd();
let config = null;
let nextId = 1000;
const handle = (m) => {
  // A reply to the configuration request this server sent the client.
  if (m.id !== undefined && m.method === undefined) {
    config = m.result ?? null;
    return;
  }
  if (m.method === "initialize") {
    initOptions = m.params.initializationOptions ?? null;
    root = fileURLToPath(m.params.rootUri);
    return send({ id: m.id, result: { capabilities: {} } });
  }
  if (m.method === "initialized") {
    // As pyright does: ask the client for its settings.
    return send({
      id: nextId++,
      method: "workspace/configuration",
      params: { items: [{ section: "python.analysis" }, { section: "unknown.section" }] },
    });
  }
  if (m.method === "sekhemet/echo") {
    return send({
      id: m.id,
      result: { nodeOptions: process.env.NODE_OPTIONS ?? null, initOptions, config },
    });
  }
  if (m.method === "textDocument/rename") {
    const uri = m.params.textDocument.uri;
    const text = docs.get(uri) ?? readFileSync(fileURLToPath(uri), "utf8");
    const word = wordAt(text, m.params.position.line, m.params.position.character);
    const re = new RegExp(`\\b${word}\\b`, "g");
    // A project-wide rename: every file of the same language under the workspace naming the word.
    const sameLanguage = /\.py$/.test(uri) ? /\.py$/ : /\.[jt]sx?$/;
    const changes = {};
    const walk = (dir) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.name === "node_modules" || e.name.startsWith(".")) continue;
        const abs = join(dir, e.name);
        if (e.isDirectory()) walk(abs);
        else if (sameLanguage.test(e.name)) {
          const u = pathToFileURL(abs).href;
          const body = docs.get(u) ?? readFileSync(abs, "utf8");
          const edits = [];
          body.split("\n").forEach((l, i) => {
            for (const hit of l.matchAll(re)) {
              // A shorthand property `return { word }` keeps its shape: `{ newName: word }`.
              const shorthand =
                l.slice(0, hit.index).endsWith("return { ") &&
                l.slice(hit.index + word.length).startsWith(" }");
              edits.push({
                range: {
                  start: { line: i, character: hit.index },
                  end: { line: i, character: hit.index + word.length },
                },
                newText: shorthand ? `${m.params.newName}: ${word}` : m.params.newName,
              });
            }
          });
          if (edits.length) changes[u] = edits;
        }
      }
    };
    walk(root);
    return send({ id: m.id, result: { changes } });
  }
  if (m.method === "textDocument/didOpen")
    return docs.set(m.params.textDocument.uri, m.params.textDocument.text);
  if (m.method === "textDocument/didChange")
    return docs.set(m.params.textDocument.uri, m.params.contentChanges[0].text);
  if (m.method === "shutdown") return send({ id: m.id, result: null });
  if (m.method === "exit") process.exit(0);
  if (m.method === "textDocument/definition" || m.method === "textDocument/references") {
    const uri = m.params.textDocument.uri;
    const text = docs.get(uri) ?? readFileSync(fileURLToPath(uri), "utf8");
    const word = wordAt(text, m.params.position.line, m.params.position.character);
    const lines = text.split("\n");
    const hits = [];
    lines.forEach((l, i) => {
      const col = l.indexOf(word);
      if (col < 0) return;
      if (m.method === "textDocument/definition" && !l.includes(`function ${word}`)) return;
      hits.push({
        uri,
        range: {
          start: { line: i, character: col },
          end: { line: i, character: col + word.length },
        },
      });
    });
    return send({
      id: m.id,
      result: m.method === "textDocument/definition" ? (hits[0] ?? null) : hits,
    });
  }
  if (m.id !== undefined) send({ id: m.id, error: { code: -32601, message: `no ${m.method}` } });
};
process.stdin.on("data", (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  for (;;) {
    const h = buf.indexOf("\r\n\r\n");
    if (h < 0) return;
    const len = Number(/Content-Length: (\d+)/i.exec(buf.subarray(0, h).toString())[1]);
    if (buf.length < h + 4 + len) return;
    const body = buf.subarray(h + 4, h + 4 + len).toString();
    buf = buf.subarray(h + 4 + len);
    handle(JSON.parse(body));
  }
});
