/**
 * The capstone's showcase (W2 G5; owner, 2026-09-29): every arm's finished
 * app, captured at the same fixed views with the same seeded data, for the
 * public repository.
 *
 * For one run it copies the finished tree (without `.git`, installed
 * packages, build output or data) to a fresh directory, installs and builds
 * it, starts it the way the technical notes say (`npm start`, `PORT`, a fresh
 * `DATA_DIR`, the host clock in UTC), loads the same data through the HTTP
 * API of the interface contract, and captures each view at 1440 and 400
 * pixels wide with the visual gate's own headless Chromium (`CdpBrowser`,
 * confined; nothing is downloaded). Each view is also checked with the visual
 * gate's WCAG subset. An app that does not install, build or start gets a
 * screenshot of its failure with the log excerpt, as its error state, and
 * every other view is recorded as not captured and why: nothing is skipped
 * silently.
 *
 *   node scripts/capstone/screenshots.mjs --arm <id> --run <n> [--tree <dir>] [--out <dir>]
 *   node scripts/capstone/screenshots.mjs --readme      the comparison page, from every run captured
 */
import { spawn, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ARMS, REPO_ROOT, arm as armOf, runPaths } from "./grid.mjs";

export const SHOWCASE = join(REPO_ROOT, "docs", "showcase", "capstone");
export const WIDTHS = [1440, 400];
const HEIGHTS = { 1440: 900, 400: 860 };
/** The tallest a capture may be, so a page stays a GitHub-sized image. */
export const MAX_HEIGHT = 2400;

/** The week every view shows: Sunday 4 October 2026, Pacific daylight time (-07:00). */
export const WEEK = "2026-10-04";
const NOT_A_SUNDAY = "2026-10-05";

/** The fixed views, in order; `path` gets the seeded people's ids. */
export const VIEWS = [
  {
    id: "manager-grid",
    title: "The manager's timesheet grid",
    path: (p) => `/week/${WEEK}?as=${p.manager}`,
  },
  { id: "employee-view", title: "The employee's view", path: (p) => `/week/${WEEK}?as=${p.ben}` },
  {
    id: "federal-overtime",
    title: "A week with federal overtime",
    path: (p) => `/timesheet/${p.ana}/${WEEK}?as=${p.manager}`,
  },
  {
    id: "california",
    title: "The California case after the change",
    path: (p) => `/timesheet/${p.chloe}/${WEEK}?as=${p.manager}`,
  },
  { id: "csv-export", title: "The payroll CSV export", csv: true },
  {
    id: "error-state",
    title: "An error state (a week name that is not a Sunday)",
    path: (p) => `/week/${NOT_A_SUNDAY}?as=${p.manager}`,
  },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolvePort, reject) => {
    const s = net.createServer();
    s.unref();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolvePort(port));
    });
  });
}

function copyTree(from, to) {
  cpSync(from, to, {
    recursive: true,
    filter: (src) => {
      const rel = relative(from, src);
      if (rel === "") return true;
      const parts = rel.split(sep);
      if (parts.includes(".git") || parts.includes("node_modules")) return false;
      return !(parts.length === 1 && (parts[0] === "dist" || parts[0] === "data"));
    },
  });
}

const baseEnv = () => ({
  PATH: process.env.PATH ?? "",
  HOME: process.env.HOME ?? "",
  TMPDIR: process.env.TMPDIR ?? tmpdir(),
});
const tail = (text, lines = 40) => text.split("\n").slice(-lines).join("\n").slice(-4000);

/**
 * Install, build and start a finished tree in a scratch copy under
 * `scratchRoot` (the shared temp directory by default; the sealed scratch
 * root beside the hidden suite, `<hidden>-scratch`, for the sealed
 * reference). Resolves to
 * `{ base, stop, scratch }`, or `{ failure: { stage, log } }` when a step
 * failed; the scratch directory is removed on failure and by `stop`.
 */
export async function startApp(tree, { startTimeoutMs = 30_000, scratchRoot = tmpdir() } = {}) {
  mkdirSync(scratchRoot, { recursive: true });
  const scratch = mkdtempSync(join(scratchRoot, "capstone-shots-"));
  const app = join(scratch, "app");
  const fail = (stage, log) => {
    rmSync(scratch, { recursive: true, force: true });
    return { failure: { stage, log: tail(log) } };
  };
  copyTree(tree, app);
  if (!existsSync(join(app, "package.json")))
    return fail("install", "the tree has no package.json");
  const lock = existsSync(join(app, "package-lock.json"));
  const install = spawnSync(
    "npm",
    [lock ? "ci" : "install", "--no-audit", "--no-fund", "--prefer-offline"],
    { cwd: app, env: baseEnv(), encoding: "utf8", timeout: 15 * 60_000 },
  );
  if (install.status !== 0) return fail("install", `${install.stdout}${install.stderr}`);
  const build = spawnSync("npm", ["run", "build"], {
    cwd: app,
    env: baseEnv(),
    encoding: "utf8",
    timeout: 10 * 60_000,
  });
  if (build.status !== 0) return fail("build", `${build.stdout}${build.stderr}`);
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const proc = spawn("npm", ["start", "--silent"], {
    cwd: app,
    env: { ...baseEnv(), TZ: "UTC", PORT: String(port), DATA_DIR: join(scratch, "data") },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let exited = null;
  proc.stdout.on("data", (d) => {
    output = (output + d).slice(-8000);
  });
  proc.stderr.on("data", (d) => {
    output = (output + d).slice(-8000);
  });
  proc.on("exit", (code, signal) => {
    exited = { code, signal };
  });
  const stop = async () => {
    try {
      process.kill(-proc.pid, "SIGTERM");
    } catch {
      // Already gone.
    }
    for (let i = 0; i < 30 && !exited; i += 1) await sleep(100);
    try {
      process.kill(-proc.pid, "SIGKILL");
    } catch {
      // Already gone.
    }
    rmSync(scratch, { recursive: true, force: true });
  };
  const deadline = Date.now() + startTimeoutMs;
  while (Date.now() < deadline) {
    if (exited) {
      await stop();
      return {
        failure: {
          stage: "start",
          log: tail(
            `the app stopped (exit ${exited.code ?? exited.signal}) before it answered\n${output}`,
          ),
        },
      };
    }
    try {
      const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1000) });
      if (res.ok) return { base, port, stop, log: () => output };
    } catch {
      // Not listening yet.
    }
    await sleep(200);
  }
  await stop();
  return {
    failure: {
      stage: "start",
      log: tail(`the app did not answer /api/health within ${startTimeoutMs / 1000} s\n${output}`),
    },
  };
}

/** Local time in the Pacific week of 4 October 2026 (PDT, -07:00). */
const at = (day, hhmm) => `2026-10-${String(day).padStart(2, "0")}T${hhmm}:00-07:00`;

/**
 * The same data for every arm, through the interface contract only: a
 * manager (by first-run setup) and a second manager, three employees (one in
 * California, given after the change), a week of shifts each, and every
 * timesheet sent in and approved. Every step's HTTP status is recorded; a
 * refused step is recorded and never retried with other data.
 */
export async function seedData(base) {
  const steps = [];
  const call = async (what, method, path, body, as) => {
    let status = 0;
    let json = null;
    try {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: { "Content-Type": "application/json", ...(as ? { "X-User-Id": as } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(10_000),
      });
      status = res.status;
      json = await res.json().catch(() => null);
    } catch (err) {
      json = { error: String(err) };
    }
    steps.push({ what, status });
    return { status, json };
  };
  const people = {};
  const setup = await call("first-run setup: Marisol Hollis, manager", "POST", "/api/setup", {
    name: "Marisol Hollis",
    hourlyRateCents: 3200,
  });
  people.manager = setup.json?.id ?? "unknown-manager";
  const add = async (key, body) => {
    const r = await call(
      `add ${body.name} (${body.role}${body.state ? `, ${body.state}` : ""})`,
      "POST",
      "/api/people",
      body,
      people.manager,
    );
    people[key] = r.json?.id ?? `unknown-${key}`;
  };
  await add("dana", { name: "Dana Okafor", role: "manager", hourlyRateCents: 2900 });
  await add("ana", { name: "Ana Reyes", role: "employee", hourlyRateCents: 1850 });
  await add("ben", { name: "Ben Carter", role: "employee", hourlyRateCents: 1700 });
  await add("chloe", {
    name: "Chloé Martin",
    role: "employee",
    hourlyRateCents: 1900,
    state: "CA",
  });
  const shift = (key, day, start, end, note) =>
    call(
      `shift for ${key}, 2026-10-${String(day).padStart(2, "0")} ${start}-${end}`,
      "POST",
      "/api/shifts",
      {
        personId: people[key],
        start: at(day, start),
        end: at(day, end),
        ...(note ? { note } : {}),
      },
      people.manager,
    );
  // Ana: 8 h 48 min, Monday to Friday: 44 hours, 4 of them federal overtime.
  for (const day of [5, 6, 7, 8, 9]) await shift("ana", day, "06:00", "14:48");
  // Ben: 7 h 36 min, Monday to Friday: 38 hours, no overtime.
  for (const day of [5, 6, 7, 8, 9]) await shift("ben", day, "07:00", "14:36");
  // Chloé (California): all seven days; 13 hours on Monday; 9 on the seventh day.
  await shift("chloe", 4, "06:00", "10:00");
  await shift("chloe", 5, "05:00", "18:00", "Wedding order");
  for (const day of [6, 7, 8, 9]) await shift("chloe", day, "06:00", "14:00");
  await shift("chloe", 10, "06:00", "15:00");
  for (const key of ["ana", "ben", "chloe"]) {
    const sheet = await call(
      `read ${key}'s timesheet`,
      "GET",
      `/api/timesheets/${people[key]}/${WEEK}`,
      null,
      people.manager,
    );
    const submitted = await call(
      `send in ${key}'s timesheet`,
      "POST",
      `/api/timesheets/${people[key]}/${WEEK}/submit`,
      { version: sheet.json?.version ?? 0 },
      people[key],
    );
    await call(
      `approve ${key}'s timesheet`,
      "POST",
      `/api/timesheets/${people[key]}/${WEEK}/approve`,
      { version: submitted.json?.version ?? 0 },
      people.manager,
    );
  }
  const csv = await fetch(`${base}/api/export.csv?week=${WEEK}`, {
    headers: { "X-User-Id": people.manager },
    signal: AbortSignal.timeout(10_000),
  })
    .then(async (r) => ({
      status: r.status,
      type: r.headers.get("content-type"),
      body: await r.text(),
    }))
    .catch((err) => ({ status: 0, type: null, body: String(err) }));
  steps.push({ what: "read the payroll CSV", status: csv.status });
  return { people, steps, csv };
}

const escapeHtml = (s) =>
  String(s).replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );

function neutralPage(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(title)}</title><style>body{font:15px/1.45 system-ui,sans-serif;margin:24px;color:#1b1b1b;background:#fff}h1{font-size:18px}pre{white-space:pre-wrap;word-break:break-all;background:#f4f4f4;padding:12px;border:1px solid #ddd;font:13px/1.4 ui-monospace,monospace}p.note{color:#555}</style></head><body>${body}</body></html>`;
}

/** The CSV exactly as the app returned it, shown on a neutral page (a browser tab cannot send `X-User-Id`). */
export function csvPage(csv) {
  return neutralPage(
    "The payroll CSV",
    `<h1>GET /api/export.csv?week=${WEEK}</h1><p class="note">HTTP ${csv.status}; Content-Type ${escapeHtml(csv.type ?? "(none)")}. The body, exactly as returned (line endings shown as ↵):</p><pre>${escapeHtml(csv.body.replace(/\r\n/g, "↵\n"))}</pre>`,
  );
}

/** The page an app that does not run gets: what failed, and the end of its log. */
export function failurePage(failure) {
  return neutralPage(
    "The app did not start",
    `<h1>The app did not ${failure.stage === "start" ? "start" : failure.stage === "build" ? "build" : "install"}</h1><p class="note">npm ${failure.stage === "install" ? "ci" : failure.stage === "build" ? "run build" : "start"} failed. The last lines of its output:</p><pre>${escapeHtml(failure.log)}</pre>`,
  );
}

/**
 * The capturer with the visual gate's Chromium: one confined browser for
 * the run; each capture sets the width, loads the page (or the given HTML),
 * freezes animations, sizes the viewport to the page up to MAX_HEIGHT and
 * takes a PNG, and runs the WCAG subset on it.
 */
export async function chromiumCapturer({ localPorts = [] } = {}) {
  const gates = await import(
    pathToFileURL(join(REPO_ROOT, "packages", "gates", "dist", "index.js")).href
  );
  let why = "no local Chromium (set SEKHEMET_CHROME)";
  const browser = await gates.CdpBrowser.launch(undefined, {
    localPorts,
    onFailure: (reason) => {
      why = reason;
    },
  });
  if (!browser) throw new Error(`the screenshots need the visual gate's Chromium: ${why}`);
  return {
    name: "the visual gate's headless Chromium",
    capture: async ({ url, html, width }) => {
      const page = await browser.newPage();
      await page.setViewport(width, HEIGHTS[width] ?? 900);
      await page.goto(
        url ?? `data:text/html;charset=utf-8;base64,${Buffer.from(html).toString("base64")}`,
      );
      await page.freeze();
      const height = await page.evaluate(
        "Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0)",
      );
      await page.setViewport(
        width,
        Math.min(MAX_HEIGHT, Math.max(HEIGHTS[width] ?? 900, Number(height) || 0)),
      );
      const png = await page.screenshotViewport();
      const a11y = await page.evaluate(gates.A11Y_SCRIPT).catch(() => []);
      await page.send("Page.close").catch(() => undefined);
      return { png, a11y: Array.isArray(a11y) ? a11y : [], problems: page.problems };
    },
    close: () => browser.close(),
  };
}

/**
 * Capture every view of one run into `out`; returns and writes `views.json`.
 * `makeCapturer({ localPorts })` is called once the app's port is known (the
 * confined browser may reach only that loopback port).
 */
export async function captureRun({
  tree,
  out,
  arm,
  run,
  makeCapturer = chromiumCapturer,
  scratchRoot,
}) {
  mkdirSync(out, { recursive: true });
  const record = {
    about: "The capstone showcase's views for one run (W2 G5).",
    arm,
    run,
    week: WEEK,
    widths: WIDTHS,
    capturedAt: new Date().toISOString(),
    views: [],
  };
  const started = await startApp(tree, scratchRoot ? { scratchRoot } : {});
  let capturer;
  const shoot = async (view, target) => {
    for (const width of WIDTHS) {
      const file = `${view.id}-${width}.png`;
      try {
        const shot = await capturer.capture({ ...target, width });
        writeFileSync(join(out, file), shot.png);
        record.views.push({
          view: view.id,
          title: view.title,
          width,
          file,
          url: target.url ? new URL(target.url).pathname + new URL(target.url).search : null,
          bytes: shot.png.length,
          a11y: shot.a11y ?? [],
          problems: shot.problems ?? null,
        });
      } catch (err) {
        record.views.push({
          view: view.id,
          title: view.title,
          width,
          file: null,
          notCaptured: `the capture failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
  };
  if (started.failure) {
    capturer = await makeCapturer({ localPorts: [] });
    record.started = false;
    record.failure = started.failure;
    await shoot(
      VIEWS.find((v) => v.id === "error-state"),
      { html: failurePage(started.failure) },
    );
    for (const v of VIEWS.filter((x) => x.id !== "error-state")) {
      for (const width of WIDTHS)
        record.views.push({
          view: v.id,
          title: v.title,
          width,
          file: null,
          notCaptured: `the app did not ${started.failure.stage}`,
        });
    }
  } else {
    record.started = true;
    try {
      capturer = await makeCapturer({ localPorts: [started.port] });
      const seeded = await seedData(started.base);
      record.seeding = seeded.steps;
      for (const v of VIEWS) {
        await shoot(
          v,
          v.csv
            ? { html: csvPage(seeded.csv) }
            : { url: `${started.base}${v.path(seeded.people)}` },
        );
      }
    } finally {
      await started.stop();
    }
  }
  record.capturer = capturer?.name ?? "unnamed";
  await capturer?.close?.();
  writeFileSync(join(out, "views.json"), `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

// --- the comparison page --------------------------------------------------------------------

const fmt = (c) => (c && c.passRate !== undefined ? `${c.passed}/${c.total}` : "not run");

/** The showcase's README: one row per arm, its scores, time and tokens, and its screenshots side by side. */
export function readme(showcase = SHOWCASE) {
  const lines = [
    "# The capstone: every arm's finished app",
    "",
    "Each arm of the capstone grid built the same timesheet and overtime app from the same frozen prompt ([protocol](../../research/CAPSTONE_SELECTION_2026-09.md#protocol-to-freeze-before-any-run)). Each finished app was started from its own repository, given the same data through its HTTP API, and captured at the same views, 1440 and 400 pixels wide. An app that did not start is shown failing. Hidden tests are counted after the change request (the release-1 tests run again, plus California's); regressions are release-1 tests that passed at the `release-1` tag and fail after the change.",
    "",
    "Generated by `scripts/capstone/screenshots.mjs --readme` from each run's `score.json` and `views.json`.",
    "",
  ];
  const runsOf = (armId) => {
    const dir = join(showcase, armId);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((d) => /^\d+$/.test(d))
      .sort((a, b) => Number(a) - Number(b))
      .map((d) => {
        const read = (f) =>
          existsSync(join(dir, d, f)) ? JSON.parse(readFileSync(join(dir, d, f), "utf8")) : null;
        return { run: Number(d), score: read("score.json"), views: read("views.json") };
      });
  };
  const shown = ARMS.map((a) => ({ a, runs: runsOf(a.id) })).filter((x) => x.runs.length);
  // A count that leaves some of the arm's models out is not set beside one that counts them all.
  const tokensCell = (s) =>
    s.effort?.tokensNotCounted
      ? "not comparable: some models not counted"
      : s.effort?.inputTokens != null
        ? `${s.effort.inputTokens} / ${s.effort.outputTokens}`
        : "—";
  if (!shown.length) {
    lines.push("No run has been captured yet.", "");
    return `${lines.join("\n")}\n`;
  }
  lines.push(
    "| Arm | Hidden tests after the change | Release 1 | Regressions | Time (min) | Tokens in / out | Views (run 1, 1440 px) |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  );
  for (const { a, runs } of shown) {
    const per = (f) => runs.map((r) => (r.score ? f(r.score) : "not scored")).join(" · ");
    const first = runs[0];
    const thumbs = first.views
      ? first.views.views
          .filter((v) => v.width === 1440)
          .map((v) =>
            v.file
              ? `<img src="${a.id}/${first.run}/${v.file}" width="160" alt="${escapeHtml(v.title)}">`
              : `(${escapeHtml(v.view)}: ${escapeHtml(v.notCaptured)})`,
          )
          .join(" ")
      : "not captured";
    lines.push(
      `| ${a.row === "one-shot" ? "One shot" : "With its harness"}: ${a.column} (\`${a.id}\`) | ${per((s) => fmt(s.afterChange))} | ${per((s) => fmt(s.releaseOne))} | ${per((s) => String(s.regressions?.count ?? "not run"))} | ${per((s) => String(s.effort?.wallClockMinutes ?? "—"))} | ${per(tokensCell)} | ${thumbs} |`,
    );
  }
  const partial = shown.flatMap(({ a, runs }) =>
    runs
      .filter((r) => r.score?.effort?.tokensNotCounted)
      .map((r) => `- \`${a.id}\` run ${r.run}: ${r.score.effort.tokensNotCounted}.`),
  );
  if (partial.length)
    lines.push(
      "",
      "Tokens are compared only where a run counts every model it used. Not counted:",
      ...partial,
    );
  lines.push(
    "",
    'Each run\'s cell lists its runs in order (run 1 · run 2 · run 3). Differences between arms are reported with their intervals in `stats-change-request.json`; where the runs cannot separate two arms, it says "no clear difference".',
    "",
  );
  for (const { a, runs } of shown) {
    lines.push(`## ${a.row === "one-shot" ? "One shot" : "With its harness"}: ${a.column}`, "");
    for (const r of runs) {
      if (!r.views) continue;
      lines.push(
        `Run ${r.run}${r.views.started ? "" : ` — the app did not ${r.views.failure?.stage ?? "start"}`}`,
        "",
        "| View | 1440 px | 400 px |",
        "| --- | --- | --- |",
      );
      const byView = new Map();
      for (const v of r.views.views)
        byView.set(v.view, { ...(byView.get(v.view) ?? {}), [v.width]: v, title: v.title });
      for (const [id, v] of byView) {
        const cell = (x) =>
          x?.file
            ? `<img src="${a.id}/${r.run}/${x.file}" width="${x.width === 1440 ? 360 : 120}" alt="${escapeHtml(v.title)}">`
            : `not captured: ${escapeHtml(x?.notCaptured ?? "missing")}`;
        lines.push(`| ${escapeHtml(v.title)} (\`${id}\`) | ${cell(v[1440])} | ${cell(v[400])} |`);
      }
      lines.push("");
    }
  }
  return `${lines.join("\n")}\n`;
}

// --- the command line -----------------------------------------------------------------------

async function main(argv) {
  const get = (flag) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  if (argv.includes("--readme")) {
    mkdirSync(SHOWCASE, { recursive: true });
    writeFileSync(join(SHOWCASE, "README.md"), readme());
    console.log(`wrote ${join(SHOWCASE, "README.md")}`);
    return 0;
  }
  const a = armOf(get("--arm"));
  const run = get("--run");
  const tree = resolve(get("--tree") ?? runPaths(a.id, run).repo);
  const out = resolve(get("--out") ?? join(SHOWCASE, a.id, String(run)));
  const r = await captureRun({ tree, out, arm: a.id, run: Number(run) });
  const n = r.views.filter((v) => v.file).length;
  console.log(
    `${a.id} run ${run}: ${n} screenshots in ${out}${r.started ? "" : ` (the app did not ${r.failure.stage})`}`,
  );
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    },
  );
}
