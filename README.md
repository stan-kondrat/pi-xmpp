# pi-xmpp

XMPP runtime adapter for [Pi](https://pi.dev).

Connect your Pi agent to Jabber/XMPP servers for instant messaging with AI assistance.

> **Privacy first** — No telemetry, no phone-home, no external dependencies. Works with any self-hosted Jabber server and supports self-signed certificates.

## Modes of operation

The bridge works in three modes depending on how you configure `ownerJid` and `roomJid`:

| Mode | `ownerJid` | `roomJid` | Behaviour |
|------|------------|-----------------|-----------|
| **Direct messaging** | set | empty | Only the owner can DM the bot. No room participation. |
| **Open room** | empty | set | Anyone in the room can send commands to the bot. |
| **Supervised room** | set | set | Everyone in the room sees all output, but only the owner can send commands. Auth uses the sender's real JID extracted from MUC presence (XEP-0045) in non-anonymous rooms. In anonymous rooms, all messages are denied. |

## Features

- **XMPP Connection Management** — Connect, disconnect, and auto-reconnect to any XMPP server
- **Direct Messaging** — Receive and respond to one-on-one chat messages
- **MUC/Groupchat Support** — Join, leave, and participate in multi-user chat rooms
- **Presence Management** — Set your availability and status message
- **Authorization & Pairing** — Auto-pair on first message, restrict to specific JIDs
- **Auto-join Rooms** — Automatically join configured chat rooms on connect
- **Auto-connect** — Per-account `autoConnect` flag (default: `false`) with instance-lock to prevent duplicate connections across Pi CLIs
- **Connect Greeting** — Sends a ready notification DM to `ownerJid` on auto-connect
- **Auto-routing** — If the agent forgets to call `xmpp_send`, the bridge automatically routes its text response back through XMPP
- **Multi-instance safety** — Atomic filesystem lock prevents multiple Pi instances from auto-connecting the same account
- **Text template system** — All user-facing strings are configurable via `prompts` (→ LLM) and `uiMessages` (→ notifications/XMPP wire) in `~/.pi/agent/xmpp.json` with `{placeholder}` interpolation
- **Auth harness** — Authorization checks happen in the bridge runtime before any message reaches the LLM; 13 dedicated tests verify this invariant
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

2. **Configure auto-connect** (optional) — Set `"autoConnect": true` on any account to auto-connect on startup.

3. **Start Pi** — accounts with `"autoConnect": true` connect automatically. Only the first Pi instance acquires the instance lock; other instances skip with a notification.

4. **Chat** from any XMPP client — send a message to your Pi agent's JID.

### Connect manually

```
/xmpp-connect                                                         # uses the "default" account
/xmpp-connect myaccount                                               # connects an existing account
/xmpp-connect myaccount --jid user@... --password secret \            # creates a NEW account
               [--ownerJid admin@domain.tld] \
               [--roomJid room@conference.tld] \
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
    "roomJid": "team@conference.work.org"
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

Accounts are keyed objects — the special `"default"` key is used by `/xmpp-connect` without arguments. Set `"autoConnect": true` on any account to auto-connect on start.

### Auto-connect and multi-instance safety

When multiple Pi CLIs start in the same workspace, the lock is **per-account** — different instances
can auto-connect different accounts simultaneously.

Each account gets an atomic directory lock at
`~/.pi/agent/xmpp-auto-connect.lock/{accountName}/`. If another instance already holds the lock
for that account, auto-connect is skipped:

> ℹ️ XMPP auto-connect skipped: work — another Pi instance already connected

Manual `/xmpp-connect` always works regardless of the lock.

### Connect greeting

On successful auto-connect, if the account has an `ownerJid`, the bridge sends a DM:

> ✅ XMPP bridge connected and ready (account: default, jid: user@domain)

### Response routing

- **XMPP-originated messages** — The agent's text response is automatically routed back through XMPP to the sender (or room), even if the agent doesn't explicitly call `xmpp_send`.
- **Slash commands** — `/xmpp-status`, `/xmpp-connect`, etc. respond directly over XMPP to the user who ran the command.
- **Local commands** — Responses appear as TUI notifications without creating a new agent turn.

```json
{
  "default": {
    "jid": "user@domain.tld",
    "password": "secret",
    "service": "xmpp://server.tld",
    "domain": "server.tld",
    "ownerJid": "trusted@domain.tld",
    "autoReconnect": true,
    "roomJid": "room@conference.tld"
  },
  "personal": {
    "jid": "user@personal.org",
    "password": "secret2"
  }
}
```

### Text Templates (`prompts` / `uiMessages`)

All user-facing strings are configurable. The config file supports both **global** and
**per-account** overrides with `{placeholder}` interpolation:

```json
{
  // global overrides (optional)
  "prompts": {
    "toolNoClient": "Custom offline message: {body}",
    "toolSent": "📤 Sent to {to}: {body}",
    "toolSendFailed": "Send error: {err}",
    "turnFromLine": "[xmpp|from:{from}]",
    "turnRoomLine": "[room:{roomJid}]",
    "turnNickLine": "[nick:{nick}]"
  },
  "uiMessages": {
    "configLoadFailed": "Config error: {err}",
    "autoConnectSkipped": "Skipped {name}: another instance connected",
    "connectedOk": "✅ Bot ready as {jid}",
    "connectFailed": "❌ Failed: {name}",
    "greeting": "Hello {name} at {jid}",
    "processingRequest": "Working on it...",
    "stillWorking": "⏳ Still working...",
    "ready": "Idle",
    "processing": "Thinking: {preview}",
    "heartbeat": "Still on: {preview}",
    "responseSent": "✅ Replied to {to}: {preview}",
    "systemIntro": "Message from XMPP.",
    "systemAccount": "Account: {name}",
    "systemGroupchatWarning": "⚠️ Groupchat — everyone sees replies.",
    "systemRoomLine": "Room: {roomJid}",
    "systemNickLine": "Sender: {nick}",
    "systemDirectMessage": "💬 Direct message — private.",
    "systemReplyInstruction": "Reply via \`xmpp_send\` tool.",
    "systemHelpInstruction": "See \`xmpp_help\` for details.",
    "localSuffix": "\n\nXMPP bridge available.",
    "helpText": "--- XMPP BRIDGE HELP ---\n... (full text below)",
    "commandsHelp": "🤖 Bot commands:\n... (full text below)"
  },

  // per-account overrides (optional, merge on top of global)
  "default": {
    "jid": "user@domain.tld",
    "password": "secret",
    "prompts": {
      "toolSent": "✅ Sent to {to}: {body}"
    }
  }
}
```

**Merge order:** `DEFAULTS ← global overrides ← per-account overrides`

The default `helpText` (shown by the `xmpp_help` tool) is:

```
--- XMPP BRIDGE HELP ---

How to understand XMPP turns:
- [xmpp|from:user@domain] marks XMPP origin and sender.
- [room:room@conference] indicates a groupchat (MUC) message.
- [nick:nickname] is the sender's nickname in a MUC room.
- When ownerJid is set, only the owner can send commands to rooms.
- Reply to the user's current instruction, not quoted context.

How to answer XMPP turns:
- Reply in concise, scannable text.
- For generated/requested files, mention the local path.

Assistant-authored XMPP actions:
- Use the xmpp_send tool to send direct messages or groupchat replies.

Debugging pi-xmpp:
- Inspect ~/.pi/agent/tmp/xmpp/state.json for runtime state and diagnostics.
- Use /xmpp-status for compact health information.
```

The default `commandsHelp` (sent on room join or DM by companion plugins) is:

```
🤖 Bot commands:
  !compact    — Compact conversation history
  !models     — List all available AI models
  !model <id> — Switch AI model
  !help       — Show this message
Only the owner can use these commands.
```

**`prompts`** — tool results + turn prefixes (become part of LLM conversation context):
- `toolNoClient` — `❌ No XMPP account connected. Message not sent: {body}`
- `toolSent` — `📤 Message sent to {to}: {body}`
- `toolSendFailed` — `Failed to send message: {err}`
- `turnFromLine` — `[xmpp|from:{from}]`
- `turnRoomLine` — `[room:{roomJid}]`
- `turnNickLine` — `[nick:{nick}]`
- `turnSubjectLine` — `[subject:{subject}]`
- `turnThreadLine` — `[thread:{thread}]`
- `turnContextLine` — `[context:{ctx}]`

**`uiMessages`** — UI notifications, XMPP wire strings, and system prompt instructions (never reach the LLM as user messages):
- `configLoadFailed`, `autoConnectSkipped`, `connectedOk`, `connectFailed`
- `greeting`, `processingRequest`, `stillWorking`, `ready`
- `processing`, `heartbeat`, `responseSent`
- `systemIntro`, `systemAccount`, `systemGroupchatWarning`, `systemRoomLine`, `systemNickLine`
- `systemDirectMessage`, `systemReplyInstruction`, `systemHelpInstruction`
- `localSuffix`, `helpText`, `commandsHelp`

### Fields

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `jid` | yes | — | Your XMPP address |
| `password` | yes | — | Your XMPP password |
| `service` | no | `xmpp://<jid-domain>` | Server address (use for non-standard ports or WebSocket/BOSH endpoints) |
| `domain` | no | JID domain | XMPP domain |
| `ownerJid` | no | — | Authorized JID (see Authorization below) |
| `autoReconnect` | no | `true` | Reconnect on disconnect |
| `roomJid` | no | — | Single MUC room JID to join on connect |
| `autoConnect` | no | `false` | Auto-connect this account on startup |
| `prompts` | no | — | Partial prompt template overrides (`{placeholder}` syntax) |
| `uiMessages` | no | — | Partial UI message template overrides (`{placeholder}` syntax) |

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
