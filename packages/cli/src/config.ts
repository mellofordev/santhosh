import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, readFile, writeFile, access, chmod } from "node:fs/promises";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import {
  generateIdentity,
  loadIdentity,
  type Identity,
} from "../../protocol/src/sign.ts";

export interface Config {
  listen: string[];
  bootstrap: string[];
  enableMdns: boolean;
  initialTopics: string[];
  tickIntervalMs: number;
  maxHeadersPerTick: number;
  soloSeedIntervalMs: number;
  maxSeedsPerTick: number;
  dashboard: DashboardConfig;
}

export interface DashboardConfig {
  enabled: boolean;
  host: string;
  port: number;
}

export interface LocalStateStatus {
  config: boolean;
  identity: boolean;
}

export function defaultRoot(): string {
  return process.env.SANTHOSH_HOME ?? join(homedir(), ".santhosh");
}

export function paths(root = defaultRoot()) {
  return {
    root,
    config: join(root, "config.json"),
    identity: join(root, "identity.key"),
    db: join(root, "index.db"),
    blobs: join(root, "blobs"),
  };
}

const DEFAULT_CONFIG: Config = {
  listen: ["/ip4/0.0.0.0/tcp/0"],
  bootstrap: [],
  enableMdns: true,
  initialTopics: ["santhosh/v1/general"],
  tickIntervalMs: 5 * 60 * 1000,
  maxHeadersPerTick: 20,
  soloSeedIntervalMs: 60 * 60 * 1000,
  maxSeedsPerTick: 1,
  dashboard: {
    enabled: true,
    host: "127.0.0.1",
    port: 8732,
  },
};

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

export async function localStateStatus(
  root = defaultRoot(),
): Promise<LocalStateStatus> {
  const p = paths(root);
  return {
    config: await exists(p.config),
    identity: await exists(p.identity),
  };
}

export async function ensureRoot(root = defaultRoot()): Promise<void> {
  await mkdir(root, { recursive: true });
}

export async function loadOrInitConfig(root = defaultRoot()): Promise<Config> {
  const p = paths(root).config;
  if (!(await exists(p))) {
    await writeFile(p, JSON.stringify(DEFAULT_CONFIG, null, 2));
    return { ...DEFAULT_CONFIG };
  }
  const raw = await readFile(p, "utf8");
  return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
}

export async function saveConfig(cfg: Config, root = defaultRoot()): Promise<void> {
  await writeFile(paths(root).config, JSON.stringify(cfg, null, 2));
}

export async function loadOrInitIdentity(root = defaultRoot()): Promise<Identity> {
  const p = paths(root).identity;
  if (await exists(p)) {
    const hex = (await readFile(p, "utf8")).trim();
    return loadIdentity(hex);
  }
  const id = await generateIdentity();
  await writeFile(p, bytesToHex(id.privateKey), "utf8");
  await chmod(p, 0o600);
  return id;
}
