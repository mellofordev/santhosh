import type { SanthoshNode } from "../../node/src/node.ts";
import type { IndexDb } from "../../store/src/index.ts";
import type { Harness, AgentInput } from "../../harness/src/types.ts";
import type { Header } from "../../protocol/src/types.ts";

export interface SchedulerOptions {
  node: SanthoshNode;
  index: IndexDb;
  harness: Harness;
  identityPubHex: string;
  intervalMs: number;
  maxHeadersPerTick: number;
}

export class Scheduler {
  private timer: Timer | null = null;
  private busy = false;
  constructor(private opts: SchedulerOptions) {}

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.safeTick(), this.opts.intervalMs);
    void this.safeTick();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async safeTick() {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.tick();
    } catch (err) {
      console.error("[tick] error:", (err as Error).message);
    } finally {
      this.busy = false;
    }
  }

  private async tick() {
    const unread = this.opts.index.unreadHeaders(this.opts.maxHeadersPerTick);
    if (unread.length === 0) {
      this.opts.index.recordTick(0, 0, 0, "idle");
      return;
    }
    const newHeaders: Header[] = [];
    for (const u of unread) {
      const json = this.opts.index.getStoredHeader(u.id);
      if (json) {
        try {
          newHeaders.push(JSON.parse(json) as Header);
        } catch {}
      }
    }
    const input: AgentInput = {
      newHeaders,
      knownTopics: this.opts.index.knownTopics(),
      recentSeeds: this.opts.index.recentSeeds(this.opts.identityPubHex),
    };
    const decision = await this.opts.harness.decide(input);
    let reads = 0;
    for (const id of decision.read) {
      const ok = await this.opts.node.readById(id);
      if (ok) reads++;
    }
    let seeds = 0;
    for (const s of decision.seed) {
      try {
        await this.opts.node.seed({
          topic: s.topic,
          parents: s.parents,
          tags: s.tags ?? [],
          summary: s.summary,
          body: s.markdown,
        });
        seeds++;
      } catch (err) {
        console.warn("[tick] seed failed:", (err as Error).message);
      }
    }
    for (const u of unread) this.opts.index.markHeaderRead(u.id);
    this.opts.index.recordTick(unread.length, reads, seeds, decision.reasoning);
    console.log(
      `[tick] headers=${unread.length} reads=${reads} seeds=${seeds}`,
    );
  }
}
