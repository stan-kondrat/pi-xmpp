/**
 * XMPP bridge extension entrypoint and orchestration layer
 * Zones: xmpp, pi agent, orchestration
 * Keeps the runtime wiring in one place while delegating reusable domain logic to /lib modules
 */

import * as Pi from "./lib/pi.ts";
import * as Commands from "./lib/commands.ts";
import * as Config from "./lib/config.ts";
import * as Inbound from "./lib/inbound.ts";
import * as Lifecycle from "./lib/lifecycle.ts";
import * as Outbound from "./lib/outbound.ts";
import * as Prompts from "./lib/prompts.ts";
import * as Queue from "./lib/queue.ts";
import * as Routing from "./lib/routing.ts";
import * as Runtime from "./lib/runtime.ts";
import * as Status from "./lib/status.ts";
import * as XmppApi from "./lib/xmpp-api.ts";
import type { XmppConnectionStatus } from "./lib/xmpp-api.ts";
import { Type } from "@sinclair/typebox";
import * as Updates from "./api/updates.ts";

// ── Client Manager ──

interface ManagedClient {
  client: XmppApi.XmppClientInstance;
  accountName: string;
}

function createXmppClientManager(
  onStanza: (accountName: string, stanza: XmppApi.XmppStanza) => void,
  recordRuntimeEvent: (category: string, error: unknown, details?: Record<string, unknown>) => void,
) {
  const clients = new Map<string, ManagedClient>();
  // Track joined rooms per account: account → Map<roomJid, Set<occupantBareJid>>
  const joinedRooms = new Map<string, Map<string, Set<string>>>();

  async function connectAccount(name: string, config: Config.XmppAccountConfig): Promise<void> {
    // Disconnect existing client for this name if any
    const existing = clients.get(name);
    if (existing) {
      await existing.client.disconnect();
    }

    const client = XmppApi.createXmppClient();

    // Track joined rooms for this account
    if (!joinedRooms.has(name)) {
      joinedRooms.set(name, new Map());
    }
    const rooms = joinedRooms.get(name)!;

    // Wire stanza handler scoped to this account — also tracks room occupants
    client.onStanza((stanza) => {
      // Track MUC presence for occupant counting
      if (stanza.name === "presence" && stanza.attrs.from) {
        const fromBare = Routing.getBareJid(stanza.attrs.from);
        if (rooms.has(fromBare)) {
          if (stanza.attrs.type === "unavailable") {
            rooms.get(fromBare)!.delete(stanza.attrs.from);
          } else {
            rooms.get(fromBare)!.add(stanza.attrs.from);
          }
        }
      }
      onStanza(name, stanza);
    });

    // Wire error logging
    client.onError((error) => {
      recordRuntimeEvent("xmpp-error", error, { account: name });
    });

    clients.set(name, { client, accountName: name });

    // Build connect config
    const connectConfig: Config.XmppAccountConfig = {
      jid: config.jid,
      password: config.password,
      service: config.service,
      domain: config.domain,
      autoReconnect: config.autoReconnect,
    };

    await client.connect(connectConfig);

    // Auto-join room — use joinRoomOnAccount to initialize occupant tracking
    if (config.autoJoinRoom) {
      const nick = config.jid?.split("@")[0] ?? "pi";
      joinRoomOnAccount(name, config.autoJoinRoom, nick);
    }
  }

  async function disconnectAccount(name?: string): Promise<void> {
    if (name) {
      const entry = clients.get(name);
      if (entry) {
        await entry.client.disconnect();
        clients.delete(name);
      }
      joinedRooms.delete(name);
    } else {
      for (const [, entry] of clients) {
        await entry.client.disconnect();
      }
      clients.clear();
      joinedRooms.clear();
    }
  }

  function getConnectedAccounts(): string[] {
    return Array.from(clients.keys());
  }

  function getClientJid(name: string): string | undefined {
    return clients.get(name)?.client.jid;
  }

  function getClientStatus(name: string): XmppConnectionStatus {
    return clients.get(name)?.client.status ?? "offline";
  }

  function getConnectedStatuses(): Array<{ name: string; status: XmppConnectionStatus; jid?: string }> {
    const result: Array<{ name: string; status: XmppConnectionStatus; jid?: string }> = [];
    for (const [name, entry] of clients) {
      result.push({ name, status: entry.client.status, jid: entry.client.jid });
    }
    return result;
  }

  function joinRoomOnAccount(name: string, room: string, nick: string): void {
    clients.get(name)?.client.joinRoom(room, nick);
    // Initialize occupant tracking for this room
    if (!joinedRooms.has(name)) {
      joinedRooms.set(name, new Map());
    }
    if (!joinedRooms.get(name)!.has(room)) {
      joinedRooms.get(name)!.set(room, new Set());
    }
  }

  function leaveRoomOnAccount(name: string, room: string): void {
    clients.get(name)?.client.leaveRoom(room);
    // Clean up occupant tracking
    joinedRooms.get(name)?.delete(room);
  }

  function sendPresenceOnAccount(name: string, options?: { show?: string; status?: string; type?: string; to?: string }): void {
    clients.get(name)?.client.sendPresence(options);
  }

  function getClientForTurn(accountName?: string): XmppApi.XmppClientInstance | undefined {
    if (accountName) return clients.get(accountName)?.client;
    // Fall back to first connected
    const first = clients.values().next().value;
    return first?.client;
  }

  function getJoinedRooms(name: string): Array<{ room: string; occupants: number }> {
    const rooms = joinedRooms.get(name);
    if (!rooms) return [];
    const result: Array<{ room: string; occupants: number }> = [];
    for (const [room, occupants] of rooms) {
      result.push({ room, occupants: occupants.size });
    }
    return result;
  }

  function getStatusDetail(name: string): { jid?: string; status: XmppConnectionStatus; rooms: Array<{ room: string; occupants: number }> } {
    const entry = clients.get(name);
    return {
      jid: entry?.client.jid,
      status: entry?.client.status ?? "offline",
      rooms: getJoinedRooms(name),
    };
  }

  return {
    connectAccount,
    disconnectAccount,
    getConnectedAccounts,
    getClientJid,
    getClientStatus,
    getConnectedStatuses,
    joinRoomOnAccount,
    leaveRoomOnAccount,
    sendPresenceOnAccount,
    getClientForTurn,
    getJoinedRooms,
    getStatusDetail,
  };
}

// ── Extension Runtime ──

export default function (pi: Pi.ExtensionAPI) {
  const piRuntime = Pi.createExtensionApiRuntimePorts(pi);
  const { sendUserMessage } = piRuntime;

  // --- Instance identity ---
  const xmppInstanceId = `${process.pid}:${Date.now()}`;

  // --- Runtime ---
  const bridgeRuntime = Runtime.createXmppBridgeRuntime();
  const { abort, lifecycle, queue } = bridgeRuntime;

  // --- Config ---
  const runtimeEvents = Status.createXmppRuntimeEventRecorder();
  const configStore = Config.createXmppConfigStore({ recordRuntimeEvent: runtimeEvents.record });
  Outbound.bindXmppRuntimeEventRecorder(runtimeEvents.record);

  const recordRuntimeEvent = function (
    category: string,
    error: unknown,
    details?: Record<string, unknown>,
  ) {
    runtimeEvents.record(category, error ?? undefined, details);
  };

  const getRuntimeEvents = () => runtimeEvents.getEvents();

  // --- Context store ---
  const sessionContextStore = Lifecycle.createXmppSessionContextStore<Pi.ExtensionContext>();

  // --- Active turn store ---
  const activeTurnRuntime = Queue.createXmppActiveTurnStore();

  // --- Queue store ---
  const xmppQueueStore = Queue.createXmppQueueStore<Pi.ExtensionContext>();

  // --- Status helpers ---
  const getOwnerJid = () => configStore.getOwnerJid();

  const sendMessageToActiveTurn = async function (body: string): Promise<void> {
    sendUserMessage(body);
  };

  // --- Create client manager ---
  const clientManager = createXmppClientManager(
    (accountName, stanza) => {
      handleIncomingStanza(accountName, stanza);
    },
    recordRuntimeEvent,
  );

  // --- Incoming stanza handler ---
  const handleIncomingStanza = async function (accountName: string, stanza: XmppApi.XmppStanza): Promise<void> {
    // Run through update handlers first
    const updateHandlers = Updates.getXmppUpdateHandlers();
    for (const handler of updateHandlers) {
      try {
        const verdict = await handler(stanza);
        if (verdict.handled) return;
      } catch {
        // Continue to next handler
      }
    }

    // Route the stanza
    const route = Routing.routeStanza(stanza);
    if (!route) return;

    if (route.kind === "message") {
      recordRuntimeEvent("incoming-msg", null, {
        account: accountName,
        fromBare: route.fromBare,
        type: route.type,
        preview: route.body.slice(0, 60),
      });
      await handleIncomingMessage(accountName, route);
    } else if (route.kind === "presence") {
      await handleIncomingPresence(route);
    }
  };

  // --- Incoming message handler ---
  const handleIncomingMessage = async function (accountName: string, route: Routing.XmppMessageRoute): Promise<void> {
    // Skip error messages
    if (route.type === "error") return;

    // Get the account's config for auth
    const accountConfig = configStore.getAccountByName(accountName);
    const ownerJid = accountConfig?.ownerJid;

    recordRuntimeEvent("auth-check", null, {
      account: accountName,
      fromBare: route.fromBare,
      ownerJid: ownerJid ?? "(none)",
      isGroup: String(route.isGroup),
    });

    if (route.isGroup) {
      // In groupchats: if no owner is configured, anyone can participate.
      // If an owner is configured, only their messages are processed.
      if (ownerJid && route.fromBare !== ownerJid) {
        recordRuntimeEvent("auth-deny", null, { account: accountName, fromBare: route.fromBare, reason: "not owner in groupchat" });
        return;
      }
    } else {
      // Direct messages: use pairing/allow/deny
      const auth = Config.getXmppAuthorizationState(
        route.fromBare,
        ownerJid,
      );

      if (auth.kind === "deny") {
        recordRuntimeEvent("auth-deny", null, { account: accountName, fromBare: route.fromBare });
        return;
      }

      // Auto-pair if needed (first DM sender becomes owner)
      if (auth.kind === "pair") {
        recordRuntimeEvent("auth-pair", null, { account: accountName, fromBare: route.fromBare });
        if (accountConfig) {
          accountConfig.ownerJid = route.fromBare;
          configStore.setActiveAccount(accountName);
          configStore.set(accountConfig);
          await configStore.persist();
        }
        recordRuntimeEvent("pair", null, { account: accountName, jid: route.fromBare });
      }
    }

    // Process through inbound handler pipeline
    const config = accountConfig ?? {};
    const inboundResult = await Inbound.processXmppInbound(route, config, ownerJid);

    // Build turn context
    const turn: Queue.XmppTurnContext = {
      from: route.from,
      fromBare: route.fromBare,
      body: inboundResult.rawText,
      type: route.type,
      thread: route.thread,
      subject: route.subject,
      isGroup: route.isGroup,
      roomJid: route.roomJid,
      senderNick: route.senderNick,
      accountName,
      timestamp: Date.now(),
    };

    // Build prompt
    const prompt = Queue.buildXmppTurnPrompt(turn, {
      includeThread: true,
      extraContext: inboundResult.handlerOutputs.length > 0
        ? `handler outputs: ${inboundResult.handlerOutputs.join("; ")}`
        : undefined,
    });

    // Enqueue the message
    const ctx = sessionContextStore.get();
    if (ctx) {
      const item: Queue.XmppQueueItem<Pi.ExtensionContext> = {
        id: `xmpp-${queue.allocateItemOrder()}-${Date.now()}`,
        order: queue.allocateItemOrder(),
        turn,
        prompt,
        ctx,
        status: "queued",
      };

      xmppQueueStore.enqueue(item);
      dispatchNextQueuedTurn();
    }
  };

  // --- Incoming presence handler ---
  const handleIncomingPresence = async function (
    route: Routing.XmppPresenceRoute,
  ): Promise<void> {
    recordRuntimeEvent("presence", null, {
      from: route.from,
      type: route.type,
      show: route.show,
    });
  };

  // --- Dispatch next queued turn ---
  const dispatchNextQueuedTurn = function (): void {
    if (bridgeRuntime.state.xmppTurnDispatchPending) return;
    if (bridgeRuntime.state.compactionInProgress) return;
    if (activeTurnRuntime.has()) return;

    const next = xmppQueueStore.dequeue();
    if (!next) return;

    bridgeRuntime.state.xmppTurnDispatchPending = true;
    activeTurnRuntime.set(next.turn);

    const ctx = next.ctx;

    // Set abort handler
    const abortController = new AbortController();
    abort.setHandler(() => {
      abortController.abort();
      activeTurnRuntime.clear();
      bridgeRuntime.state.xmppTurnDispatchPending = false;
    });

    try {
      sendUserMessage(next.prompt);
    } catch (error: unknown) {
      recordRuntimeEvent("dispatch", error);
      activeTurnRuntime.clear();
      bridgeRuntime.state.xmppTurnDispatchPending = false;
      abort.clearHandler();
    }
  };

  // --- Register slash commands ---
  const allCommands = Commands.createXmppSlashCommands({
    configStore,
    runtime: bridgeRuntime,
    sendMessageToActiveTurn,
    updateStatus: () => {},
    getOwnerJid,
    connectAccount: clientManager.connectAccount,
    disconnectAccount: clientManager.disconnectAccount,
    getConnectedAccounts: clientManager.getConnectedAccounts,
    getClientJid: clientManager.getClientJid,
    getClientStatus: clientManager.getClientStatus,
    getConnectedStatuses: clientManager.getConnectedStatuses,
    getJoinedRooms: clientManager.getJoinedRooms,
    getStatusDetail: clientManager.getStatusDetail,
    joinRoomOnAccount: clientManager.joinRoomOnAccount,
    leaveRoomOnAccount: clientManager.leaveRoomOnAccount,
    sendPresenceOnAccount: clientManager.sendPresenceOnAccount,
    getRuntimeEvents,
  });

  for (const cmd of allCommands) {
    pi.registerCommand(cmd.name, {
      description: cmd.description,
      handler: async (_args: string, _ctx: Pi.ExtensionCommandContext) => {
        await cmd.handler({ args: [], rawArgs: _args });
      },
    });
  }

  // --- Register the xmpp_send tool ---
  pi.registerTool({
    name: "xmpp_send",
    label: "Send XMPP Message",
    description:
      "Send a message via XMPP. Provide `to` (JID), `body` (message text), and optionally `type` (chat or groupchat). Replies go through the account that received the current turn.",
    parameters: Type.Object({
      to: Type.String({ description: "Recipient JID" }),
      body: Type.String({ description: "Message body" }),
      type: Type.Optional(Type.String({ description: "Message type (default: chat)" })),
      subject: Type.Optional(Type.String({ description: "Optional message subject" })),
    }),
    execute: async (_toolCallId: string, params: { to: string; body: string; type?: string; subject?: string }) => {
      const turn = activeTurnRuntime.get();
      // Use the client for the account that received the current turn, or fall back to first connected
      const client = turn?.accountName
        ? clientManager.getClientForTurn(turn.accountName)
        : clientManager.getClientForTurn();

      if (!client) {
        return {
          content: [{ type: "text" as const, text: "No XMPP account connected. Use /xmpp-connect first." }],
          isError: true,
          details: {},
        };
      }

      try {
        await Outbound.sendXmppMessage(client, params.to, params.body, {
          type: params.type,
          subject: params.subject,
        });
        return {
          content: [{ type: "text" as const, text: `Message sent to ${params.to}` }],
          details: {},
        };
      } catch (error: unknown) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to send message: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
          details: {},
        };
      }
    },
  });

  // --- Register the xmpp_help tool ---
  Prompts.registerXmppHelpTool(pi);

  // --- Lifecycle hooks ---
  const beforeAgentStartHook = Prompts.createXmppBeforeAgentStartHook();

  Lifecycle.registerXmppLifecycleHooks(pi, {
    onSessionStart: async (_event, ctx) => {
      sessionContextStore.set(ctx);

      // Load config from disk before accessing accounts
      await configStore.load();

      // Auto-connect the default account
      const defaultAccount = configStore.getDefaultAccount();
      if (defaultAccount?.jid && defaultAccount?.password) {
        const name = defaultAccount.name ?? "default";
        try {
          await clientManager.connectAccount(name, defaultAccount);
        } catch (error) {
          recordRuntimeEvent("auto-connect", error, { account: name });
        }
      }
    },

    onSessionShutdown: async () => {
      await clientManager.disconnectAccount();
      sessionContextStore.clear();
    },

    onBeforeAgentStart: async (event) => {
      return beforeAgentStartHook(event);
    },

    onAgentStart: async () => {
      // Agent started processing
    },

    onAgentEnd: async () => {
      activeTurnRuntime.clear();
      bridgeRuntime.state.xmppTurnDispatchPending = false;
      abort.clearHandler();
      dispatchNextQueuedTurn();
    },
  });

  // --- Record extension start ---
  recordRuntimeEvent("extension-start", null, {
    instanceId: xmppInstanceId,
    pid: process.pid,
  });
}
