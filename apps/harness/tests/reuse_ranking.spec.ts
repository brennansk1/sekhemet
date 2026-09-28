import { describe, expect, it } from "vitest";
import { type LibraryCandidate, formatHits, searchLibraries } from "../src/pm/libraries.js";
import { reuseSurvey } from "../src/research/reuse.js";

/**
 * Design-stage P7 (compliance C3): candidates are ranked by BM25 over their
 * names, descriptions and keywords in SQLite FTS5 (REUSE_SURVEY_2026-09
 * "relevance ranking"), not taken in the registry's order and matched on
 * five-letter stems, which the Phase A review (domain08 §6) said "cannot make
 * that call". No verdict is handed in: the classifier judges every licence.
 */

const NOW = new Date("2026-09-27T00:00:00Z");

const lib = (
  name: string,
  description: string,
  extra: Partial<LibraryCandidate> = {},
): LibraryCandidate => ({
  name,
  ecosystem: "npm",
  version: "1.0.0",
  license: "MIT",
  description,
  weeklyDownloads: 1_000_000,
  publishedAt: "2026-06-01T00:00:00Z",
  url: `https://www.npmjs.com/package/${name}`,
  ...extra,
});

const survey = async (need: string, libraries: LibraryCandidate[]) =>
  (
    await reuseSurvey(
      [need],
      { libraries: async () => libraries, repos: async () => [] },
      { now: NOW },
    )
  )[0];

describe("BM25 ranking over name, description and keywords", () => {
  it("ranks on every word of the need, not only the four the keyword query sends (fix review C3)", async () => {
    // Content words: stores, user, sessions, exports | receipts, pdf. With no
    // Planning model the query sent is the first four; ranking is local, so
    // the fifth and sixth count too.
    const f = await survey("stores user sessions and exports receipts as pdf", [
      lib("pdfkit", "PDF generation for receipts and invoices", { keywords: ["pdf", "receipts"] }),
    ]);
    expect(f?.libraries.map((l) => l.name)).toEqual(["pdfkit"]);
  });

  it("puts the candidate that holds more of the need above one the registry listed first", async () => {
    // The fixture registry's live-like failure: papaparse ("JSON", "web
    // workers") shares two words with a JSON Web Token need.
    const f = await survey("signs and verifies json web tokens", [
      lib(
        "papaparse",
        "Fast and powerful CSV parser for the browser that supports web workers. Converts CSV to JSON and JSON to CSV.",
        { weeklyDownloads: 5_000_000 },
      ),
      lib("jose", "JWA, JWS, JWE, JWT, JWK, JWKS for Node.js and the browser", {
        keywords: ["json web token", "sign", "verify", "jwt"],
        weeklyDownloads: 25_000_000,
      }),
    ]);
    expect(f?.libraries[0]?.name).toBe("jose");
  });

  it("reads a candidate's keywords, not only its name and description", async () => {
    const f = await survey("hashes passwords", [
      lib("argon2", "An Argon2 library for Node", { keywords: ["hashing", "password"] }),
    ]);
    expect(f?.libraries.map((l) => l.name)).toEqual(["argon2"]);
  });

  it("stems words, and reads a hyphenated word joined: 'sends email' finds 'e-mail sending'", async () => {
    const f = await survey("sends email over smtp", [
      lib("nodemailer", "Easy as cake e-mail sending from your Node.js applications", {
        license: "MIT-0",
      }),
    ]);
    expect(f?.libraries.map((l) => l.name)).toEqual(["nodemailer"]);
  });

  it("matches a long stem's longer words: 'parses' finds a 'parser', 'serves' a 'server'", async () => {
    expect(
      (await survey("parses yaml documents", [lib("js-yaml", "YAML 1.2 parser and serializer")]))
        ?.libraries[0]?.name,
    ).toBe("js-yaml");
    expect(
      (
        await survey("serves websocket connections", [
          lib("ws", "Simple to use websocket client and server for Node.js"),
        ])
      )?.libraries[0]?.name,
    ).toBe("ws");
  });

  it("orders equally relevant candidates by popularity, whatever the registry's order", async () => {
    const f = await survey("parses csv files", [
      lib("csv-lite", "Parse CSV text", { weeklyDownloads: 2_000 }),
      lib("csv-heavy", "Parse CSV text", { weeklyDownloads: 8_000_000 }),
    ]);
    expect(f?.libraries.map((l) => l.name)).toEqual(["csv-heavy", "csv-lite"]);
  });

  it("still drops a candidate that shares one word of a two-word need", async () => {
    const f = await survey("handles refunds for orders", [
      lib("order-id", "Generate unique order ids"),
      lib("refund-kit", "Compute and issue refunds for orders"),
    ]);
    expect(f?.libraries.map((l) => l.name)).toEqual(["refund-kit"]);
  });

  it("find_library shows the survey's order (DS-P7-9)", () => {
    const found = [
      lib("csv-lite", "Parse CSV text", { weeklyDownloads: 2_000 }),
      lib("csv-heavy", "Parse CSV text", { weeklyDownloads: 8_000_000 }),
    ];
    const text = formatHits("parse csv", found, NOW);
    expect(text.indexOf("csv-heavy")).toBeLessThan(text.indexOf("csv-lite"));
  });

  it("keeps npm's keywords from the search response", async () => {
    const fetcher = async () => ({
      objects: [
        {
          package: {
            name: "argon2",
            version: "0.41.0",
            description: "An Argon2 library for Node",
            keywords: ["argon2", "hashing", "password"],
            license: "MIT",
          },
          downloads: { weekly: 600_000 },
        },
      ],
    });
    const [hit] = await searchLibraries("hashes passwords", "npm", fetcher);
    expect(hit?.keywords).toEqual(["argon2", "hashing", "password"]);
  });
});
