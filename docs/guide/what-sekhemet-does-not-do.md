# What Sekhemet does not do

Sekhemet builds software the way a professional team does, checked and accepted by people. Some of what a team needs is outside it, on purpose or not yet. This page says so plainly, so you can plan for it.

## Outside what it is for

- **It does not tell you whether to build something.** Seshat writes down the problem, the outcome and how you will know it worked, and puts the riskiest assumption first; but whether anyone wants the product is yours to find out, with the people who would use it. Sekhemet does not validate a market.
- **It does not deploy.** Accept merges to `main` and a release gets a version and a changelog; putting it on a server, a store or a customer's machine is your pipeline's job. Sekhemet does not check the deployment or rollback of what it builds.
- **It does not give legal advice.** Code Sekhemet's models write for you is yours, and Sekhemet claims no rights to it. Whether AI-written code is protected by copyright, and who owns it where you are, differs from country to country and is still being decided; every commit records which model wrote it (`Agent-Model`), so you can answer the question when you need to. Ask a lawyer, not Sekhemet. The licence of the libraries a project uses is checked and shown, which is information, not advice.
- **It does not translate.** It does not check internationalisation in what it builds.

## Not in v1

- **No AI review yet.** The Review role ships unfilled until a model catches at least 0.3 of a 22-defect seeded set; the best candidate so far caught 4 of 22. A change reaches you without an AI review, and its issue says so. You are the reviewer.
- **Some checks.** Sekhemet does not check, in the software it builds: internationalisation; complexity or code smells beyond the project's own lint; API deprecation beyond the project's own lint; load; metrics and crash reporting; deployment and rollback; similarity to existing code; or dead controls in a web app. A check that needs a database, a cache or another service reports itself *unavailable*, never passed.
- **Cloud models.** Every role runs locally in v1. A cloud model per role comes after v1, as an option, never a requirement.
- **Machines under 24 GB, and Windows.** v1 supports macOS on Apple silicon and Linux x64 with 24 GB of memory or more.
- **Signed commits.** Sekhemet's commits are unsigned, so a branch that requires signed commits refuses them.
- **Live two-way sync with Jira or Linear.** Boards move by export and import. GitHub issues, pull requests and the Projects board sync both ways.
- **A page a stakeholder opens with no terminal at all.** Someone has to install Sekhemet and run its server; v1 has no hosted or one-click deployment, so a non-developer needs a developer or an administrator to set it up once. After that, they can work entirely in the browser and talk to Seshat.
- **Starting a whole project by conversation** is in preview: status by conversation is built, and the milestone for a non-developer starting a project has not run.

## Slower than a frontier model

Local models are slower and weaker than the best cloud models. Expect hours, not minutes, for a batch of issues, and more requests for changes on ambiguous work. Sekhemet is built around that: small issues, checks the model cannot edit, a repair ladder, and a person who accepts. The capstone comparison that measures the difference has not run yet; its results will be published whatever they show.

Where things stand today: [STATUS](../reference/STATUS.md).
