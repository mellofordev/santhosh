import matter from "gray-matter";
import { blake3 } from "@noble/hashes/blake3";
import { bytesToHex } from "@noble/hashes/utils";
import type { Unit, UnitFrontmatter, Header } from "./types.ts";

const TEXT = new TextEncoder();

/**
 * Canonical body for hashing: deterministic JSON of frontmatter (minus id, sig)
 * concatenated with a newline and the markdown body. Keys sorted.
 */
function normalizeBody(body: string): string {
  return body.replace(/\r\n/g, "\n").replace(/\s+$/, "");
}

export function canonicalBytes(
  fm: Omit<UnitFrontmatter, "id" | "sig">,
  body: string,
): Uint8Array {
  const ordered = {
    author: fm.author,
    created_at: fm.created_at,
    parents: [...fm.parents].sort(),
    summary: fm.summary,
    tags: [...fm.tags].sort(),
    topic: fm.topic,
  };
  return TEXT.encode(JSON.stringify(ordered) + "\n" + normalizeBody(body));
}

export function computeId(
  fm: Omit<UnitFrontmatter, "id" | "sig">,
  body: string,
): string {
  return bytesToHex(blake3(canonicalBytes(fm, body)));
}

export function serialize(unit: Unit): string {
  return matter.stringify(unit.body, unit.frontmatter as unknown as Record<string, unknown>);
}

export function parse(raw: string): Unit {
  const { data, content } = matter(raw);
  const fm = data as Partial<UnitFrontmatter>;
  for (const k of [
    "id",
    "topic",
    "parents",
    "author",
    "tags",
    "summary",
    "created_at",
    "sig",
  ] as const) {
    if (fm[k] === undefined) throw new Error(`Missing frontmatter field: ${k}`);
  }
  return { frontmatter: fm as UnitFrontmatter, body: content };
}

export function toHeader(fm: UnitFrontmatter): Header {
  return {
    id: fm.id,
    topic: fm.topic,
    parents: fm.parents,
    author: fm.author,
    tags: fm.tags,
    summary: fm.summary,
    created_at: fm.created_at,
    sig: fm.sig,
  };
}
