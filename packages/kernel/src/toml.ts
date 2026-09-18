/**
 * Minimal TOML v1.0 subset parser and serializer.
 *
 * The playbook is a TOML file written and re-read by the harness, so the
 * previous `split(/\[\[rule\]\]/)`-plus-one-regex approach silently corrupted
 * any rule whose instruction contained a newline, a `#`, a quote, or the
 * literal text `[[rule]]`, and dropped every non-string field.
 *
 * Supported: comments, bare and quoted keys, dotted keys, basic strings with
 * escapes, literal strings, multi-line basic and literal strings, integers,
 * floats, booleans, offset/local datetimes (kept as strings), arrays (including
 * nested and multi-line), inline tables, `[table]` headers and `[[array of
 * table]]` headers.
 *
 * Not supported (rejected rather than mis-parsed): mixed-type arithmetic,
 * hex/octal/binary integer literals, and `inf`/`nan`.
 */

export type TomlValue = string | number | boolean | TomlValue[] | TomlTable;
export interface TomlTable {
  [key: string]: TomlValue;
}

export class TomlParseError extends Error {
  public readonly line: number;

  constructor(message: string, line: number) {
    super(`TOML parse error on line ${line}: ${message}`);
    this.name = "TomlParseError";
    this.line = line;
  }
}

const BARE_KEY_CHAR = /[A-Za-z0-9_-]/;
const DATETIME_REGEX =
  /^\d{4}-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})?)?$/;
const TIME_REGEX = /^\d{2}:\d{2}:\d{2}(?:\.\d+)?$/;

class Scanner {
  private readonly src: string;
  private pos = 0;

  constructor(src: string) {
    this.src = src;
  }

  public get lineNumber(): number {
    let line = 1;
    for (let i = 0; i < this.pos && i < this.src.length; i++) {
      if (this.src[i] === "\n") line++;
    }
    return line;
  }

  public eof(): boolean {
    return this.pos >= this.src.length;
  }

  public peek(offset = 0): string {
    return this.src[this.pos + offset] ?? "";
  }

  public startsWith(text: string): boolean {
    return this.src.startsWith(text, this.pos);
  }

  public next(): string {
    const ch = this.src[this.pos] ?? "";
    this.pos++;
    return ch;
  }

  public advance(count: number): void {
    this.pos += count;
  }

  public fail(message: string): never {
    throw new TomlParseError(message, this.lineNumber);
  }

  /** Skips spaces and tabs only. */
  public skipInlineWhitespace(): void {
    while (!this.eof() && (this.peek() === " " || this.peek() === "\t")) this.pos++;
  }

  /** Skips whitespace, newlines and comments. */
  public skipTrivia(): void {
    for (;;) {
      const ch = this.peek();
      if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
        this.pos++;
        continue;
      }
      if (ch === "#") {
        while (!this.eof() && this.peek() !== "\n") this.pos++;
        continue;
      }
      return;
    }
  }

  /** Consumes the rest of a line, allowing only whitespace and a comment. */
  public expectLineEnd(): void {
    this.skipInlineWhitespace();
    if (this.peek() === "#") {
      while (!this.eof() && this.peek() !== "\n") this.pos++;
    }
    if (this.eof()) return;
    const ch = this.peek();
    if (ch === "\n") {
      this.pos++;
      return;
    }
    if (ch === "\r" && this.peek(1) === "\n") {
      this.pos += 2;
      return;
    }
    this.fail(`unexpected trailing content "${ch}"`);
  }
}

function decodeEscape(scanner: Scanner): string {
  const ch = scanner.next();
  switch (ch) {
    case "b":
      return "\b";
    case "t":
      return "\t";
    case "n":
      return "\n";
    case "f":
      return "\f";
    case "r":
      return "\r";
    case '"':
      return '"';
    case "\\":
      return "\\";
    case "u":
    case "U": {
      const width = ch === "u" ? 4 : 8;
      let hex = "";
      for (let i = 0; i < width; i++) hex += scanner.next();
      const code = Number.parseInt(hex, 16);
      if (Number.isNaN(code)) scanner.fail(`invalid unicode escape \\${ch}${hex}`);
      return String.fromCodePoint(code);
    }
    default:
      return scanner.fail(`invalid escape \\${ch}`);
  }
}

function parseMultilineBasicString(scanner: Scanner): string {
  scanner.advance(3);
  // A newline immediately after the opening delimiter is trimmed.
  if (scanner.peek() === "\n") scanner.advance(1);
  else if (scanner.peek() === "\r" && scanner.peek(1) === "\n") scanner.advance(2);

  let out = "";
  for (;;) {
    if (scanner.eof()) scanner.fail("unterminated multi-line basic string");
    if (scanner.startsWith('"""')) {
      // TOML allows up to two extra quotes directly before the delimiter; they
      // belong to the content, the last three close the string.
      let quotes = 0;
      while (scanner.peek(quotes) === '"') quotes++;
      if (quotes > 5) scanner.fail("too many quotes before multi-line delimiter");
      out += '"'.repeat(quotes - 3);
      scanner.advance(quotes);
      return out;
    }
    const ch = scanner.next();
    if (ch === "\\") {
      // Line-ending backslash trims the following whitespace run.
      const lookahead = scanner.peek();
      if (lookahead === "\n" || lookahead === "\r" || lookahead === " " || lookahead === "\t") {
        let i = 0;
        while (" \t".includes(scanner.peek(i))) i++;
        if (
          scanner.peek(i) === "\n" ||
          (scanner.peek(i) === "\r" && scanner.peek(i + 1) === "\n")
        ) {
          scanner.advance(i);
          while (" \t\r\n".includes(scanner.peek()) && !scanner.eof()) scanner.advance(1);
          continue;
        }
      }
      out += decodeEscape(scanner);
      continue;
    }
    out += ch;
  }
}

function parseBasicString(scanner: Scanner): string {
  scanner.advance(1);
  let out = "";
  for (;;) {
    if (scanner.eof()) scanner.fail("unterminated basic string");
    const ch = scanner.next();
    if (ch === '"') return out;
    if (ch === "\n") scanner.fail("newline in basic string");
    if (ch === "\\") {
      out += decodeEscape(scanner);
      continue;
    }
    out += ch;
  }
}

function parseMultilineLiteralString(scanner: Scanner): string {
  scanner.advance(3);
  if (scanner.peek() === "\n") scanner.advance(1);
  else if (scanner.peek() === "\r" && scanner.peek(1) === "\n") scanner.advance(2);

  let out = "";
  for (;;) {
    if (scanner.eof()) scanner.fail("unterminated multi-line literal string");
    if (scanner.startsWith("'''")) {
      scanner.advance(3);
      return out;
    }
    out += scanner.next();
  }
}

function parseLiteralString(scanner: Scanner): string {
  scanner.advance(1);
  let out = "";
  for (;;) {
    if (scanner.eof()) scanner.fail("unterminated literal string");
    const ch = scanner.next();
    if (ch === "'") return out;
    if (ch === "\n") scanner.fail("newline in literal string");
    out += ch;
  }
}

function parseString(scanner: Scanner): string {
  if (scanner.startsWith('"""')) return parseMultilineBasicString(scanner);
  if (scanner.startsWith("'''")) return parseMultilineLiteralString(scanner);
  if (scanner.peek() === '"') return parseBasicString(scanner);
  return parseLiteralString(scanner);
}

function parseKey(scanner: Scanner): string[] {
  const parts: string[] = [];
  for (;;) {
    scanner.skipInlineWhitespace();
    const ch = scanner.peek();
    if (ch === '"' || ch === "'") {
      parts.push(parseString(scanner));
    } else {
      let bare = "";
      while (!scanner.eof() && BARE_KEY_CHAR.test(scanner.peek())) bare += scanner.next();
      if (!bare) scanner.fail("expected a key");
      parts.push(bare);
    }
    scanner.skipInlineWhitespace();
    if (scanner.peek() === ".") {
      scanner.advance(1);
      continue;
    }
    return parts;
  }
}

function parseNumberOrKeyword(scanner: Scanner): TomlValue {
  let raw = "";
  while (!scanner.eof() && !",]}\n\r#".includes(scanner.peek())) raw += scanner.next();
  const token = raw.trim();

  if (token === "true") return true;
  if (token === "false") return false;
  if (DATETIME_REGEX.test(token) || TIME_REGEX.test(token)) return token;

  const normalized = token.replace(/_/g, "");
  if (/^[+-]?\d+$/.test(normalized)) return Number.parseInt(normalized, 10);
  if (/^[+-]?(?:\d+\.\d+(?:[eE][+-]?\d+)?|\d+[eE][+-]?\d+)$/.test(normalized)) {
    return Number.parseFloat(normalized);
  }

  return scanner.fail(`unsupported value "${token}"`);
}

function parseArray(scanner: Scanner): TomlValue[] {
  scanner.advance(1);
  const out: TomlValue[] = [];
  for (;;) {
    scanner.skipTrivia();
    if (scanner.eof()) scanner.fail("unterminated array");
    if (scanner.peek() === "]") {
      scanner.advance(1);
      return out;
    }
    out.push(parseValue(scanner));
    scanner.skipTrivia();
    if (scanner.peek() === ",") {
      scanner.advance(1);
      continue;
    }
    if (scanner.peek() === "]") {
      scanner.advance(1);
      return out;
    }
    scanner.fail("expected , or ] in array");
  }
}

function parseInlineTable(scanner: Scanner): TomlTable {
  scanner.advance(1);
  const table: TomlTable = {};
  scanner.skipInlineWhitespace();
  if (scanner.peek() === "}") {
    scanner.advance(1);
    return table;
  }
  for (;;) {
    const key = parseKey(scanner);
    scanner.skipInlineWhitespace();
    if (scanner.next() !== "=") scanner.fail("expected = in inline table");
    scanner.skipInlineWhitespace();
    setPath(table, key, parseValue(scanner), scanner);
    scanner.skipInlineWhitespace();
    const ch = scanner.next();
    if (ch === ",") {
      scanner.skipInlineWhitespace();
      continue;
    }
    if (ch === "}") return table;
    scanner.fail("expected , or } in inline table");
  }
}

function parseValue(scanner: Scanner): TomlValue {
  const ch = scanner.peek();
  if (ch === '"' || ch === "'") return parseString(scanner);
  if (ch === "[") return parseArray(scanner);
  if (ch === "{") return parseInlineTable(scanner);
  return parseNumberOrKeyword(scanner);
}

function isTable(value: TomlValue | undefined): value is TomlTable {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function setPath(table: TomlTable, path: string[], value: TomlValue, scanner: Scanner): void {
  let cursor = table;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i] ?? "";
    const existing = cursor[key];
    if (existing === undefined) {
      const created: TomlTable = {};
      cursor[key] = created;
      cursor = created;
    } else if (isTable(existing)) {
      cursor = existing;
    } else if (Array.isArray(existing) && isTable(existing[existing.length - 1])) {
      cursor = existing[existing.length - 1] as TomlTable;
    } else {
      scanner.fail(`cannot redefine "${key}" as a table`);
    }
  }
  const last = path[path.length - 1] ?? "";
  cursor[last] = value;
}

function resolveTablePath(root: TomlTable, path: string[], scanner: Scanner): TomlTable {
  let cursor = root;
  for (const key of path) {
    const existing = cursor[key];
    if (existing === undefined) {
      const created: TomlTable = {};
      cursor[key] = created;
      cursor = created;
    } else if (isTable(existing)) {
      cursor = existing;
    } else if (Array.isArray(existing) && isTable(existing[existing.length - 1])) {
      cursor = existing[existing.length - 1] as TomlTable;
    } else {
      scanner.fail(`cannot use "${key}" as a table`);
    }
  }
  return cursor;
}

function appendArrayTable(root: TomlTable, path: string[], scanner: Scanner): TomlTable {
  const parent = resolveTablePath(root, path.slice(0, -1), scanner);
  const key = path[path.length - 1] ?? "";
  const existing = parent[key];
  const created: TomlTable = {};
  if (existing === undefined) {
    parent[key] = [created];
    return created;
  }
  if (Array.isArray(existing)) {
    existing.push(created);
    return created;
  }
  return scanner.fail(`cannot append to non-array "${key}"`);
}

export function parseToml(src: string): TomlTable {
  const scanner = new Scanner(src.replace(/^﻿/, ""));
  const root: TomlTable = {};
  let current = root;

  for (;;) {
    scanner.skipTrivia();
    if (scanner.eof()) return root;

    if (scanner.startsWith("[[")) {
      scanner.advance(2);
      const path = parseKey(scanner);
      scanner.skipInlineWhitespace();
      if (!scanner.startsWith("]]")) scanner.fail("expected ]] after array-of-table header");
      scanner.advance(2);
      scanner.expectLineEnd();
      current = appendArrayTable(root, path, scanner);
      continue;
    }

    if (scanner.peek() === "[") {
      scanner.advance(1);
      const path = parseKey(scanner);
      scanner.skipInlineWhitespace();
      if (scanner.peek() !== "]") scanner.fail("expected ] after table header");
      scanner.advance(1);
      scanner.expectLineEnd();
      current = resolveTablePath(root, path, scanner);
      continue;
    }

    const key = parseKey(scanner);
    scanner.skipInlineWhitespace();
    if (scanner.next() !== "=") scanner.fail(`expected = after key "${key.join(".")}"`);
    scanner.skipInlineWhitespace();
    const value = parseValue(scanner);
    setPath(current, key, value, scanner);
    scanner.expectLineEnd();
  }
}

/** Escapes a string for a TOML basic string, newlines and quotes included. */
export function escapeTomlString(value: string): string {
  let out = "";
  for (const ch of value) {
    switch (ch) {
      case "\\":
        out += "\\\\";
        break;
      case '"':
        out += '\\"';
        break;
      case "\n":
        out += "\\n";
        break;
      case "\r":
        out += "\\r";
        break;
      case "\t":
        out += "\\t";
        break;
      default: {
        const code = ch.codePointAt(0) ?? 0;
        out += code < 0x20 || code === 0x7f ? `\\u${code.toString(16).padStart(4, "0")}` : ch;
      }
    }
  }
  return `"${out}"`;
}

/** Serializes a scalar, array or inline table back to TOML. */
export function formatTomlValue(value: TomlValue): string {
  if (typeof value === "string") return escapeTomlString(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : String(value);
  if (Array.isArray(value)) return `[${value.map(formatTomlValue).join(", ")}]`;
  const entries = Object.entries(value).map(([k, v]) => `${k} = ${formatTomlValue(v)}`);
  return `{ ${entries.join(", ")} }`;
}
