# pi-xmpp

XMPP runtime adapter for [Pi](https://github.com/earendil-works/pi).

Connect your Pi agent to Jabber/XMPP servers for instant messaging with AI assistance.

## Features

- **XMPP Connection Management** — Connect, disconnect, and auto-reconnect to any XMPP server
- **Direct Messaging** — Receive and respond to one-on-one chat messages
- **MUC/Groupchat Support** — Join, leave, and participate in multi-user chat rooms
- **Presence Management** — Set your availability and status message
- **Authorization & Pairing** — Auto-pair on first message, restrict to specific JIDs
- **Companion Extension API** — Register inbound/outbound handlers, status providers, and slash commands
- **Auto-join Rooms** — Automatically join configured chat rooms on connect
- **Slash Commands** — Control the bridge via `/xmpp-connect`, `/xmpp-status`, `/xmpp-join`, and more

## Installation

```bash
npm install pi-xmpp
```

## Quick Start

1. **Configure your credentials** in `~/.pi/agent/xmpp.json`:

```json
{
  "jid": "your-username@your-server.org",
  "password": "your-password",
  "service": "xmpp://your-server.org"
}
```

2. **Start Pi** and the bridge auto-connects.

3. **Or connect manually** from within Pi:

```
/xmpp-connect --jid user@domain.tld --password secret --service xmpp://server.tld
```

## Slash Commands

| Command | Description |
|---------|-------------|
| `/xmpp-connect` | Connect to XMPP server (--jid, --password, --service) |
| `/xmpp-disconnect` | Disconnect from XMPP server |
| `/xmpp-status` | Show connection status and diagnostics |
| `/xmpp-join` | Join a MUC room (--room, --nick) |
| `/xmpp-leave` | Leave a MUC room (--room) |
| `/xmpp-set-presence` | Set presence (--show, --status) |

## Configuration

Configuration is stored in `~/.pi/agent/xmpp.json`:

```json
{
  "jid": "user@domain.tld",
  "password": "secret",
  "service": "xmpp://server.tld",
  "domain": "server.tld",
  "resource": "pi-bridge",
  "allowedJid": "trusted@domain.tld",
  "autoReconnect": true,
  "autoJoinRooms": ["room@conference.tld"]
}
```

## Extension API

### Inbound Handlers

```typescript
import { registerXmppInboundHandler } from "pi-xmpp/inbound";

registerXmppInboundHandler(async (input) => {
  if (input.body.startsWith("!ping")) {
    return { handled: true, prompt: "User requested ping" };
  }
  return { handled: false };
});
```

### Outbound Handlers

```typescript
import { registerXmppOutboundHandler } from "pi-xmpp/outbound";

registerXmppOutboundHandler(async (input) => {
  return { handled: false };
});
```

### Status Providers

```typescript
import { registerXmppStatusLineProvider } from "pi-xmpp/status";

registerXmppStatusLineProvider((ctx) => ({
  label: "My Custom Status",
  value: "ok",
}));
```

## Architecture

```
┌─────────────┐     ┌──────────────┐     ┌─────────────┐
│  XMPP Server│◄───►│  xmpp.js     │◄───►│  pi-xmpp    │
│             │     │  Client      │     │  Extension  │
└─────────────┘     └──────────────┘     └──────┬──────┘
                                                │
                                         ┌──────▼──────┐
                                         │  Pi Agent   │
                                         │  Runtime    │
                                         └─────────────┘
```

## License

MIT
