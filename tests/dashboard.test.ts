import { describe, expect, test } from "bun:test";
import {
  headerEvent,
  peerEvent,
  tickEvent,
} from "../packages/cli/src/dashboard.ts";
import type { Header } from "../packages/protocol/src/types.ts";

describe("dashboard events", () => {
  test("summarizes peer, header, and tick activity", () => {
    expect(peerEvent([])).toEqual({
      type: "network",
      title: "Searching for nodes",
      detail: "No other Santhosh nodes connected yet.",
    });

    expect(
      peerEvent([
        {
          id: "1234567890abcdefghijklmnopqrstuvwxyz",
          direction: "outbound",
        },
      ]),
    ).toEqual({
      type: "network",
      title: "Connected to 1 node",
      detail: "1234567890ab...uvwxyz",
    });

    const header: Header = {
      id: "unit-1",
      topic: "santhosh/v1/general",
      parents: [],
      author: "author",
      tags: [],
      summary: "Useful note",
      created_at: "2026-04-25T00:00:00.000Z",
      sig: "sig",
    };
    expect(headerEvent(header, "remote-peer")).toEqual({
      type: "knowledge",
      title: "Knowledge announced",
      detail: "Useful note from remote-peer",
    });

    expect(
      tickEvent({
        mode: "peer-observe",
        peers: 1,
        headers: 2,
        reads: 1,
        seeds: 1,
        a2a: 1,
      }),
    ).toEqual({
      type: "agent",
      title: "Agent activity",
      detail: "reviewed 2 announcements, saved 1 item, shared 1 item, completed 1 A2A exchange",
    });

    expect(
      tickEvent({
        mode: "network-idle",
        peers: 1,
        headers: 0,
        reads: 0,
        seeds: 0,
        a2a: 0,
      }),
    ).toBeNull();
  });
});
