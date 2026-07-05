# Changelog

## 0.2.0 (unreleased)

- **Multi-account config** — Config file now uses keyed-object format (`"default": {...}, "name": {...}`) instead of flat single-account format
- **Simultaneous connections** — `/xmpp-connect` can be called multiple times; accounts stay connected concurrently. Each account gets its own XMPP client.
- **`/xmpp-disconnect [account-name]`** — Without args disconnects all accounts. With an account name, disconnects only that one.
- **`/xmpp-connect` without args** — Connects the `"default"` account from config
- **`/xmpp-connect account-name --jid ... --password ...`** — Creates a new account entry and persists it. Never overwrites existing accounts.
- **`ownerJid` field** — Replaces `allowedJid`. Controls authorization per account. No backward-compat aliases.
- **`autoJoinRoom` field** — Changed from array `autoJoinRooms` to a single room JID string.
- **Groupchat authorization** — When `ownerJid` is unset, all room participants can send commands. When set, only the owner's messages are processed.
- **DM auto-pairing** — First DM sender becomes owner when no `ownerJid` is configured.
- **`/xmpp-status`** — Now shows all active connections with status icons (🟢🟡🔴), account names, and JIDs.
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
