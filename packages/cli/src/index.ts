#!/usr/bin/env bun
import { Command } from "commander";
import {
  defaultRoot,
  ensureRoot,
  loadOrInitConfig,
  loadOrInitIdentity,
  localStateStatus,
  paths,
  saveConfig,
} from "./config.ts";
import {
  headerEvent,
  peerEvent,
  startDashboard,
  tickEvent,
  type DashboardServer,
  type DashboardState,
} from "./dashboard.ts";
import { BlobStore, IndexDb } from "../../store/src/index.ts";
import { SanthoshNode, type PeerInfo } from "../../node/src/node.ts";
import { detectHarness } from "../../harness/src/detect.ts";
import { Scheduler, type TickSummary } from "../../scheduler/src/loop.ts";

const program = new Command();
program.name("santhosh").description("Santhosh P2P knowledge protocol daemon");

function shortId(id: string): string {
  if (id.length <= 18) return id;
  return `${id.slice(0, 12)}...${id.slice(-6)}`;
}

function printSection(title: string, rows: [string, string][]): void {
  console.log(`\n${title}`);
  for (const [label, value] of rows) {
    console.log(`  ${label.padEnd(10)} ${value}`);
  }
}

function printList(title: string, values: string[], empty = "none"): void {
  console.log(`\n${title}`);
  if (values.length === 0) {
    console.log(`  ${empty}`);
    return;
  }
  for (const value of values) console.log(`  ${value}`);
}

function printConnections(peers: PeerInfo[]): void {
  console.log("\nNetwork");
  if (peers.length === 0) {
    console.log("  No other Santhosh nodes connected yet.");
    console.log("  Searching automatically on this network...");
    return;
  }
  console.log(`  Connected to ${peers.length} Santhosh node${peers.length === 1 ? "" : "s"}.`);
  for (const peer of peers) {
    const direction = peer.direction === "inbound" ? "connected to you" : "you connected";
    console.log(`  ${shortId(peer.id)}  ${direction}`);
  }
}

function printTick(summary: {
  mode: string;
  peers: number;
  headers: number;
  reads: number;
  seeds: number;
}): void {
  if (summary.headers === 0 && summary.reads === 0 && summary.seeds === 0) {
    if (summary.mode === "network-idle") return;
    if (summary.mode === "solo-bootstrap") {
      console.log("\nAgent checked for starter knowledge. Nothing shared yet.");
    }
    return;
  }

  const parts: string[] = [];
  if (summary.headers > 0) {
    parts.push(`reviewed ${summary.headers} new announcement${summary.headers === 1 ? "" : "s"}`);
  }
  if (summary.reads > 0) {
    parts.push(`saved ${summary.reads} knowledge item${summary.reads === 1 ? "" : "s"}`);
  }
  if (summary.seeds > 0) {
    parts.push(`shared ${summary.seeds} knowledge item${summary.seeds === 1 ? "" : "s"}`);
  }

  console.log(`\nAgent update: ${parts.join(", ")}.`);
}

function peerListKey(peers: PeerInfo[]): string {
  return peers.map((peer) => `${peer.id}:${peer.address ?? ""}`).join("|");
}

async function startDaemon(): Promise<void> {
  const root = defaultRoot();
  const before = await localStateStatus(root);
  await ensureRoot(root);
  const cfg = await loadOrInitConfig(root);
  const id = await loadOrInitIdentity(root);
  const p = paths(root);
  const blobs = new BlobStore(p.blobs);
  await blobs.init();
  const index = await IndexDb.open(p.db);
  let lastPeerList = "";
  let consoleReady = false;
  let dashboard: DashboardServer | null = null;
  const node = new SanthoshNode({
    listen: cfg.listen,
    bootstrapPeers: cfg.bootstrap,
    enableMdns: cfg.enableMdns,
    identity: id,
    blobs,
    index,
    initialTopics: cfg.initialTopics,
    events: {
      onPeerConnected: () => {
        const peers = node.connectedPeers();
        const peerList = peerListKey(peers);
        if (peerList !== lastPeerList) {
          lastPeerList = peerList;
          if (consoleReady) printConnections(peers);
          dashboard?.update((state) => {
            state.peers = peers;
            state.graph = index.knowledgeGraph();
          });
          dashboard?.record(peerEvent(peers));
        }
      },
      onHeaderSeen: (header, topic, sourcePeer) => {
        console.log(
          `\nNew knowledge announced: ${header.summary} (${topic}, from ${shortId(sourcePeer ?? "unknown")})`,
        );
        dashboard?.record(headerEvent(header, sourcePeer));
        dashboard?.update((state) => {
          state.graph = index.knowledgeGraph();
        });
      },
    },
  });
  try {
    await node.start();
  } catch (err) {
    console.error("Failed to start Santhosh node.");
    console.error(`  ${(err as Error).message.split("\n")[0]}`);
    console.error("  Check your listen addresses in config.json.");
    process.exit(1);
  }
  const harness = await detectHarness();
  const scheduler = new Scheduler({
    node,
    index,
    harness,
    identityPubHex: id.publicKeyHex,
    intervalMs: cfg.tickIntervalMs,
    maxHeadersPerTick: cfg.maxHeadersPerTick,
    soloSeedIntervalMs: cfg.soloSeedIntervalMs,
    maxSeedsPerTick: cfg.maxSeedsPerTick,
    events: {
      onError: (err) => {
        console.error(`\nScheduler error: ${err.message}`);
        dashboard?.record({
          type: "system",
          title: "Scheduler error",
          detail: err.message,
        });
      },
      onSeedFailed: (err) => {
        console.error(`\nSeed failed: ${err.message}`);
        dashboard?.record({
          type: "system",
          title: "Knowledge share failed",
          detail: err.message,
        });
      },
      onTick: (summary: TickSummary) => {
        printTick(summary);
        dashboard?.update((state) => {
          state.lastTick = summary;
          state.peers = node.connectedPeers();
          state.graph = index.knowledgeGraph();
        });
        const event = tickEvent(summary);
        if (event) dashboard?.record(event);
      },
    },
  });
  if (!before.config || !before.identity) {
    console.log(`Initialized local node at ${root}`);
  }
  const initialPeers = node.connectedPeers();
  lastPeerList = peerListKey(initialPeers);
  if (cfg.dashboard.enabled) {
    const dashboardState: DashboardState = {
      home: root,
      peerId: node.peerId,
      agent: harness.name,
      topics: cfg.initialTopics,
      listenAddrs: node.listenAddrs(),
      discovery: cfg.enableMdns ? "automatic local network" : "manual only",
      checksEverySeconds: Math.round(cfg.tickIntervalMs / 1000),
      peers: initialPeers,
      lastTick: null,
      events: [],
      graph: index.knowledgeGraph(),
    };
    try {
      dashboard = startDashboard({
        host: cfg.dashboard.host,
        port: cfg.dashboard.port,
        state: dashboardState,
        loadMarkdown: (hash) => blobs.get(hash),
      });
      dashboard.record({
        type: "system",
        title: "Santhosh started",
        detail: `Local dashboard available at ${dashboard.url}`,
      });
    } catch (err) {
      console.error(`\nDashboard failed to start: ${(err as Error).message}`);
    }
  }
  printSection("Santhosh is running", [
    ["agent", harness.name],
    ["topics", cfg.initialTopics.join(", ")],
    ["discovery", cfg.enableMdns ? "automatic local network" : "manual only"],
    ["checks", `every ${Math.round(cfg.tickIntervalMs / 1000)}s`],
    ["dashboard", dashboard?.url ?? "disabled"],
  ]);
  if (harness.name === "observe-only") {
    console.log(
      "\nNo Claude or Codex harness found. The node will observe and fetch, but it will not seed new knowledge.",
    );
  }
  printList(
    "Your node addresses (advanced)",
    node.listenAddrs(),
    "no addresses available",
  );
  printConnections(initialPeers);
  consoleReady = true;
  scheduler.start();
  process.on("SIGINT", async () => {
    console.log("\nStopping Santhosh node...");
    scheduler.stop();
    dashboard?.stop();
    await node.stop();
    process.exit(0);
  });
}

program.action(startDaemon);

program
  .command("init")
  .description("Initialize/show local config, identity, and harness")
  .action(async () => {
    const root = defaultRoot();
    await ensureRoot(root);
    const cfg = await loadOrInitConfig(root);
    const id = await loadOrInitIdentity(root);
    const harness = await detectHarness();
    printSection("Local node", [
      ["home", root],
      ["pubkey", id.publicKeyHex],
      ["harness", harness.name],
      ["topics", cfg.initialTopics.join(", ")],
    ]);
  });

program
  .command("start")
  .description("Start the node, auto-init if needed, and discover peers")
  .action(startDaemon);

program
  .command("status")
  .description("Show daemon-independent local state")
  .action(async () => {
    const root = defaultRoot();
    await ensureRoot(root);
    const cfg = await loadOrInitConfig(root);
    const id = await loadOrInitIdentity(root);
    const index = await IndexDb.open(paths(root).db);
    const last = index.lastTick();
    console.log(`pubkey:   ${id.publicKeyHex}`);
    console.log(`topics:   ${cfg.initialTopics.join(", ")}`);
    console.log(`units:    ${index.countUnits()}`);
    console.log(`lasttick: ${last ? `${last.ts} (h=${last.new_headers} r=${last.reads} s=${last.seeds})` : "(never)"}`);
  });

program
  .command("topics")
  .description("List topics with stored units")
  .action(async () => {
    const root = defaultRoot();
    const index = await IndexDb.open(paths(root).db);
    for (const t of index.knownTopics()) console.log(t);
  });

program
  .command("bootstrap")
  .argument("<action>", "add | list")
  .argument("[multiaddr]", "multiaddr (for add)")
  .description("Manage bootstrap peers")
  .action(async (action: string, addr?: string) => {
    const root = defaultRoot();
    const cfg = await loadOrInitConfig(root);
    if (action === "list") {
      cfg.bootstrap.forEach((a) => console.log(a));
      return;
    }
    if (action === "add") {
      if (!addr) {
        console.error("multiaddr required");
        process.exit(2);
      }
      if (!cfg.bootstrap.includes(addr)) cfg.bootstrap.push(addr);
      await saveConfig(cfg, root);
      console.log("added");
      return;
    }
    console.error("unknown action");
    process.exit(2);
  });

await program.parseAsync(process.argv);
