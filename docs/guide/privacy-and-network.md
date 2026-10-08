# Privacy and network

Your code and your prompts stay on your machine, or on your team's server. Sekhemet sends no telemetry, and the network is off by default: `[network] mode = "offline"`.

This page lists every host Sekhemet's own code can contact, what it is for, what is sent, and the setting that turns it off. It is generated from the network policy's host catalogue, and the build fails when the code names a host this page does not list.

## How the network is decided

- **One policy for every request.** Each request Sekhemet makes goes through one network policy, set in `[network]` in your own `config.toml`: `mode` is `offline` (the default), `allowlist` (only the hosts in `fetch_allow`) or `open`. A host in `fetch_deny` is refused whatever else says. A project's configuration can only narrow your policy, never widen it.
- **Research is the one exception, and only yours to allow.** `[network] research = "yes"`, in your own config.toml only, lets research reach the public web even when `mode` is offline, still bounded by a non-empty `fetch_allow`. Each question names its hosts and asks first.
- **Everything is recorded.** Every request, allowed or refused, is recorded on the Activity log with its host, purpose and size. `sekhemet egress` lists them, newest first, and so does Configuration › Project › *Network activity*. With nothing recorded they say *Nothing has left this machine*.
- **The Coding model has no network.** Commands an issue runs are confined by the sandbox, with egress denied unless the project's `gates.toml` allows a host and the policy allows it too; then a per-issue proxy refuses loopback, private and cloud-metadata addresses and logs each request.
- **Hosts you configure.** A GitHub Enterprise or Forgejo host, an SMTP server, a push-notification server, a SearXNG instance, your company's sign-in provider and your repository's git remote are reached only at the addresses you give, and only once you connect them.

## Every host

<!-- generated:privacy-and-network:start -->
### The update check

- **Hosts:** `registry.npmjs.org`
- **When:** Only when you run `sekhemet doctor --check-updates` and answer yes. Nothing else asks for a release: not at start-up, not on a schedule.
- **What is sent:** One GET of the package's latest version, with an `accept` header only: no identifier of the install or of you.
- **Turn it off:** Do not run it. `[network] mode = "offline"` in your user config.toml (the default) refuses it.

### Get the inference engine

- **Hosts:** `github.com`, `release-assets.githubusercontent.com`, `objects.githubusercontent.com`
- **When:** Only when you choose *Get the inference engine* (Configuration › Models) or run `sekhemet engine get` and answer yes. github.com redirects the download to its release-asset hosts; every hop is checked and recorded.
- **What is sent:** GET requests for the one pinned llama.cpp release file for your platform.
- **Turn it off:** Do not choose it; install llama.cpp yourself instead. `[network] mode = "offline"` in your user config.toml (the default) refuses it.

### Model downloads and lookups

- **Hosts:** `huggingface.co`
- **When:** When you download a model (Configuration › Models › Download…, or `sekhemet models fetch`), and when a model's published file and hash are looked up for it.
- **What is sent:** GET requests naming the model's repository and file. The file is checked against its published SHA-256 before it is used.
- **Turn it off:** Do not download; register a GGUF file you already have. `[network] mode = "offline"` in your user config.toml (the default) refuses it for downloads; lookups are research requests and follow `[network] research`.

### The package registry check

- **Hosts:** `registry.npmjs.org`, `api.npmjs.org`, `pypi.org`, `crates.io`, `proxy.golang.org`
- **When:** When an issue adds a dependency, its checks ask the ecosystem's registry whether the package exists and how old it is (a guard against invented or look-alike package names).
- **What is sent:** The package's name, in the request's path.
- **Turn it off:** `[network] mode = "offline"` in your user config.toml (the default) refuses it; the check then reports itself as an advisory, never a pass. An air-gapped workspace asks only its own mirror.

### A new project's generator

- **Hosts:** `registry.npmjs.org`, `pypi.org`, `files.pythonhosted.org`, `crates.io`, `static.crates.io`, `index.crates.io`, `proxy.golang.org`, `sum.golang.org`
- **When:** Only on a new project's first issue, when you approved its generator on *Create project*: the generator's own steps, in the sandbox, may reach that one ecosystem's package registry.
- **What is sent:** What the package manager sends to fetch the generator and its packages.
- **Turn it off:** Choose no generator on *Create project*. A host in `[network] fetch_deny` stays refused.

### Research

- **Hosts:** `registry.npmjs.org`, `pypi.org`, `api.github.com`, `github.com`, `huggingface.co`, `arxiv.org`, `export.arxiv.org`, `api.openalex.org`, `api.crossref.org`, `api.semanticscholar.org`, `en.wikipedia.org`, `api.deps.dev`, `unpkg.com`, `docs.rs`, `pkg.go.dev`, `api.search.brave.com`, `api.tavily.com`
- **When:** Only with research on. The Researcher and Seshat search package registries, GitHub, paper indexes and the documentation of the versions your project uses, and read the pages a search returns, which can be any public site. Each question names its hosts and asks first. Brave and Tavily are asked only when you set their API key; a SearXNG you run is asked at the address you give.
- **What is sent:** Search words: package names, API identifiers and keywords, never your code or your brief's text. A page is fetched by its address.
- **Turn it off:** `[network] research = "no"` in your user config.toml (the default). Only your own config can turn it on; a project's can only turn it off.

### Integrations you connect

- **Hosts:** `api.github.com`, `github.com`, `hooks.slack.com`, `slack.com`, `ntfy.sh`
- **When:** Only after you connect one: GitHub (issues, pull requests, the Projects board, Check Runs; a GitHub Enterprise or Forgejo host you name instead), Slack, push notifications (ntfy.sh or a server you name), email (the SMTP server you name), and Push to remote after Accept.
- **What is sent:** What the integration carries: issue titles and descriptions, review findings, notifications, and the commits you accept, to the service you connected.
- **Turn it off:** Disconnect it in Configuration › Integrations. `[network] mode = "offline"` in your user config.toml (the default) refuses it.

### Building an air-gap kit

- **Hosts:** `unpkg.com`, `pypi.org`
- **When:** Only when you build an air-gap kit on a connected machine: the documentation of the exact versions your project pins, and the `llms.txt` of each package's own site.
- **What is sent:** GET requests naming each package and version.
- **Turn it off:** Do not build a kit. `[network] mode = "offline"` in your user config.toml (the default) refuses it.

### Named in the source, never contacted on their own

| Hosts | Why they appear |
| --- | --- |
| `nodejs.org`, `git-scm.com`, `bun.sh`, `cli.github.com`, `www.npmjs.com`, `npmjs.com`, `x.com`, `keepachangelog.com`, `semver.org` | Links printed in a message or a page, for you to open: where to install a tool, a package's page, a credit, a format's specification. |
| `owasp.org`, `playwright.dev`, `google.github.io`, `www.atlassian.com`, `linear.app`, `en.wikipedia.org`, `martinfowler.com`, `www.agilealliance.org`, `scrumguides.org`, `kanbanguides.org`, `scaledagileframework.com`, `wiki.c2.com`, `www.jpattonassociates.com`, `www.mountaingoatsoftware.com`, `xp123.com` | Further reading in the *Tips*, opened in your browser. |
| `www.typescriptlang.org`, `typescriptlang.org`, `vitest.dev`, `biomejs.dev`, `pnpm.io`, `react.dev`, `vite.dev`, `sqlite.org`, `www.postgresql.org`, `postgresql.org`, `docs.python.org`, `fastapi.tiangolo.com`, `docs.djangoproject.com`, `docs.pytest.org`, `doc.rust-lang.org`, `go.dev`, `zod.dev`, `expressjs.com`, `tanstack.com`, `developer.mozilla.org`, `w3.org`, `whatwg.org`, `rfc-editor.org`, `datatracker.ietf.org`, `.readthedocs.io`, `readthedocs.org`, `docs.github.com`, `openreview.net`, `aclanthology.org`, `doi.org`, `dl.acm.org`, `semanticscholar.org`, `stackoverflow.com`, `stackexchange.com`, `serverfault.com`, `superuser.com`, `reddit.com`, `news.ycombinator.com`, `geeksforgeeks.org`, `w3resource.com`, `tutorialspoint.com`, `javatpoint.com`, `codegrepper.com`, `programmerall.com`, `itecnote.com`, `deps.dev` | Documentation sites and sources the Researcher ranks or reads first: reached only as research, when research is on and a question needs them. |
| `github.com`, `gist.github.com`, `gitlab.com`, `bitbucket.org`, `pastebin.com`, `transfer.sh`, `file.io`, `api.github.com`, `uploads.github.com` | Hosts that can carry data out: the network settings warn you when you allow one for an issue's commands. Named for the warning, never contacted for it. |
| `ghcr.io` | Where the Team server's inference-engine container images come from: Docker pulls them when you start the server, not Sekhemet. |
| `www.w3.org`, `www.apple.com`, `socket.io` | Not a request: an XML namespace, a property list's document type, and an npm package's name. |
<!-- generated:privacy-and-network:end -->

## Air-gapped use

A workspace can run with no network at all: an air-gap kit carries the models, the engine, a package mirror and the documentation of the versions a project pins. `sekhemet doctor --airgap` runs the air-gap self-test and records its result ([INSTALL](../reference/INSTALL.md)).
