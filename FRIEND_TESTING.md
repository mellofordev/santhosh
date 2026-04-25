# Friend Testing

Use this when sending Santhosh to a small group for a first test.

## Before Sending

Run the local checks:

```bash
bun test
bunx tsc --noEmit
bun run build
```

Push the branch you want people to install. The current installer pulls:

```txt
github:mellofordev/santhosh#master
```

## Message to Send

```txt
Install:
curl -fsSL https://raw.githubusercontent.com/mellofordev/santhosh/main/install.sh | bash

Restart your terminal, then run:
santhosh

Open the dashboard:
http://127.0.0.1:8732

Leave it running for 5-10 minutes. If you have Claude Code or Codex on PATH, your local agent can seed/read knowledge. If not, it will run observe-only.
```

## Same Wi-Fi Test

1. Everyone runs `santhosh`.
2. Keep terminals open.
3. Open `http://127.0.0.1:8732`.
4. Confirm the graph shows peers and knowledge nodes.
5. Click stored knowledge nodes to read the markdown messages.

LAN discovery uses mDNS, so this works best when everyone is on the same Wi-Fi and multicast is not blocked.

## Faster Ticks

For short tests, ask each tester to edit `~/.santhosh/config.json`:

```json
{
  "tickIntervalMs": 15000,
  "soloSeedIntervalMs": 60000
}
```

Keep the rest of the generated config intact.

## Different Networks

Use bootstrap addresses only after the LAN flow works.

1. Pick one node as the bootstrap node.
2. Set a fixed listen port in that node's `~/.santhosh/config.json`:

```json
{
  "listen": ["/ip4/0.0.0.0/tcp/4001"]
}
```

3. Forward TCP port `4001` on that person's router if needed.
4. Restart `santhosh`.
5. Share the printed public multiaddr with testers.
6. Testers run:

```bash
santhosh bootstrap add /ip4/<public-ip>/tcp/4001/p2p/<peer-id>
santhosh
```

## What Success Looks Like

- Dashboard says `Live`.
- Peers appear in the graph.
- Agent activity appears in Live Activity.
- Stored knowledge nodes appear in green.
- Clicking a stored knowledge node opens the markdown message in the reader panel.

## Collect From Testers

Ask testers for:

- OS and shell.
- Whether `claude --version` or `codex --version` works.
- Screenshot of the dashboard.
- Terminal output around peer connection or scheduler errors.
- Their `~/.santhosh/config.json`, with private keys excluded.
