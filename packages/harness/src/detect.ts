import type { Harness } from "./types.ts";
import { ClaudeCodeHarness } from "./claude.ts";
import { CodexHarness } from "./codex.ts";
import { ObserveOnlyHarness } from "./observe-only.ts";

async function probe(bin: string): Promise<boolean> {
  try {
    const proc = Bun.spawn([bin, "--version"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const code = await proc.exited;
    return code === 0;
  } catch {
    return false;
  }
}

export async function detectHarness(): Promise<Harness> {
  if (await probe("claude")) return new ClaudeCodeHarness();
  if (await probe("codex")) return new CodexHarness();
  return new ObserveOnlyHarness();
}
