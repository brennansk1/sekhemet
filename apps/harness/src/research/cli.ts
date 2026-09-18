import type { CardStore } from "@sekhemet/kernel";
import type { LocalInferenceAdapter } from "@sekhemet/models";
import { crawl4aiInstalled } from "./crawl4ai.js";
import { ResearchService, researchSources, researcherAdapter } from "./service.js";

export const CRAWL4AI_CREDIT =
  "This product includes software developed by UncleCode (https://x.com/unclecode) as part of the Crawl4AI project (https://github.com/unclecode/crawl4ai).";

export const RESEARCH_USAGE = `Usage: sekhemet research "<question>" [options]

Ask the Researcher. It gathers evidence with its tools (papers, docs, the web,
GitHub, package registries, this repository) and answers with sources.

Options
  --deep            Decompose, research each part, merge (slower, broader)
  --model <name>    Researcher model: apodex (default) or an Ollama tag
  --web / --offline Override the project's research web setting
  --card <id>       Record the answer on the card's dossier
  --fresh           Research again even if memory has an answer
  --rounds <n>      Model turns per question
  --json            Print the full result as JSON
  --keep            Leave the Researcher model loaded afterwards
  --status          Show which sources are available, then exit

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
): Promise<number> {
  const question = argv.find(
    (a, i) => !a.startsWith("--") && !["--model", "--card", "--rounds"].includes(argv[i - 1] ?? ""),
  );
  const forceWeb = argv.includes("--web") ? true : argv.includes("--offline") ? false : undefined;
  if (argv.includes("--help") || (!question && !argv.includes("--status"))) {
    console.log(RESEARCH_USAGE);
    return question || argv.includes("--help") ? 0 : 1;
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
  if (!question) return 0;

  const modelName = flag(argv, "--model") ?? process.env.SEKHEMET_RESEARCHER ?? "apodex";
  let adapter: LocalInferenceAdapter | undefined;
  const rounds = Number(flag(argv, "--rounds")) || undefined;
  const service = new ResearchService({
    repoPath,
    web,
    ...(cardStore ? { cardStore } : {}),
    ...(rounds ? { maxRounds: rounds } : {}),
    model: async () => {
      adapter ??= researcherAdapter(modelName);
      return adapter;
    },
  });
  const cardId = flag(argv, "--card");
  const started = Date.now();
  try {
    const r = await service.ask(question, {
      deep: argv.includes("--deep"),
      fresh: argv.includes("--fresh"),
      ...(cardId ? { cardId } : {}),
    });
    const secs = ((Date.now() - started) / 1000).toFixed(0);
    if (argv.includes("--json")) {
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
        }${r.fromMemory ? "; from memory" : ""}; ${secs}s`,
      );
    }
    return r.grounded ? 0 : 2;
  } finally {
    const unload = (adapter as { unload?: () => Promise<void> } | undefined)?.unload;
    if (unload && !argv.includes("--keep")) await unload.call(adapter).catch(() => undefined);
  }
}
