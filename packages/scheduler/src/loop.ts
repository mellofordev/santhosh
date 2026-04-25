import type { SanthoshNode } from "../../node/src/node.ts";
import type { IndexDb } from "../../store/src/index.ts";
import type {
  AgentInput,
  AgentMode,
  Harness,
} from "../../harness/src/types.ts";
import type { Header } from "../../protocol/src/types.ts";
import type { A2ATask } from "../../protocol/src/a2a.ts";

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
  a2a: number;
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
        a2a: 0,
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
    for (const header of newHeaders) {
      if (!decision.read.includes(header.id)) decision.read.push(header.id);
    }
    if (this.shouldCreateStarterMemory(mode, decision.seed.length)) {
      decision.seed.push(this.starterMemory(peerCount));
      decision.reasoning = appendReason(
        decision.reasoning,
        "deterministic-starter-memory",
      );
    }
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
    let a2a = 0;
    if (peerCount > 0) {
      await this.opts.node.announceStoredUnits();
      a2a = await this.exchangeA2AWithPeers(mode);
    }
    for (const u of unread) this.opts.index.markHeaderRead(u.id);
    const note = appendA2ANote(decision.reasoning, a2a);
    this.opts.index.recordTick(unread.length, reads, seeds, note);
    this.opts.events?.onTick?.({
      mode,
      peers: peerCount,
      headers: unread.length,
      reads,
      seeds,
      a2a,
      note,
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

  private shouldCreateStarterMemory(mode: AgentMode, plannedSeeds: number): boolean {
    if (plannedSeeds > 0) return false;
    if (this.opts.index.countOwnUnits(this.opts.identityPubHex) > 0) return false;
    if (this.opts.index.countUnits() > 0) return false;
    if (mode !== "solo-bootstrap" && mode !== "network-idle") return false;
    return this.canSoloSeed();
  }

  private starterMemory(peerCount: number) {
    const topic = this.opts.index.knownTopics()[0] ?? "santhosh/v1/general";
    const now = new Date().toISOString();
    return {
      topic,
      parents: [],
      tags: ["coordination", "starter", "a2a"],
      summary: "Starter coordination memory from a Santhosh node",
      markdown: [
        "# Starter Coordination Memory",
        "",
        "This node is online and ready to coordinate with nearby Santhosh agents.",
        "",
        "## Requested peer behavior",
        "",
        "- Observe this memory header.",
        "- Fetch and verify the markdown body.",
        "- Reply through A2A over the Santhosh P2P stream if connected.",
        "- Publish a useful memory artifact that other peers can read.",
        "",
        "## Node context",
        "",
        `- Created at: ${now}`,
        `- Connected peers at creation: ${peerCount}`,
      ].join("\n"),
    };
  }

  private async exchangeA2AWithPeers(mode: AgentMode): Promise<number> {
    const peers = this.opts.node.connectedPeers().slice(0, 2);
    let completed = 0;
    for (const peer of peers) {
      try {
        const response = await this.opts.node.sendA2AToPeer(peer.id, {
          jsonrpc: "2.0",
          id: crypto.randomUUID(),
          method: "message/send",
          params: {
            message: {
              kind: "message",
              role: "user",
              messageId: crypto.randomUUID(),
              parts: [
                {
                  kind: "text",
                  text: [
                    "Share one useful Santhosh memory or operational observation with this peer.",
                    `Mode: ${mode}.`,
                    `Known topics: ${this.opts.index.knownTopics().join(", ") || "none"}.`,
                  ].join("\n"),
                },
              ],
              metadata: {
                santhoshPeerExchange: true,
              },
            },
            metadata: {
              source: "santhosh-scheduler",
            },
          },
        });
        if ("result" in response) {
          if (isA2ATask(response.result)) {
            this.opts.index.recordA2ATaskSnapshot(response.result, peer.id);
          }
          completed++;
        }
      } catch {
        continue;
      }
    }
    return completed;
  }
}

function appendA2ANote(note: string | undefined, a2a: number): string | undefined {
  if (a2a === 0) return note;
  const a2aNote = `a2a_exchanges=${a2a}`;
  return note ? `${note}; ${a2aNote}` : a2aNote;
}

function appendReason(note: string | undefined, reason: string): string {
  return note ? `${note}; ${reason}` : reason;
}

function isA2ATask(value: unknown): value is A2ATask {
  if (!value || typeof value !== "object") return false;
  const task = value as Partial<A2ATask>;
  return task.kind === "task" && typeof task.id === "string" && typeof task.contextId === "string";
}
