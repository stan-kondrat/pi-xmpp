/**
 * XMPP extension slash commands
 * Zones: pi agent commands, xmpp specific
 * Owns /xmpp slash commands for connection management, status, and control
 */

import type { ExtensionAPI } from "./pi.ts";
import type { XmppConnectionStatus } from "./xmpp-api.ts";
import type { XmppAccountConfig, XmppConfigStore } from "./config.ts";
import type { XmppBridgeRuntime } from "./runtime.ts";
import type { XmppRuntimeEventEntry } from "./status.ts";
import { VERSION } from "./version.ts";

export interface XmppExtensionCommandContext {
  args: string[];
  rawArgs: string;
}

export interface XmppExtensionCommandRegistration {
  name: string;
  description: string;
  handler: (ctx: XmppExtensionCommandContext) => Promise<void>;
}

const COMMAND_REGISTRY_KEY = "__piXmppCommands__";

/**
 * Register an extension slash command.
 */
export function registerXmppCommand(
  registration: XmppExtensionCommandRegistration,
): void {
  const registry = getCommandRegistry();
  registry.push(registration);
}

function getCommandRegistry(): XmppExtensionCommandRegistration[] {
  const globals = globalThis as Record<string, unknown>;
  if (!globals[COMMAND_REGISTRY_KEY]) {
    globals[COMMAND_REGISTRY_KEY] = [];
  }
  return globals[COMMAND_REGISTRY_KEY] as XmppExtensionCommandRegistration[];
}

export interface XmppSlashCommandsDeps {
  configStore: XmppConfigStore;
  runtime: XmppBridgeRuntime;
  sendMessageToActiveTurn: (body: string) => Promise<void>;
  updateStatus: () => void;
  getOwnerJid: () => string | undefined;
  // Client manager
  connectAccount: (name: string, config: XmppAccountConfig) => Promise<void>;
  disconnectAccount: (name?: string) => Promise<void>;
  getConnectedAccounts: () => string[];
  getClientJid: (name: string) => string | undefined;
  getClientStatus: (name: string) => XmppConnectionStatus;
  getConnectedStatuses: () => Array<{ name: string; status: XmppConnectionStatus; jid?: string }>;
  getJoinedRooms: (name: string) => Array<{ room: string; occupants: number }>;
  getStatusDetail: (name: string) => { jid?: string; status: XmppConnectionStatus; rooms: Array<{ room: string; occupants: number }> };
  getRuntimeEvents: () => XmppRuntimeEventEntry[];
  joinRoomOnAccount: (name: string, room: string, nick: string) => void;
  leaveRoomOnAccount: (name: string, room: string) => void;
  sendPresenceOnAccount: (name: string, options?: { show?: string; status?: string; type?: string; to?: string }) => void;
}

export function createXmppSlashCommands(deps: XmppSlashCommandsDeps) {
  return [
    {
      name: "xmpp-connect",
      description:
        "Connect an account. No args = default account. `name` = existing account. `name --jid --password [...]` = create new account. Keeps other connections alive.",
      handler: async (ctx: XmppExtensionCommandContext) => {
        const rawTrimmed = ctx.rawArgs.trim();
        const args = parseArgs(ctx.rawArgs);
        const jid = args.jid ?? args.J;
        const password = args.password ?? args.p;
        const service = args.service ?? args.s;
        const domain = args.domain ?? args.d;
        const accountFlag = args.account ?? args.a;
        const ownerJid = args.ownerJid;
        const autoJoinRoom = args.autoJoinRoom;

        // First bareword that isn't a flag is treated as the account name
        const bareword = extractFirstBareword(rawTrimmed);
        const accountName = accountFlag ?? bareword;

        // ── No args → connect default ──
        if (!accountName && !jid && !password) {
          // Ensure config is loaded from disk
          await deps.configStore.load();
          const defaultAccount = deps.configStore.getDefaultAccount();
          if (!defaultAccount || (!defaultAccount.jid && !defaultAccount.password)) {
            await deps.sendMessageToActiveTurn(
              "❌ No default account configured.\n" +
              "Usage: /xmpp-connect                           (uses default from config)\n" +
              "       /xmpp-connect account-name                (existing account from config)\n" +
              "       /xmpp-connect account-name --jid ... --pw ...  (create new account)",
            );
            return;
          }
          const name = defaultAccount.name ?? "default";
          const config = { ...defaultAccount };
          try {
            await deps.connectAccount(name, config);
            deps.updateStatus();
            await deps.sendMessageToActiveTurn(`✅ Connected as ${name} (${config.jid})`);
          } catch (error) {
            await deps.sendMessageToActiveTurn(
              `❌ Connection failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
          return;
        }

        // ── account-name + --jid --password → create a NEW account ──
        if (accountName && jid && password) {
          const config: XmppAccountConfig = {
            name: accountName,
            jid,
            password,
            service: service || undefined,
            domain: domain || undefined,
            ownerJid: ownerJid || undefined,
            autoJoinRoom: autoJoinRoom || undefined,
          };
          deps.configStore.setActiveAccount(accountName);
          deps.configStore.set(config);
          await deps.configStore.persist();

          try {
            await deps.connectAccount(accountName, config);
            deps.updateStatus();
            await deps.sendMessageToActiveTurn(
              `✅ Connected as ${accountName} (${jid})${ownerJid ? ` — owner: ${ownerJid}` : ""}`,
            );
          } catch (error) {
            await deps.sendMessageToActiveTurn(
              `❌ Connection failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
          return;
        }

        // ── account-name only → connect existing account ──
        if (accountName && !jid) {
          const account = deps.configStore.getAccountByName(accountName);
          if (!account) {
            await deps.sendMessageToActiveTurn(
              `❌ Account "${accountName}" not found. Available: ${
                deps.configStore.getAccounts().map((a) => a.name).filter(Boolean).join(", ") || "(none)"
              }`,
            );
            return;
          }
          const config = { ...account };
          if (password) config.password = password;
          try {
            await deps.connectAccount(accountName, config);
            deps.updateStatus();
            await deps.sendMessageToActiveTurn(`✅ Connected as ${accountName}`);
          } catch (error) {
            await deps.sendMessageToActiveTurn(
              `❌ Connection failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
          return;
        }

        // ── fallback: show usage ──
        await deps.sendMessageToActiveTurn(
          "Usage: /xmpp-connect                           (uses default from config)\n" +
          "       /xmpp-connect account-name                (existing account from config)\n" +
          "       /xmpp-connect account-name --jid ... --pw ...  (create new account)",
        );
      },
    },
    {
      name: "xmpp-disconnect",
      description:
        "Disconnect. Without args, disconnects ALL accounts. With an account name, disconnects only that account.",
      handler: async (ctx: XmppExtensionCommandContext) => {
        const rawTrimmed = ctx.rawArgs.trim();
        const args = parseArgs(rawTrimmed);
        const accountName = args.account ?? args.a ?? extractFirstBareword(rawTrimmed);

        if (accountName) {
          await deps.disconnectAccount(accountName);
          deps.updateStatus();
          await deps.sendMessageToActiveTurn(`🔌 Disconnected ${accountName}.`);
        } else {
          await deps.disconnectAccount();
          deps.updateStatus();
          await deps.sendMessageToActiveTurn("🔌 Disconnected all accounts.");
        }
      },
    },
    {
      name: "xmpp-status",
      description: "Show XMPP connection status and diagnostics for all accounts.",
      handler: async () => {
        const connected = deps.getConnectedStatuses();
        const accounts = deps.configStore.getAccounts();
        const ownerJid = deps.getOwnerJid();
        const events = deps.getRuntimeEvents();

        const lines = [
          `**XMPP Bridge Status**`,
          `**Version:** ${VERSION}`,
          ``,
        ];

        if (connected.length === 0) {
          lines.push(`**No active connections.**`);
        }

        for (const c of connected) {
          const icon = c.status === "online" ? "🟢" : c.status === "connecting" ? "🟡" : "🔴";
          let line = `${icon} **${c.name}** — ${c.status}${c.jid ? ` (${c.jid})` : ""}`;

          // Show joined rooms with occupant counts
          const detail = deps.getStatusDetail(c.name);
          if (detail.rooms.length > 0) {
            const roomInfo = detail.rooms
              .map((r) => `${r.room} (${r.occupants} occupant${r.occupants === 1 ? "" : "s"})`)
              .join(", ");
            line += `\n   🚪 ${roomInfo}`;
          }

          lines.push(line);
        }

        lines.push(``);
        lines.push(`**Configured accounts:** ${accounts.length}`);
        const defaultAccount = deps.configStore.getDefaultAccount();
        if (defaultAccount?.name) {
          lines.push(`**Default:** ${defaultAccount.name}`);
        }
        lines.push(`**Owner JID:** ${ownerJid ?? "anyone (no restriction)"}`);

        // Show recent runtime events for debugging
        const denied = events.filter((e) => e.category === "auth-deny" || e.category === "auth-pair");
        if (denied.length > 0) {
          lines.push(``);
          lines.push(`**Recent auth events:**`);
          for (const e of denied.slice(-5)) {
            const time = new Date(e.timestamp).toLocaleTimeString();
            const jid = e.details?.fromBare ?? "";
            lines.push(`  [${time}] ${e.category}: ${jid}`);
          }
        }

        await deps.sendMessageToActiveTurn(lines.join("\n"));
      },
    },
    {
      name: "xmpp-join",
      description:
        "Join a MUC room on a connected account. Usage: /xmpp-join --room room@conference.tld [--nick your_nick] [--account account-name]",
      handler: async (ctx: XmppExtensionCommandContext) => {
        const args = parseArgs(ctx.rawArgs);
        const room = args.room ?? args.r;
        const nick = args.nick ?? args.n;
        const accountName = args.account ?? args.a ?? deps.getConnectedAccounts()[0];

        if (!room || !accountName) {
          await deps.sendMessageToActiveTurn(
            "Usage: /xmpp-join --room room@conference.tld [--nick your_nick] [--account account-name]",
          );
          return;
        }

        const jid = deps.getClientJid(accountName);
        const nickname = nick ?? jid?.split("@")[0] ?? "pi";
        deps.joinRoomOnAccount(accountName, room, nickname);

        // Save to the account's config
        const account = deps.configStore.getAccountByName(accountName);
        if (account && !account.autoJoinRoom) {
          account.autoJoinRoom = room;
          deps.configStore.setActiveAccount(accountName);
          deps.configStore.set(account);
          await deps.configStore.persist();
        }

        await deps.sendMessageToActiveTurn(
          `🚪 Joined room ${room} as ${nickname} on ${accountName}`,
        );
      },
    },
    {
      name: "xmpp-leave",
      description:
        "Leave a MUC room on a connected account. Usage: /xmpp-leave --room room@conference.tld [--account account-name]",
      handler: async (ctx: XmppExtensionCommandContext) => {
        const args = parseArgs(ctx.rawArgs);
        const room = args.room ?? args.r;
        const accountName = args.account ?? args.a ?? deps.getConnectedAccounts()[0];

        if (!room || !accountName) {
          await deps.sendMessageToActiveTurn(
            "Usage: /xmpp-leave --room room@conference.tld [--account account-name]",
          );
          return;
        }

        deps.leaveRoomOnAccount(accountName, room);

        // Clear from config if it's the auto-join room
        const account = deps.configStore.getAccountByName(accountName);
        if (account && account.autoJoinRoom === room) {
          delete account.autoJoinRoom;
          deps.configStore.setActiveAccount(accountName);
          deps.configStore.set(account);
          await deps.configStore.persist();
        }

        await deps.sendMessageToActiveTurn(`🚪 Left room ${room} on ${accountName}`);
      },
    },
    {
      name: "xmpp-set-presence",
      description:
        "Set presence on all connected accounts. Usage: /xmpp-set-presence [--show chat|away|dnd|xa] [--status message]",
      handler: async (ctx: XmppExtensionCommandContext) => {
        const args = parseArgs(ctx.rawArgs);
        const show = args.show ?? args.s;
        const status = args.status ?? args.m;
        const connected = deps.getConnectedAccounts();

        if (connected.length === 0) {
          await deps.sendMessageToActiveTurn("❌ No accounts connected.");
          return;
        }

        for (const name of connected) {
          deps.sendPresenceOnAccount(name, {
            show: show || undefined,
            status: status || undefined,
          });
        }

        await deps.sendMessageToActiveTurn(
          `🟢 Presence updated on ${connected.length} account(s): ${show ?? "available"}${status ? ` (${status})` : ""}`,
        );
      },
    },
  ];
}

function extractFirstBareword(raw: string): string | undefined {
  const tokens = raw.match(/(?:--?\w+(?:=\S+)?|"[^"]*"|'[^']*'|\S+)/g) ?? [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.startsWith("--")) {
      if (!t.includes("=")) i++;
    } else if (t.startsWith("-") && t.length === 2) {
      if (i + 1 < tokens.length && !tokens[i + 1].startsWith("-")) i++;
    } else {
      return t.replace(/^["']|["']$/g, "");
    }
  }
  return undefined;
}

function parseArgs(raw: string): Record<string, string> {
  const args: Record<string, string> = {};
  const tokens = raw.match(/(?:--?\w+(?:=\S+|\s+\S+)?|"[^"]*"|'[^']*'|\S+)/g) ?? [];
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    if (token.startsWith("--")) {
      const eqIdx = token.indexOf("=");
      if (eqIdx >= 0) {
        args[token.slice(2, eqIdx)] = token.slice(eqIdx + 1);
      } else {
        const key = token.slice(2);
        const next = tokens[i + 1];
        if (next && !next.startsWith("-")) {
          args[key] = next.replace(/^["']|["']$/g, "");
          i++;
        } else {
          args[key] = "true";
        }
      }
    } else if (token.startsWith("-") && token.length === 2) {
      const key = token.slice(1);
      const next = tokens[i + 1];
      if (next && !next.startsWith("-")) {
        args[key] = next.replace(/^["']|["']$/g, "");
        i++;
      } else {
        args[key] = "true";
      }
    }
    i++;
  }
  return args;
}
