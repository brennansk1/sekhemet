// Integrations (PM_DESIGN §3.5, PM_CONTRACT §5): Now / Next / Later. Every
// entry says what leaves this machine when connected; nothing is on by default.
// Import is a preview of proposals, never a silent write.
import { esc, getJSON, icon, postJSON, sendJSON } from "./dom.js";
import { formatWait } from "./lib/vocabulary.js";
import { bindProposals, proposalGroupHtml } from "./proposals.js";
import { setTopbar } from "./shell.js";
import { store } from "./store.js";
import { toast } from "./toast.js";
import { mutationsBlocked } from "./triage.js";

/** The design's catalogue: order, copy and data lines. The server adds state. */
const CATALOG = [
  {
    id: "github",
    tier: "now",
    name: "GitHub Issues + Projects",
    mono: "GH",
    does: "Two-way card and issue sync through your gh login. Priority, points and cycle map to Projects fields; cards and issues link by reference.",
    leaves:
      "Card titles, specs, priority, points, cycle and state, as issues and Projects fields in the repository you choose. Uses your gh login; Sekhemet stores no token.",
  },
  {
    id: "github-pr",
    tier: "now",
    name: "GitHub PR on accept",
    mono: "PR",
    does: "Accept pushes the card branch and opens a pull request whose body is the evidence, instead of merging locally.",
    leaves: "The card branch, its diff, and the gate results.",
  },
  {
    id: "research-web",
    tier: "now",
    name: "Researcher web access",
    mono: "RW",
    does: "When on, the Researcher can search papers (Hugging Face, arXiv), read papers and web pages, and search GitHub. When off, it works only from this machine: the project's docs, history and registries.",
    leaves:
      "Search queries, and the URLs of the pages it reads. Private and local addresses are never fetched.",
  },
  {
    id: "jira",
    tier: "now",
    name: "Jira",
    mono: "JI",
    does: "Import and export in Jira's own CSV columns: Summary, Issue Type, Priority, Story Points, Sprint, Epic Link, Labels, Description.",
    leaves: "Nothing. Export writes a file; you upload it to Jira yourself.",
  },
  {
    id: "linear",
    tier: "now",
    name: "Linear",
    mono: "LI",
    does: "Import and export in Linear's fields: title, priority 0–4, estimate, cycle, project, labels.",
    leaves: "Nothing. Export writes a file; you import it into Linear yourself.",
  },
  {
    id: "slack",
    tier: "now",
    name: "Slack for the PM",
    mono: "SL",
    does: "Seshat posts the daily standup, “needs you” alerts and run reports to one channel.",
    leaves:
      "Standup text, the titles of cards that need you, and run summaries, to the channel behind the webhook.",
  },
  {
    id: "push",
    tier: "now",
    name: "Push notifications (ntfy or Gotify)",
    mono: "PU",
    does: "Your phone hears when a card waits for review, a card is parked or hits its budget, the Worker asks a question, or a run finishes. Tapping opens the card here.",
    leaves:
      "The alert title and one line naming the card, to the ntfy or Gotify server you choose (your own, or ntfy.sh).",
  },
  {
    id: "jira-sync",
    tier: "next",
    name: "Jira live sync",
    mono: "JI",
    does: "Two-way sync over Jira's REST API.",
    leaves: "Card fields, to your Jira site, with a token from your OS keychain.",
  },
  {
    id: "linear-sync",
    tier: "next",
    name: "Linear live sync",
    mono: "LI",
    does: "Two-way sync over Linear's GraphQL API.",
    leaves: "Card fields, to your Linear workspace, with a token from your OS keychain.",
  },
  {
    id: "github-actions",
    tier: "next",
    name: "GitHub Actions gate mirror",
    mono: "GA",
    does: "Posts each card's gate results as a check run on its pull request.",
    leaves: "Gate names, results and durations.",
  },
  {
    id: "teams",
    tier: "next",
    name: "Microsoft Teams",
    mono: "MT",
    does: "The same standup, alerts and run reports as Slack, through an incoming webhook.",
    leaves: "The same messages as Slack.",
  },
  {
    id: "slack-replies",
    tier: "next",
    name: "Slack replies",
    mono: "SL",
    does: "Talk to Seshat from a Slack thread.",
    leaves: "Your messages and Seshat's replies.",
  },
  {
    id: "sentry",
    tier: "later",
    name: "Sentry",
    mono: "SE",
    does: "New errors and regressions arrive as proposals for bug cards.",
    leaves: "Nothing leaves; issue data comes in.",
  },
  {
    id: "datadog",
    tier: "later",
    name: "Datadog",
    mono: "DD",
    does: "Monitors that fire arrive as proposals for bug cards.",
    leaves: "Nothing leaves; alert data comes in.",
  },
  {
    id: "pagerduty",
    tier: "later",
    name: "PagerDuty",
    mono: "PD",
    does: "Incident follow-ups arrive as proposals for cards.",
    leaves: "Nothing leaves; incident data comes in.",
  },
  {
    id: "notion",
    tier: "later",
    name: "Notion",
    mono: "NO",
    does: "Seshat publishes cycle plans, run reports and decision logs, and reads linked specs as card context.",
    leaves: "Cycle plans, run reports and decision logs.",
  },
  {
    id: "confluence",
    tier: "later",
    name: "Confluence",
    mono: "CO",
    does: "The same publishing as Notion, to a Confluence space.",
    leaves: "Cycle plans, run reports and decision logs.",
  },
];

const FORMATS = [
  { id: "jira-csv", label: "Jira CSV", ext: ".csv" },
  { id: "linear-csv", label: "Linear CSV", ext: ".csv" },
  { id: "github-json", label: "GitHub JSON", ext: ".json" },
  { id: "json", label: "Sekhemet JSON", ext: ".json" },
];

const ui = {
  root: null,
  status: 0,
  entries: [],
  busy: new Set(),
  sync: null,
  importFormat: null,
  importList: null,
  importTitle: "",
  importError: "",
  importContent: "",
};

function ago(iso) {
  const t = Date.parse(iso ?? "");
  if (!Number.isFinite(t)) return "";
  const ms = Date.now() - t;
  return ms < 60_000 ? "just now" : `${formatWait(ms)} ago`;
}

function merged() {
  const byId = new Map(ui.entries.map((e) => [e.id, e]));
  const out = CATALOG.map((c) => ({
    ...c,
    ...(byId.get(c.id) ?? {}),
    known: byId.has(c.id),
    name: c.name,
  }));
  for (const e of ui.entries)
    if (!CATALOG.some((c) => c.id === e.id))
      out.push({
        mono: e.name.slice(0, 2).toUpperCase(),
        does: e.detail ?? "",
        leaves: "",
        known: true,
        ...e,
      });
  return out;
}

function stateTag(e) {
  if (ui.status === 404) return '<span class="itag">Not available on this server yet</span>';
  if (e.connected || e.enabled)
    return `<span class="itag on">${icon("check", 12, "ic s12")}${e.id === "github-pr" ? "On" : "Connected"}</span>`;
  return '<span class="itag">Not connected</span>';
}

function mono(e) {
  return `<span class="imono" aria-hidden="true">${esc(e.mono)}</span>`;
}

function controls(e) {
  if (ui.status === 404 || !e.known) return "";
  const busy = (k) => ui.busy.has(`${e.id}:${k}`);
  switch (e.id) {
    case "github": {
      const res = ui.sync
        ? `<p class="iresult tnum">${ui.sync.error ? `${icon("alert", 12, "ic s12 i-fail")}<span>${esc(ui.sync.error)}</span>` : `${icon("check", 12, "ic s12 i-pass")}<span>Last sync: ${ui.sync.created} created · ${ui.sync.updated} updated · ${ui.sync.skipped} skipped · ${ui.sync.errors?.length ?? 0} errors</span>`}</p>${(ui.sync.errors ?? []).map((x) => `<p class="ierr mono">${esc(typeof x === "string" ? x : JSON.stringify(x))}</p>`).join("")}`
        : "";
      const dis = !e.connected ? " disabled" : "";
      const anyBusy = ["pull", "push", "both"].some(busy);
      const b = (dir, label, primary) =>
        `<button class="btn sm${primary ? " primary" : ""}" type="button" data-sync="${dir}"${dis || (anyBusy ? " disabled" : "")}>${busy(dir) ? "Syncing with GitHub…" : esc(label)}</button>`;
      return `<div class="iacts">${b("pull", "Pull")}${b("push", "Push")}${b("both", "Sync both", true)}<a class="btn sm ghost" href="/api/export?format=github-json" download>${icon("download", 12, "ic s12")}Export GitHub JSON</a></div>${res}`;
    }
    case "github-pr": {
      const on = Boolean(e.enabled ?? e.connected);
      return `<div class="iacts"><button class="switch" type="button" role="switch" aria-checked="${on}" aria-label="Open a pull request on Accept" data-toggle-pr ${busy("pr") ? "disabled" : ""}><span></span></button><span class="sec">${on ? "Accept opens a pull request." : "Accept merges locally as one commit."}</span></div>`;
    }
    case "research-web": {
      const on = Boolean(e.enabled ?? e.connected);
      return `<div class="iacts"><button class="switch" type="button" role="switch" aria-checked="${on}" aria-label="Researcher web access" data-toggle-web ${busy("web") ? "disabled" : ""}><span></span></button><span class="sec">${on ? "The Researcher may use the web." : "The Researcher stays on this machine."}</span></div>${e.detail ? `<p class="istatus">${esc(e.detail)}</p>` : ""}`;
    }
    case "push": {
      if (e.connected) {
        return `<div class="iacts"><button class="btn sm" type="button" data-push-test ${busy("test") ? "disabled" : ""}>${busy("test") ? "Sending…" : "Send test alert"}</button><button class="btn sm ghost" type="button" data-push-off>Disconnect</button></div>${e.detail ? `<p class="istatus">${esc(e.detail)}</p>` : ""}`;
      }
      return `<form class="iacts push-form" data-push-form><select name="kind" aria-label="Server"><option value="ntfy">ntfy</option><option value="gotify">Gotify</option></select><input name="url" type="url" required placeholder="https://ntfy.sh or http://192.168.1.5:8080" aria-label="Server URL" autocomplete="off" spellcheck="false"><input name="topic" type="text" placeholder="Topic (ntfy)" aria-label="ntfy topic" autocomplete="off" spellcheck="false"><input name="token" type="password" placeholder="Token (optional for ntfy, required for Gotify)" aria-label="Access token" autocomplete="off"><button class="btn sm primary" type="submit" ${busy("connect") ? "disabled" : ""}>${busy("connect") ? "Connecting…" : "Connect"}</button></form><p class="inote">${icon("lock", 12, "ic s12")}<span>The server URL and token stay in <code>~/.config/sekhemet/repos/…</code> with mode 0600, never in the repository or the ledger.</span></p>`;
    }
    case "jira":
    case "linear": {
      const f = `${e.id}-csv`;
      return `<div class="iacts"><a class="btn sm" href="/api/export?format=${f}" download>${icon("download", 12, "ic s12")}Export ${esc(e.name)} CSV</a><button class="btn sm ghost" type="button" data-import="${f}">${icon("upload", 12, "ic s12")}Import…</button></div>`;
    }
    case "slack": {
      if (e.connected) {
        return `<div class="iacts"><button class="btn sm" type="button" data-slack-test ${busy("test") ? "disabled" : ""}>${busy("test") ? "Sending…" : "Send test message"}</button><button class="btn sm ghost" type="button" data-slack-off>Disconnect</button></div>`;
      }
      return `<form class="iacts slack-form" data-slack-form><input type="url" required placeholder="https://hooks.slack.com/services/…" aria-label="Slack incoming webhook URL" autocomplete="off" spellcheck="false"><button class="btn sm primary" type="submit" ${busy("connect") ? "disabled" : ""}>${busy("connect") ? "Connecting…" : "Connect"}</button></form><p class="inote">${icon("lock", 12, "ic s12")}<span>The webhook URL is a credential. Sekhemet keeps it in <code>~/.config/sekhemet/repos/…</code> with mode 0600, never in the repository or the ledger.</span></p>`;
    }
    default:
      return "";
  }
}

function nowCard(e) {
  const status =
    e.id === "github" && e.known
      ? `<p class="istatus">${e.connected ? `${esc(e.detail ?? "Connected via gh")}${e.lastSyncAt ? ` · Last synced ${esc(ago(e.lastSyncAt))}` : " · Never synced"}` : esc(e.detail ?? "gh isn't signed in, or no repository is set. Run gh auth login in this repository.")}</p>`
      : e.id === "slack" && e.connected && e.known
        ? `<p class="istatus mono">${esc(e.detail ?? "Webhook set")}${e.lastSyncAt ? ` · last message ${esc(ago(e.lastSyncAt))}` : ""}</p>`
        : "";
  return `<article class="icard" data-int="${esc(e.id)}"><header>${mono(e)}<div><h3>${esc(e.name)}</h3>${stateTag(e)}</div></header><p class="idoes">${esc(e.does)}</p>${status}${controls(e)}<p class="ileaves"><b>Leaves this machine:</b> ${esc(e.leaves)}</p></article>`;
}

function nextCard(e) {
  return `<article class="icard quiet">${mono(e)}<div><header><h3>${esc(e.name)}</h3><span class="itag">Planned</span></header><p class="idoes">${esc(e.does)}</p><p class="ileaves"><b>Would send:</b> ${esc(e.leaves)}</p></div></article>`;
}

function laterRow(e) {
  return `<li>${mono(e)}<b>${esc(e.name)}</b><span class="sec">${esc(e.does)}</span></li>`;
}

function importHtml() {
  if (!ui.importFormat) return "";
  const opts = FORMATS.map(
    (f) =>
      `<option value="${f.id}"${f.id === ui.importFormat ? " selected" : ""}>${esc(f.label)}</option>`,
  ).join("");
  const preview = ui.importList
    ? `${proposalGroupHtml(ui.importList, { title: ui.importTitle })}<p class="inote">The same preview is in Seshat's thread. Nothing changes until you apply.</p>`
    : "";
  return `<section class="isheet" aria-label="Import"><header><h2>Import</h2><button class="icon-btn" type="button" data-import-close aria-label="Close import">${icon("x", 14, "ic s14")}</button></header><form data-import-form><div class="irow"><label>Format <select name="format">${opts}</select></label><label class="file">File <input type="file" name="file" accept=".csv,.json,text/csv,application/json"></label></div><textarea name="content" rows="5" placeholder="Or paste the export here" spellcheck="false">${esc(ui.importContent ?? "")}</textarea><div class="iacts"><button class="btn sm primary" type="submit" ${ui.busy.has("import") ? "disabled" : ""}>${ui.busy.has("import") ? "Reading…" : "Preview as proposals"}</button><span class="sec">Import is never silent: each card becomes a proposal you apply or discard.</span></div>${ui.importError ? `<p class="ierr">${icon("alert", 12, "ic s12 i-fail")}${esc(ui.importError)}</p>` : ""}</form>${preview}</section>`;
}

function render() {
  if (!ui.root) return;
  const all = merged();
  const now = all.filter((e) => e.tier === "now");
  const next = all.filter((e) => e.tier === "next");
  const later = all.filter((e) => e.tier === "later");
  const connected = now.filter((e) => e.connected || e.enabled).length;
  setTopbar({
    title: "Integrations",
    crumb: ui.status === 404 ? "Roadmap" : `${connected} of ${now.length} connected`,
  });
  const banner =
    ui.status === 404
      ? `<p class="ibanner">${icon("alert", 14, "ic s14 i-park")}<span><b>Integrations aren't on this server yet.</b> <code>GET /api/integrations</code> returned 404. The roadmap below is what arrives with an updated Sekhemet.</span></p>`
      : ui.status && ui.status !== 200
        ? `<p class="ibanner">${icon("alert", 14, "ic s14 i-fail")}<span><b>Couldn't load integrations.</b> The server returned ${esc(ui.status)}.</span></p>`
        : "";
  const html = `<div class="ints">${banner}<p class="ilede">Every integration is off until you connect it, and each one says what leaves this machine. Sekhemet uses your own CLI logins and webhook URLs and keeps no tokens in the repository.</p>${importHtml()}<section><h2>Now <span class="sec">Connect these</span></h2><div class="igrid">${now.map(nowCard).join("")}</div></section><section><h2>Next <span class="sec">Planned</span></h2><div class="igrid next">${next.map(nextCard).join("")}</div></section><section><h2>Later <span class="sec">On the roadmap</span></h2><ul class="ilater">${later.map(laterRow).join("")}</ul></section></div>`;
  const scroll = ui.root.scrollTop;
  ui.root.innerHTML = html;
  ui.root.scrollTop = scroll;
}

async function load() {
  try {
    const r = await getJSON("/api/integrations");
    ui.status = r.status;
    const list = Array.isArray(r.data)
      ? r.data
      : Array.isArray(r.data?.integrations)
        ? r.data.integrations
        : [];
    ui.entries = r.ok ? list : [];
  } catch {
    ui.status = -1;
  }
  render();
}

function blocked() {
  const b = mutationsBlocked();
  if (b)
    toast({
      tone: "parked",
      text: b === "readonly" ? "Read-only." : "Offline.",
      detail: "Integrations can't change right now.",
    });
  return Boolean(b);
}

async function withBusy(key, fn) {
  ui.busy.add(key);
  render();
  try {
    await fn();
  } finally {
    ui.busy.delete(key);
    render();
  }
}

function send(method, path, body) {
  return sendJSON(method, path, body || undefined);
}

function err(r) {
  return r.data?.error ?? `The server returned ${r.status || "no response"}.`;
}

async function onClick(e) {
  const t = e.target instanceof Element ? e.target : null;
  if (!t) return;
  const sync = t.closest("[data-sync]");
  if (sync && !blocked()) {
    const dir = sync.dataset.sync;
    await withBusy(`github:${dir}`, async () => {
      const r = await postJSON("/api/integrations/github/sync", { direction: dir });
      ui.sync = r.ok ? r.data : { error: `Couldn't sync with GitHub. ${err(r)}` };
      if (r.ok) {
        toast({
          tone: "pass",
          text: `Synced with GitHub: ${r.data.created} created, ${r.data.updated} updated`,
        });
        window.dispatchEvent(new CustomEvent("sekhemet:refresh"));
      }
      await load();
    });
    return;
  }
  if (t.closest("[data-toggle-pr]") && !blocked()) {
    const e2 = merged().find((x) => x.id === "github-pr");
    const next = !(e2?.enabled ?? e2?.connected);
    await withBusy("github-pr:pr", async () => {
      const r = await send("PUT", "/api/integrations/github-pr", { enabled: next });
      if (!r.ok) toast({ tone: "fail", text: "Couldn't change PR on accept.", detail: err(r) });
      await load();
    });
    return;
  }
  if (t.closest("[data-toggle-web]") && !blocked()) {
    const e2 = merged().find((x) => x.id === "research-web");
    const next = !(e2?.enabled ?? e2?.connected);
    await withBusy("research-web:web", async () => {
      const r = await send("PUT", "/api/integrations/research-web", { enabled: next });
      if (!r.ok)
        toast({ tone: "fail", text: "Couldn't change Researcher web access.", detail: err(r) });
      else
        toast({
          text: next
            ? "Researcher web access is on."
            : "Researcher web access is off. It works from this machine only.",
        });
      await load();
    });
    return;
  }
  if (t.closest("[data-push-test]") && !blocked()) {
    await withBusy("push:test", async () => {
      const r = await postJSON("/api/integrations/push/test");
      if (r.ok && r.data?.ok !== false) toast({ tone: "pass", text: "Test alert sent" });
      else
        toast({
          tone: "fail",
          text: "The server didn't accept the test alert.",
          detail: r.data?.error ?? err(r),
        });
    });
    return;
  }
  if (t.closest("[data-push-off]") && !blocked()) {
    const r = await send("DELETE", "/api/integrations/push");
    if (r.ok)
      toast({
        text: "Push notifications are off. The server details were removed from this machine.",
      });
    else toast({ tone: "fail", text: "Couldn't disconnect push notifications.", detail: err(r) });
    await load();
    return;
  }
  if (t.closest("[data-slack-test]") && !blocked()) {
    await withBusy("slack:test", async () => {
      const r = await postJSON("/api/integrations/slack/test");
      if (r.ok && r.data?.ok !== false) toast({ tone: "pass", text: "Test message sent to Slack" });
      else
        toast({
          tone: "fail",
          text: "Slack didn't accept the test message.",
          detail: r.data?.error ?? err(r),
        });
    });
    return;
  }
  if (t.closest("[data-slack-off]") && !blocked()) {
    const r = await send("DELETE", "/api/integrations/slack");
    if (r.ok) toast({ text: "Disconnected Slack. The webhook URL was removed from this machine." });
    else toast({ tone: "fail", text: "Couldn't disconnect Slack.", detail: err(r) });
    await load();
    return;
  }
  const imp = t.closest("[data-import]");
  if (imp) {
    ui.importFormat = imp.dataset.import;
    ui.importList = null;
    ui.importError = "";
    render();
    ui.root.querySelector(".isheet")?.scrollIntoView({ block: "start" });
    ui.root.querySelector(".isheet select")?.focus();
    return;
  }
  if (t.closest("[data-import-close]")) {
    ui.importFormat = null;
    ui.importList = null;
    render();
  }
}

async function onSubmit(e) {
  const form = e.target;
  if (form.matches("[data-push-form]")) {
    e.preventDefault();
    if (blocked()) return;
    const f = form.elements;
    const body = {
      kind: f.kind.value,
      url: f.url.value.trim(),
      ...(f.topic.value.trim() ? { topic: f.topic.value.trim() } : {}),
      ...(f.token.value ? { token: f.token.value } : {}),
    };
    await withBusy("push:connect", async () => {
      const r = await send("PUT", "/api/integrations/push", body);
      if (r.ok)
        toast({ tone: "pass", text: "Push notifications are on. Send a test alert to check." });
      else toast({ tone: "fail", text: "Couldn't connect push notifications.", detail: err(r) });
      await load();
    });
    return;
  }
  if (form.matches("[data-slack-form]")) {
    e.preventDefault();
    if (blocked()) return;
    const url = form.querySelector("input").value.trim();
    await withBusy("slack:connect", async () => {
      const r = await send("PUT", "/api/integrations/slack", { webhookUrl: url });
      if (r.ok)
        toast({ tone: "pass", text: "Connected Slack. Seshat will post the standup there." });
      else toast({ tone: "fail", text: "Couldn't connect Slack.", detail: err(r) });
      await load();
    });
    return;
  }
  if (form.matches("[data-import-form]")) {
    e.preventDefault();
    if (blocked()) return;
    const format = form.elements.format.value;
    const file = form.elements.file.files?.[0];
    const content = file ? await file.text() : form.elements.content.value;
    ui.importFormat = format;
    ui.importContent = file ? "" : content;
    if (!content.trim()) {
      ui.importError = "Choose a file or paste an export first.";
      render();
      return;
    }
    await withBusy("import", async () => {
      const r = await postJSON("/api/import", { format, content });
      if (!r.ok) {
        ui.importError = `Couldn't read that ${FORMATS.find((f) => f.id === format)?.label ?? format} file. ${err(r)}`;
        return;
      }
      const list = Array.isArray(r.data) ? r.data : (r.data?.proposals ?? []);
      ui.importError = "";
      ui.importList = list;
      ui.importTitle = `Import from ${FORMATS.find((f) => f.id === format)?.label ?? format} · ${list.length} proposed ${list.length === 1 ? "change" : "changes"}`;
    });
  }
}

export function mount(view) {
  const host = document.createElement("div");
  host.className = "view-host int-host";
  view.append(host);
  ui.root = host;
  host.addEventListener("click", onClick);
  host.addEventListener("submit", onSubmit);
  bindProposals(host, { sources: () => (ui.importList ? [ui.importList] : []), onChange: render });
  const unsub = store.on((_s, patch) => {
    if ("connection" in patch || "meta" in patch) render();
  });
  render();
  load();
  return {
    unmount() {
      unsub();
      host.remove();
      ui.root = null;
    },
  };
}
