// Copyright (c) 2025 Bytedance Ltd. and/or its affiliates
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
//
// CHANGED FILE (Apache-2.0 §4(b)): ported to plain JavaScript for Sekhemet's
// capstone (W2b G3, 2026-09-29) from Web-Bench commit 7b31ca2b:
// - tools/bench-agent/src/prompt/index.ts (`getSystemMessage`, unchanged text);
// - tools/bench-agent/src/agent.ts (`getMessages`: its text parts, joined into
//   one message, because the grid's one-shot cells take one prompt string);
// - tools/bench-agent/src/utils/markdown.ts (`parseMarkdownCodeBlocks`,
//   `isFileName`, `trimNewlines`, unchanged logic);
// - tools/evaluator/src/utils/report.ts (`getPassCounts`, `getErrorCounts`);
// - tools/evaluator/src/utils/error.ts and string.ts (`prettierErrorMessage`,
//   `clearErrorMsg`, `filterNumberStartString`; ANSI stripped by Node's own
//   `stripVTControlCharacters` in place of the `strip-ansi` package, and each
//   directory matched literally).
// This file is a derivative work of Web-Bench and stays under the Apache
// License 2.0, not this repository's licence: the notice above is kept, and
// the licence's text is beside it (`webbench_agent.LICENSE.md`, Web-Bench's
// own LICENSE.md at that commit). No Web-Bench test, task text or reference solution is in
// it: only these functions, changed as listed, for running its protocol the
// way its evaluator and agent do.

import { stripVTControlCharacters } from "node:util";

/** The system message of Web-Bench's bench-agent, byte for byte. */
export function getSystemMessage() {
  const rules = [
    "Always produce a single code block.",
    "Never separate the code into multiple code blocks.",
    "Only include the code that is being added.",
    "No explanation, no issue, only code.",
    "Never omit any code.",
    "If the user submits a code block that contains a filename in the language specifier, always include the filename in any code block you generate based on that file. The filename should be on the next line as the language specifier in your code block.",
    "Don't repeat filename in code block",
  ];

  return `
# Rules
When generating new code:
${rules.map((v, i) => `${i + 1}. ${v}`)}

Always follow these guidelines when generating code responses.

# Example

Here is an example of response:

<example>
\`\`\`html
file_a.html
<div>file_a</div>
\`\`\`
\`\`\`typescript
sub_dir/file_b.ts
console.log("file_b")
\`\`\`
</example>

Here are some error examples of response:

1. repeated filenames
<example>
\`\`\`javascript
index.js
index.js
window.addEventListener('DOMContentLoaded', () => {
    console.log('Dark mode page loaded');
});
\`\`\`
</example>

2. without filename
<example>
\`\`\`javascript
window.addEventListener('DOMContentLoaded', () => {
    console.log('Dark mode page loaded');
});
\`\`\`
</example>
`;
}

/** Between the parts of bench-agent's one user message, which it sends as separate text parts. */
export const PART_SEPARATOR = "\n\n";

/**
 * bench-agent's user message for one attempt: every file of the tree as a
 * code block, the task, then either its "code only" line or, on a retry, its
 * sentence carrying the error output. Returns the parts and them joined.
 */
export function getMessageParts({ files = {}, task, error }) {
  const parts = [];
  for (const filePath of Object.keys(files)) {
    parts.push(`\`\`\`${filePath}\n${files[filePath]}\n\`\`\``);
  }
  parts.push(`${task} \n Do not compress the original code in file and return full file.`);
  if (error) {
    parts.push(
      `I got the following error, please help me to fix error and apply changes to origin files, return the full files about  ${Object.keys(files).join()} for me. And always include filename with the absolute path in any code block you generate based on that file. \n${error}`,
    );
  } else {
    parts.push("I only want the returned results to contain code, without any explanations.");
  }
  return parts;
}

const MARKDOWN_LANGUAGES = [
  "javascript",
  "js",
  "typescript",
  "ts",
  "python",
  "py",
  "java",
  "cpp",
  "c++",
  "csharp",
  "c#",
  "php",
  "ruby",
  "rb",
  "go",
  "rust",
  "swift",
  "kotlin",
  "scala",
  "html",
  "css",
  "scss",
  "sass",
  "less",
  "jsx",
  "tsx",
  "vue",
  "svelte",
  "xml",
  "json",
  "yaml",
  "yml",
  "stylus",
  "styl",
  "pug",
  "ejs",
  "bash",
  "shell",
  "powershell",
  "batch",
  "sql",
  "markdown",
  "md",
  "tex",
  "latex",
  "diff",
  "ini",
  "toml",
  "dockerfile",
  "text",
  "plaintext",
  "diff",
  "console",
  "none",
];

export function trimNewlines(str) {
  return str.replace(/^[\n\r]+|[\n\r]+$/g, "");
}

export function isFileName(str) {
  const fileNamePattern = /^[[\]\w,\s-]*(\.[A-Za-z]+)+$/;
  const pathFilePattern = /^(.+\/)?([^/]+)$/;
  if (fileNamePattern.test(str)) return true;
  if (pathFilePattern.test(str)) {
    const fileName = str.split("/").pop();
    return fileName ? fileNamePattern.test(fileName) : false;
  }
  return false;
}

/** bench-agent's reading of a reply: every fenced block, its language and file name. */
export function parseMarkdownCodeBlocks(markdown) {
  const codeBlockRegex = /```([\s\S]+?)```/g;
  const codeBlocks = [];
  let match = codeBlockRegex.exec(markdown);
  while (match !== null) {
    const content = match[1] || "\n";
    const lines = trimNewlines(content).split("\n");
    let language = "";
    if (MARKDOWN_LANGUAGES.includes(lines[0])) language = lines.shift() || "";
    let filename = "";
    const first = lines[0] ?? "";
    if (isFileName(first.startsWith("/") ? first.substring(1) : first)) {
      filename = lines.shift() || "";
    } else if (isFileName(lines[lines.length - 1] ?? "")) {
      filename = lines.pop() || "";
    }
    if (!language && filename) language = filename.split(".").pop() || "";
    codeBlocks.push({
      language,
      filename: filename.startsWith("/") ? filename.substring(1) : filename,
      code: lines.join("\n"),
    });
    match = codeBlockRegex.exec(markdown);
  }
  return codeBlocks;
}

/**
 * Web-Bench's pass counts: for pass@k, the index of the first task whose
 * first k attempts all failed (the tasks passed before it), or every task.
 * `results` is one array of attempt outcomes (booleans) per task given.
 */
export function getPassCounts(results, allTaskCount, retry) {
  return Array.from({ length: retry }, (_, n) => {
    const firstN = results.map((r) => r.slice(0, Math.min(n + 1, r.length)));
    const failIndex = firstN.findIndex((r) => r.every((ok) => !ok));
    return failIndex === -1 ? allTaskCount : failIndex;
  });
}

/** Web-Bench's error counts: error@k is the tasks with a failure among their first k attempts (k < retry). */
export function getErrorCounts(results, retry) {
  const counts = Array.from({ length: retry }, (_, n) => {
    const firstN = results.map((r) => r.slice(0, Math.min(n + 1, r.length)));
    return firstN.filter((r) => r.some((ok) => !ok)).length;
  });
  counts.pop();
  return counts;
}

/** A percentage as Web-Bench reports it: two decimals. */
export function rate(count, allTaskCount) {
  return +((count / allTaskCount) * 100).toFixed(2);
}

/** ANSI escapes removed, as `strip-ansi` does: Node's own `stripVTControlCharacters`. */
export function stripAnsi(text) {
  return stripVTControlCharacters(text);
}

/** A Playwright progress line (`[1/20] ...`), which Web-Bench drops. */
export function filterNumberStartString(str) {
  return /^\[\d+\/\d+\]/.test(str);
}

/** Every occurrence of each directory replaced by `.`, so no absolute path reaches an arm. */
export function clearErrorMsg(error, dirs) {
  let res = error;
  for (const dir of dirs) {
    if (!dir) continue;
    res = res.split(dir).join(".");
  }
  return res;
}

/** Web-Bench's cleaning of a failed test run's output: ANSI, progress lines, `<` lines and blanks dropped. */
export function prettierErrorMessage(errorMsg, dirs) {
  let out = stripAnsi(errorMsg);
  if (out) {
    out = out
      .split("\n")
      .filter((v) => !filterNumberStartString(v) && !v.startsWith("<") && Boolean(v.trim()))
      .join("\n");
  }
  return dirs ? clearErrorMsg(out, dirs) : out;
}
