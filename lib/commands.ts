/**
 * XMPP extension slash commands
 * Zones: pi agent commands, xmpp specific
 * Owns /xmpp slash commands for connection management, status, and control
 */

import type { ExtensionAPI } from "./pi.ts";
import type { XmppClientInstance, XmppConnectionStatus } from "./xmpp-api.ts";
import type { XmppConfig, XmppConfigStore } from "./config.ts";
import type { XmppBridgeRuntime } from "./runtime.ts";

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

export function createXmppSlashCommands(deps: {
  client: XmppClientInstance;
  configStore: XmppConfigStore;
  runtime: XmppBridgeRuntime;
  getConnectionStatus: () => string;
  sendMessageToActiveTurn: (body: string) => Promise<void>;
  updateStatus: () => void;
  getAllowedJid: () => string | undefined;
}) {
  return [
    {
      name: "xmpp-connect",
      description:
        "Connect the XMPP client to your server. Provide --jid, --password, and --service options.",
      handler: async (ctx: XmppExtensionCommandContext) => {
        const args = parseArgs(ctx.rawArgs);
        const jid = args.jid ?? args.J;
        const password = args.password ?? args.p;
        const service = args.service ?? args.s;
        const domain = args.domain ?? args.d;

        if (!jid || !password) {
          await deps.sendMessageToActiveTurn(
            "Usage: /xmpp-connect --jid user@domain.tld --password <your_password> [--service xmpp://server.tld] [--domain domain.tld]",
          );
          return;
        }

        const config = deps.configStore.get();
        config.jid = jid;
        config.password = password;
        config.service = service || config.service;
        config.domain = domain || config.domain;
        deps.configStore.set(config);
        await deps.configStore.persist();

        try {
          await deps.client.connect(config);
          deps.updateStatus();
          await deps.sendMessageToActiveTurn(
            `✅ Connected as ${jid}`,
          );
        } catch (error) {
          await deps.sendMessageToActiveTurn(
            `❌ Connection failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      },
    },
    {
      name: "xmpp-disconnect",
      description: "Disconnect the XMPP client.",
      handler: async () => {
        await deps.client.disconnect();
        deps.updateStatus();
        await deps.sendMessageToActiveTurn("🔌 Disconnected from XMPP server.");
      },
    },
    {
      name: "xmpp-status",
      description: "Show XMPP connection status and configuration info.",
      handler: async () => {
        const config = deps.configStore.get();
        const status = deps.client.status;
        const jid = deps.client.jid;
        const allowedJid = deps.getAllowedJid();

        const lines = [
          `**XMPP Bridge Status**`,
          ``,
          `**Connection:** ${status}`,
          `**JID:** ${jid ?? "not connected"}`,
          `**Configured JID:** ${config.jid ?? "not configured"}`,
          `**Service:** ${config.service ?? "auto"}`,
          `**Allowed JID:** ${allowedJid ?? "not paired"}`,
          `**Auto-reconnect:** ${config.autoReconnect ?? true}`,
        ];

        if (config.autoJoinRooms?.length) {
          lines.push(`**Auto-join rooms:** ${config.autoJoinRooms.join(", ")}`);
        }

        await deps.sendMessageToActiveTurn(lines.join("\n"));
      },
    },
    {
      name: "xmpp-join",
      description:
        "Join a MUC room. Usage: /xmpp-join --room room@conference.tld --nick your_nick",
      handler: async (ctx: XmppExtensionCommandContext) => {
        const args = parseArgs(ctx.rawArgs);
        const room = args.room ?? args.r;
        const nick = args.nick ?? args.n;

        if (!room) {
          await deps.sendMessageToActiveTurn(
            "Usage: /xmpp-join --room room@conference.tld [--nick your_nick]",
          );
          return;
        }

        const nickname = nick ?? deps.client.jid?.split("@")[0] ?? "pi";
        deps.client.joinRoom(room, nickname);

        const config = deps.configStore.get();
        const rooms = config.autoJoinRooms ?? [];
        if (!rooms.includes(room)) {
          rooms.push(room);
          config.autoJoinRooms = rooms;
          deps.configStore.set(config);
          await deps.configStore.persist();
        }

        await deps.sendMessageToActiveTurn(
          `🚪 Joined room ${room} as ${nickname}`,
        );
      },
    },
    {
      name: "xmpp-leave",
      description:
        "Leave a MUC room. Usage: /xmpp-leave --room room@conference.tld",
      handler: async (ctx: XmppExtensionCommandContext) => {
        const args = parseArgs(ctx.rawArgs);
        const room = args.room ?? args.r;

        if (!room) {
          await deps.sendMessageToActiveTurn(
            "Usage: /xmpp-leave --room room@conference.tld",
          );
          return;
        }

        deps.client.leaveRoom(room);

        const config = deps.configStore.get();
        if (config.autoJoinRooms) {
          config.autoJoinRooms = config.autoJoinRooms.filter(
            (r) => r !== room,
          );
          deps.configStore.set(config);
          await deps.configStore.persist();
        }

        await deps.sendMessageToActiveTurn(`🚪 Left room ${room}`);
      },
    },
    {
      name: "xmpp-set-presence",
      description:
        "Set your presence. Usage: /xmpp-set-presence [--show chat|away|dnd|xa] [--status message]",
      handler: async (ctx: XmppExtensionCommandContext) => {
        const args = parseArgs(ctx.rawArgs);
        const show = args.show ?? args.s;
        const status = args.status ?? args.m;

        deps.client.sendPresence({
          show: show || undefined,
          status: status || undefined,
        });

        await deps.sendMessageToActiveTurn(
          `🟢 Presence updated: ${show ?? "available"}${status ? ` (${status})` : ""}`,
        );
      },
    },
  ];
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
