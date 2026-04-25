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
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code !== 0) {
      const detail = (stderr.trim() || stdout.trim() || "(no output)").slice(0, 2000);
      throw new Error(`claude exited with code ${code}: ${detail}`);
    }
    try {
      return parseDecision(stdout);
    } catch (err) {
      throw new Error(
        `failed to parse claude output as decision JSON: ${(err as Error).message}\n--- raw ---\n${stdout}`,
      );
    }
  }
}
