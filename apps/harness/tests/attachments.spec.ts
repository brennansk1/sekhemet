import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { type InferenceRequest, MockInferenceAdapter } from "@sekhemet/models";
import { afterEach, describe, expect, it } from "vitest";
import {
  attachImage,
  cardsNeedingVision,
  listAttachments,
  resolveVisionModel,
  sniffImage,
  visionPrePass,
} from "../src/attachments.js";
import { runWave2Command } from "../src/wave2.js";
import { handleWave2Route } from "../src/wave2_server.js";

const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d4948445200000001000000010806000000" +
    "1f15c4890000000d49444154789c6360000002000105fe02fea70000000049454e44ae426082",
  "hex",
);
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

async function setup() {
  const repo = mkdtempSync(join(tmpdir(), "sek-attach-"));
  dirs.push(repo);
  const db = new DatabaseSync(":memory:");
  initSchema(db);
  const log = new EventLog(db);
  const store = new CardStore(db, log);
  const card = await store.createCard({
    tier: "task",
    title: "Fix the overlapping login button",
    spec: "See the screenshot.",
  });
  return { repo, log, store, card };
}

describe("X3: multimodal card input", () => {
  it("saves images with the evidence, refuses non-images, and puts them on the ledger", async () => {
    const { repo, store, card } = await setup();
    expect(sniffImage(PNG)).toBe("image/png");
    const a = await attachImage(repo, store, card.id, { name: "../shot 1.png", bytes: PNG });
    expect(a).toMatchObject({ name: "shot_1.png", mime: "image/png" });
    expect(a.path.startsWith(".sekhemet/evidence/attachments/")).toBe(true);
    // The same bytes twice are one attachment.
    await attachImage(repo, store, card.id, { name: "again.png", bytes: PNG });
    expect(listAttachments(repo, card.id)).toHaveLength(1);
    await expect(
      attachImage(repo, store, card.id, { name: "x.png", bytes: Buffer.from("<svg/>") }),
    ).rejects.toThrow(/not a PNG/);
    expect(await store.cardEvents(card.id, ["card/attachment"])).toHaveLength(1);
  });

  it("the vision model sees the pixels once; text models get the description via the dossier", async () => {
    const { repo, store, card } = await setup();
    await attachImage(repo, store, card.id, { name: "shot.png", bytes: PNG });
    const seen: InferenceRequest[] = [];
    const vision = new MockInferenceAdapter("qwen-vl", [], {
      rules: [
        {
          match: (req) => {
            seen.push(req);
            return true;
          },
          response: {
            text: '{"description":"The Sign in button overlaps the password field.","criteria":["The Sign in button does not overlap the password field"]}',
            toolCalls: [],
            usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 },
          },
        },
      ],
    });
    let released = 0;
    const deps = {
      modelName: resolveVisionModel("auto", { visionModels: () => [{ id: "qwen-vl" }] }),
      load: async () => vision,
      release: async () => {
        released++;
      },
    };
    expect(deps.modelName).toBe("qwen-vl");
    expect(await visionPrePass(repo, store, [card], deps)).toBe(1);
    expect(seen[0]?.images?.[0]).toMatchObject({ mime: "image/png", data: PNG.toString("base64") });
    expect(released).toBe(1);
    const dossier = await store.getDossier(card.id);
    expect(dossier.notes[0]?.text).toMatch(/overlaps the password field/);
    expect(dossier.notes[0]?.text).toMatch(/Visual criteria:\n- The Sign in button/);
    expect(dossier.notes[0]?.text).not.toContain(PNG.toString("base64"));
    // Described once: the next pass has nothing to do and loads nothing.
    expect(await cardsNeedingVision(repo, store, [card])).toEqual([]);
    expect(await visionPrePass(repo, store, [card], deps)).toBe(0);
    expect(released).toBe(1);
  });

  it("without a vision model the images wait and are named", async () => {
    const { repo, store, card } = await setup();
    await attachImage(repo, store, card.id, { name: "shot.png", bytes: PNG });
    const lines: string[] = [];
    const n = await visionPrePass(repo, store, [card], {
      load: async () => {
        throw new Error("must not load");
      },
      say: (l) => lines.push(l),
    });
    expect(n).toBe(0);
    expect(lines[0]).toMatch(/no vision model is configured/);
  });

  it("the dashboard uploads and serves them; `sekhemet attach` adds from files", async () => {
    const { repo, log, store, card } = await setup();
    const ctx = {
      repoPath: repo,
      cardStore: store,
      log,
      json: (res: { s?: number; b?: unknown }, s: number, b: unknown) => {
        res.s = s;
        res.b = b;
      },
      isTrustedMutation: () => true,
      readJsonBody: async () => ({}),
    };
    const body = JSON.stringify({
      name: "mock.png",
      data: `data:image/png;base64,${PNG.toString("base64")}`,
    });
    const post = Object.assign([Buffer.from(body)], { method: "POST", headers: {} });
    const res: { s?: number; b?: unknown } = {};
    await handleWave2Route(
      post as never,
      res as never,
      `/api/cards/${card.id}/attachments`,
      ctx as never,
    );
    expect(res.s).toBe(201);
    const id = (res.b as { attachment: { id: string } }).attachment.id;
    const served: { head?: Record<string, string>; bytes?: Buffer } = {};
    const out = {
      writeHead: (_s: number, h: Record<string, string>) => {
        served.head = h;
      },
      end: (b: Buffer) => {
        served.bytes = b;
      },
    };
    await handleWave2Route(
      { method: "GET", headers: {} } as never,
      out as never,
      `/api/cards/${card.id}/attachments/${id}`,
      ctx as never,
    );
    expect(served.head?.["content-type"]).toBe("image/png");
    expect(served.bytes?.equals(PNG)).toBe(true);

    const file = join(repo, "board.gif");
    writeFileSync(file, Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(20)]));
    const lines: string[] = [];
    expect(
      await runWave2Command(
        "attach",
        [card.id, file],
        { repoPath: repo, log, cardStore: store },
        {
          print: (l) => lines.push(l),
        },
      ),
    ).toBe(0);
    expect(lines[0]).toMatch(/Attached board.gif \(image\/gif/);
    expect(listAttachments(repo, card.id)).toHaveLength(2);
  });
});
