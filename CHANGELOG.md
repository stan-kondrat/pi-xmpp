# Changelog

## Backlog

- [ ] **XMPP roster management** — Fetch and display contacts via `/xmpp-roster`
- [ ] **Chat state notifications (XEP-0085)** — Send/receive typing indicators
- [ ] **Message delivery receipts (XEP-0184)** — Track and display delivery status
- [ ] **File transfer (XEP-0363)** — HTTP Upload support for sending/receiving files
- [ ] **End-to-end encryption (OMEMO / XEP-0384)** — E2EE for direct messages
- [ ] **Formatted messages (XEP-0071)** — Support XHTML-IM for rich formatting
- [ ] **Message correction (XEP-0308)** — Allow editing sent messages
- [ ] **Multi-instance bus** — Threaded mode like pi-telegram
- [ ] **Voice messages** — Send/receive audio messages
- [ ] **MAM (XEP-0313)** — Message archive management for loading history on connect
- [ ] **Roster presence subscription** — Handle subscribe/subscribed/unsubscribe/unsubscribed presence
- [ ] **Config hot-reload** — Detect file changes to `~/.pi/agent/xmpp.json` without restart
- [ ] **CLI `pi-xmpp` command** — Separate CLI tool for connection management outside Pi

## 0.4.0

### MUC authorization fix
- **Groupchat owner check now uses real JIDs** — Previously, the bridge compared the room JID
  against `ownerJid`, which always failed. Now it extracts the sender's real JID from MUC
  presence stanzas (XEP-0045 `<x xmlns='http://jabber.org/protocol/muc#user'><item jid='...'/></x>`)
  and compares the sender's bare JID against `ownerJid`. Owner messages in non-anonymous
  rooms now correctly pass authorization. [#BUG]
- **Anonymous room safety** — When the sender's real JID cannot be resolved (anonymous room
  or presence not yet received), the message is denied to prevent unauthorised access.

### Config & template system
- **`prompts` and `uiMessages` override config** — Config file now supports global and
  per-account template overrides at `~/.pi/agent/xmpp.json`:
  ```json
  {
    "prompts": { "toolNoClient": "Custom: {body}" },
    "uiMessages": { "connectedOk": "✅ Bot ready as {jid}" },
    "default": { "jid": "...", "prompts": { ... } }
  }
  ```
  Merge order: `DEFAULTS ← global overrides ← per-account overrides`.
- **`XmppPromptTemplates` / `XmppUiMessageTemplates`** — Split into two interfaces.
  `prompts` are tool results returned to the LLM; `uiMessages` are UI notifications and
  XMPP wire strings that never reach the LLM.
- **`{placeholder}` interpolation** — JSON template strings use `{paramName}` syntax,
  compiled to runtime functions via `compileXmppTemplate()`.
- **Text templates extracted to config** — All user-facing strings moved from inline
  template literals to `DEFAULT_XMPP_PROMPTS` / `DEFAULT_XMPP_UI_MESSAGES` consts in
  `lib/config.ts`.

### Bot commands
- **Built-in bot commands** — `!compact`, `!models`, `!model <id>`, `!help` now work out of the box.
  Commands run **after auth but before the LLM** — they never reach the agent prompt.
- **`!compact`** — Triggers Pi session compaction via `ctx.compact()`.
- **`!models`** — Shows the current model and enabled model patterns from Pi settings.
- **`!model <id>`** — Switches the active model via `pi.setModel()`. Supports `provider/id`
  format (e.g. `!model anthropic/claude-sonnet-4-20250514`).
- **`!help`** — Replies with the configurable `commandsHelp` template.
- **Owner-aware** — In supervised rooms (`ownerJid` set), only the owner can run commands.
  In open rooms (no `ownerJid`), anyone can.
- **`commandsHelp` template** — Default command list with `{placeholder}` syntax,
  overridable per-account or globally in config.

### Auth harness verification
- **Auth gate invariant proven** — 13 new tests verify that unauthorized messages are
  silently dropped before `sendUserMessage()` is called, that malicious JID manipulation
  cannot bypass the string comparison, and that the queue remains empty for denied messages.
- **Pipeline tracing** — End-to-end test traces the exact stage at which unauthorized
  messages are stopped (`auth-checked`) vs authorized ones (`sent-to-llm`).

## 0.3.1

### Fixes
- **Reliable auto-reconnect** — Replaced reliance on `@xmpp/reconnect`'s one-shot retry with the bridge's own reconnect loop featuring exponential backoff (1s → 2s → 4s → … → 60s cap), proper error surfacing via `xmpp-error` events, and status reporting (`reconnecting`). On unexpected disconnect or failed initial connect, the bridge now retries indefinitely until the connection is restored or `disconnect()` is called explicitly. [#ECONNRESET]

## 0.3.0

### Config changes
- **`autoJoinRoom` → `roomJid`** — Config field renamed; old `autoJoinRoom` key still read for backward compat
- **`autoConnect` flag** — Per-account boolean to auto-connect on startup (default: `false`). Previously the default account was always auto-connected; now only accounts with `"autoConnect": true` are.
- **`getAutoConnect()`** — Now respects the per-account `autoConnect` field instead of always returning `true`.

### Prompt & routing improvements
- **Dynamic XMPP turn context** — System prompt now injects account name, groupchat vs DM awareness (⚠️ everyone sees replies vs 💬 private), room JID, and sender nick per turn.
- **Improved local prompt** — TUI/CLI agents are now told they *can* use `xmpp_send` to notify users or forward results.
- **Command responses routed through XMPP** — Slash command responses (`/xmpp-status`, `/xmpp-connect`, etc.) are now sent back through XMPP to the original sender, not just to Pi's local session.
- **Auto-routing of agent responses** — If the agent forgets to call `xmpp_send`, the bridge automatically sends the text response via XMPP using the account that received the message.
- **Tool result includes confirmation** — `xmpp_send` now shows `📤 Message sent to ...` in the local chat.
- **Tool + prompt guidance** — Agent is told to not produce extra text after calling `xmpp_send`.

### Multi-instance safety
- **Auto-connect instance lock** — Uses per-account atomic `mkdir` filesystem locks at `~/.pi/agent/xmpp-auto-connect.lock/{accountName}/`. Different Pi instances can auto-connect different accounts simultaneously. Manual `/xmpp-connect` bypasses the lock.
- **Self-message echo suppression** — DM echoes (from matching bare JID) and groupchat echoes (from recently sent body cache) are filtered out to prevent loops.

### Notifications
- **Connect greeting** — Auto-connect sends `✅ XMPP bridge connected and ready` as a DM to the account's `ownerJid`.
- **Local TUI notifications** — Auto-connect success/failure, auto-connect skipped (lock held), and auto-routed responses all show as `ctx.ui.notify()` notifications in the Pi TUI.
- **Runtime events** — `auto-connect-success`, `auto-connect-skipped` events added for diagnostics via `/xmpp-status`.

## 0.2.0

- **Multi-account config** — Config file now uses keyed-object format (`"default": {...}, "name": {...}`) instead of flat single-account format
- **Simultaneous connections** — `/xmpp-connect` can be called multiple times; accounts stay connected concurrently. Each account gets its own XMPP client.
- **`/xmpp-disconnect [account-name]`** — Without args disconnects all accounts. With an account name, disconnects only that one.
- **`/xmpp-connect` without args** — Connects the `"default"` account from config
- **`/xmpp-connect account-name --jid ... --password ...`** — Creates a new account entry and persists it. Never overwrites existing accounts.
- **`ownerJid` field** — Replaces `allowedJid`. Controls authorization per account. No backward-compat aliases.
- **`autoJoinRoom` field** — Changed from array `autoJoinRooms` to a single room JID string.
- **Groupchat authorization** — When `ownerJid` is unset, all room participants can send commands. When set, only the owner's messages are processed.
- **DM auto-pairing** — First DM sender becomes owner when no `ownerJid` is configured.
- **`/xmpp-status`** — Now shows all active connections with status icons (🟢🟡🔴), account names, JIDs, joined MUC rooms with occupant counts, and recent runtime events for debugging.
- **Room occupant tracking** — The bridge tracks MUC room occupants via presence stanzas and displays counts in `/xmpp-status`.
- **Initial presence** — Bridge now sends `<presence/>` on connect so the server routes messages (fixes silent message delivery failure).
- **Dispatch retry** — When Pi's agent is busy, queued messages are re-queued instead of dropped.
- **Agent prompt** — XMPP turn system prompt now explicitly tells the agent to use `xmpp_send` for replies.
- **Auth debug logging** — Incoming messages and authorization decisions logged to runtime events, visible in `/xmpp-status`.
- **Config auto-load** — Config file is read from disk before accessing accounts in both auto-connect and `/xmpp-connect`.
- **Unified terminology** — All user-facing "profile" renamed to "account" for consistency.
- **Version display** — Bridge version shown in `/xmpp-status` output.
- **`/xmpp-join` / `/xmpp-leave`** — Accept `--account` flag to target a specific connection.
- **`/xmpp-set-presence`** — Updates presence on all connected accounts.
- **`xmpp_send` tool** — Replies through the account that received the current turn.
- **README** — Added privacy-first notice, three modes of operation table, multi-account examples, and authorization docs.
- **Code cleanup** — Removed all `@deprecated` aliases and legacy `allowedJid` references.

## 0.1.0

- Initial release
- XMPP connection management (connect/disconnect/auto-reconnect)
- Direct message send/receive
- MUC/groupchat support (join/leave/participate)
- Presence management
- Authorization and auto-pairing
- Slash commands (/xmpp-connect, /xmpp-disconnect, /xmpp-status, /xmpp-join, /xmpp-leave, /xmpp-set-presence)
- Programmatic inbound/outbound handler API
- Companion extension API (status providers, commands, update handlers)
- Configuration via ~/.pi/agent/xmpp.json
- Auto-join rooms on connect
