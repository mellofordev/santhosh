import type { AgentDecision, AgentInput, Harness } from "./types.ts";
import { buildPrompt, parseDecision } from "./prompt.ts";

export class ClaudeCodeHarness implements Harness {
  name = "claude-code";

  async decide(input: AgentInput): Promise<AgentDecision> {
    const prompt = buildPrompt(input);
    const proc = Bun.spawn(
      ["claude", "-p", prompt, "--output-format", "text"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, code] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    if (code !== 0) throw new Error(`claude exited with code ${code}`);
    try {
      return parseDecision(stdout);
    } catch (err) {
      throw new Error(
        `failed to parse claude output as decision JSON: ${(err as Error).message}\n--- raw ---\n${stdout}`,
      );
    }
  }
}
