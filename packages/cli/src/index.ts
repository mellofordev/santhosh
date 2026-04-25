#!/usr/bin/env bun
import { Command } from "commander";
import {
  defaultRoot,
  ensureRoot,
  loadOrInitConfig,
  loadOrInitIdentity,
  paths,
  saveConfig,
} from "./config.ts";
import { BlobStore, IndexDb } from "../../store/src/index.ts";
import { SanthoshNode } from "../../node/src/node.ts";
import { detectHarness } from "../../harness/src/detect.ts";
import { Scheduler } from "../../scheduler/src/loop.ts";

const program = new Command();
program.name("santhosh").description("Santhosh P2P knowledge protocol daemon");

program
  .command("init")
  .description("Initialize keypair, config, and detect harness")
  .action(async () => {
    const root = defaultRoot();
    await ensureRoot(root);
    const cfg = await loadOrInitConfig(root);
    const id = await loadOrInitIdentity(root);
    const harness = await detectHarness();
    console.log(`root:     ${root}`);
    console.log(`pubkey:   ${id.publicKeyHex}`);
    console.log(`harness:  ${harness.name}`);
    console.log(`topics:   ${cfg.initialTopics.join(", ")}`);
  });

program
  .command("start")
  .description("Run the daemon (P2P host + scheduler)")
  .action(async () => {
    const root = defaultRoot();
    await ensureRoot(root);
    const cfg = await loadOrInitConfig(root);
    const id = await loadOrInitIdentity(root);
    const p = paths(root);
    const blobs = new BlobStore(p.blobs);
    await blobs.init();
    const index = await IndexDb.open(p.db);
    const node = new SanthoshNode({
      listen: cfg.listen,
      bootstrapPeers: cfg.bootstrap,
      enableMdns: cfg.enableMdns,
      identity: id,
      blobs,
      index,
      initialTopics: cfg.initialTopics,
    });
    await node.start();
    const harness = await detectHarness();
    const scheduler = new Scheduler({
      node,
      index,
      harness,
      identityPubHex: id.publicKeyHex,
      intervalMs: cfg.tickIntervalMs,
      maxHeadersPerTick: cfg.maxHeadersPerTick,
    });
    scheduler.start();
    console.log(`[santhosh] up — peer ${node.peerId}`);
    for (const a of node.listenAddrs()) console.log("  listen:", a);
    console.log(`  harness: ${harness.name}`);
    process.on("SIGINT", async () => {
      console.log("\n[santhosh] shutting down");
      scheduler.stop();
      await node.stop();
      process.exit(0);
    });
  });

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
