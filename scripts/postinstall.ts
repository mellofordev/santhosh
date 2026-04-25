#!/usr/bin/env bun
import { appendFile, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const bunBin = join(homedir(), ".bun", "bin");
const exportLine = `\nexport PATH="${bunBin}:$PATH"\n`;

// Already in PATH — nothing to do.
if (process.env.PATH?.split(":").includes(bunBin)) process.exit(0);

const shell = process.env.SHELL ?? "";

const rcFiles: Record<string, string> = {
  zsh: join(homedir(), ".zshrc"),
  bash: join(homedir(), ".bashrc"),
  fish: join(homedir(), ".config", "fish", "config.fish"),
};

const fishExport = `\nfish_add_path "${bunBin}"\n`;

async function alreadyPatched(file: string, marker: string): Promise<boolean> {
  try {
    const contents = await readFile(file, "utf8");
    return contents.includes(marker);
  } catch {
    return false;
  }
}

async function patch(file: string, line: string) {
  if (await alreadyPatched(file, bunBin)) return;
  await appendFile(file, line, "utf8");
}

const shellName = Object.keys(rcFiles).find((s) => shell.endsWith(s));

if (shellName && rcFiles[shellName]) {
  const file = rcFiles[shellName]!;
  const line = shellName === "fish" ? fishExport : exportLine;
  await patch(file, line);
  console.log(`\n✓ Added santhosh to PATH in ${file}`);
  console.log(`  Run this once now, or open a new terminal:\n`);
  if (shellName === "fish") {
    console.log(`    fish_add_path "${bunBin}"\n`);
  } else {
    console.log(`    export PATH="${bunBin}:$PATH"\n`);
  }
} else {
  // Unknown shell — print manual instructions.
  console.log(`\n  Add this to your shell config to use santhosh:\n`);
  console.log(`    export PATH="${bunBin}:$PATH"\n`);
}
