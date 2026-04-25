import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BlobStore, IndexDb } from "../packages/store/src/index.ts";
import { generateIdentity, signUnit, serialize } from "../packages/protocol/src/index.ts";
import type { A2ATask } from "../packages/protocol/src/a2a.ts";

describe("store", () => {
  test("blob put/get roundtrip", async () => {
    const dir = mkdtempSync(join(tmpdir(), "santhosh-blobs-"));
    const blobs = new BlobStore(dir);
    await blobs.init();
    await blobs.put("abc", "# hi");
    expect(await blobs.has("abc")).toBe(true);
    expect(await blobs.get("abc")).toBe("# hi");
    expect(await blobs.get("missing")).toBeNull();
  });

  test("index records units, dedupes headers, tracks reads", async () => {
    const dir = mkdtempSync(join(tmpdir(), "santhosh-db-"));
    const db = await IndexDb.open(join(dir, "i.db"));
    const id = await generateIdentity();
    const unit = await signUnit(
      {
        topic: "santhosh/v1/general",
        parents: [],
        tags: ["a"],
        summary: "s",
        body: "body",
      },
      id,
    );
    db.recordUnit(unit.frontmatter);
    expect(db.countUnits()).toBe(1);
    expect(db.latestSeedAt(id.publicKeyHex)).toBe(unit.frontmatter.created_at);
    expect(db.knownTopics()).toEqual(["santhosh/v1/general"]);
    expect(db.recordHeaderSeen(unit.frontmatter.id, "peerA", "{}")).toBe(true);
    expect(db.recordHeaderSeen(unit.frontmatter.id, "peerA", "{}")).toBe(false);
    expect(db.unreadHeaders().length).toBe(1);
    db.markHeaderRead(unit.frontmatter.id);
    expect(db.unreadHeaders().length).toBe(0);
  });

  test("index builds knowledge graph from units and announced headers", async () => {
    const dir = mkdtempSync(join(tmpdir(), "santhosh-db-"));
    const db = await IndexDb.open(join(dir, "i.db"));
    const id = await generateIdentity();
    const parent = await signUnit(
      {
        topic: "santhosh/v1/general",
        parents: [],
        tags: ["root"],
        summary: "root note",
        body: "body",
      },
      id,
    );
    const child = await signUnit(
      {
        topic: "santhosh/v1/general",
        parents: [parent.frontmatter.id],
        tags: ["child"],
        summary: "child note",
        body: "body",
      },
      id,
    );
    db.recordUnit(parent.frontmatter);
    db.recordUnit(child.frontmatter);
    db.recordHeaderSeen(
      "announced",
      "peerA",
      JSON.stringify({
        id: "announced",
        topic: "santhosh/v1/general",
        parents: [child.frontmatter.id],
        author: "peer-author",
        tags: ["remote"],
        summary: "remote note",
        created_at: "2026-04-25T00:00:00.000Z",
        sig: "sig",
      }),
    );

    const graph = db.knowledgeGraph();
    expect(graph.nodes.map((n) => n.id).sort()).toEqual(
      [child.frontmatter.id, parent.frontmatter.id, "announced"].sort(),
    );
    expect(graph.nodes.find((n) => n.id === "announced")?.status).toBe(
      "announced",
    );
    expect(graph.links).toContainEqual({
      source: parent.frontmatter.id,
      target: child.frontmatter.id,
    });
    expect(graph.links).toContainEqual({
      source: child.frontmatter.id,
      target: "announced",
    });
  });

  test("index stores A2A tasks, messages, and artifacts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "santhosh-db-"));
    const db = await IndexDb.open(join(dir, "i.db"));
    const task: A2ATask = {
      kind: "task",
      id: "task-1",
      contextId: "ctx-1",
      status: { state: "completed" },
      history: [
        {
          kind: "message",
          role: "user",
          messageId: "msg-1",
          parts: [{ kind: "text", text: "Remember this installer fix" }],
        },
      ],
      artifacts: [
        {
          artifactId: "artifact-1",
          name: "memory",
          parts: [{ kind: "text", text: "# Memory" }],
        },
      ],
    };

    db.upsertA2ATask(task, "peer-1");
    db.recordA2AMessage(task.id, task.history![0]!);
    db.recordA2AArtifact(task.id, task.artifacts![0]!, "unit-1");

    expect(db.listA2ATasks()[0]).toMatchObject({
      id: "task-1",
      contextId: "ctx-1",
      state: "completed",
      peerId: "peer-1",
      goal: "Remember this installer fix",
    });
    const stored = db.getA2ATask("task-1");
    expect(stored?.history?.[0]?.messageId).toBe("msg-1");
    expect(stored?.artifacts?.[0]?.artifactId).toBe("artifact-1");
  });
});
