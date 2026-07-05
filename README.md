# pi-xmpp

XMPP runtime adapter for [Pi](https://pi.dev).

Connect your Pi agent to Jabber/XMPP servers for instant messaging with AI assistance.

> **Privacy first** — No telemetry, no phone-home, no external dependencies. Works with any self-hosted Jabber server and supports self-signed certificates.

## Modes of operation

The bridge works in three modes depending on how you configure `ownerJid` and `autoJoinRoom`:

| Mode | `ownerJid` | `autoJoinRoom` | Behaviour |
|------|------------|-----------------|-----------|
| **Direct messaging** | set | empty | Only the owner can DM the bot. No room participation. |
| **Open room** | empty | set | Anyone in the room can send commands to the bot. |
| **Supervised room** | set | set | Everyone in the room sees all output, but only the owner can send commands. |

## Features

- **XMPP Connection Management** — Connect, disconnect, and auto-reconnect to any XMPP server
- **Direct Messaging** — Receive and respond to one-on-one chat messages
- **MUC/Groupchat Support** — Join, leave, and participate in multi-user chat rooms
- **Presence Management** — Set your availability and status message
- **Authorization & Pairing** — Auto-pair on first message, restrict to specific JIDs
- **Auto-join Rooms** — Automatically join configured chat rooms on connect
- **Companion Extension API** — Register inbound/outbound handlers, status providers, and slash commands

## Install

```bash
pi install npm:pi-xmpp
```

Or from git:

```bash
pi install git:github.com/stan-kondrat/pi-xmpp
```

## Quick Start

1. **Configure** `~/.pi/agent/xmpp.json`:

```json
{
  "default": {
    "jid": "your-username@your-server.org",
    "password": "your-password",
    "ownerJid": "trusted@domain.tld"
  }
}
```

2. **Start Pi** — the bridge auto-connects using the `"default"` account.

3. **Chat** from any XMPP client — send a message to your Pi agent's JID.

### Connect manually

```
/xmpp-connect                                                         # uses the "default" account
/xmpp-connect myaccount                                               # connects an existing account
/xmpp-connect myaccount --jid user@... --password secret \            # creates a NEW account
               [--ownerJid admin@domain.tld] \
               [--autoJoinRoom room@conference.tld] \
               [--service xmpp://server.tld]
```

The first positional argument is always the **account name** (the key in `~/.pi/agent/xmpp.json`).

- `/xmpp-connect account-name` — connects an **existing** account from config
- `/xmpp-connect account-name --jid ... --password ...` — **creates** a new account and persists it to config
- Accounts are never overwritten by ad-hoc credentials — each `--jid --password` invocation creates a fresh entry

## Multiple accounts

Define additional accounts as named keys in `~/.pi/agent/xmpp.json`:

```json
{
  "default": {
    "jid": "user@work.org",
    "password": "secret",
    "ownerJid": "admin@work.org",
    "autoJoinRoom": "team@conference.work.org"
  },
  "personal": {
    "jid": "user@personal.org",
    "password": "secret2"
  }
}
```

Connect to any account by name:

```
/xmpp-connect personal
/xmpp-connect default
```

## Slash Commands

| Command | Description |
|---------|-------------|
| `/xmpp-connect` | Connect. No args = default account. `account-name` = existing account. `account-name --jid --password [...]` = create new account. |
| `/xmpp-disconnect` | Disconnect from XMPP server |
| `/xmpp-status` | Show connection status and diagnostics |
| `/xmpp-join` | Join a MUC room (`--room`, `--nick`) |
| `/xmpp-leave` | Leave a MUC room (`--room`) |
| `/xmpp-set-presence` | Set presence (`--show`, `--status`) |

## Configuration

Config file: `~/.pi/agent/xmpp.json`

Accounts are keyed objects — the special `"default"` key auto-connects on start and is used by `/xmpp-connect` without arguments.

```json
{
  "default": {
    "jid": "user@domain.tld",
    "password": "secret",
    "service": "xmpp://server.tld",
    "domain": "server.tld",
    "resource": "pi-bridge",
    "ownerJid": "trusted@domain.tld",
    "autoReconnect": true,
    "autoJoinRoom": "room@conference.tld"
  },
  "personal": {
    "jid": "user@personal.org",
    "password": "secret2"
  }
}
```

### Fields

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `jid` | yes | — | Your XMPP address |
| `password` | yes | — | Your XMPP password |
| `service` | no | `xmpp://<jid-domain>` | Server address (use for non-standard ports or WebSocket/BOSH endpoints) |
| `domain` | no | JID domain | XMPP domain |
| `resource` | no | `pi-bridge` | Client resource identifier |
| `ownerJid` | no | — | Authorized JID (see Authorization below) |
| `autoReconnect` | no | `true` | Reconnect on disconnect |
| `autoJoinRoom` | no | — | Single MUC room JID to join on connect |

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
│  XMPP Server│◄───►│  @xmpp/client│◄───►│  pi-xmpp    │
│             │     │              │     │  Extension  │
└─────────────┘     └──────────────┘     └──────┬──────┘
                                                │
                                         ┌──────▼──────┐
                                         │  Pi Agent   │
                                         │  Runtime    │
                                         └─────────────┘
```

## License

MIT
