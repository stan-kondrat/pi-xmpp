/**
 * Low-level XMPP client wrapper
 * Zones: xmpp protocol, connection lifecycle, stanza handling
 * Owns the @xmpp/client instance, connection lifecycle management, stanza send/receive, reconnection, and presence
 */

import { client, xml, jid as parseJid } from "@xmpp/client";
import type { XmppConfig } from "./config.ts";

export type { XmppConfig };

// ── XMPP Protocol Namespaces ──

export const NS_CHAT_STATES = "http://jabber.org/protocol/chatstates";
export const NS_RECEIPTS = "urn:xmpp:receipts";
export const NS_CHAT_MARKERS = "urn:xmpp:chat-markers";

// ── Chat State Types (XEP-0085) ──

export type ChatState = "active" | "composing" | "paused" | "inactive" | "gone";

// ── Chat Marker Types (XEP-0333) ──

export type ChatMarker = "markable" | "received" | "displayed" | "acknowledged";

export interface XmppMessageStanza {
  id?: string;
  from?: string;
  to?: string;
  type?: string;
  body?: string;
  subject?: string;
  thread?: string;
  html?: string;
  // Raw XML for advanced processing
  raw: string;
}

export interface XmppPresenceStanza {
  from?: string;
  type?: string; // "unavailable", "subscribe", "subscribed", "unsubscribe", "unsubscribed"
  show?: string; // "away", "chat", "dnd", "xa"
  status?: string;
  raw: string;
}

export interface XmppStanza {
  name: string;
  attrs: Record<string, string>;
  children: unknown[];
  toString(): string;
}

export type XmppConnectionStatus =
  | "offline"
  | "connecting"
  | "online"
  | "disconnecting"
  | "disconnected"
  | "reconnecting";

export interface XmppClientInstance {
  jid?: string;
  status: XmppConnectionStatus;
  connect: (config: XmppConfig) => Promise<void>;
  disconnect: () => Promise<void>;
  send: (stanza: string | ReturnType<typeof xml>) => Promise<void>;
  sendMessage: (
    to: string,
    body: string,
    options?: { type?: string; subject?: string; thread?: string },
  ) => Promise<void>;
  sendPresence: (options?: {
    show?: string;
    status?: string;
    type?: string;
    to?: string;
  }) => void;
  joinRoom: (roomJid: string, nickname: string) => void;
  leaveRoom: (roomJid: string) => void;
  onStanza: (handler: (stanza: XmppStanza) => void) => void;
  offStanza: (handler: (stanza: XmppStanza) => void) => void;
  onStatusChange: (handler: (status: XmppConnectionStatus) => void) => () => void;
  onError: (handler: (error: Error) => void) => () => void;
  getRoster: () => Promise<Array<{ jid: string; name?: string; subscription?: string }>>;
}

export function createXmppClient(): XmppClientInstance {
  let xmpp: ReturnType<typeof client> | undefined;
  let currentStatus: XmppConnectionStatus = "offline";
  let currentJid: string | undefined;
  const stanzaHandlers: Array<(stanza: XmppStanza) => void> = [];
  const statusHandlers: Array<(status: XmppConnectionStatus) => void> = [];
  const errorHandlers: Array<(error: Error) => void> = [];

  function setStatus(status: XmppConnectionStatus): void {
    currentStatus = status;
    for (const handler of statusHandlers) {
      try {
        handler(status);
      } catch {
        // Silently ignore handler errors
      }
    }
  }

  return {
    get jid(): string | undefined {
      return currentJid;
    },
    get status(): XmppConnectionStatus {
      return currentStatus;
    },

    async connect(config: XmppConfig): Promise<void> {
      if (xmpp) {
        await this.disconnect();
      }

      if (!config.jid || !config.password) {
        throw new Error("JID and password are required to connect");
      }

      const parsedJid = parseJid(config.jid);
      const service = config.service ?? `xmpp://${parsedJid.domain}`;
      const domain = config.domain ?? parsedJid.domain;

      xmpp = client({
        service,
        domain,
        username: parsedJid.local,
        password: config.password,
      });

      xmpp.on("status", (status: string) => {
        switch (status) {
          case "online":
            setStatus("online");
            break;
          case "offline":
            setStatus("offline");
            break;
          case "connecting":
            setStatus("connecting");
            break;
          case "disconnecting":
            setStatus("disconnecting");
            break;
          case "disconnected":
            setStatus("disconnected");
            break;
          default:
            setStatus(status as XmppConnectionStatus);
        }
      });

      xmpp.on("error", (err: Error) => {
        for (const handler of errorHandlers) {
          try {
            handler(err);
          } catch {
            // Silently ignore
          }
        }
      });

      xmpp.on("online", (jid: { toString(): string }) => {
        currentJid = jid.toString();
        // Send initial presence so the server routes messages to us
        xmpp!.send(xml("presence", {})).catch(() => {});
      });

      xmpp.on("offline", () => {
        currentJid = undefined;
      });

      xmpp.on("stanza", (stanza: unknown) => {
        const s = stanza as XmppStanza;
        for (const handler of stanzaHandlers) {
          try {
            handler(s);
          } catch {
            // Silently ignore
          }
        }
      });

      setStatus("connecting");
      try {
        await xmpp.start();
      } catch (error) {
        setStatus("offline");
        throw error;
      }
    },

    async disconnect(): Promise<void> {
      if (!xmpp) return;
      setStatus("disconnecting");
      try {
        await xmpp.stop();
      } finally {
        xmpp = undefined;
        currentJid = undefined;
        setStatus("offline");
      }
    },

    async send(stanza: string | ReturnType<typeof xml>): Promise<void> {
      if (!xmpp) throw new Error("Not connected");
      await xmpp.send(stanza);
    },

    async sendMessage(
      to: string,
      body: string,
      options?: { type?: string; subject?: string; thread?: string },
    ): Promise<void> {
      const msgChildren: ReturnType<typeof xml>[] = [];

      if (options?.subject) {
        msgChildren.push(xml("subject", {}, options.subject));
      }

      msgChildren.push(xml("body", {}, body));

      if (options?.thread) {
        msgChildren.push(xml("thread", {}, options.thread));
      }

      // XEP-0184: Request delivery receipt for chat messages (not groupchat)
      if (!options?.type || options.type === "chat") {
        msgChildren.push(xml("request", { xmlns: NS_RECEIPTS }));
      }

      // XEP-0333: Mark message as markable so the client can send displayed/acknowledged
      if (!options?.type || options.type === "chat") {
        msgChildren.push(xml("markable", { xmlns: NS_CHAT_MARKERS }));
      }

      // XEP-0085: Hint that we're actively sending
      msgChildren.push(xml("active", { xmlns: NS_CHAT_STATES }));

      const attrs: Record<string, string> = { to };
      if (options?.type) attrs.type = options.type;

      await this.send(xml("message", attrs, ...msgChildren));
    },

    sendPresence(options?: {
      show?: string;
      status?: string;
      type?: string;
      to?: string;
    }): void {
      if (!xmpp) return;
      const attrs: Record<string, string> = {};
      if (options?.type) attrs.type = options.type;
      if (options?.to) attrs.to = options.to;

      const children: ReturnType<typeof xml>[] = [];
      if (options?.show) children.push(xml("show", {}, options.show));
      if (options?.status) children.push(xml("status", {}, options.status));

      xmpp.send(xml("presence", attrs, ...children)).catch(() => {});
    },

    joinRoom(roomJid: string, nickname: string): void {
      const fullRoomJid = `${roomJid}/${nickname}`;
      this.sendPresence({ to: fullRoomJid });
    },

    leaveRoom(roomJid: string): void {
      const presence = xml("presence", {
        to: roomJid,
        type: "unavailable",
      });
      this.send(presence).catch(() => {});
    },

    onStanza(handler: (stanza: XmppStanza) => void): void {
      stanzaHandlers.push(handler);
    },

    offStanza(handler: (stanza: XmppStanza) => void): void {
      const idx = stanzaHandlers.indexOf(handler);
      if (idx >= 0) stanzaHandlers.splice(idx, 1);
    },

    onStatusChange(handler: (status: XmppConnectionStatus) => void): () => void {
      statusHandlers.push(handler);
      return () => {
        const idx = statusHandlers.indexOf(handler);
        if (idx >= 0) statusHandlers.splice(idx, 1);
      };
    },

    onError(handler: (error: Error) => void): () => void {
      errorHandlers.push(handler);
      return () => {
        const idx = errorHandlers.indexOf(handler);
        if (idx >= 0) errorHandlers.splice(idx, 1);
      };
    },

    async getRoster(): Promise<
      Array<{ jid: string; name?: string; subscription?: string }>
    > {
      return [];
    },
  };
}

/**
 * Extract text body from a message stanza
 */
export function getMessageBody(stanza: XmppStanza): string | undefined {
  if (stanza.name !== "message") return undefined;
  const body = stanza.children.find(
    (c) =>
      typeof c === "object" &&
      c !== null &&
      (c as XmppStanza).name === "body",
  ) as XmppStanza | undefined;
  if (!body) return undefined;
  // body text is the first text child
  const text = body.children.find((c) => typeof c === "string");
  return typeof text === "string" ? text : undefined;
}

/**
 * Extract subject from a message stanza
 */
export function getMessageSubject(stanza: XmppStanza): string | undefined {
  if (stanza.name !== "message") return undefined;
  const subject = stanza.children.find(
    (c) =>
      typeof c === "object" &&
      c !== null &&
      (c as XmppStanza).name === "subject",
  ) as XmppStanza | undefined;
  if (!subject) return undefined;
  const text = subject.children.find((c) => typeof c === "string");
  return typeof text === "string" ? text : undefined;
}

/**
 * Extract thread ID from a message stanza
 */
export function getMessageThread(stanza: XmppStanza): string | undefined {
  if (stanza.name !== "message") return undefined;
  const thread = stanza.children.find(
    (c) =>
      typeof c === "object" &&
      c !== null &&
      (c as XmppStanza).name === "thread",
  ) as XmppStanza | undefined;
  if (!thread) return undefined;
  const text = thread.children.find((c) => typeof c === "string");
  return typeof text === "string" ? text : undefined;
}

/**
 * Check if a stanza is a groupchat message (MUC)
 */
export function isGroupMessage(stanza: XmppStanza): boolean {
  return (
    stanza.name === "message" &&
    stanza.attrs.type === "groupchat"
  );
}

/**
 * Check if a stanza is an error
 */
export function isErrorMessage(stanza: XmppStanza): boolean {
  return (
    stanza.name === "message" && stanza.attrs.type === "error"
  );
}

// ── Child-element finder helper ──

/**
 * Find a child element by name and optional xmlns attribute.
 */
function findChild(
  stanza: XmppStanza,
  name: string,
  xmlns?: string,
): XmppStanza | undefined {
  return stanza.children.find((c): c is XmppStanza => {
    if (typeof c !== "object" || c === null) return false;
    const s = c as XmppStanza;
    if (s.name !== name) return false;
    if (xmlns !== undefined && s.attrs.xmlns !== xmlns) return false;
    return true;
  });
}

/**
 * Get the text content of a child element.
 */
function getChildText(child: XmppStanza): string | undefined {
  const text = child.children.find((c) => typeof c === "string");
  return typeof text === "string" ? text : undefined;
}

// ── XEP-0085: Chat State Notifications ──

/**
 * Send a chat state notification (XEP-0085) to a contact.
 * Chat state messages carry no \<body\> — only the state element.
 */
export async function sendChatState(
  client: XmppClientInstance,
  to: string,
  state: ChatState,
): Promise<void> {
  await client.send(
    xml("message", { to },
      xml(state, { xmlns: NS_CHAT_STATES }),
    ),
  );
}

/**
 * Check whether a message stanza carries a chat state notification.
 */
export function hasChatState(stanza: XmppStanza): boolean {
  if (stanza.name !== "message") return false;
  return stanza.children.some((c) =>
    typeof c === "object" &&
    c !== null &&
    (c as XmppStanza).attrs?.xmlns === NS_CHAT_STATES,
  );
}

/**
 * Get the chat state value from a stanza, if any.
 */
export function getChatState(stanza: XmppStanza): ChatState | undefined {
  if (stanza.name !== "message") return undefined;
  for (const c of stanza.children) {
    if (typeof c !== "object" || c === null) continue;
    const s = c as XmppStanza;
    if (s.attrs?.xmlns === NS_CHAT_STATES) {
      return s.name as ChatState;
    }
  }
  return undefined;
}

// ── XEP-0184: Message Delivery Receipts ──

/**
 * Check if a message stanza contains a delivery receipt request.
 */
export function hasDeliveryReceiptRequest(stanza: XmppStanza): boolean {
  return !!findChild(stanza, "request", NS_RECEIPTS);
}

/**
 * Check if a message stanza is a delivery receipt (has \<received\>).
 */
export function isDeliveryReceipt(stanza: XmppStanza): boolean {
  return !!findChild(stanza, "received", NS_RECEIPTS);
}

/**
 * Get the message ID that a \<received\> element refers to.
 */
export function getReceivedId(stanza: XmppStanza): string | undefined {
  const child = findChild(stanza, "received", NS_RECEIPTS);
  return child?.attrs.id;
}

/**
 * Send a delivery receipt (XEP-0184) for a received message.
 */
export async function sendDeliveryReceipt(
  client: XmppClientInstance,
  to: string,
  originalMsgId: string,
): Promise<void> {
  await client.send(
    xml("message", { to },
      xml("received", { xmlns: NS_RECEIPTS, id: originalMsgId }),
    ),
  );
}

// ── XEP-0333: Chat Markers ──

/**
 * Check if a stanza has a markable marker.
 */
export function hasMarkable(stanza: XmppStanza): boolean {
  return !!findChild(stanza, "markable", NS_CHAT_MARKERS);
}

/**
 * Check if a stanza has a chat marker of any type.
 */
export function hasChatMarker(stanza: XmppStanza): boolean {
  if (stanza.name !== "message") return false;
  return stanza.children.some((c) =>
    typeof c === "object" &&
    c !== null &&
    (c as XmppStanza).attrs?.xmlns === NS_CHAT_MARKERS,
  );
}

/**
 * Get the chat marker type and referenced id from a stanza.
 */
export function getChatMarker(
  stanza: XmppStanza,
): { marker: ChatMarker; id?: string } | undefined {
  if (stanza.name !== "message") return undefined;
  for (const c of stanza.children) {
    if (typeof c !== "object" || c === null) continue;
    const s = c as XmppStanza;
    if (s.attrs?.xmlns === NS_CHAT_MARKERS) {
      return { marker: s.name as ChatMarker, id: s.attrs.id };
    }
  }
  return undefined;
}

/**
 * Send a chat marker (XEP-0333) — typically "displayed" or "received".
 */
export async function sendChatMarker(
  client: XmppClientInstance,
  to: string,
  marker: "received" | "displayed" | "acknowledged",
  originalMsgId: string,
): Promise<void> {
  const attrs: Record<string, string> = { xmlns: NS_CHAT_MARKERS };
  if (originalMsgId) attrs.id = originalMsgId;
  await client.send(
    xml("message", { to },
      xml(marker, attrs),
    ),
  );
}
