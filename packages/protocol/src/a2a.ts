import { pipe } from "it-pipe";
import * as lp from "it-length-prefixed";
import type { Stream } from "@libp2p/interface";

export const A2A_VERSION = "0.2.4";
export const A2A_PROTOCOL = "/santhosh/a2a/1.0.0";

const TEXT = new TextEncoder();
const DEC = new TextDecoder();

export type A2ARole = "user" | "agent";
export type A2ATaskState =
  | "submitted"
  | "working"
  | "input-required"
  | "completed"
  | "canceled"
  | "failed"
  | "rejected";

export interface A2ATextPart {
  kind: "text";
  text: string;
  metadata?: Record<string, unknown>;
}

export type A2APart = A2ATextPart;

export interface A2AMessage {
  kind: "message";
  role: A2ARole;
  parts: A2APart[];
  messageId: string;
  taskId?: string;
  contextId?: string;
  metadata?: Record<string, unknown>;
}

export interface A2ATaskStatus {
  state: A2ATaskState;
  message?: A2AMessage;
  timestamp?: string;
}

export interface A2AArtifact {
  artifactId: string;
  name?: string;
  description?: string;
  parts: A2APart[];
  metadata?: Record<string, unknown>;
}

export interface A2ATask {
  kind: "task";
  id: string;
  contextId: string;
  status: A2ATaskStatus;
  history?: A2AMessage[];
  artifacts?: A2AArtifact[];
  metadata?: Record<string, unknown>;
}

export interface A2AAgentSkill {
  id: string;
  name: string;
  description: string;
  tags?: string[];
  examples?: string[];
  inputModes?: string[];
  outputModes?: string[];
}

export interface A2AAgentCard {
  protocolVersion: string;
  name: string;
  description: string;
  url: string;
  version: string;
  capabilities: {
    streaming?: boolean;
    pushNotifications?: boolean;
    stateTransitionHistory?: boolean;
  };
  defaultInputModes: string[];
  defaultOutputModes: string[];
  skills: A2AAgentSkill[];
  provider?: {
    organization: string;
    url?: string;
  };
}

export interface A2AMessageSendParams {
  message: A2AMessage;
  configuration?: {
    acceptedOutputModes?: string[];
    historyLength?: number;
  };
  metadata?: Record<string, unknown>;
}

export interface A2ATaskQueryParams {
  id: string;
  historyLength?: number;
  metadata?: Record<string, unknown>;
}

export interface A2AJsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: unknown;
}

export interface A2AJsonRpcSuccess {
  jsonrpc: "2.0";
  id: string | number | null;
  result: unknown;
}

export interface A2AJsonRpcError {
  jsonrpc: "2.0";
  id: string | number | null;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export type A2AJsonRpcResponse = A2AJsonRpcSuccess | A2AJsonRpcError;

export interface A2AStreamHandlerDeps {
  handleRequest(req: A2AJsonRpcRequest): Promise<A2AJsonRpcResponse>;
}

export function textFromA2AMessage(message: A2AMessage): string {
  return message.parts
    .filter((part): part is A2ATextPart => part.kind === "text")
    .map((part) => part.text)
    .join("\n\n")
    .trim();
}

export function jsonRpcSuccess(
  id: string | number | null | undefined,
  result: unknown,
): A2AJsonRpcSuccess {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

export function jsonRpcError(
  id: string | number | null | undefined,
  code: number,
  message: string,
  data?: unknown,
): A2AJsonRpcError {
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    error: data === undefined ? { code, message } : { code, message, data },
  };
}

export function isA2AMessage(value: unknown): value is A2AMessage {
  if (!value || typeof value !== "object") return false;
  const msg = value as Partial<A2AMessage>;
  return (
    msg.kind === "message" &&
    (msg.role === "user" || msg.role === "agent") &&
    typeof msg.messageId === "string" &&
    Array.isArray(msg.parts) &&
    msg.parts.every((part) => {
      const p = part as Partial<A2ATextPart>;
      return p.kind === "text" && typeof p.text === "string";
    })
  );
}

export function a2aStreamHandler(deps: A2AStreamHandlerDeps) {
  return async ({ stream }: { stream: Stream }) => {
    try {
      await pipe(
        stream.source,
        (src) => lp.decode(src),
        async function* (src) {
          for await (const buf of src) {
            const raw = DEC.decode(buf.subarray());
            let response: A2AJsonRpcResponse;
            try {
              const req = JSON.parse(raw) as A2AJsonRpcRequest;
              response = await deps.handleRequest(req);
            } catch (err) {
              response = jsonRpcError(
                null,
                -32700,
                "Invalid A2A JSON-RPC payload",
                (err as Error).message,
              );
            }
            yield TEXT.encode(JSON.stringify(response));
            break;
          }
        },
        (src) => lp.encode(src),
        stream.sink,
      );
    } catch (err) {
      stream.abort(err as Error);
    }
  };
}

export async function sendA2ARequest(
  stream: Stream,
  req: A2AJsonRpcRequest,
): Promise<A2AJsonRpcResponse> {
  let response = "";
  await pipe(
    [TEXT.encode(JSON.stringify(req))],
    (src) => lp.encode(src),
    stream,
    (src) => lp.decode(src),
    async (src) => {
      for await (const buf of src) {
        response = DEC.decode(buf.subarray());
        break;
      }
    },
  );
  if (!response) throw new Error("empty A2A response");
  return JSON.parse(response) as A2AJsonRpcResponse;
}
