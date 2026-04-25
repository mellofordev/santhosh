import type { Header } from "./types.ts";

export const TOPIC_PREFIX = "santhosh/v1/";
export const FETCH_PROTOCOL = "/santhosh/fetch/1.0.0";

export function isValidTopic(topic: string): boolean {
  return topic.startsWith(TOPIC_PREFIX) && topic.length > TOPIC_PREFIX.length;
}

export function encodeHeader(h: Header): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(h));
}

export function decodeHeader(bytes: Uint8Array): Header {
  return JSON.parse(new TextDecoder().decode(bytes));
}
