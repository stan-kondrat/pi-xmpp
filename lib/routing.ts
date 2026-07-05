/**
 * XMPP message routing helpers
 * Zones: xmpp routing, stanza dispatch
 * Owns stanza type detection, sender extraction, and routing logic for dispatching
 * incoming stanzas to the correct handler pipeline
 */

import type { XmppStanza } from "./xmpp-api.ts";

export const XMPP_PREFIX = "[xmpp";

export interface XmppMessageRoute {
  kind: "message";
  from: string;
  fromBare: string;
  body: string;
  type: string;
  thread?: string;
  subject?: string;
  isGroup: boolean;
  roomJid?: string;
  senderNick?: string;
}

export interface XmppPresenceRoute {
  kind: "presence";
  from: string;
  type?: string;
  show?: string;
  status?: string;
}

export interface XmppErrorRoute {
  kind: "error";
  from?: string;
  body?: string;
}

export type XmppRoute = XmppMessageRoute | XmppPresenceRoute | XmppErrorRoute;

/**
 * Get the bare JID (without resource) from a full JID string
 */
export function getBareJid(jid: string): string {
  const idx = jid.indexOf("/");
  return idx >= 0 ? jid.slice(0, idx) : jid;
}

/**
 * Extract nickname from a MUC occupant JID
 */
export function extractMucNick(fullJid: string): string | undefined {
  const idx = fullJid.indexOf("/");
  return idx >= 0 ? fullJid.slice(idx + 1) : undefined;
}

/**
 * Determine if a bare JID looks like a MUC room
 */
export function isRoomJid(bareJid: string): boolean {
  // MUC rooms typically have a conference subdomain or contain special chars
  return bareJid.includes("conference") || bareJid.includes("chat.");
}

/**
 * Build the XMPP prefix for Pi agent context
 */
export function buildXmppPrefix(route: XmppMessageRoute): string {
  const parts = [`${XMPP_PREFIX}|from:${route.from}`];
  if (route.isGroup && route.roomJid) {
    parts.push(`room:${route.roomJid}`);
    if (route.senderNick) parts.push(`nick:${route.senderNick}`);
  }
  return parts.join("|");
}

/**
 * Route an incoming stanza
 */
export function routeStanza(stanza: XmppStanza): XmppRoute | undefined {
  if (stanza.name === "message") {
    return routeMessage(stanza);
  }
  if (stanza.name === "presence") {
    return routePresence(stanza);
  }
  return undefined;
}

function routeMessage(stanza: XmppStanza): XmppMessageRoute | undefined {
  const from = stanza.attrs.from;
  const type = stanza.attrs.type ?? "normal";
  if (!from) return undefined;

  // Skip messages from self
  const fromBare = getBareJid(from);

  // Find body
  const bodyChild = stanza.children.find(
    (c) =>
      typeof c === "object" && c !== null && (c as XmppStanza).name === "body",
  ) as XmppStanza | undefined;

  if (!bodyChild) return undefined;

  const bodyText = bodyChild.children.find((c) => typeof c === "string");
  if (typeof bodyText !== "string") return undefined;

  // Find subject and thread
  const subjectChild = stanza.children.find(
    (c) =>
      typeof c === "object" &&
      c !== null &&
      (c as XmppStanza).name === "subject",
  ) as XmppStanza | undefined;

  const threadChild = stanza.children.find(
    (c) =>
      typeof c === "object" &&
      c !== null &&
      (c as XmppStanza).name === "thread",
  ) as XmppStanza | undefined;

  const subject = subjectChild
    ? (subjectChild.children.find((c) => typeof c === "string") as
        | string
        | undefined)
    : undefined;

  const thread = threadChild
    ? (threadChild.children.find((c) => typeof c === "string") as
        | string
        | undefined)
    : undefined;

  const isGroup = type === "groupchat";
  let roomJid: string | undefined;
  let senderNick: string | undefined;

  if (isGroup) {
    roomJid = fromBare;
    senderNick = extractMucNick(from);
  }

  return {
    kind: "message",
    from,
    fromBare,
    body: bodyText,
    type,
    thread,
    subject,
    isGroup,
    roomJid,
    senderNick,
  };
}

function routePresence(
  stanza: XmppStanza,
): XmppPresenceRoute | undefined {
  const from = stanza.attrs.from;
  if (!from) return undefined;

  const showChild = stanza.children.find(
    (c) =>
      typeof c === "object" && c !== null && (c as XmppStanza).name === "show",
  ) as XmppStanza | undefined;

  const statusChild = stanza.children.find(
    (c) =>
      typeof c === "object" &&
      c !== null &&
      (c as XmppStanza).name === "status",
  ) as XmppStanza | undefined;

  const show = showChild
    ? (showChild.children.find((c) => typeof c === "string") as
        | string
        | undefined)
    : undefined;

  const status = statusChild
    ? (statusChild.children.find((c) => typeof c === "string") as
        | string
        | undefined)
    : undefined;

  return {
    kind: "presence",
    from,
    type: stanza.attrs.type,
    show,
    status,
  };
}
