import { z } from "zod";
import type { AgentInput } from "./types.ts";

export const DecisionSchema = z.object({
  read: z.array(z.string()).default([]),
  seed: z
    .array(
      z.object({
        markdown: z.string(),
        parents: z.array(z.string()).default([]),
        topic: z.string(),
        tags: z.array(z.string()).optional(),
        summary: z.string(),
      }),
    )
    .default([]),
  reasoning: z.string().optional(),
});

export function buildPrompt(input: AgentInput): string {
  return `You are a node-agent in the Santhosh P2P knowledge protocol.

You see lightweight HEADERS from peers. You may:
  - read: list the header ids whose full content you want fetched
  - seed: produce new markdown knowledge units that build on what you've read or know

Respond ONLY with JSON matching this schema (no prose, no markdown fences):
{
  "read": [<id>...],
  "seed": [
    {
      "topic": "santhosh/v1/<namespace>",
      "parents": [<id>...],
      "tags": [<tag>...],
      "summary": "<one sentence>",
      "markdown": "<full markdown body>"
    }
  ],
  "reasoning": "<optional short rationale>"
}

KNOWN TOPICS: ${JSON.stringify(input.knownTopics)}
RECENT OWN SEEDS: ${JSON.stringify(input.recentSeeds)}
NEW HEADERS:
${JSON.stringify(input.newHeaders, null, 2)}

Return JSON now:`;
}

export function parseDecision(raw: string) {
  const trimmed = extractJson(raw);
  return DecisionSchema.parse(JSON.parse(trimmed));
}

function extractJson(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) return fenced[1]!.trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) return raw.slice(start, end + 1);
  return raw.trim();
}
