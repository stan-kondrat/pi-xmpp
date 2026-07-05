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
