import { createLibp2p, type Libp2p } from "libp2p";
import { tcp } from "@libp2p/tcp";
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { gossipsub } from "@chainsafe/libp2p-gossipsub";
import { identify } from "@libp2p/identify";
import { kadDHT } from "@libp2p/kad-dht";
import { mdns } from "@libp2p/mdns";
import { bootstrap } from "@libp2p/bootstrap";

export interface HostOptions {
  listen: string[];
  bootstrapPeers: string[];
  enableMdns: boolean;
}

export async function createHost(opts: HostOptions): Promise<Libp2p> {
  const peerDiscovery = [];
  if (opts.enableMdns) peerDiscovery.push(mdns());
  if (opts.bootstrapPeers.length > 0)
    peerDiscovery.push(bootstrap({ list: opts.bootstrapPeers }));

  const node = await createLibp2p({
    addresses: { listen: opts.listen },
    transports: [tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    peerDiscovery,
    services: {
      identify: identify(),
      pubsub: gossipsub({ allowPublishToZeroTopicPeers: true }),
      dht: kadDHT({ clientMode: false }),
    },
  });
  return node;
}
