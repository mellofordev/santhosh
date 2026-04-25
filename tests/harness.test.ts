import { describe, expect, test } from "bun:test";
import { ObserveOnlyHarness } from "../packages/harness/src/observe-only.ts";
import { parseDecision, buildPrompt } from "../packages/harness/src/prompt.ts";

describe("harness", () => {
  test("observe-only reads everything, seeds nothing", async () => {
    const h = new ObserveOnlyHarness();
    const decision = await h.decide({
      newHeaders: [
        {
          id: "abc",
          topic: "santhosh/v1/general",
          parents: [],
          author: "deadbeef",
          tags: [],
          summary: "x",
          created_at: "2026-04-25T00:00:00Z",
          sig: "00",
        },
      ],
      knownTopics: [],
      recentSeeds: [],
    });
    expect(decision.read).toEqual(["abc"]);
    expect(decision.seed).toEqual([]);
  });

  test("parseDecision handles fenced JSON", () => {
    const raw = "```json\n{\"read\":[\"x\"],\"seed\":[]}\n```";
    const d = parseDecision(raw);
    expect(d.read).toEqual(["x"]);
  });

  test("parseDecision handles bare JSON with prose around it", () => {
    const raw = "Here is my decision:\n{\"read\":[],\"seed\":[]}\nThanks.";
    const d = parseDecision(raw);
    expect(d.read).toEqual([]);
  });

  test("buildPrompt mentions known topics and headers", () => {
    const p = buildPrompt({
      newHeaders: [],
      knownTopics: ["santhosh/v1/general"],
      recentSeeds: [],
    });
    expect(p).toContain("santhosh/v1/general");
    expect(p).toContain("Return JSON now");
  });
});
