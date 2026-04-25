import type { Libp2p } from "libp2p";
import type { Connection } from "@libp2p/interface";
import { createHost, type HostOptions } from "./host.ts";
import { BlobStore, IndexDb } from "../../store/src/index.ts";
import {
  A2A_PROTOCOL,
  FETCH_PROTOCOL,
  TOPIC_PREFIX,
  a2aStreamHandler,
  decodeHeader,
  encodeHeader,
  fetchBlob,
  fetchStreamHandler,
  isA2AMessage,
  jsonRpcError,
  jsonRpcSuccess,
  parse as parseUnit,
  sendA2ARequest,
  serialize as serializeUnit,
  signUnit,
  textFromA2AMessage,
  toHeader,
  verifyUnit,
  type A2AArtifact,
  type A2AJsonRpcRequest,
  type A2AJsonRpcResponse,
  type A2AMessage,
  type A2AMessageSendParams,
  type A2ATask,
  type Header,
  type Identity,
  type UnseededUnit,
} from "../../protocol/src/index.ts";

export interface SanthoshNodeOptions extends HostOptions {
  identity: Identity;
  blobs: BlobStore;
  index: IndexDb;
  initialTopics: string[];
  events?: SanthoshNodeEvents;
}

export interface PeerInfo {
  id: string;
  address?: string;
  direction?: string;
}

export interface SanthoshNodeEvents {
  onHeaderSeen?: (header: Header, topic: string, sourcePeer?: string) => void;
  onPeerConnected?: (peer: PeerInfo) => void;
  onPeerDiscovered?: (peer: PeerInfo) => void;
  onA2ATask?: (task: A2ATask, sourcePeer?: string) => void;
}

export class SanthoshNode {
  private libp2p!: Libp2p;
  private dialingPeers = new Set<string>();
  constructor(private opts: SanthoshNodeOptions) {}

  get peerId() {
    return this.libp2p.peerId.toString();
  }

  get pubsub() {
    return (this.libp2p.services as any).pubsub;
  }

  async start(): Promise<void> {
    this.libp2p = await createHost(this.opts);
    this.libp2p.addEventListener("peer:discovery", (evt: any) => {
      const peer = evt.detail;
      const info = peerDiscoveryToPeerInfo(peer);
      this.opts.events?.onPeerDiscovered?.(info);
      void this.dialDiscoveredPeer(peer);
    });
    this.libp2p.addEventListener("connection:open", (evt: any) => {
      this.opts.events?.onPeerConnected?.(connectionToPeerInfo(evt.detail));
    });
    await this.libp2p.handle(
      FETCH_PROTOCOL,
      fetchStreamHandler({
        loadBlob: (hash) => this.opts.blobs.get(hash),
      }),
    );
    await this.libp2p.handle(
      A2A_PROTOCOL,
      a2aStreamHandler({
        handleRequest: (req) => this.handleA2ARequest(req, "p2p"),
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
        if (fresh) {
          this.opts.events?.onHeaderSeen?.(
            header,
            topic,
            evt.detail.from?.toString(),
          );
        }
      } catch {
        // Ignore malformed gossip payloads; valid headers are stored and surfaced.
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

  connectedPeers(): PeerInfo[] {
    const byId = new Map<string, PeerInfo>();
    for (const conn of this.libp2p.getConnections() as any[]) {
      const peer = connectionToPeerInfo(conn);
      if (peer.id) byId.set(peer.id, peer);
    }
    for (const peerId of this.libp2p.getPeers()) {
      const id = peerId.toString();
      if (!id || byId.has(id)) continue;
      byId.set(id, { id, direction: "known" });
    }
    return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
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

  async announceStoredUnits(limit = 20): Promise<number> {
    let announced = 0;
    for (const unitRef of this.opts.index.recentUnits(limit)) {
      const md = await this.opts.blobs.get(unitRef.id);
      if (!md) continue;
      try {
        const unit = parseUnit(md);
        const ok = await verifyUnit(unit);
        if (!ok) continue;
        const header = toHeader(unit.frontmatter);
        if (!this.subscribedTopics().includes(header.topic)) {
          this.pubsub.subscribe(header.topic);
        }
        await this.pubsub.publish(header.topic, encodeHeader(header));
        announced++;
      } catch {
        continue;
      }
    }
    return announced;
  }

  async sendA2AToPeer(
    peerId: string,
    req: A2AJsonRpcRequest,
  ): Promise<A2AJsonRpcResponse> {
    const peer = this.libp2p
      .getPeers()
      .find((p) => p.toString() === peerId);
    if (!peer) throw new Error(`peer not connected: ${peerId}`);
    const stream = await this.libp2p.dialProtocol(peer, A2A_PROTOCOL);
    return await sendA2ARequest(stream, req);
  }

  async handleA2ARequest(
    req: A2AJsonRpcRequest,
    peerId?: string,
  ): Promise<A2AJsonRpcResponse> {
    if (!req || req.jsonrpc !== "2.0" || typeof req.method !== "string") {
      return jsonRpcError(req?.id, -32600, "Invalid JSON-RPC request");
    }
    if (req.method === "message/send") {
      const params = req.params as Partial<A2AMessageSendParams> | undefined;
      if (!params || !isA2AMessage(params.message)) {
        return jsonRpcError(req.id, -32602, "Expected params.message with text parts");
      }
      const task = await this.captureA2AMessage(params as A2AMessageSendParams, peerId);
      return jsonRpcSuccess(req.id, task);
    }
    if (req.method === "tasks/get") {
      const params = req.params as { id?: unknown; historyLength?: number } | undefined;
      if (!params || typeof params.id !== "string") {
        return jsonRpcError(req.id, -32602, "Expected params.id");
      }
      const task = this.opts.index.getA2ATask(params.id, params.historyLength);
      if (!task) return jsonRpcError(req.id, -32001, "Task not found");
      return jsonRpcSuccess(req.id, task);
    }
    return jsonRpcError(req.id, -32601, `Unsupported A2A method: ${req.method}`);
  }

  onConnect(cb: (c: Connection) => void) {
    this.libp2p.addEventListener("connection:open", (e: any) => cb(e.detail));
  }

  private async dialDiscoveredPeer(peer: any): Promise<void> {
    const peerId = peer.id ?? peer.peerId;
    const key = peerId?.toString() ?? peer.multiaddrs?.[0]?.toString();
    if (!key || key === this.peerId || this.dialingPeers.has(key)) return;
    if (this.libp2p.getPeers().some((p) => p.toString() === key)) return;

    this.dialingPeers.add(key);
    try {
      if (peer.multiaddrs?.length) {
        await this.libp2p.dial(peer.multiaddrs);
      } else if (peerId) {
        await this.libp2p.dial(peerId);
      }
      this.opts.events?.onPeerConnected?.(peerDiscoveryToPeerInfo(peer));
    } catch {
      // Discovery is best-effort; failed peers can be rediscovered later.
    } finally {
      this.dialingPeers.delete(key);
    }
  }

  private async captureA2AMessage(
    params: A2AMessageSendParams,
    peerId?: string,
  ): Promise<A2ATask> {
    const taskId = params.message.taskId ?? crypto.randomUUID();
    const contextId = params.message.contextId ?? crypto.randomUUID();
    const receivedText = textFromA2AMessage(params.message);
    const markdown = [
      "# A2A Memory",
      "",
      receivedText || "(empty message)",
      "",
      "## Metadata",
      "",
      `- A2A task: ${taskId}`,
      `- A2A message: ${params.message.messageId}`,
      `- Received from: ${peerId ?? "local-a2a-client"}`,
      `- Received: ${new Date().toISOString()}`,
    ].join("\n");
    const summary =
      receivedText.split(/\s+/).slice(0, 16).join(" ") || "A2A memory";
    const header = await this.seed({
      topic: this.opts.initialTopics[0] ?? "santhosh/v1/general",
      parents: [],
      tags: ["a2a", "memory"],
      summary: summary.length > 120 ? `${summary.slice(0, 117)}...` : summary,
      body: markdown,
    });
    const artifact: A2AArtifact = {
      artifactId: header.id,
      name: "Signed Santhosh memory",
      description: "Markdown memory artifact published on the Santhosh P2P network.",
      parts: [{ kind: "text", text: markdown }],
      metadata: {
        santhoshUnitId: header.id,
        topic: header.topic,
      },
    };
    const response: A2AMessage = {
      kind: "message",
      role: "agent",
      messageId: crypto.randomUUID(),
      taskId,
      contextId,
      parts: [
        {
          kind: "text",
          text: `Stored and announced memory artifact ${header.id}.`,
        },
      ],
      metadata: {
        santhoshUnitId: header.id,
      },
    };
    const task: A2ATask = {
      kind: "task",
      id: taskId,
      contextId,
      status: {
        state: "completed",
        message: response,
        timestamp: new Date().toISOString(),
      },
      history: [params.message, response],
      artifacts: [artifact],
      metadata: {
        santhoshUnitId: header.id,
      },
    };
    this.opts.index.upsertA2ATask(task, peerId ?? "local-a2a-client");
    this.opts.index.recordA2AMessage(taskId, params.message);
    this.opts.index.recordA2AMessage(taskId, response);
    this.opts.index.recordA2AArtifact(taskId, artifact, header.id);
    this.opts.events?.onA2ATask?.(task, peerId);
    return task;
  }
}

function connectionToPeerInfo(conn: any): PeerInfo {
  return {
    id: (conn.remotePeer ?? conn.remotePeerId ?? "").toString(),
    address: conn.remoteAddr?.toString(),
    direction: conn.direction,
  };
}

function peerDiscoveryToPeerInfo(peer: any): PeerInfo {
  return {
    id: (peer.id ?? peer.peerId ?? peer).toString(),
    address: peer.multiaddrs?.[0]?.toString(),
  };
}
