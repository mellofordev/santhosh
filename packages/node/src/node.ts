import type { Libp2p } from "libp2p";
import type { Connection } from "@libp2p/interface";
import { createHost, type HostOptions } from "./host.ts";
import { BlobStore, IndexDb } from "../../store/src/index.ts";
import {
  FETCH_PROTOCOL,
  TOPIC_PREFIX,
  decodeHeader,
  encodeHeader,
  fetchBlob,
  fetchStreamHandler,
  parse as parseUnit,
  serialize as serializeUnit,
  signUnit,
  toHeader,
  verifyUnit,
  type Header,
  type Identity,
  type UnseededUnit,
} from "../../protocol/src/index.ts";

export interface SanthoshNodeOptions extends HostOptions {
  identity: Identity;
  blobs: BlobStore;
  index: IndexDb;
  initialTopics: string[];
}

export class SanthoshNode {
  private libp2p!: Libp2p;
  constructor(private opts: SanthoshNodeOptions) {}

  get peerId() {
    return this.libp2p.peerId.toString();
  }

  get pubsub() {
    return (this.libp2p.services as any).pubsub;
  }

  async start(): Promise<void> {
    this.libp2p = await createHost(this.opts);
    await this.libp2p.handle(
      FETCH_PROTOCOL,
      fetchStreamHandler({
        loadBlob: (hash) => this.opts.blobs.get(hash),
      }),
    );
    this.pubsub.addEventListener("message", (evt: any) => {
      const topic: string = evt.detail.topic;
      if (!topic.startsWith(TOPIC_PREFIX)) return;
      try {
        const header = decodeHeader(evt.detail.data);
        const fresh = this.opts.index.recordHeaderSeen(
          header.id,
          evt.detail.from?.toString(),
          JSON.stringify(header),
        );
        if (fresh) console.log(`[gossip] new header ${header.id.slice(0, 12)} on ${topic}`);
      } catch (err) {
        console.warn("[gossip] bad header:", err);
      }
    });
    for (const t of this.opts.initialTopics) this.pubsub.subscribe(t);
    await this.libp2p.start();
  }

  async stop(): Promise<void> {
    await this.libp2p.stop();
  }

  listenAddrs(): string[] {
    return this.libp2p.getMultiaddrs().map((m) => m.toString());
  }

  peerCount(): number {
    return this.libp2p.getPeers().length;
  }

  subscribedTopics(): string[] {
    return this.pubsub.getTopics() as string[];
  }

  async seed(draft: UnseededUnit): Promise<Header> {
    const unit = await signUnit(draft, this.opts.identity);
    const md = serializeUnit(unit);
    await this.opts.blobs.put(unit.frontmatter.id, md);
    this.opts.index.recordUnit(unit.frontmatter);
    this.opts.index.recordHeaderSeen(unit.frontmatter.id);
    this.opts.index.markHeaderRead(unit.frontmatter.id);
    const header = toHeader(unit.frontmatter);
    if (!this.subscribedTopics().includes(header.topic)) {
      this.pubsub.subscribe(header.topic);
    }
    await this.pubsub.publish(header.topic, encodeHeader(header));
    return header;
  }

  async readById(hash: string): Promise<boolean> {
    if (await this.opts.blobs.has(hash)) {
      this.opts.index.markHeaderRead(hash);
      return true;
    }
    const peers = this.libp2p.getPeers();
    for (const peer of peers) {
      try {
        const stream = await this.libp2p.dialProtocol(peer, FETCH_PROTOCOL);
        const md = await fetchBlob(stream, hash);
        const unit = parseUnit(md);
        if (unit.frontmatter.id !== hash) continue;
        const ok = await verifyUnit(unit);
        if (!ok) continue;
        await this.opts.blobs.put(hash, md);
        this.opts.index.recordUnit(unit.frontmatter);
        this.opts.index.markHeaderRead(hash);
        return true;
      } catch {
        continue;
      }
    }
    return false;
  }

  onConnect(cb: (c: Connection) => void) {
    this.libp2p.addEventListener("connection:open", (e: any) => cb(e.detail));
  }
}
