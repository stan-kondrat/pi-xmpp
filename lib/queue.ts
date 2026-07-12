/**
 * XMPP message queue and turn management
 * Zones: xmpp queue, turn lifecycle, prompt injection
 * Owns incoming message queuing, turn tracking, and deferred prompt dispatch
 */

import type { ExtensionContext } from "./pi.ts";
import type { XmppMessageRoute } from "./routing.ts";
import { DEFAULT_XMPP_PROMPTS } from "./config.ts";
import type { XmppPromptTemplates } from "./config.ts";

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
  /** Account name that received this message */
  accountName?: string;
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
    promptTemplates?: XmppPromptTemplates;
  },
): string {
  const t = options?.promptTemplates ?? DEFAULT_XMPP_PROMPTS;
  // Sanitize helper: replace control chars and limit length
  const safe = (s: string, maxLen = 200): string =>
    s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "").slice(0, maxLen);

  const parts: string[] = [];
  parts.push(t.turnFromLine(safe(turn.from, 120)));

  if (turn.isGroup && turn.roomJid) {
    parts.push(t.turnRoomLine(safe(turn.roomJid, 120)));
    if (turn.senderNick) parts.push(t.turnNickLine(safe(turn.senderNick, 60)));
  }

  if (turn.subject) {
    parts.push(t.turnSubjectLine(safe(turn.subject, 200)));
  }

  if (options?.includeThread && turn.thread) {
    parts.push(t.turnThreadLine(safe(turn.thread, 100)));
  }

  if (options?.extraContext) {
    parts.push(t.turnContextLine(safe(options.extraContext, 500)));
  }

  parts.push("");
  parts.push(turn.body);

  return parts.join("\n");
}
