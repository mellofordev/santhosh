import type { AgentDecision, AgentInput, Harness } from "./types.ts";
import { buildPrompt, parseDecision } from "./prompt.ts";

export class CodexHarness implements Harness {
  name = "codex";

  async decide(input: AgentInput): Promise<AgentDecision> {
    const prompt = buildPrompt(input);
    const proc = Bun.spawn(["codex", "exec", prompt], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, code] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    if (code !== 0) throw new Error(`codex exited with code ${code}`);
    try {
      return parseDecision(stdout);
    } catch (err) {
      throw new Error(
        `failed to parse codex output as decision JSON: ${(err as Error).message}\n--- raw ---\n${stdout}`,
      );
    }
  }
}
