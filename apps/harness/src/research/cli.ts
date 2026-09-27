import { readFileSync } from "node:fs";
import type { CardStore } from "@sekhemet/kernel";
import { McpHub, loadMcpConfig } from "../mcp_client.js";
import { sharedModelAccess } from "../model_access.js";
import { runnerLease } from "../runner_lease.js";
import { renderDisagreements } from "./claims.js";
import { crawl4aiInstalled } from "./crawl4ai.js";
import { RESEARCH_EFFORTS, parseEffort } from "./effort.js";
import { runReuseEval } from "./reuse_eval.js";
import { ResearchService, researchSources, researcherModel } from "./service.js";

export const CRAWL4AI_CREDIT =
  "This product includes software developed by UncleCode (https://x.com/unclecode) as part of the Crawl4AI project (https://github.com/unclecode/crawl4ai).";

export const RESEARCH_USAGE = `Usage: sekhemet research "<question>" [options]

Ask the Researcher. It gathers evidence with its tools (papers, docs, the web,
GitHub, package registries, this repository) and answers with sources.

Options
  --deep            Decompose, research each part, merge (the same as --effort standard)
  --effort <level>  quick, standard or exhaustive: sub-questions, pages read per
                    sub-question and critique depth; exhaustive runs overnight
  --model <name>    Researcher model: apodex (default) or an Ollama tag
  --web / --offline Override the project's research web setting
  --card <id>       Record the answer on the card's dossier
  --fresh           Research again even if memory has an answer
  --rounds <n>      Model turns per question
  --json            Print the full result as JSON
  --batch <file>    Answer one question per line (prefix "deep:" for deep) with one model load
  --status          Show which sources are available, then exit
  --reuse-eval      Measure the reuse survey on its labelled set (precision@1 and
                    correct silence) against the real registries; needs research
                    consent. Add --baseline to record the run as the baseline

Web pages are read with Crawl4AI when installed.
${CRAWL4AI_CREDIT}`;

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
}

export async function runResearchCommand(
  argv: string[],
  repoPath: string,
  cardStore?: CardStore,
  log?: import("@sekhemet/kernel").EventLog,
): Promise<number> {
  const question =
    argv.find(
      (a, i) =>
        !a.startsWith("--") &&
        !["--model", "--card", "--rounds", "--batch", "--effort"].includes(argv[i - 1] ?? ""),
    ) ?? (argv.includes("--batch") ? "(batch)" : undefined);
  if (argv.includes("--reuse-eval")) {
    // DS-P7-7: refused, with nothing sent, without the person's research consent.
    if (!log) {
      console.log("No ledger here to record the measurement: run sekhemet init first.");
      return 1;
    }
    const r = await runReuseEval({
      repoPath,
      log,
      print: (l) => console.log(l),
      offline: argv.includes("--offline") || process.env.SEKHEMET_OFFLINE === "1",
      baseline: argv.includes("--baseline"),
    });
    return "refused" in r ? 1 : r.belowBaseline ? 2 : 0;
  }
  const forceWeb = argv.includes("--web") ? true : argv.includes("--offline") ? false : undefined;
  if (argv.includes("--help") || (!question && !argv.includes("--status"))) {
    console.log(RESEARCH_USAGE);
    return question || argv.includes("--help") ? 0 : 1;
  }
  const effortFlag = flag(argv, "--effort");
  const effort = effortFlag === undefined ? undefined : parseEffort(effortFlag);
  if (effortFlag !== undefined && !effort) {
    console.log(`--effort takes ${RESEARCH_EFFORTS.join(", ")}; got "${effortFlag}".`);
    return 1;
  }
  // DS-N4-1: exhaustive research is refused while a card is running, and
  // offered for the overnight window instead.
  const holder = effort === "exhaustive" ? runnerLease(repoPath) : undefined;
  if (holder) {
    const what = holder.cardId
      ? `card ${holder.cardId} is running`
      : `a ${holder.kind ?? "run"} holds the machine`;
    console.log(
      `Exhaustive research is refused while ${what} (pid ${holder.pid}): it would hold the Researcher for hours.\nRun it in the overnight window instead: add a card labelled "research" and "effort:exhaustive" with this question, and sekhemet overnight runs it when the machine is free; or ask again when the run ends.`,
    );
    return 1;
  }
  const { web, status } = await researchSources(
    repoPath,
    forceWeb === undefined ? {} : { forceWeb },
  );
  console.log(
    `Sources: web ${status.web ? "on" : "off"}; search ${status.search}; pages ${status.pages}${
      !crawl4aiInstalled() ? " (install Crawl4AI for rendered pages)" : ""
    }`,
  );
  // DS-N4-4: what a project's config.toml tried to widen, and was ignored.
  for (const line of status.ignored) console.log(`Network: ${line}`);
  if (!question) return 0;

  // H11: tools from the user's MCP servers, when any are configured.
  const mcpConfig = loadMcpConfig(repoPath);
  const mcp =
    Object.keys(mcpConfig).length > 0 ? await McpHub.connect(repoPath, mcpConfig) : undefined;
  if (mcp) {
    const n = mcp.toolDefinitions().length;
    console.log(
      `MCP: ${n} tool(s) from ${Object.keys(mcpConfig).length} server(s)${mcp.errors.length ? `; failed: ${mcp.errors.join("; ")}` : ""}`,
    );
  }
  const modelName = flag(argv, "--model") ?? process.env.SEKHEMET_RESEARCHER ?? "apodex";
  const model = researcherModel(modelName, sharedModelAccess(), log);
  const rounds = Number(flag(argv, "--rounds")) || undefined;
  const service = new ResearchService({
    repoPath,
    web,
    ...(cardStore ? { cardStore } : {}),
    ...(log ? { log } : {}),
    ...(rounds ? { maxRounds: rounds } : {}),
    onEvent: (line) => process.stderr.write(`${line}\n`),
    ...(mcp ? { mcp } : {}),
    model: model.acquire,
  });
  const cardId = flag(argv, "--card");
  // --batch <file>: one question per line (a line starting "deep:" runs deep),
  // answered in one process with one model load; results as JSON lines.
  const batchFile = flag(argv, "--batch");
  const questions = batchFile
    ? readFileSync(batchFile, "utf8")
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("#"))
    : [question];
  let worst = 0;
  try {
    for (const raw of questions) {
      const deep = argv.includes("--deep") || /^deep:\s*/i.test(raw);
      const q = raw.replace(/^deep:\s*/i, "");
      const started = Date.now();
      const r = await service.ask(q, {
        deep,
        ...(effort ? { effort } : {}),
        fresh: argv.includes("--fresh"),
        ...(cardId ? { cardId } : {}),
      });
      const secs = ((Date.now() - started) / 1000).toFixed(0);
      if (batchFile) {
        console.log(JSON.stringify({ question: q, deep, ...r, seconds: Number(secs) }));
      } else if (argv.includes("--json")) {
        console.log(JSON.stringify({ ...r, seconds: Number(secs) }, null, 2));
      } else {
        console.log(`\n${r.answer}\n`);
        if (r.sources.length) {
          console.log("Sources");
          r.sources.forEach((s, i) => console.log(`  [${i + 1}] ${s}`));
        }
        console.log(
          `\n${r.grounded ? "Grounded" : "NOT grounded"}; confidence ${r.confidence.toFixed(2)}${
            r.badCitations.length ? `; citations to nothing: ${r.badCitations.join(", ")}` : ""
          }${
            r.coverage
              ? `; covered ${r.coverage.covered.length}/${r.coverage.items} (${r.coverage.stoppedBecause})`
              : ""
          }${r.effort ? `; effort ${r.effort}` : ""}${r.fromMemory ? "; from memory" : ""}; ${secs}s`,
        );
        if (r.coverage?.outstanding.length) {
          console.log(`Not covered: ${r.coverage.outstanding.join("; ")}`);
        }
        if (r.disagreements?.length) console.log(`\n${renderDisagreements(r.disagreements)}`);
      }
      if (!r.grounded) worst = 2;
    }
    return worst;
  } finally {
    // The managed server is bound to this process (it never outlives it), so
    // unload it now; nothing may keep the CLI alive afterwards.
    await model.release().catch(() => undefined);
    mcp?.close();
  }
}
