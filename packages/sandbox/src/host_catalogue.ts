import { GENERATOR_REGISTRY_HOSTS } from "./network_policy.js";

/**
 * Every host Sekhemet's own code can reach, with its purpose, what is sent
 * and the setting that turns it off (security item 33a, NEW-security-11,
 * SEC-N11-1; FINDINGS_C1 INS-08). The user guide's *Privacy and network*
 * page is generated from this table (`scripts/gen_docs.mjs`), and
 * `docs_generated.spec.ts` scans the product's source for every host it
 * names and fails on one this table does not list, as contacted or as only
 * named.
 *
 * Every request listed here goes through the one network policy
 * (`policyFetch`, items 28–33): `[network] mode = "offline"`, the default,
 * refuses all but research, which only `[network] research = "yes"` in the
 * person's own config.toml allows; `fetch_deny` refuses a host whatever
 * else says; and each request, allowed or refused, is recorded on the
 * Activity log as egress (`sekhemet egress` lists them).
 */
export interface HostEntry {
  /** A short id for the page's anchor. */
  id: string;
  /** What it is, in a few words: the page's heading. */
  title: string;
  /** The hosts. A leading dot covers every subdomain. */
  hosts: readonly string[];
  /** What it is for and when a request is made. */
  when: string;
  /** What is sent. */
  sent: string;
  /** The setting, or the act, that turns it off. */
  off: string;
}

/** The policy's general off-switch, named by every entry it covers. */
const OFFLINE = '`[network] mode = "offline"` in your user config.toml (the default) refuses it';

export const HOST_CATALOGUE: readonly HostEntry[] = [
  {
    id: "update-check",
    title: "The update check",
    hosts: ["registry.npmjs.org"],
    when: "Only when you run `sekhemet doctor --check-updates` and answer yes. Nothing else asks for a release: not at start-up, not on a schedule.",
    sent: "One GET of the package's latest version, with an `accept` header only: no identifier of the install or of you.",
    off: `Do not run it. ${OFFLINE}.`,
  },
  {
    id: "engine-download",
    title: "Get the inference engine",
    hosts: ["github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"],
    when: "Only when you choose *Get the inference engine* (Configuration › Models) or run `sekhemet engine get` and answer yes. github.com redirects the download to its release-asset hosts; every hop is checked and recorded.",
    sent: "GET requests for the one pinned llama.cpp release file for your platform.",
    off: `Do not choose it; install llama.cpp yourself instead. ${OFFLINE}.`,
  },
  {
    id: "model-download",
    title: "Model downloads and lookups",
    hosts: ["huggingface.co"],
    when: "When you download a model (Configuration › Models › Download…, or `sekhemet models fetch`), and when a model's published file and hash are looked up for it.",
    sent: "GET requests naming the model's repository and file. The file is checked against its published SHA-256 before it is used.",
    off: `Do not download; register a GGUF file you already have. ${OFFLINE} for downloads; lookups are research requests and follow \`[network] research\`.`,
  },
  {
    id: "package-check",
    title: "The package registry check",
    hosts: ["registry.npmjs.org", "api.npmjs.org", "pypi.org", "crates.io", "proxy.golang.org"],
    when: "When an issue adds a dependency, its checks ask the ecosystem's registry whether the package exists and how old it is (a guard against invented or look-alike package names).",
    sent: "The package's name, in the request's path.",
    off: `${OFFLINE}; the check then reports itself as an advisory, never a pass. An air-gapped workspace asks only its own mirror.`,
  },
  {
    id: "project-generator",
    title: "A new project's generator",
    hosts: [...new Set(Object.values(GENERATOR_REGISTRY_HOSTS).flat())],
    when: "Only on a new project's first issue, when you approved its generator on *Create project*: the generator's own steps, in the sandbox, may reach that one ecosystem's package registry.",
    sent: "What the package manager sends to fetch the generator and its packages.",
    off: "Choose no generator on *Create project*. A host in `[network] fetch_deny` stays refused.",
  },
  {
    id: "research",
    title: "Research",
    hosts: [
      "registry.npmjs.org",
      "pypi.org",
      "api.github.com",
      "github.com",
      "huggingface.co",
      "arxiv.org",
      "export.arxiv.org",
      "api.openalex.org",
      "api.crossref.org",
      "api.semanticscholar.org",
      "en.wikipedia.org",
      "api.deps.dev",
      "unpkg.com",
      "docs.rs",
      "pkg.go.dev",
      "api.search.brave.com",
      "api.tavily.com",
    ],
    when: "Only with research on. The Researcher and Seshat search package registries, GitHub, paper indexes and the documentation of the versions your project uses, and read the pages a search returns, which can be any public site. Each question names its hosts and asks first. Brave and Tavily are asked only when you set their API key; a SearXNG you run is asked at the address you give.",
    sent: "Search words: package names, API identifiers and keywords, never your code or your brief's text. A page is fetched by its address.",
    off: '`[network] research = "no"` in your user config.toml (the default). Only your own config can turn it on; a project\'s can only turn it off.',
  },
  {
    id: "integrations",
    title: "Integrations you connect",
    hosts: ["api.github.com", "github.com", "hooks.slack.com", "slack.com", "ntfy.sh"],
    when: "Only after you connect one: GitHub (issues, pull requests, the Projects board, Check Runs; a GitHub Enterprise or Forgejo host you name instead), Slack, push notifications (ntfy.sh or a server you name), email (the SMTP server you name), and Push to remote after Accept.",
    sent: "What the integration carries: issue titles and descriptions, review findings, notifications, and the commits you accept, to the service you connected.",
    off: `Disconnect it in Configuration › Integrations. ${OFFLINE}.`,
  },
  {
    id: "airgap-kit",
    title: "Building an air-gap kit",
    hosts: ["unpkg.com", "pypi.org"],
    when: "Only when you build an air-gap kit on a connected machine: the documentation of the exact versions your project pins, and the `llms.txt` of each package's own site.",
    sent: "GET requests naming each package and version.",
    off: `Do not build a kit. ${OFFLINE}.`,
  },
];

/**
 * Hosts the source names that Sekhemet itself never contacts on its own:
 * links a person opens in their own browser, documentation addresses the
 * Researcher ranks or reads only as research, and names that only look like
 * a host. The page lists them, so nothing in the source is unaccounted for.
 */
export interface NamedHost {
  hosts: readonly string[];
  why: string;
}

export const NAMED_NOT_CONTACTED: readonly NamedHost[] = [
  {
    hosts: [
      "nodejs.org",
      "git-scm.com",
      "bun.sh",
      "cli.github.com",
      "www.npmjs.com",
      "npmjs.com",
      "x.com",
      "keepachangelog.com",
      "semver.org",
    ],
    why: "Links printed in a message or a page, for you to open: where to install a tool, a package's page, a credit, a format's specification.",
  },
  {
    hosts: [
      "owasp.org",
      "playwright.dev",
      "google.github.io",
      "www.atlassian.com",
      "linear.app",
      "en.wikipedia.org",
      "martinfowler.com",
      "www.agilealliance.org",
      "scrumguides.org",
      "kanbanguides.org",
      "scaledagileframework.com",
      "wiki.c2.com",
      "www.jpattonassociates.com",
      "www.mountaingoatsoftware.com",
      "xp123.com",
    ],
    why: "Further reading in the *Tips*, opened in your browser.",
  },
  {
    hosts: [
      "www.typescriptlang.org",
      "typescriptlang.org",
      "vitest.dev",
      "biomejs.dev",
      "pnpm.io",
      "react.dev",
      "vite.dev",
      "sqlite.org",
      "www.postgresql.org",
      "postgresql.org",
      "docs.python.org",
      "fastapi.tiangolo.com",
      "docs.djangoproject.com",
      "docs.pytest.org",
      "doc.rust-lang.org",
      "go.dev",
      "zod.dev",
      "expressjs.com",
      "tanstack.com",
      "developer.mozilla.org",
      "w3.org",
      "whatwg.org",
      "rfc-editor.org",
      "datatracker.ietf.org",
      ".readthedocs.io",
      "readthedocs.org",
      "docs.github.com",
      "openreview.net",
      "aclanthology.org",
      "doi.org",
      "dl.acm.org",
      "semanticscholar.org",
      "stackoverflow.com",
      "stackexchange.com",
      "serverfault.com",
      "superuser.com",
      "reddit.com",
      "news.ycombinator.com",
      "geeksforgeeks.org",
      "w3resource.com",
      "tutorialspoint.com",
      "javatpoint.com",
      "codegrepper.com",
      "programmerall.com",
      "itecnote.com",
      "deps.dev",
    ],
    why: "Documentation sites and sources the Researcher ranks or reads first: reached only as research, when research is on and a question needs them.",
  },
  {
    hosts: [
      "github.com",
      "gist.github.com",
      "gitlab.com",
      "bitbucket.org",
      "pastebin.com",
      "transfer.sh",
      "file.io",
      "api.github.com",
      "uploads.github.com",
    ],
    why: "Hosts that can carry data out: the network settings warn you when you allow one for an issue's commands. Named for the warning, never contacted for it.",
  },
  {
    hosts: ["ghcr.io"],
    why: "Where the Team server's inference-engine container images come from: Docker pulls them when you start the server, not Sekhemet.",
  },
  {
    hosts: ["www.w3.org", "www.apple.com", "socket.io"],
    why: "Not a request: an XML namespace, a property list's document type, and an npm package's name.",
  },
];

/** Whether `host` is one of `listed` (a leading dot covers every subdomain). */
export function hostCovered(host: string, listed: readonly string[]): boolean {
  const h = host.toLowerCase();
  return listed.some((l) => (l.startsWith(".") ? h.endsWith(l) || h === l.slice(1) : h === l));
}

/** Every host the catalogue lists, contacted or only named. */
export function catalogueHosts(): string[] {
  return [
    ...new Set([
      ...HOST_CATALOGUE.flatMap((e) => e.hosts),
      ...NAMED_NOT_CONTACTED.flatMap((n) => n.hosts),
    ]),
  ];
}
