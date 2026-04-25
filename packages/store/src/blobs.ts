import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { join } from "node:path";

export class BlobStore {
  constructor(private readonly dir: string) {}

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  private path(hash: string): string {
    return join(this.dir, `${hash}.md`);
  }

  async has(hash: string): Promise<boolean> {
    try {
      await access(this.path(hash));
      return true;
    } catch {
      return false;
    }
  }

  async put(hash: string, markdown: string): Promise<void> {
    await writeFile(this.path(hash), markdown, "utf8");
  }

  async get(hash: string): Promise<string | null> {
    try {
      return await readFile(this.path(hash), "utf8");
    } catch {
      return null;
    }
  }
}
