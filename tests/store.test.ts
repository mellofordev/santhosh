import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BlobStore, IndexDb } from "../packages/store/src/index.ts";
import { generateIdentity, signUnit, serialize } from "../packages/protocol/src/index.ts";

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
});
