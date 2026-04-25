import { pipe } from "it-pipe";
import * as lp from "it-length-prefixed";
import type { Stream } from "@libp2p/interface";

const TEXT = new TextEncoder();
const DEC = new TextDecoder();

export interface FetchHandlerDeps {
  loadBlob(hash: string): Promise<string | null>;
}

export function fetchStreamHandler(deps: FetchHandlerDeps) {
  return async ({ stream }: { stream: Stream }) => {
    try {
      await pipe(
        stream.source,
        (src) => lp.decode(src),
        async function* (src) {
          for await (const buf of src) {
            const hash = DEC.decode(buf.subarray()).trim();
            const blob = await deps.loadBlob(hash);
            if (blob === null) {
              yield TEXT.encode("ERR:notfound");
            } else {
              yield TEXT.encode("OK:" + blob);
            }
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

export async function fetchBlob(stream: Stream, hash: string): Promise<string> {
  let response = "";
  await pipe(
    [TEXT.encode(hash)],
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
  if (response.startsWith("ERR:")) throw new Error(response.slice(4));
  if (response.startsWith("OK:")) return response.slice(3);
  throw new Error("invalid fetch response");
}
