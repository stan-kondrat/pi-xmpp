/**
 * XMPP message queue and turn management
 * Zones: xmpp queue, turn lifecycle, prompt injection
 * Owns incoming message queuing, turn tracking, and deferred prompt dispatch
 */

import type { ExtensionContext } from "./pi.ts";
import type { XmppMessageRoute } from "./routing.ts";

export interface XmppTurnContext {
  from: string;
  fromBare: string;
  body: string;
  type: string;
  thread?: string;
  subject?: string;
  isGroup: boolean;
  roomJid?: string;
  senderNick?: string;
  timestamp: number;
}

export interface XmppQueueItem<TContext> {
  id: string;
  order: number;
  turn: XmppTurnContext;
  prompt: string;
  ctx: TContext;
  status: "queued" | "dispatching" | "active" | "done";
}

export interface XmppActiveTurnStore {
  has: () => boolean;
  get: () => XmppTurnContext | undefined;
  getChatId: () => string | undefined;
  set: (turn: XmppTurnContext | undefined) => void;
  clear: () => void;
}

export function createXmppActiveTurnStore(): XmppActiveTurnStore {
  let current: XmppTurnContext | undefined;
  return {
    has: () => current !== undefined,
    get: () => current,
    getChatId: () => current?.fromBare,
    set: (turn) => {
      current = turn;
    },
    clear: () => {
      current = undefined;
    },
  };
}

export interface XmppQueueStore<TContext> {
  enqueue: (item: XmppQueueItem<TContext>) => void;
  dequeue: () => XmppQueueItem<TContext> | undefined;
  peek: () => XmppQueueItem<TContext> | undefined;
  getQueuedItems: () => XmppQueueItem<TContext>[];
  remove: (id: string) => void;
  clear: () => void;
  size: () => number;
}

export function createXmppQueueStore<TContext>(): XmppQueueStore<TContext> {
  const items: XmppQueueItem<TContext>[] = [];
  return {
    enqueue: (item) => {
      items.push(item);
      items.sort((a, b) => a.order - b.order);
    },
    dequeue: () => items.shift(),
    peek: () => items[0],
    getQueuedItems: () => [...items],
    remove: (id) => {
      const idx = items.findIndex((i) => i.id === id);
      if (idx >= 0) items.splice(idx, 1);
    },
    clear: () => {
      items.length = 0;
    },
    size: () => items.length,
  };
}

export function formatQueuedXmppItemsStatus<TContext>(
  items: XmppQueueItem<TContext>[],
): string {
  if (items.length === 0) return "0 queued";
  return items
    .map(
      (i) =>
        `${i.status}: from=${i.turn.fromBare} body="${i.turn.body.slice(0, 40)}"`,
    )
    .join("; ");
}

export function buildXmppTurnPrompt(
  turn: XmppTurnContext,
  options?: {
    includeThread?: boolean;
    extraContext?: string;
  },
): string {
  const parts: string[] = [];
  parts.push(`[xmpp|from:${turn.from}]`);

  if (turn.isGroup && turn.roomJid) {
    parts.push(`[room:${turn.roomJid}]`);
    if (turn.senderNick) parts.push(`[nick:${turn.senderNick}]`);
  }

  if (turn.subject) {
    parts.push(`[subject:${turn.subject}]`);
  }

  if (options?.includeThread && turn.thread) {
    parts.push(`[thread:${turn.thread}]`);
  }

  if (options?.extraContext) {
    parts.push(`[context:${options.extraContext}]`);
  }

  parts.push("");
  parts.push(turn.body);

  return parts.join("\n");
}
