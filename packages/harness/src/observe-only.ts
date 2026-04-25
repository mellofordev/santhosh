import type { AgentDecision, AgentInput, Harness } from "./types.ts";

export class ObserveOnlyHarness implements Harness {
  name = "observe-only";
  async decide(input: AgentInput): Promise<AgentDecision> {
    return { read: input.newHeaders.map((h) => h.id), seed: [] };
  }
}
