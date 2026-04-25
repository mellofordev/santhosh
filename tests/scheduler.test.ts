import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Scheduler } from "../packages/scheduler/src/loop.ts";
import { IndexDb } from "../packages/store/src/index.ts";
import {
  generateIdentity,
  signUnit,
  toHeader,
  type Header,
} from "../packages/protocol/src/index.ts";
import type { AgentDecision, AgentInput } from "../packages/harness/src/types.ts";

function schedulerOpts(overrides: {
  node: any;
  index: IndexDb;
  identityPubHex: string;
  decide: (input: AgentInput) => Promise<AgentDecision>;
  onTick?: (summary: any) => void;
}) {
  return {
    node: overrides.node,
    index: overrides.index,
    harness: { name: "test", decide: overrides.decide },
    identityPubHex: overrides.identityPubHex,
    intervalMs: 60_000,
    maxHeadersPerTick: 20,
    soloSeedIntervalMs: 60 * 60 * 1000,
    maxSeedsPerTick: 1,
    events: { onTick: overrides.onTick },
  };
}

describe("scheduler", () => {
  test("solo node calls harness in solo-bootstrap mode", async () => {
    const dir = mkdtempSync(join(tmpdir(), "santhosh-scheduler-"));
    const index = await IndexDb.open(join(dir, "i.db"));
    const id = await generateIdentity();
    const seenInputs: AgentInput[] = [];
    let tick: any = null;
    const scheduler = new Scheduler(
      schedulerOpts({
        index,
        identityPubHex: id.publicKeyHex,
        node: {
          peerCount: () => 0,
          readById: async () => false,
          seed: async () => undefined,
        },
        decide: async (input) => {
          seenInputs.push(input);
          return { read: [], seed: [] };
        },
        onTick: (summary) => {
          tick = summary;
        },
      }),
    );

    await (scheduler as any).tick();

    const input = seenInputs[0]!;
    expect(input.mode).toBe("solo-bootstrap");
    expect(input.peerCount).toBe(0);
    expect(tick?.mode).toBe("solo-bootstrap");
  });

  test("unread headers put scheduler in peer-observe mode", async () => {
    const dir = mkdtempSync(join(tmpdir(), "santhosh-scheduler-"));
    const index = await IndexDb.open(join(dir, "i.db"));
    const id = await generateIdentity();
    const unit = await signUnit(
      {
        topic: "santhosh/v1/general",
        parents: [],
        tags: ["test"],
        summary: "test header",
        body: "body",
      },
      id,
    );
    const header: Header = toHeader(unit.frontmatter);
    index.recordHeaderSeen(header.id, "peerA", JSON.stringify(header));

    const seenInputs: AgentInput[] = [];
    const readIds: string[] = [];
    const scheduler = new Scheduler(
      schedulerOpts({
        index,
        identityPubHex: id.publicKeyHex,
        node: {
          peerCount: () => 1,
          readById: async (hash: string) => {
            readIds.push(hash);
            return true;
          },
          seed: async () => undefined,
        },
        decide: async (input) => {
          seenInputs.push(input);
          return { read: [header.id], seed: [] };
        },
      }),
    );

    await (scheduler as any).tick();

    const input = seenInputs[0]!;
    expect(input.mode).toBe("peer-observe");
    expect(input.newHeaders.map((h: Header) => h.id)).toEqual([header.id]);
    expect(readIds).toEqual([header.id]);
  });
});
