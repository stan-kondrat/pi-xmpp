/**
 * Low-level XMPP client wrapper
 * Zones: xmpp protocol, connection lifecycle, stanza handling
 * Owns the @xmpp/client instance, connection lifecycle management, stanza send/receive, reconnection, and presence
 */

import { client, xml, jid as parseJid } from "@xmpp/client";
import type { XmppConfig } from "./config.ts";

export type { XmppConfig };

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
