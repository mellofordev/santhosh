import type { SanthoshNode } from "../../node/src/node.ts";
import type { IndexDb } from "../../store/src/index.ts";
import type {
  AgentInput,
  AgentMode,
  Harness,
} from "../../harness/src/types.ts";
import type { Header } from "../../protocol/src/types.ts";

export interface SchedulerOptions {
  node: SanthoshNode;
  index: IndexDb;
  harness: Harness;
  identityPubHex: string;
  intervalMs: number;
  maxHeadersPerTick: number;
  soloSeedIntervalMs: number;
  maxSeedsPerTick: number;
  events?: SchedulerEvents;
}

export interface TickSummary {
  mode: AgentMode;
  peers: number;
  headers: number;
  reads: number;
  seeds: number;
  note?: string;
}

export interface SchedulerEvents {
  onError?: (err: Error) => void;
  onSeedFailed?: (err: Error) => void;
  onTick?: (summary: TickSummary) => void;
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
      this.opts.events?.onError?.(err as Error);
    } finally {
      this.busy = false;
    }
  }

  private async tick() {
    const peerCount = this.opts.node.peerCount();
    const unread = this.opts.index.unreadHeaders(this.opts.maxHeadersPerTick);
    const mode = this.tickMode(peerCount, unread.length);
    if (mode === "solo-bootstrap" && !this.canSoloSeed()) {
      this.opts.index.recordTick(0, 0, 0, "solo-bootstrap-throttled");
      this.opts.events?.onTick?.({
        mode,
        peers: peerCount,
        headers: 0,
        reads: 0,
        seeds: 0,
        note: "solo-bootstrap-throttled",
      });
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
      mode,
      peerCount,
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
    for (const s of decision.seed.slice(0, this.opts.maxSeedsPerTick)) {
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
        this.opts.events?.onSeedFailed?.(err as Error);
      }
    }
    for (const u of unread) this.opts.index.markHeaderRead(u.id);
    this.opts.index.recordTick(unread.length, reads, seeds, decision.reasoning);
    this.opts.events?.onTick?.({
      mode,
      peers: peerCount,
      headers: unread.length,
      reads,
      seeds,
      note: decision.reasoning,
    });
  }

  private tickMode(peerCount: number, unreadCount: number): AgentMode {
    if (unreadCount > 0) return "peer-observe";
    if (peerCount === 0) return "solo-bootstrap";
    return "network-idle";
  }

  private canSoloSeed(): boolean {
    const latest = this.opts.index.latestSeedAt(this.opts.identityPubHex);
    if (!latest) return true;
    const latestMs = Date.parse(latest);
    if (Number.isNaN(latestMs)) return true;
    return Date.now() - latestMs >= this.opts.soloSeedIntervalMs;
  }
}
