import { Database } from "bun:sqlite";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Header, UnitFrontmatter } from "../../protocol/src/types.ts";

export { BlobStore } from "./blobs.ts";

export interface KnowledgeGraphNode {
  id: string;
  topic: string;
  author: string;
  createdAt: string;
  summary: string;
  tags: string[];
  status: "stored" | "announced";
}

export interface KnowledgeGraphLink {
  source: string;
  target: string;
}

export interface KnowledgeGraph {
  nodes: KnowledgeGraphNode[];
  links: KnowledgeGraphLink[];
}

export class IndexDb {
  private db: Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.migrate();
  }

  static async open(path: string): Promise<IndexDb> {
    await mkdir(dirname(path), { recursive: true });
    return new IndexDb(path);
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS units (
        id TEXT PRIMARY KEY,
        topic TEXT NOT NULL,
        author TEXT NOT NULL,
        created_at TEXT NOT NULL,
        parents_json TEXT NOT NULL,
        tags_json TEXT NOT NULL,
        summary TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_units_topic ON units(topic);
      CREATE INDEX IF NOT EXISTS idx_units_author ON units(author);

      CREATE TABLE IF NOT EXISTS headers_seen (
        id TEXT PRIMARY KEY,
        first_seen TEXT NOT NULL,
        source_peer TEXT,
        read_at TEXT,
        header_json TEXT
      );

      CREATE TABLE IF NOT EXISTS tick_log (
        ts TEXT NOT NULL,
        new_headers INTEGER NOT NULL,
        reads INTEGER NOT NULL,
        seeds INTEGER NOT NULL,
        note TEXT
      );
    `);
  }

  recordUnit(fm: UnitFrontmatter): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO units (id, topic, author, created_at, parents_json, tags_json, summary)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        fm.id,
        fm.topic,
        fm.author,
        fm.created_at,
        JSON.stringify(fm.parents),
        JSON.stringify(fm.tags),
        fm.summary,
      );
  }

  recordHeaderSeen(id: string, sourcePeer?: string, headerJson?: string): boolean {
    const row = this.db
      .prepare("SELECT id FROM headers_seen WHERE id = ?")
      .get(id);
    if (row) return false;
    this.db
      .prepare(
        `INSERT INTO headers_seen (id, first_seen, source_peer, header_json) VALUES (?, ?, ?, ?)`,
      )
      .run(id, new Date().toISOString(), sourcePeer ?? null, headerJson ?? null);
    return true;
  }

  getStoredHeader(id: string): string | null {
    const row = this.db
      .prepare("SELECT header_json FROM headers_seen WHERE id = ?")
      .get(id) as { header_json: string | null } | undefined;
    return row?.header_json ?? null;
  }

  markHeaderRead(id: string): void {
    this.db
      .prepare("UPDATE headers_seen SET read_at = ? WHERE id = ?")
      .run(new Date().toISOString(), id);
  }

  unreadHeaders(limit = 50): { id: string; first_seen: string }[] {
    return this.db
      .prepare(
        `SELECT id, first_seen FROM headers_seen
         WHERE read_at IS NULL
         ORDER BY first_seen ASC LIMIT ?`,
      )
      .all(limit) as { id: string; first_seen: string }[];
  }

  knownTopics(): string[] {
    const rows = this.db
      .prepare(`SELECT DISTINCT topic FROM units`)
      .all() as { topic: string }[];
    return rows.map((r) => r.topic);
  }

  recentSeeds(author: string, limit = 10): { id: string; topic: string }[] {
    return this.db
      .prepare(
        `SELECT id, topic FROM units WHERE author = ? ORDER BY created_at DESC LIMIT ?`,
      )
      .all(author, limit) as { id: string; topic: string }[];
  }

  latestSeedAt(author: string): string | null {
    const row = this.db
      .prepare(
        `SELECT created_at FROM units WHERE author = ? ORDER BY created_at DESC LIMIT 1`,
      )
      .get(author) as { created_at: string } | undefined;
    return row?.created_at ?? null;
  }

  recordTick(newHeaders: number, reads: number, seeds: number, note?: string) {
    this.db
      .prepare(
        `INSERT INTO tick_log (ts, new_headers, reads, seeds, note) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(new Date().toISOString(), newHeaders, reads, seeds, note ?? null);
  }

  lastTick(): { ts: string; new_headers: number; reads: number; seeds: number } | null {
    return (
      this.db
        .prepare(`SELECT ts, new_headers, reads, seeds FROM tick_log ORDER BY ts DESC LIMIT 1`)
        .get() as { ts: string; new_headers: number; reads: number; seeds: number } | undefined
    ) ?? null;
  }

  countUnits(): number {
    return (this.db.prepare("SELECT COUNT(*) as c FROM units").get() as { c: number }).c;
  }

  knowledgeGraph(limit = 80): KnowledgeGraph {
    const nodes = new Map<string, KnowledgeGraphNode>();
    const links: KnowledgeGraphLink[] = [];
    const unitRows = this.db
      .prepare(
        `SELECT * FROM units ORDER BY created_at DESC LIMIT ?`,
      )
      .all(limit) as {
      id: string;
      topic: string;
      author: string;
      created_at: string;
      parents_json: string;
      tags_json: string;
      summary: string;
    }[];

    for (const row of unitRows) {
      const parents = parseJsonArray(row.parents_json);
      nodes.set(row.id, {
        id: row.id,
        topic: row.topic,
        author: row.author,
        createdAt: row.created_at,
        summary: row.summary,
        tags: parseJsonArray(row.tags_json),
        status: "stored",
      });
      for (const parent of parents) links.push({ source: parent, target: row.id });
    }

    const remaining = Math.max(0, limit - nodes.size);
    if (remaining > 0) {
      const headerRows = this.db
        .prepare(
          `SELECT id, first_seen, source_peer, header_json FROM headers_seen
           WHERE header_json IS NOT NULL
           ORDER BY first_seen DESC LIMIT ?`,
        )
        .all(remaining) as {
        id: string;
        first_seen: string;
        source_peer: string | null;
        header_json: string | null;
      }[];

      for (const row of headerRows) {
        if (nodes.has(row.id) || !row.header_json) continue;
        try {
          const header = JSON.parse(row.header_json) as Header;
          nodes.set(header.id, {
            id: header.id,
            topic: header.topic,
            author: header.author || row.source_peer || "unknown",
            createdAt: header.created_at || row.first_seen,
            summary: header.summary,
            tags: header.tags,
            status: "announced",
          });
          for (const parent of header.parents) {
            links.push({ source: parent, target: header.id });
          }
        } catch {
          // Malformed stored headers are ignored; gossip validation happens elsewhere.
        }
      }
    }

    for (const link of links) {
      if (!nodes.has(link.source)) {
        nodes.set(link.source, {
          id: link.source,
          topic: "unknown",
          author: "unknown",
          createdAt: "",
          summary: "Parent not stored locally",
          tags: [],
          status: "announced",
        });
      }
    }

    return {
      nodes: [...nodes.values()],
      links: links.filter((link) => nodes.has(link.source) && nodes.has(link.target)),
    };
  }

  // Lookup full header from units table (for outbound gossip).
  getUnitHeader(id: string): Pick<Header, "id" | "topic" | "author" | "created_at" | "parents" | "tags" | "summary"> | null {
    const row = this.db
      .prepare(`SELECT * FROM units WHERE id = ?`)
      .get(id) as
      | {
          id: string;
          topic: string;
          author: string;
          created_at: string;
          parents_json: string;
          tags_json: string;
          summary: string;
        }
      | undefined;
    if (!row) return null;
    return {
      id: row.id,
      topic: row.topic,
      author: row.author,
      created_at: row.created_at,
      parents: JSON.parse(row.parents_json),
      tags: JSON.parse(row.tags_json),
      summary: row.summary,
    };
  }
}

function parseJsonArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}
