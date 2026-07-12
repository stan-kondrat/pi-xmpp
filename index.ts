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
import type { XmppConnectionStatus, ChatState } from "./lib/xmpp-api.ts";
import { Type } from "@sinclair/typebox";
import * as Updates from "./api/updates.ts";

// ── Text Templates ──
// prompts → returned as tool results, become LLM context
// uiMessages → notifications / XMPP wire strings, never reach LLM
import { DEFAULT_XMPP_PROMPTS, DEFAULT_XMPP_UI_MESSAGES } from "./lib/config.ts";

const {
  toolNoClient: TPL_TOOL_NO_CLIENT,
  toolSent: TPL_TOOL_SENT,
  toolSendFailed: TPL_TOOL_SEND_FAILED,
} = DEFAULT_XMPP_PROMPTS;

const {
  configLoadFailed: TPL_CONFIG_LOAD_FAILED,
  autoConnectSkipped: TPL_AUTO_CONNECT_SKIPPED,
  connectedOk: TPL_CONNECTED_OK,
  connectFailed: TPL_CONNECT_FAILED,
  greeting: TPL_GREETING,
  processingRequest: MSG_PROCESSING_REQUEST,
  stillWorking: MSG_STILL_WORKING,
  ready: MSG_READY,
  processing: TPL_PROCESSING,
  heartbeat: TPL_HEARTBEAT,
  responseSent: TPL_RESPONSE_SENT,
} = DEFAULT_XMPP_UI_MESSAGES;

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
  // Track real JIDs of room occupants from MUC presence (XEP-0045):
  // account → Map<roomJid, Map<nick, realJid>>
  const roomOccupantRealJids = new Map<string, Map<string, Map<string, string>>>();
  // Track recently sent message bodies per account to suppress groupchat echoes
  const sentMessageBodies = new Map<string, Set<string>>();
  const MAX_SENT_BODIES = 50;

  /**
   * Extract the real JID from a MUC presence stanza.
   * Non-anonymous rooms include <x xmlns='http://jabber.org/protocol/muc#user'>
   * with <item jid='user@domain.tld/resource'/>.
   */
  function extractMucRealJid(stanza: XmppApi.XmppStanza): string | undefined {
    const mucUserChild = (stanza.children ?? []).find(
      (c): c is XmppApi.XmppStanza =>
        typeof c === "object" && c !== null &&
        (c as XmppApi.XmppStanza).name === "x" &&
        (c as XmppApi.XmppStanza).attrs?.xmlns === "http://jabber.org/protocol/muc#user",
    );
    if (!mucUserChild) return undefined;
    const itemChild = (mucUserChild.children ?? []).find(
      (c): c is XmppApi.XmppStanza =>
        typeof c === "object" && c !== null &&
        (c as XmppApi.XmppStanza).name === "item",
    );
    return itemChild?.attrs?.jid;
  }

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
      // Skip echo of our own messages
      if (stanza.name === "message") {
        const ourBare = client.jid ? Routing.getBareJid(client.jid) : undefined;

        // DM echo: from matches our own bare JID
        if (ourBare && stanza.attrs.from && Routing.getBareJid(stanza.attrs.from) === ourBare) {
          return;
        }

        // Groupchat echo: body matches a recently sent message
        if (stanza.attrs.from) {
          const bodyChild = (stanza.children ?? []).find(
            (c): c is XmppApi.XmppStanza =>
              typeof c === "object" && c !== null && (c as XmppApi.XmppStanza).name === "body",
          );
          if (bodyChild) {
            const bodyText = bodyChild.children.find((c) => typeof c === "string");
            if (typeof bodyText === "string") {
              const bodies = sentMessageBodies.get(name);
              if (bodies && bodies.has(bodyText)) {
                return; // groupchat echo of our own message
              }
            }
          }
        }
      }

      // Track MUC presence for occupant counting and real JID extraction
      if (stanza.name === "presence" && stanza.attrs.from) {
        const fromBare = Routing.getBareJid(stanza.attrs.from);
        if (rooms.has(fromBare)) {
          const nick = Routing.extractMucNick(stanza.attrs.from);
          if (stanza.attrs.type === "unavailable") {
            rooms.get(fromBare)!.delete(stanza.attrs.from);
            // Also clean up real JID tracking
            if (nick) {
              const realJids = roomOccupantRealJids.get(name);
              realJids?.get(fromBare)?.delete(nick);
            }
          } else {
            rooms.get(fromBare)!.add(stanza.attrs.from);
            // Extract and store real JID from MUC presence (XEP-0045)
            const realJid = extractMucRealJid(stanza);
            if (realJid && nick) {
              if (!roomOccupantRealJids.has(name)) {
                roomOccupantRealJids.set(name, new Map());
              }
              const accountRealJids = roomOccupantRealJids.get(name)!;
              if (!accountRealJids.has(fromBare)) {
                accountRealJids.set(fromBare, new Map());
              }
              accountRealJids.get(fromBare)!.set(nick, realJid);
            }
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

    // Build connect config — reconnect is handled internally by the client
    const connectConfig: Config.XmppAccountConfig = {
      jid: config.jid,
      password: config.password,
      service: config.service,
      domain: config.domain,
    };

    await client.connect(connectConfig);

    // Auto-join room — use joinRoomOnAccount to initialize occupant tracking
    if (config.roomJid) {
      const nick = config.jid?.split("@")[0] ?? "pi";
      joinRoomOnAccount(name, config.roomJid, nick);
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
    roomOccupantRealJids.get(name)?.delete(room);
  }

  function sendPresenceOnAccount(name: string, options?: { show?: string; status?: string; type?: string; to?: string }): void {
    clients.get(name)?.client.sendPresence(options);
  }

  async function sendChatStateToAccount(name: string, to: string, state: ChatState): Promise<void> {
    const entry = clients.get(name);
    if (entry) {
      await XmppApi.sendChatState(entry.client, to, state);
    }
  }

  function sendPresenceToAll(options?: { show?: string; status?: string }): void {
    for (const [name] of clients) {
      clients.get(name)?.client.sendPresence(options);
    }
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

  function getRoomOccupantRealJid(accountName: string, roomJid: string, nick: string): string | undefined {
    return roomOccupantRealJids.get(accountName)?.get(roomJid)?.get(nick);
  }

  function getSentMessageBodies(accountName: string): Set<string> {
    let bodies = sentMessageBodies.get(accountName);
    if (!bodies) {
      bodies = new Set();
      sentMessageBodies.set(accountName, bodies);
    }
    // Evict old entries when limit is reached
    if (bodies.size >= MAX_SENT_BODIES) {
      const first = bodies.values().next().value;
      if (first !== undefined) bodies.delete(first);
    }
    return bodies;
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
    sendChatStateToAccount,
    sendPresenceToAll,
    getClientForTurn,
    getJoinedRooms,
    getStatusDetail,
    getSentMessageBodies,
    getRoomOccupantRealJid,
  };
}

// ── Helpers ──

/** Collapse whitespace and truncate a string for preview display. */
function sanitizePreview(text: string, maxLen: number): string {
  return text
    .replace(/\n/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLen);
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

  // Heartbeat timers for long-running agent turns
  const heartbeatTimers = new Map<string, ReturnType<typeof setTimeout>>();

  // Local notification function (set by command registration)
  let localNotify: ((body: string, type?: "info" | "warning" | "error") => void) | undefined;

  const sendMessageToActiveTurn = async function (body: string): Promise<void> {
    const turn = activeTurnRuntime.get();
    // If there's an active XMPP turn, reply through XMPP
    if (turn) {
      const client = turn.accountName
        ? clientManager.getClientForTurn(turn.accountName)
        : clientManager.getClientForTurn();
      if (client) {
        const to = turn.isGroup && turn.roomJid ? turn.roomJid : turn.fromBare;
        const type = turn.isGroup ? "groupchat" : "chat";
        // Track sent body so groupchat echo suppression works
        if (turn.accountName) {
          const bodies = clientManager.getSentMessageBodies(turn.accountName);
          bodies.add(body);
        }
        await Outbound.sendXmppMessage(client, to, body, { type });
        return;
      }
    }
    // No active XMPP turn → show as local notification (no new agent turn)
    if (localNotify) {
      localNotify(body, "info");
    }
  };

  // --- Create client manager ---
  const clientManager = createXmppClientManager(
    (accountName, stanza) => {
      handleIncomingStanza(accountName, stanza);
    },
    recordRuntimeEvent,
  );

  // --- Bot command handler (runs after auth, before LLM) ---

  async function handleBotCommand(
    accountName: string,
    route: Routing.XmppMessageRoute,
    accountConfig: Config.XmppAccountConfig | undefined,
  ): Promise<boolean> {
    const body = route.body.trim();
    if (!body.startsWith("!")) return false;

    const compactRe = /^\s*!compact\b/i;
    const modelsRe = /^\s*!models\b/i;
    const modelRe = /^\s*!model\s+(\S+)/i;
    const helpRe = /^\s*!help\b/i;

    // Resolve templates for this account
    const ui = configStore.getResolvedUiMessages(accountName);

    // Get the XMPP client to send reply
    const client = clientManager.getClientForTurn(accountName);
    if (!client) return false;

    const to = route.isGroup && route.roomJid ? route.roomJid : route.fromBare;
    const type = route.isGroup ? "groupchat" : "chat";

    // !compact — compact conversation history
    if (compactRe.test(body)) {
      recordRuntimeEvent("bot-command", null, { account: accountName, command: "compact" });
      const ctx = sessionContextStore.get();
      if (ctx) {
        ctx.compact();
      }
      await Outbound.sendXmppMessage(client, to, "✅ Conversation compacted.", { type });
      return true;
    }

    // !models — list available models
    if (modelsRe.test(body)) {
      recordRuntimeEvent("bot-command", null, { account: accountName, command: "models" });
      const ctx = sessionContextStore.get();
      let modelInfo = "Available models:\n";
      if (ctx?.model) {
        modelInfo += `  Current: ${ctx.model.provider}/${ctx.model.id}\n`;
      }
      // Try to list enabled models from settings
      try {
        const { createSettingsManager, getExtensionContextCwd } = await import("./lib/pi.ts");
        const cwd = ctx ? getExtensionContextCwd(ctx) : process.cwd();
        const settings = createSettingsManager(cwd);
        const enabled = settings.getEnabledModels();
        if (enabled && enabled.length > 0) {
          modelInfo += `  Enabled patterns: ${enabled.join(", ")}`;
        } else {
          modelInfo += "  (no model filter — all configured models available)";
        }
      } catch {
        modelInfo += "  (could not query model list)";
      }
      await Outbound.sendXmppMessage(client, to, modelInfo, { type });
      return true;
    }

    // !model <id> — switch model
    const modelMatch = modelRe.exec(body);
    if (modelMatch) {
      recordRuntimeEvent("bot-command", null, { account: accountName, command: "model", args: modelMatch[1] });
      const modelArg = modelMatch[1];
      // Support provider/model format
      let provider = "default";
      let modelId = modelArg;
      if (modelArg.includes("/")) {
        const parts = modelArg.split("/", 2);
        provider = parts[0];
        modelId = parts[1];
      }
      try {
        const success = await piRuntime.setModel({ provider, id: modelId } as any);
        if (success) {
          await Outbound.sendXmppMessage(client, to, `✅ Model switched to ${provider}/${modelId}`, { type });
        } else {
          await Outbound.sendXmppMessage(client, to, `❌ No API key available for ${provider}/${modelId}`, { type });
        }
      } catch (error: unknown) {
        const errMsg = error instanceof Error ? error.message : String(error);
        await Outbound.sendXmppMessage(client, to, `❌ Failed to switch model: ${errMsg}`, { type });
      }
      return true;
    }

    // !help — show available commands
    if (helpRe.test(body)) {
      recordRuntimeEvent("bot-command", null, { account: accountName, command: "help" });
      await Outbound.sendXmppMessage(client, to, ui.commandsHelp, { type });
      return true;
    }

    return false;
  }

  // --- Incoming stanza handler ---
  const handleIncomingStanza = async function (accountName: string, stanza: XmppApi.XmppStanza): Promise<void> {
    // Debug: log message stanzas to confirm delivery
    if (stanza.name === "message") {
      recordRuntimeEvent("raw-stanza", null, {
        account: accountName,
        type: stanza.attrs.type ?? "",
        from: (stanza.attrs.from ?? "").slice(0, 60),
      });
    }

    // Run through update handlers first
    const updateHandlers = Updates.getXmppUpdateHandlers();
    for (const handler of updateHandlers) {
      try {
        const verdict = await handler(stanza);
        if (verdict.handled) return;
      } catch (err) {
        recordRuntimeEvent("update-handler-error", err, {
          account: accountName,
          stanzaName: stanza.name,
          from: (stanza.attrs.from ?? "").slice(0, 60),
        });
      }
    }

    // ── XEP-0184 / XEP-0333: Handle delivery receipts and chat markers ──
    if (stanza.name === "message" && stanza.attrs.from) {
      const fromBare = Routing.getBareJid(stanza.attrs.from);
      const client = clientManager.getClientForTurn(accountName);

      // If this IS a delivery receipt from the remote party (has <received>), log and drop
      if (XmppApi.isDeliveryReceipt(stanza)) {
        const receivedId = XmppApi.getReceivedId(stanza);
        recordRuntimeEvent("delivery-receipt", null, {
          from: fromBare,
          msgId: receivedId ?? "(unknown)",
        });
        return;
      }

      // If this IS a chat marker from the remote party, log and drop
      if (XmppApi.hasChatMarker(stanza) && !XmppApi.getMessageBody(stanza)) {
        const marker = XmppApi.getChatMarker(stanza);
        recordRuntimeEvent("chat-marker", null, {
          from: fromBare,
          marker: marker?.marker ?? "unknown",
          id: marker?.id,
        });
        return;
      }

      // Message has a body + (optionally) receipt request and/or markable
      const hasBody = !!XmppApi.getMessageBody(stanza);

      // XEP-0184: Send delivery receipt if requested (on any message with an id)
      if (hasBody && XmppApi.hasDeliveryReceiptRequest(stanza) && stanza.attrs.id && client) {
        recordRuntimeEvent("send-receipt", null, { from: fromBare, msgId: stanza.attrs.id });
        XmppApi.sendDeliveryReceipt(client, fromBare, stanza.attrs.id).catch(() => {});
      }

      // XEP-0333: Send "displayed" marker if message is markable and has a body
      if (hasBody && XmppApi.hasMarkable(stanza) && stanza.attrs.id && client) {
        recordRuntimeEvent("send-marker", null, { from: fromBare, marker: "displayed", msgId: stanza.attrs.id });
        XmppApi.sendChatMarker(client, fromBare, "displayed", stanza.attrs.id).catch(() => {});
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
      // The sender's identity is verified via their real JID extracted from
      // MUC presence (XEP-0045) in non-anonymous rooms.
      if (ownerJid) {
        let senderRealJid: string | undefined;
        if (route.roomJid && route.senderNick) {
          senderRealJid = clientManager.getRoomOccupantRealJid(accountName, route.roomJid, route.senderNick);
        }
        if (!senderRealJid) {
          // Could not resolve sender's real JID (anonymous room, or presence
          // not yet received). Deny to be safe; the owner can still be reached
          // via DM.
          recordRuntimeEvent("auth-deny", null, {
            account: accountName,
            roomJid: route.roomJid,
            senderNick: route.senderNick,
            reason: "cannot resolve sender real JID",
          });
          return;
        }
        if (Routing.getBareJid(senderRealJid) !== ownerJid) {
          recordRuntimeEvent("auth-deny", null, {
            account: accountName,
            roomJid: route.roomJid,
            senderNick: route.senderNick,
            senderRealJid: senderRealJid,
            reason: "not owner in groupchat",
          });
          return;
        }
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

    // ── Bot commands (intercepted before LLM prompt) ──
    const handled = await handleBotCommand(accountName, route, accountConfig);
    if (handled) return;

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

    // Build prompt with resolved per-account template overrides
    const resolvedPrompts = configStore.getResolvedPrompts(accountName);
    const prompt = Queue.buildXmppTurnPrompt(turn, {
      includeThread: true,
      extraContext: inboundResult.handlerOutputs.length > 0
        ? `handler outputs: ${inboundResult.handlerOutputs.join("; ")}`
        : undefined,
      promptTemplates: resolvedPrompts,
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
  const dispatchNextQueuedTurn = async function (): Promise<void> {
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
      await sendUserMessage(next.prompt, { deliverAs: "followUp" });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      // If Pi is busy, re-queue the message for later dispatch
      if (msg.includes("already processing") || msg.includes("streamingBehavior")) {
        recordRuntimeEvent("dispatch-retry", null, { id: next.id, from: next.turn.fromBare });
        xmppQueueStore.enqueue(next); // put it back
        bridgeRuntime.state.xmppTurnDispatchPending = false;
        activeTurnRuntime.clear();
        abort.clearHandler();
        return;
      }
      recordRuntimeEvent("dispatch", error, { id: next.id });
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
        // Capture local notify for sendMessageToActiveTurn fallback
        localNotify = (body, type) => _ctx.ui.notify(body, type);
        try {
          await cmd.handler({ args: [], rawArgs: _args });
        } finally {
          localNotify = undefined;
        }
      },
    });
  }

  // --- Register the xmpp_send tool ---
  pi.registerTool({
    name: "xmpp_send",
    label: "Send XMPP Message",
    description:
      "Send a message via XMPP. Provide `to` (JID), `body` (message text), and optionally `type` (chat or groupchat). Replies go through the account that received the current turn. After calling this tool, do NOT produce any additional text — the message was already sent.",
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
          content: [{ type: "text" as const, text: TPL_TOOL_NO_CLIENT(params.body) }],
          isError: true,
          details: {},
        };
      }

      try {
        // Track sent body for groupchat echo suppression
        if (turn?.accountName && (params.type === "groupchat" || turn.isGroup)) {
          const bodies = clientManager.getSentMessageBodies(turn.accountName);
          bodies.add(params.body);
        }

        await Outbound.sendXmppMessage(client, params.to, params.body, {
          type: params.type,
          subject: params.subject,
        });
        return {
          content: [{ type: "text" as const, text: TPL_TOOL_SENT(params.to, params.body) }],
          details: {},
        };
      } catch (error: unknown) {
        return {
          content: [
            {
              type: "text" as const,
              text: TPL_TOOL_SEND_FAILED(error instanceof Error ? error.message : String(error)),
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
  const beforeAgentStartHook = Prompts.createXmppBeforeAgentStartHook({
    getActiveTurn: () => {
      const turn = activeTurnRuntime.get();
      if (!turn) return undefined;
      return {
        accountName: turn.accountName,
        isGroup: turn.isGroup,
        roomJid: turn.roomJid,
        senderNick: turn.senderNick,
        fromBare: turn.fromBare,
      };
    },
    uiMessageTemplates: () => {
      const turn = activeTurnRuntime.get();
      return configStore.getResolvedUiMessages(turn?.accountName);
    },
  });

  Lifecycle.registerXmppLifecycleHooks(pi, {
    onSessionStart: async (_event, ctx) => {
      sessionContextStore.set(ctx);

      // Load config from disk before accessing accounts
      try {
        await configStore.load();
      } catch (error) {
        ctx.ui.notify(
          TPL_CONFIG_LOAD_FAILED(error instanceof Error ? error.message : String(error)),
          "warning",
        );
        recordRuntimeEvent("config-load-failed", error);
      }

      // Auto-connect accounts with autoConnect=true (per-account instance lock)
      const allAccounts = configStore.getAccounts();
      for (const account of allAccounts) {
        if (!account.autoConnect || !account.jid || !account.password) continue;
        const name = account.name ?? "default";
        const hasLock = await Config.tryAcquireAutoConnectLock(name);
        if (!hasLock) {
          ctx.ui.notify(TPL_AUTO_CONNECT_SKIPPED(name), "info");
          recordRuntimeEvent("auto-connect-skipped", null, { account: name, reason: "lock held by another instance" });
          continue;
        }
        try {
          await clientManager.connectAccount(name, account);

          // Local notification
          ctx.ui.notify(TPL_CONNECTED_OK(name, account.jid!), "info");

          // Send greeting to owner JID if configured
          if (account.ownerJid) {
            const client = clientManager.getClientForTurn(name);
            if (client) {
              const greeting = TPL_GREETING(name, account.jid!);
              await Outbound.sendXmppMessage(client, account.ownerJid, greeting, { type: "chat" }).catch(() => {});
            }
          }

          recordRuntimeEvent("auto-connect-success", null, { account: name, jid: account.jid });
        } catch (error) {
          ctx.ui.notify(TPL_CONNECT_FAILED(name), "error");
          recordRuntimeEvent("auto-connect", error, { account: name });
          // Release the lock so another instance can try
          await Config.releaseAutoConnectLock(name).catch(() => {});
        }
      }
    },

    onSessionShutdown: async () => {
      // Clear all heartbeat timers
      for (const timer of heartbeatTimers.values()) {
        clearTimeout(timer);
      }
      heartbeatTimers.clear();

      await clientManager.disconnectAccount();
      // Release all per-account locks
      const released = new Set<string>();
      for (const account of configStore.getAccounts()) {
        const name = account.name ?? "default";
        if (!released.has(name)) {
          await Config.releaseAutoConnectLock(name);
          released.add(name);
        }
      }
      sessionContextStore.clear();
    },

    onBeforeAgentStart: async (event) => {
      return beforeAgentStartHook(event);
    },

    onAgentStart: async () => {
      const turn = activeTurnRuntime.get();
      if (turn) {
        const to = turn.isGroup && turn.roomJid ? turn.roomJid : turn.fromBare;
        const client = turn.accountName
          ? clientManager.getClientForTurn(turn.accountName)
          : clientManager.getClientForTurn();

        if (client && !turn.isGroup) {
          // Derive a short preview from the user's message body for presence status
          const preview80 = sanitizePreview(turn.body, 80);
          const statusText = preview80
            ? TPL_PROCESSING(preview80, turn.body.length > 80)
            : MSG_PROCESSING_REQUEST;

          // XEP-0085: Send active chat state to let the contact know we're processing
          XmppApi.sendChatState(client, to, "active").catch(() => {});

          // Set presence to dnd with the user's actual request as context
          client.sendPresence({ show: "dnd", status: statusText });

          // Long-task heartbeat: after 30s send a brief status if still running
          const preview60 = sanitizePreview(turn.body, 60);
          const heartbeatPreview = preview60
            ? TPL_HEARTBEAT(preview60, turn.body.length > 60)
            : MSG_STILL_WORKING;
          const heartbeatId = `${turn.fromBare}:${turn.timestamp}`;
          const heartbeatTimer = setTimeout(async () => {
            heartbeatTimers.delete(heartbeatId);
            const stillTurn = activeTurnRuntime.get();
            if (stillTurn && !stillTurn.isGroup) {
              try {
                await Outbound.sendXmppMessage(
                  client,
                  to,
                  heartbeatPreview,
                  { type: "chat" },
                );
              } catch {
                // Non-fatal
              }
            }
          }, 30_000);
          heartbeatTimers.set(heartbeatId, heartbeatTimer);
        }
      }
    },

    onAgentEnd: async (event, ctx) => {
      const turn = activeTurnRuntime.get();
      if (turn) {
        // Clear heartbeat timer
        const heartbeatId = `${turn.fromBare}:${turn.timestamp}`;
        const timer = heartbeatTimers.get(heartbeatId);
        if (timer) {
          clearTimeout(timer);
          heartbeatTimers.delete(heartbeatId);
        }

        // Send inactive chat state + restore presence
        const to = turn.isGroup && turn.roomJid ? turn.roomJid : turn.fromBare;
        const client = turn.accountName
          ? clientManager.getClientForTurn(turn.accountName)
          : clientManager.getClientForTurn();
        if (client && !turn.isGroup) {
          XmppApi.sendChatState(client, to, "inactive").catch(() => {});
          client.sendPresence({ show: "chat", status: MSG_READY });
        }
      }

      // Auto-route agent's text response back through XMPP if it didn't call xmpp_send
      if (turn) {
        const msgs = (event as any).messages;
        const hasXmppSend = Array.isArray(msgs)
          ? msgs.some(
              (m: any) =>
                m.role === "assistant" &&
                Array.isArray(m.content) &&
                m.content.some(
                  (c: any) => c.type === "toolCall" && c.name === "xmpp_send",
                ),
            )
          : false;
        if (!hasXmppSend && Array.isArray(msgs)) {
          // Find the last assistant text response
          const lastAssistant = [...msgs]
            .reverse()
            .find((m) => m.role === "assistant");
          if (lastAssistant) {
            const textParts: string[] = [];
            for (const c of lastAssistant.content ?? []) {
              if (c.type === "text" && c.text) textParts.push(c.text);
            }
            if (textParts.length > 0) {
              const responseText = textParts.join("\n");
              const client = turn.accountName
                ? clientManager.getClientForTurn(turn.accountName)
                : clientManager.getClientForTurn();
              if (client) {
                const to = turn.isGroup && turn.roomJid ? turn.roomJid : turn.fromBare;
                const type = turn.isGroup ? "groupchat" : "chat";
                try {
                  await Outbound.sendXmppMessage(client, to, responseText, { type });
                  const preview = responseText.length > 80 ? responseText.slice(0, 77) + "..." : responseText;
                  ctx.ui.notify(TPL_RESPONSE_SENT(to, preview), "info");
                } catch {
                  // Auto-send failure is non-fatal
                }
              }
            }
          }
        }
      }

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
