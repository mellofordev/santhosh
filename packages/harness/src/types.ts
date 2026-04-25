import type { Header } from "../../protocol/src/types.ts";

export type AgentMode = "solo-bootstrap" | "peer-observe" | "network-idle";

export interface AgentInput {
  mode: AgentMode;
  peerCount: number;
  newHeaders: Header[];
  knownTopics: string[];
  recentSeeds: { id: string; topic: string }[];
}

export interface SeedRequest {
  markdown: string;
  parents: string[];
  topic: string;
  tags?: string[];
  summary: string;
}

export interface AgentDecision {
  read: string[];
  seed: SeedRequest[];
  reasoning?: string;
}

export interface Harness {
  name: string;
  decide(input: AgentInput): Promise<AgentDecision>;
}
