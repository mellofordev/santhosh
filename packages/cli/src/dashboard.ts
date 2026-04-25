import type { PeerInfo } from "../../node/src/node.ts";
import {
  A2A_VERSION,
  isA2AMessage,
  jsonRpcError,
  jsonRpcSuccess,
  type A2AAgentCard,
  type A2AJsonRpcRequest,
  type A2AMessageSendParams,
  type A2ATask,
  type A2ATaskQueryParams,
} from "../../protocol/src/a2a.ts";
import type { Header } from "../../protocol/src/types.ts";
import type { TickSummary } from "../../scheduler/src/loop.ts";
import type { A2ATaskRecord, KnowledgeGraph } from "../../store/src/index.ts";

export interface DashboardOptions {
  host: string;
  port: number;
  state: DashboardState;
  loadMarkdown?: (id: string) => Promise<string | null>;
  getA2ATask?: (id: string, historyLength?: number) => A2ATask | null;
  handleA2AMessage?: (params: A2AMessageSendParams) => Promise<A2ATask>;
}

export interface DashboardState {
  home: string;
  peerId: string;
  agent: string;
  topics: string[];
  listenAddrs: string[];
  discovery: string;
  checksEverySeconds: number;
  peers: PeerInfo[];
  lastTick: TickSummary | null;
  events: DashboardEvent[];
  graph: KnowledgeGraph;
  a2aTasks: A2ATaskRecord[];
}

export interface DashboardEvent {
  id: number;
  ts: string;
  type: "network" | "knowledge" | "agent" | "system";
  title: string;
  detail?: string;
}

export interface DashboardServer {
  url: string;
  stop(): void;
  update(mutator: (state: DashboardState) => void): void;
  record(event: Omit<DashboardEvent, "id" | "ts">): void;
}

const encoder = new TextEncoder();

export function startDashboard(opts: DashboardOptions): DashboardServer {
  let eventId = 0;
  const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();

  function snapshot(): DashboardState {
    const graph = opts.state.graph ?? { nodes: [], links: [] };
    return {
      ...opts.state,
      topics: [...(opts.state.topics ?? [])],
      listenAddrs: [...(opts.state.listenAddrs ?? [])],
      peers: [...(opts.state.peers ?? [])],
      events: [...(opts.state.events ?? [])],
      graph: {
        nodes: [...(graph.nodes ?? [])],
        links: [...(graph.links ?? [])],
      },
      a2aTasks: [...(opts.state.a2aTasks ?? [])],
    };
  }

  function send(controller: ReadableStreamDefaultController<Uint8Array>, event: string, data: unknown) {
    controller.enqueue(
      encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
    );
  }

  function broadcast(event: string, data: unknown) {
    for (const client of clients) {
      try {
        send(client, event, data);
      } catch {
        clients.delete(client);
      }
    }
  }

  const server = Bun.serve({
    hostname: opts.host,
    port: opts.port,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/") {
        return new Response(pageHtml(), {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      if (url.pathname === "/api/status") {
        return Response.json(snapshot());
      }
      if (url.pathname === "/.well-known/agent-card.json" || url.pathname === "/agent-card.json") {
        return Response.json(agentCard(url.origin, opts.state));
      }
      if (url.pathname === "/a2a") {
        if (req.method !== "POST") {
          return new Response("Method not allowed", { status: 405 });
        }
        const rpc = (await req.json().catch(() => null)) as A2AJsonRpcRequest | null;
        const response = await handleA2ARpc(rpc, opts);
        return Response.json(response);
      }
      if (url.pathname.startsWith("/api/units/")) {
        const id = decodeURIComponent(url.pathname.slice("/api/units/".length));
        if (!opts.loadMarkdown || !isSafeUnitId(id)) {
          return new Response("Not found", { status: 404 });
        }
        const markdown = await opts.loadMarkdown(id);
        if (!markdown) return new Response("Not found", { status: 404 });
        return Response.json({ id, markdown });
      }
      if (url.pathname === "/events") {
        let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            streamController = controller;
            clients.add(controller);
            send(controller, "status", snapshot());
          },
          cancel() {
            if (streamController) clients.delete(streamController);
          },
        });
        return new Response(stream, {
          headers: {
            "cache-control": "no-cache",
            "content-type": "text/event-stream",
            connection: "keep-alive",
          },
        });
      }
      return new Response("Not found", { status: 404 });
    },
  });

  return {
    url: `http://${opts.host}:${server.port}`,
    stop() {
      server.stop();
      clients.clear();
    },
    update(mutator) {
      mutator(opts.state);
      broadcast("status", snapshot());
    },
    record(event) {
      const next = {
        id: ++eventId,
        ts: new Date().toISOString(),
        ...event,
      };
      opts.state.events.unshift(next);
      opts.state.events.splice(80);
      broadcast("event", next);
      broadcast("status", snapshot());
    },
  };
}

function agentCard(origin: string, state: DashboardState): A2AAgentCard {
  return {
    protocolVersion: A2A_VERSION,
    name: "Santhosh local memory agent",
    description:
      "A local A2A endpoint that turns agent messages into signed Santhosh memory artifacts.",
    url: `${origin}/a2a`,
    version: "0.1.0",
    capabilities: {
      streaming: false,
      pushNotifications: false,
      stateTransitionHistory: true,
    },
    defaultInputModes: ["text/plain", "text/markdown"],
    defaultOutputModes: ["text/markdown"],
    provider: {
      organization: "Santhosh",
    },
    skills: [
      {
        id: "memory.capture",
        name: "Capture memory",
        description:
          "Accepts an A2A text message, stores it as a task, and emits a signed markdown memory artifact on the Santhosh network.",
        tags: ["memory", "p2p", "markdown"],
        examples: [
          "Remember this install failure and the fix.",
          "Share a useful observation with nearby agents.",
        ],
        inputModes: ["text/plain", "text/markdown"],
        outputModes: ["text/markdown"],
      },
      {
        id: "memory.inspect",
        name: "Inspect local memory",
        description: "Returns stored A2A tasks and memory artifacts through tasks/get.",
        tags: ["memory", "tasks"],
        inputModes: ["text/plain"],
        outputModes: ["text/markdown"],
      },
    ],
    // Non-standard metadata is intentionally omitted; peer identity is visible
    // through normal Santhosh status endpoints.
  };
}

async function handleA2ARpc(
  rpc: A2AJsonRpcRequest | null,
  opts: DashboardOptions,
) {
  if (!rpc || rpc.jsonrpc !== "2.0" || typeof rpc.method !== "string") {
    return jsonRpcError(null, -32600, "Invalid JSON-RPC request");
  }
  if (rpc.method === "message/send") {
    if (!opts.handleA2AMessage) {
      return jsonRpcError(rpc.id, -32601, "A2A message handling is unavailable");
    }
    const params = rpc.params as Partial<A2AMessageSendParams> | undefined;
    if (!params || !isA2AMessage(params.message)) {
      return jsonRpcError(rpc.id, -32602, "Expected params.message with text parts");
    }
    const task = await opts.handleA2AMessage(params as A2AMessageSendParams);
    return jsonRpcSuccess(rpc.id, task);
  }
  if (rpc.method === "tasks/get") {
    const params = rpc.params as Partial<A2ATaskQueryParams> | undefined;
    if (!params || typeof params.id !== "string") {
      return jsonRpcError(rpc.id, -32602, "Expected params.id");
    }
    const task = opts.getA2ATask?.(params.id, params.historyLength);
    if (!task) return jsonRpcError(rpc.id, -32001, "Task not found");
    return jsonRpcSuccess(rpc.id, task);
  }
  return jsonRpcError(rpc.id, -32601, `Unsupported A2A method: ${rpc.method}`);
}

export function headerEvent(header: Header, sourcePeer?: string): Omit<DashboardEvent, "id" | "ts"> {
  return {
    type: "knowledge",
    title: "Knowledge announced",
    detail: `${header.summary} from ${shortId(sourcePeer ?? "unknown")}`,
  };
}

export function peerEvent(peers: PeerInfo[]): Omit<DashboardEvent, "id" | "ts"> {
  return {
    type: "network",
    title: peers.length === 0 ? "Searching for nodes" : `Connected to ${peers.length} node${peers.length === 1 ? "" : "s"}`,
    detail: peers.length === 0 ? "No other Santhosh nodes connected yet." : peers.map((p) => shortId(p.id)).join(", "),
  };
}

export function tickEvent(summary: TickSummary): Omit<DashboardEvent, "id" | "ts"> | null {
  if (summary.headers === 0 && summary.reads === 0 && summary.seeds === 0) {
    if (summary.mode === "network-idle") return null;
    return {
      type: "agent",
      title: "Agent checked network",
      detail: summary.mode === "solo-bootstrap" ? "No starter knowledge shared yet." : "No action needed.",
    };
  }
  const parts: string[] = [];
  if (summary.headers > 0) parts.push(`reviewed ${summary.headers} announcement${summary.headers === 1 ? "" : "s"}`);
  if (summary.reads > 0) parts.push(`saved ${summary.reads} item${summary.reads === 1 ? "" : "s"}`);
  if (summary.seeds > 0) parts.push(`shared ${summary.seeds} item${summary.seeds === 1 ? "" : "s"}`);
  if (summary.a2a > 0) parts.push(`completed ${summary.a2a} A2A exchange${summary.a2a === 1 ? "" : "s"}`);
  return {
    type: "agent",
    title: "Agent activity",
    detail: parts.join(", "),
  };
}

function shortId(id: string): string {
  if (id.length <= 18) return id;
  return `${id.slice(0, 12)}...${id.slice(-6)}`;
}

function isSafeUnitId(id: string): boolean {
  return /^[a-zA-Z0-9._:-]{1,180}$/.test(id);
}

function pageHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Santhosh Dashboard</title>
  <style>
    :root {
      --bg: #f6f7f4;
      --panel: #ffffff;
      --panel-2: #f0f4f2;
      --ink: #171b1a;
      --muted: #68716d;
      --line: #d9dfdc;
      --accent: #176b4d;
      --accent-2: #315f8c;
      --warn: #a45a16;
      --danger: #9f3030;
      --map-bg: #181c1b;
      --map-ink: #eef5f0;
      --map-muted: #98aaa2;
      --shadow: 0 12px 32px rgba(24, 32, 29, 0.08);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--ink);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 15px;
    }
    main { width: min(1180px, calc(100vw - 32px)); margin: 28px auto; }
    header {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 18px;
      align-items: end;
      margin-bottom: 18px;
    }
    h1 { font-size: 2rem; line-height: 1.05; margin: 0; letter-spacing: 0; }
    h2 { margin: 0; font-size: 0.88rem; line-height: 1.2; color: var(--muted); font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; }
    p { margin: 0; }
    code { display: inline-block; max-width: 100%; overflow-wrap: anywhere; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.86rem; color: #22302c; }
    .subhead { margin-top: 6px; color: var(--muted); }
    .status {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      min-height: 34px;
      border: 1px solid var(--line);
      background: var(--panel);
      border-radius: 999px;
      padding: 7px 12px;
      color: var(--accent);
      font-weight: 700;
      white-space: nowrap;
      box-shadow: var(--shadow);
    }
    .dot { width: 8px; height: 8px; border-radius: 999px; background: currentColor; }
    .status.reconnecting { color: var(--warn); }
    .status.offline { color: var(--danger); }
    .metrics { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-bottom: 12px; }
    .metric {
      min-height: 88px;
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 16px;
      box-shadow: var(--shadow);
    }
    .metric strong { display: block; margin-top: 10px; font-size: 1.55rem; line-height: 1.1; font-weight: 750; overflow-wrap: anywhere; }
    .map-layout { display: grid; grid-template-columns: minmax(0, 1fr) 320px; gap: 12px; margin-bottom: 12px; align-items: stretch; }
    .map-panel {
      position: relative;
      min-height: 440px;
      background: var(--map-bg);
      border: 1px solid #2b3531;
      border-radius: 8px;
      overflow: hidden;
      box-shadow: var(--shadow);
    }
    .map-panel canvas { display: block; width: 100%; height: 440px; }
    .map-overlay {
      position: absolute;
      left: 16px;
      top: 14px;
      right: 16px;
      display: flex;
      justify-content: space-between;
      gap: 12px;
      pointer-events: none;
      color: var(--map-ink);
    }
    .map-title strong { display: block; font-size: 1.05rem; line-height: 1.2; }
    .map-title span { display: block; margin-top: 4px; color: var(--map-muted); font-size: 0.86rem; }
    .legend { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; color: var(--map-muted); font-size: 0.8rem; }
    .legend span { display: inline-flex; align-items: center; gap: 6px; min-height: 24px; padding: 3px 8px; border: 1px solid #32413b; border-radius: 999px; background: rgba(24, 28, 27, 0.72); }
    .swatch { width: 8px; height: 8px; border-radius: 999px; background: var(--c); }
    .insight { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 16px; box-shadow: var(--shadow); }
    .insight-list { display: grid; gap: 10px; margin-top: 12px; }
    .insight-item { border: 1px solid var(--line); border-radius: 8px; padding: 11px 12px; background: var(--panel-2); }
    .insight-item strong { display: block; line-height: 1.25; }
    .insight-item span { display: block; margin-top: 4px; color: var(--muted); font-size: 0.86rem; }
    .composer { display: grid; gap: 10px; margin-top: 12px; }
    .composer textarea {
      width: 100%;
      min-height: 92px;
      resize: vertical;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 10px 11px;
      font: inherit;
      line-height: 1.4;
      color: var(--ink);
      background: #fbfcfb;
    }
    .actions { display: flex; gap: 8px; align-items: center; justify-content: space-between; }
    button {
      min-height: 34px;
      border: 1px solid #165c42;
      border-radius: 8px;
      padding: 7px 11px;
      background: var(--accent);
      color: white;
      font: inherit;
      font-weight: 700;
      cursor: pointer;
    }
    button:hover { filter: brightness(1.05); }
    button:disabled { cursor: not-allowed; opacity: 0.55; }
    .hint { color: var(--muted); font-size: 0.82rem; line-height: 1.35; }
    .reader {
      margin-top: 12px;
      border-top: 1px solid var(--line);
      padding-top: 14px;
    }
    .reader h3 { margin: 0 0 8px; font-size: 1rem; line-height: 1.25; }
    .reader-meta { color: var(--muted); font-size: 0.82rem; overflow-wrap: anywhere; }
    .markdown {
      margin-top: 12px;
      max-height: 340px;
      overflow: auto;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 14px;
      background: #fbfcfb;
      color: #1f2925;
    }
    .markdown h1, .markdown h2, .markdown h3 { margin: 14px 0 8px; line-height: 1.2; }
    .markdown h1:first-child, .markdown h2:first-child, .markdown h3:first-child { margin-top: 0; }
    .markdown p { margin: 8px 0; line-height: 1.5; }
    .markdown ul { margin: 8px 0 8px 20px; padding: 0; }
    .markdown li { margin: 4px 0; }
    .markdown pre { overflow: auto; background: #17201d; color: #edf5f1; border-radius: 8px; padding: 12px; }
    .markdown code { background: #e6eee9; border-radius: 5px; padding: 1px 4px; }
    .markdown pre code { background: transparent; padding: 0; color: inherit; }
    .markdown blockquote { margin: 10px 0; padding-left: 12px; border-left: 3px solid var(--line); color: var(--muted); }
    .layout { display: grid; grid-template-columns: minmax(0, 0.92fr) minmax(420px, 1.08fr); gap: 12px; align-items: start; }
    .stack { display: grid; gap: 12px; }
    .panel {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 16px;
      box-shadow: var(--shadow);
    }
    .panel-head { display: flex; justify-content: space-between; gap: 12px; align-items: center; margin-bottom: 12px; }
    .meta-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
    .field { border: 1px solid var(--line); border-radius: 8px; padding: 11px 12px; background: var(--panel-2); min-width: 0; }
    .field span, .row span, .event span { display: block; color: var(--muted); font-size: 0.82rem; line-height: 1.35; margin-bottom: 4px; }
    .list { display: grid; gap: 8px; }
    .row { border: 1px solid var(--line); border-radius: 8px; padding: 11px 12px; background: var(--panel-2); min-width: 0; }
    button.row { width: 100%; display: block; text-align: left; color: var(--ink); background: var(--panel-2); font-weight: 400; cursor: pointer; }
    button.row:hover, button.row.selected { border-color: #9ab7aa; background: #e8f0ec; filter: none; }
    .row strong { display: block; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.88rem; line-height: 1.35; overflow-wrap: anywhere; }
    .row em { display: block; margin-top: 3px; color: var(--muted); font-style: normal; font-size: 0.88rem; }
    .events { display: grid; gap: 8px; max-height: 720px; overflow: auto; padding-right: 2px; }
    .event { border: 1px solid var(--line); border-left: 4px solid var(--accent); background: var(--panel); border-radius: 8px; padding: 11px 12px; }
    .event.agent { border-left-color: var(--warn); }
    .event.system { border-left-color: var(--accent-2); }
    .event.network { border-left-color: var(--accent); }
    .event.knowledge { border-left-color: #694e9f; }
    .event strong { display: block; line-height: 1.3; }
    .event p { margin-top: 5px; color: #33403b; overflow-wrap: anywhere; }
    .empty { color: var(--muted); }
    details {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel);
      padding: 12px 14px;
      box-shadow: var(--shadow);
    }
    summary { cursor: pointer; color: var(--muted); font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; }
    @media (max-width: 820px) {
      main { width: min(100vw - 20px, 720px); margin: 18px auto; }
      header, .layout { grid-template-columns: 1fr; }
      header { align-items: start; }
      .metrics, .meta-grid { grid-template-columns: 1fr; }
      .map-layout { grid-template-columns: 1fr; }
      .map-panel { min-height: 380px; }
      .map-panel canvas { height: 380px; }
      .map-overlay { display: block; }
      .legend { justify-content: flex-start; margin-top: 10px; }
      .metric { min-height: 96px; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>Santhosh</h1>
        <p class="subhead">Local agent network dashboard</p>
      </div>
      <div class="status" id="connection"><span class="dot"></span><span id="connectionText">Connecting</span></div>
    </header>

    <section class="map-layout">
      <div class="map-panel">
        <canvas id="knowledgeMap" aria-label="Knowledge graph"></canvas>
        <div class="map-overlay">
          <div class="map-title">
            <strong>Knowledge Map</strong>
            <span id="mapSummary">Waiting for graph data</span>
          </div>
          <div class="legend">
            <span><i class="swatch" style="--c:#57a6d8"></i>local agent</span>
            <span><i class="swatch" style="--c:#79be8a"></i>stored</span>
            <span><i class="swatch" style="--c:#d89455"></i>announced</span>
            <span><i class="swatch" style="--c:#8ea0ff"></i>peer</span>
            <span><i class="swatch" style="--c:#c58cff"></i>A2A task</span>
          </div>
        </div>
      </div>
      <aside class="insight">
        <h2>A2A Control</h2>
        <form class="composer" id="a2aForm">
          <textarea id="a2aText" placeholder="Send a memory through local A2A, then gossip it to peers."></textarea>
          <div class="actions">
            <button id="a2aSend" type="submit">Send A2A</button>
            <span class="hint" id="a2aFormStatus">Local message/send</span>
          </div>
        </form>
        <div class="insight-list" id="insights"></div>
        <div class="reader" id="reader">
          <h3>Select a knowledge node</h3>
          <p class="reader-meta">Click a stored or announced node in the map to inspect the agent message.</p>
        </div>
      </aside>
    </section>

    <section class="metrics" aria-live="polite">
      <div class="metric"><h2>Peers</h2><strong id="peerCount">0</strong></div>
      <div class="metric"><h2>Mode</h2><strong id="mode">starting</strong></div>
      <div class="metric"><h2>Harness</h2><strong id="agent">-</strong></div>
      <div class="metric"><h2>Activity</h2><strong id="eventCount">0</strong></div>
    </section>

    <section class="layout">
      <div class="stack">
        <div class="panel">
          <div class="panel-head"><h2>Network</h2><span class="empty" id="discovery">-</span></div>
          <div id="peers" class="list"></div>
        </div>
        <div class="panel">
          <div class="panel-head"><h2>A2A Tasks</h2><span class="empty">message/send</span></div>
          <div id="a2aTasks" class="list"></div>
        </div>
        <details>
          <summary>Node details</summary>
          <div class="meta-grid" style="margin-top:12px">
            <div class="field"><span>Peer ID</span><code id="peerId">-</code></div>
            <div class="field"><span>Home</span><code id="home">-</code></div>
            <div class="field"><span>Topics</span><code id="topics">-</code></div>
            <div class="field"><span>Checks</span><code id="checks">-</code></div>
          </div>
          <div class="list" id="addresses" style="margin-top:10px"></div>
        </details>
      </div>
      <div class="panel">
        <div class="panel-head"><h2>Realtime Messages</h2><span class="empty" id="lastTick">No tick yet</span></div>
        <div id="events" class="events"></div>
      </div>
    </section>
  </main>

  <script>
    const $ = (id) => document.getElementById(id);
    const shortId = (id) => !id || id.length <= 18 ? id : id.slice(0, 12) + "..." + id.slice(-6);
    const time = (iso) => new Date(iso).toLocaleTimeString();
    let lastState = null;
    let mapFrame = 0;
    let mapHitTargets = [];
    let selectedUnitId = null;
    let selectedTaskId = null;
    let hoverUnitId = null;

    function setConnection(text, kind) {
      const el = $("connection");
      el.classList.toggle("reconnecting", kind === "reconnecting");
      el.classList.toggle("offline", kind === "offline");
      $("connectionText").textContent = text;
    }

    function clear(node) {
      while (node.firstChild) node.removeChild(node.firstChild);
    }

    function textEl(tag, text, className) {
      const el = document.createElement(tag);
      if (className) el.className = className;
      el.textContent = text;
      return el;
    }

    function normalizeState(state) {
      return {
        home: state?.home ?? "-",
        peerId: state?.peerId ?? "-",
        agent: state?.agent ?? "-",
        topics: Array.isArray(state?.topics) ? state.topics : [],
        listenAddrs: Array.isArray(state?.listenAddrs) ? state.listenAddrs : [],
        discovery: state?.discovery ?? "unknown",
        checksEverySeconds: state?.checksEverySeconds ?? 0,
        peers: Array.isArray(state?.peers) ? state.peers : [],
        lastTick: state?.lastTick ?? null,
        events: Array.isArray(state?.events) ? state.events : [],
        graph: {
          nodes: Array.isArray(state?.graph?.nodes) ? state.graph.nodes : [],
          links: Array.isArray(state?.graph?.links) ? state.graph.links : [],
        },
        a2aTasks: Array.isArray(state?.a2aTasks) ? state.a2aTasks : [],
      };
    }

    function render(state) {
      state = normalizeState(state);
      lastState = state;
      setConnection("Live", "live");
      $("peerCount").textContent = state.peers.length;
      $("mode").textContent = state.lastTick?.mode ?? "starting";
      $("agent").textContent = state.agent;
      $("eventCount").textContent = state.events.length;
      $("peerId").textContent = state.peerId;
      $("home").textContent = state.home;
      $("topics").textContent = state.topics.join(", ");
      $("checks").textContent = "every " + state.checksEverySeconds + "s, " + state.discovery;
      $("discovery").textContent = state.discovery;
      $("lastTick").textContent = state.lastTick
        ? state.lastTick.headers + " headers, " + state.lastTick.reads + " reads, " + state.lastTick.seeds + " seeds, " + (state.lastTick.a2a ?? 0) + " A2A"
        : "No tick yet";

      renderPeers(state.peers);
      renderA2ATasks(state.a2aTasks);
      renderAddresses(state.listenAddrs);
      renderEvents(state.events);
      renderInsights(state);
      scheduleGraph(state);
    }

    function renderInsights(state) {
      const root = $("insights");
      clear(root);
      const stored = state.graph.nodes.filter((n) => n.status === "stored").length;
      const announced = state.graph.nodes.filter((n) => n.status === "announced").length;
      root.appendChild(insight("Knowledge", stored + " stored, " + announced + " announced"));
      root.appendChild(insight("Network", state.peers.length ? state.peers.length + " connected peer" + (state.peers.length === 1 ? "" : "s") : "No peers connected yet"));
      root.appendChild(insight("P2P A2A", state.lastTick ? ((state.lastTick.a2a ?? 0) + " peer exchange" + ((state.lastTick.a2a ?? 0) === 1 ? "" : "s") + " last tick") : "Waiting for first tick"));
      const latest = state.graph.nodes[0];
      if (latest) root.appendChild(insight("Latest node", latest.summary || shortId(latest.id)));
    }

    function insight(title, detail) {
      const el = document.createElement("div");
      el.className = "insight-item";
      el.appendChild(textEl("strong", title));
      el.appendChild(textEl("span", detail));
      return el;
    }

    function renderPeers(peers) {
      const root = $("peers");
      clear(root);
      if (peers.length === 0) {
        root.appendChild(row("No connected nodes yet", "Searching automatically on the local network."));
        return;
      }
      for (const peer of peers) {
        root.appendChild(row(
          shortId(peer.id),
          peerDirection(peer),
          peer.address
        ));
      }
    }

    function peerDirection(peer) {
      if (peer.direction === "inbound") return "connected to you";
      if (peer.direction === "outbound") return "you connected";
      return "known peer";
    }

    function renderA2ATasks(tasks) {
      const root = $("a2aTasks");
      clear(root);
      if (!tasks || tasks.length === 0) {
        root.appendChild(row("No A2A tasks yet", "POST JSON-RPC message/send to /a2a to create one."));
        return;
      }
      for (const task of tasks) {
        const item = row(task.goal || task.id, task.state + " · " + shortId(task.id), task.peerId || "", "button");
        item.type = "button";
        item.classList.toggle("selected", task.id === selectedTaskId);
        item.addEventListener("click", () => showTask(task.id));
        root.appendChild(item);
      }
    }

    function renderAddresses(addresses) {
      const root = $("addresses");
      clear(root);
      if (addresses.length === 0) {
        root.appendChild(row("No listen addresses available"));
        return;
      }
      for (const address of addresses) root.appendChild(row(address));
    }

    function renderEvents(events) {
      const root = $("events");
      clear(root);
      if (events.length === 0) {
        root.appendChild(eventCard({ type: "system", ts: new Date().toISOString(), title: "Dashboard started", detail: "Waiting for network activity." }));
        return;
      }
      for (const event of events) root.appendChild(eventCard(event));
    }

    function row(primary, secondary, tertiary, tag = "div") {
      const el = document.createElement(tag);
      el.className = "row";
      el.appendChild(textEl("strong", primary));
      if (secondary) el.appendChild(textEl("em", secondary));
      if (tertiary) el.appendChild(textEl("em", tertiary));
      return el;
    }

    function eventCard(event) {
      const el = document.createElement("div");
      el.className = "event " + event.type;
      el.appendChild(textEl("span", time(event.ts)));
      el.appendChild(textEl("strong", eventTitle(event)));
      if (event.detail) el.appendChild(textEl("p", event.detail));
      return el;
    }

    function eventTitle(event) {
      if (event.title === "Knowledge announced") return "Memory announced";
      if (event.title === "P2P A2A task handled") return "Peer message handled";
      if (event.title === "A2A task completed") return "Local message stored";
      return event.title;
    }

    function scheduleGraph(state) {
      cancelAnimationFrame(mapFrame);
      mapFrame = requestAnimationFrame(() => drawGraph(state));
    }

    function drawGraph(state) {
      const canvas = $("knowledgeMap");
      const rect = canvas.getBoundingClientRect();
      const ratio = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.floor(rect.width * ratio));
      canvas.height = Math.max(1, Math.floor(rect.height * ratio));
      const ctx = canvas.getContext("2d");
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      const w = rect.width;
      const h = rect.height;
      ctx.clearRect(0, 0, w, h);
      drawMapBackground(ctx, w, h);

      const graph = buildMapGraph(state, w, h);
      $("mapSummary").textContent = graph.knowledgeCount + " knowledge nodes, " + state.a2aTasks.length + " A2A tasks, " + state.peers.length + " peers";
      if (graph.nodes.length === 1) {
        drawEmptyMap(ctx, w, h);
      }
      settleGraph(graph.nodes, graph.links, w, h);
      drawLinks(ctx, graph.links, graph.nodeById);
      drawNodes(ctx, graph.nodes);
      mapHitTargets = graph.nodes.map((node) => ({ ...node }));
    }

    function buildMapGraph(state, w, h) {
      const nodes = [];
      const links = [];
      const nodeById = new Map();
      const center = addNode({
        id: "local",
        label: "Local agent",
        kind: "local",
        x: w * 0.5,
        y: h * 0.52,
        fixed: true,
        r: 10,
      });

      state.peers.forEach((peer, i) => {
        const angle = Math.PI + (i - (state.peers.length - 1) / 2) * 0.42;
        const peerNode = addNode({
          id: "peer:" + peer.id,
          label: shortId(peer.id),
          kind: "peer",
          x: center.x + Math.cos(angle) * Math.min(w, h) * 0.28,
          y: center.y + Math.sin(angle) * Math.min(w, h) * 0.24,
          r: 7,
        });
        links.push({ source: center.id, target: peerNode.id, kind: "peer" });
      });

      const tasks = (state.a2aTasks || []).slice(0, 24);
      tasks.forEach((task, i) => {
        const angle = -Math.PI / 3 + (i - (tasks.length - 1) / 2) * 0.22;
        const taskNode = addNode({
          id: "task:" + task.id,
          label: task.goal || shortId(task.id),
          kind: "task",
          rawTask: task,
          x: center.x + Math.cos(angle) * Math.min(w, h) * 0.36,
          y: center.y + Math.sin(angle) * Math.min(w, h) * 0.32,
          r: 6,
        });
        links.push({ source: center.id, target: taskNode.id, kind: "a2a" });
      });

      const knowledge = state.graph.nodes.slice(0, 72);
      knowledge.forEach((item, i) => {
        const angle = (Math.PI * 2 * i) / Math.max(1, knowledge.length);
        const ring = Math.min(w, h) * (0.18 + (i % 4) * 0.055);
        addNode({
          id: item.id,
          label: item.summary || shortId(item.id),
          kind: item.status,
          topic: item.topic,
          raw: item,
          x: center.x + Math.cos(angle) * ring,
          y: center.y + Math.sin(angle) * ring,
          r: item.status === "stored" ? 7 : 6,
        });
      });

      for (const link of state.graph.links) {
        if (nodeById.has(link.source) && nodeById.has(link.target)) {
          links.push({ source: link.source, target: link.target, kind: "parent" });
        }
      }

      if (knowledge.length > 0) {
        const linked = new Set(links.flatMap((link) => [link.source, link.target]));
        for (const item of knowledge) {
          if (!linked.has(item.id)) links.push({ source: center.id, target: item.id, kind: "context" });
        }
      }

      return {
        nodes,
        links,
        nodeById,
        knowledgeCount: knowledge.length,
        parentLinks: state.graph.links.length,
      };

      function addNode(node) {
        nodes.push(node);
        nodeById.set(node.id, node);
        return node;
      }
    }

    function settleGraph(nodes, links, w, h) {
      for (let step = 0; step < 90; step++) {
        for (let i = 0; i < nodes.length; i++) {
          for (let j = i + 1; j < nodes.length; j++) {
            const a = nodes[i];
            const b = nodes[j];
            const dx = b.x - a.x || 0.01;
            const dy = b.y - a.y || 0.01;
            const dist = Math.max(12, Math.hypot(dx, dy));
            const force = Math.min(8, 520 / (dist * dist));
            const fx = (dx / dist) * force;
            const fy = (dy / dist) * force;
            if (!a.fixed) {
              a.x -= fx;
              a.y -= fy;
            }
            if (!b.fixed) {
              b.x += fx;
              b.y += fy;
            }
          }
        }
        for (const link of links) {
          const a = nodes.find((n) => n.id === link.source);
          const b = nodes.find((n) => n.id === link.target);
          if (!a || !b) continue;
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const dist = Math.max(1, Math.hypot(dx, dy));
          const target = link.kind === "parent" ? 120 : 150;
          const pull = (dist - target) * 0.012;
          const fx = (dx / dist) * pull;
          const fy = (dy / dist) * pull;
          if (!a.fixed) {
            a.x += fx;
            a.y += fy;
          }
          if (!b.fixed) {
            b.x -= fx;
            b.y -= fy;
          }
        }
        for (const node of nodes) {
          if (node.fixed) continue;
          node.x = Math.max(30, Math.min(w - 30, node.x));
          node.y = Math.max(70, Math.min(h - 30, node.y));
        }
      }
    }

    function drawMapBackground(ctx, w, h) {
      const gradient = ctx.createRadialGradient(w * 0.5, h * 0.52, 40, w * 0.5, h * 0.52, Math.max(w, h) * 0.7);
      gradient.addColorStop(0, "#202927");
      gradient.addColorStop(1, "#151817");
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = "rgba(255,255,255,0.035)";
      ctx.lineWidth = 1;
      for (let x = 0; x < w; x += 42) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.stroke();
      }
      for (let y = 0; y < h; y += 42) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
      }
    }

    function drawEmptyMap(ctx, w, h) {
      ctx.fillStyle = "rgba(238,245,240,0.78)";
      ctx.font = "14px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("Knowledge nodes will appear here as agents announce and store units.", w / 2, h * 0.66);
    }

    function drawLinks(ctx, links, nodeById) {
      for (const link of links) {
        const a = nodeById.get(link.source);
        const b = nodeById.get(link.target);
        if (!a || !b) continue;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.lineWidth = link.kind === "parent" ? 1.2 : 0.8;
        ctx.strokeStyle = link.kind === "parent" ? "rgba(220,228,225,0.48)" : "rgba(126,154,145,0.26)";
        ctx.stroke();
      }
    }

    function drawNodes(ctx, nodes) {
      const palette = {
        local: "#57a6d8",
        peer: "#8ea0ff",
        stored: "#79be8a",
        announced: "#d89455",
        task: "#c58cff",
      };
      for (const node of nodes) {
        ctx.beginPath();
        ctx.arc(node.x, node.y, node.r + 5, 0, Math.PI * 2);
        const active = node.id === selectedUnitId || node.id === hoverUnitId;
        ctx.fillStyle = hexToRgba(palette[node.kind] || "#d89455", active ? 0.26 : 0.12);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(node.x, node.y, active ? node.r + 2 : node.r, 0, Math.PI * 2);
        ctx.fillStyle = palette[node.kind] || "#d89455";
        ctx.fill();
        ctx.strokeStyle = "rgba(255,255,255,0.55)";
        ctx.lineWidth = active || node.kind === "local" ? 2 : 1;
        ctx.stroke();
      }
      ctx.font = "11px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      for (const node of nodes) {
        const label = node.kind === "stored" || node.kind === "announced" || node.kind === "task" ? compactLabel(node.label) : node.label;
        ctx.fillStyle = node.kind === "local" ? "#eef5f0" : "rgba(238,245,240,0.8)";
        ctx.fillText(label, node.x, node.y + node.r + 8, 148);
      }
    }

    function compactLabel(value) {
      if (!value) return "";
      return value.length > 28 ? value.slice(0, 25) + "..." : value;
    }

    function hexToRgba(hex, alpha) {
      const value = hex.replace("#", "");
      const r = parseInt(value.slice(0, 2), 16);
      const g = parseInt(value.slice(2, 4), 16);
      const b = parseInt(value.slice(4, 6), 16);
      return "rgba(" + r + "," + g + "," + b + "," + alpha + ")";
    }

    async function selectMapNode(evt) {
      const canvas = $("knowledgeMap");
      const rect = canvas.getBoundingClientRect();
      const x = evt.clientX - rect.left;
      const y = evt.clientY - rect.top;
      const hit = [...mapHitTargets].reverse().find((node) => Math.hypot(node.x - x, node.y - y) <= node.r + 10);
      if (!hit || (!hit.raw && !hit.rawTask)) return;
      if (hit.rawTask) {
        await showTask(hit.rawTask.id);
        return;
      }
      selectedUnitId = hit.id;
      selectedTaskId = null;
      if (lastState) renderA2ATasks(lastState.a2aTasks);
      if (lastState) scheduleGraph(lastState);
      await showUnit(hit.raw);
    }

    function hoverMapNode(evt) {
      const canvas = $("knowledgeMap");
      const rect = canvas.getBoundingClientRect();
      const x = evt.clientX - rect.left;
      const y = evt.clientY - rect.top;
      const hit = [...mapHitTargets].reverse().find((node) => Math.hypot(node.x - x, node.y - y) <= node.r + 10);
      const next = hit?.raw || hit?.rawTask ? hit.id : null;
      canvas.style.cursor = hit?.raw || hit?.rawTask ? "pointer" : "default";
      if (next !== hoverUnitId) {
        hoverUnitId = next;
        if (lastState) scheduleGraph(lastState);
      }
    }

    async function showUnit(node) {
      const reader = $("reader");
      clear(reader);
      reader.appendChild(textEl("h3", node.summary || shortId(node.id)));
      reader.appendChild(textEl("p", node.status + " · " + node.topic + " · " + shortId(node.id), "reader-meta"));
      if (node.status !== "stored") {
        const note = document.createElement("div");
        note.className = "markdown";
        note.appendChild(textEl("p", "This announcement is visible, but the full markdown has not been fetched and stored locally yet."));
        if (node.tags?.length) note.appendChild(textEl("p", "Tags: " + node.tags.join(", ")));
        reader.appendChild(note);
        return;
      }
      const loading = textEl("p", "Loading markdown...", "reader-meta");
      reader.appendChild(loading);
      try {
        const res = await fetch("/api/units/" + encodeURIComponent(node.id));
        if (!res.ok) throw new Error("missing markdown");
        const body = await res.json();
        loading.remove();
        reader.appendChild(renderMarkdown(body.markdown));
      } catch {
        loading.textContent = "Markdown is not available locally yet.";
      }
    }

    async function showTask(taskId) {
      selectedTaskId = taskId;
      selectedUnitId = null;
      if (lastState) {
        renderA2ATasks(lastState.a2aTasks);
        scheduleGraph(lastState);
      }
      const reader = $("reader");
      clear(reader);
      reader.appendChild(textEl("h3", "Loading A2A task"));
      reader.appendChild(textEl("p", shortId(taskId), "reader-meta"));
      try {
        const res = await fetch("/a2a", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: "ui-task-" + Date.now(),
            method: "tasks/get",
            params: { id: taskId, historyLength: 20 },
          }),
        });
        const rpc = await res.json();
        if (rpc.error) throw new Error(rpc.error.message);
        renderTask(rpc.result);
      } catch (err) {
        clear(reader);
        reader.appendChild(textEl("h3", "Task unavailable"));
        reader.appendChild(textEl("p", err.message || "Unable to load task", "reader-meta"));
      }
    }

    function renderTask(task) {
      const reader = $("reader");
      clear(reader);
      reader.appendChild(textEl("h3", "A2A Task " + shortId(task.id)));
      reader.appendChild(textEl("p", task.status.state + " · " + task.contextId, "reader-meta"));
      const body = document.createElement("div");
      body.className = "markdown";
      if (task.history?.length) {
        body.appendChild(textEl("h3", "Messages"));
        for (const msg of task.history) {
          body.appendChild(textEl("p", msg.role + ": " + partsText(msg.parts)));
        }
      }
      if (task.artifacts?.length) {
        body.appendChild(textEl("h3", "Artifacts"));
        for (const artifact of task.artifacts) {
          body.appendChild(textEl("p", (artifact.name || artifact.artifactId) + ": " + partsText(artifact.parts)));
        }
      }
      reader.appendChild(body);
    }

    function partsText(parts) {
      return (parts || []).filter((part) => part.kind === "text").map((part) => part.text).join(" ");
    }

    async function sendA2AFromForm(evt) {
      evt.preventDefault();
      const text = $("a2aText").value.trim();
      if (!text) return;
      const button = $("a2aSend");
      const status = $("a2aFormStatus");
      button.disabled = true;
      status.textContent = "Sending...";
      try {
        const res = await fetch("/a2a", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: "ui-send-" + Date.now(),
            method: "message/send",
            params: {
              message: {
                kind: "message",
                role: "user",
                messageId: crypto.randomUUID(),
                parts: [{ kind: "text", text }],
              },
              metadata: { source: "dashboard" },
            },
          }),
        });
        const rpc = await res.json();
        if (rpc.error) throw new Error(rpc.error.message);
        $("a2aText").value = "";
        status.textContent = "Stored as memory";
        selectedTaskId = rpc.result.id;
        renderTask(rpc.result);
        fetch("/api/status").then((r) => r.json()).then(render);
      } catch (err) {
        status.textContent = err.message || "Send failed";
      } finally {
        button.disabled = false;
      }
    }

    function renderMarkdown(markdown) {
      const root = document.createElement("div");
      root.className = "markdown";
      const lines = markdown
        .replaceAll(String.fromCharCode(13), "")
        .split(String.fromCharCode(10));
      let inFrontmatter = lines[0] === "---";
      let inCode = false;
      let codeLines = [];
      let list = null;
      let paragraph = [];

      function flushParagraph() {
        if (paragraph.length === 0) return;
        root.appendChild(textEl("p", paragraph.join(" ")));
        paragraph = [];
      }
      function flushList() {
        if (!list) return;
        root.appendChild(list);
        list = null;
      }
      function flushCode() {
        const pre = document.createElement("pre");
        pre.appendChild(textEl("code", codeLines.join(String.fromCharCode(10))));
        root.appendChild(pre);
        codeLines = [];
      }

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (inFrontmatter) {
          if (i > 0 && line === "---") inFrontmatter = false;
          continue;
        }
        if (line.startsWith("\`" + "\`" + "\`")) {
          flushParagraph();
          flushList();
          if (inCode) flushCode();
          inCode = !inCode;
          continue;
        }
        if (inCode) {
          codeLines.push(line);
          continue;
        }
        if (!line.trim()) {
          flushParagraph();
          flushList();
          continue;
        }
        const headingLevel = headingPrefixLength(line);
        if (headingLevel > 0) {
          flushParagraph();
          flushList();
          root.appendChild(textEl("h" + headingLevel, line.slice(headingLevel + 1).trim()));
          continue;
        }
        const trimmed = line.trimStart();
        if ((trimmed.startsWith("- ") || trimmed.startsWith("* ")) && trimmed.length > 2) {
          flushParagraph();
          if (!list) list = document.createElement("ul");
          list.appendChild(textEl("li", trimmed.slice(2)));
          continue;
        }
        if (line.startsWith("> ")) {
          flushParagraph();
          flushList();
          root.appendChild(textEl("blockquote", line.slice(2)));
          continue;
        }
        paragraph.push(line.trim());
      }
      flushParagraph();
      flushList();
      if (inCode) flushCode();
      return root;
    }

    function headingPrefixLength(line) {
      if (line.startsWith("# ") && line.length > 2) return 1;
      if (line.startsWith("## ") && line.length > 3) return 2;
      if (line.startsWith("### ") && line.length > 4) return 3;
      return 0;
    }

    window.addEventListener("error", (event) => {
      setConnection("UI error", "offline");
      $("mapSummary").textContent = event.message || "Dashboard script error";
      const reader = $("reader");
      clear(reader);
      reader.appendChild(textEl("h3", "Dashboard error"));
      reader.appendChild(textEl("p", event.message || "Unknown browser error", "reader-meta"));
    });
    window.addEventListener("unhandledrejection", (event) => {
      setConnection("UI error", "offline");
      $("mapSummary").textContent = event.reason?.message || "Dashboard async error";
    });
    fetch("/api/status")
      .then((r) => {
        if (!r.ok) throw new Error("/api/status " + r.status);
        return r.json();
      })
      .then(render)
      .catch((err) => {
        setConnection("Offline", "offline");
        $("mapSummary").textContent = err.message || "Unable to load status";
      });
    const source = new EventSource("/events");
    source.addEventListener("status", (event) => render(JSON.parse(event.data)));
    source.addEventListener("event", (event) => {
      const next = JSON.parse(event.data);
      if (!lastState) return;
      lastState.events = [next, ...lastState.events].slice(0, 80);
      render(lastState);
    });
    source.onerror = () => setConnection("Reconnecting", "reconnecting");
    $("knowledgeMap").addEventListener("click", selectMapNode);
    $("knowledgeMap").addEventListener("mousemove", hoverMapNode);
    $("knowledgeMap").addEventListener("mouseleave", () => {
      hoverUnitId = null;
      $("knowledgeMap").style.cursor = "default";
      if (lastState) scheduleGraph(lastState);
    });
    $("a2aForm").addEventListener("submit", sendA2AFromForm);
    window.addEventListener("resize", () => {
      if (lastState) scheduleGraph(lastState);
    });
  </script>
</body>
</html>`;
}
