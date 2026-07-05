/**
 * XMPP lifecycle hook registration helpers
 * Zones: pi agent lifecycle, xmpp session
 * Binds prepared XMPP lifecycle runtimes to pi extension lifecycle events
 */

import type {
  AgentEndEvent,
  AgentStartEvent,
  BeforeAgentStartEvent,
  ExtensionAPI,
  ExtensionContext,
  SessionBeforeCompactEvent,
  SessionCompactEvent,
  SessionShutdownEvent,
  SessionStartEvent,
} from "./pi.ts";

export interface XmppBeforeAgentStartResult {
  systemPrompt?: string;
}

type XmppBeforeAgentStartReturn =
  | Promise<XmppBeforeAgentStartResult | undefined>
  | XmppBeforeAgentStartResult
  | undefined;

export interface XmppLifecycleRegistrationDeps {
  onSessionStart: (
    event: SessionStartEvent,
    ctx: ExtensionContext,
  ) => Promise<void>;
  onSessionShutdown: (
    event: SessionShutdownEvent,
    ctx: ExtensionContext,
  ) => Promise<void>;
  onSessionBeforeCompact?: (
    event: SessionBeforeCompactEvent,
    ctx: ExtensionContext,
  ) => Promise<void> | void;
  onSessionCompact?: (
    event: SessionCompactEvent,
    ctx: ExtensionContext,
  ) => Promise<void> | void;
  onBeforeAgentStart: (
    event: BeforeAgentStartEvent,
    ctx: ExtensionContext,
  ) => XmppBeforeAgentStartReturn;
  onAgentStart: (
    event: AgentStartEvent,
    ctx: ExtensionContext,
  ) => Promise<void>;
  onAgentEnd: (
    event: AgentEndEvent,
    ctx: ExtensionContext,
  ) => Promise<void>;
}

export interface XmppSessionContextStore<TContext> {
  get: () => TContext | undefined;
  set: (ctx: TContext) => void;
  clear: () => void;
}

export function createXmppSessionContextStore<
  TContext,
>(): XmppSessionContextStore<TContext> {
  let currentContext: TContext | undefined;
  return {
    get: () => currentContext,
    set: (ctx) => {
      currentContext = ctx;
    },
    clear: () => {
      currentContext = undefined;
    },
  };
}

export function registerXmppLifecycleHooks(
  pi: ExtensionAPI,
  deps: XmppLifecycleRegistrationDeps,
): void {
  pi.on("session_start", async (event, ctx) => {
    await deps.onSessionStart(event, ctx);
  });
  pi.on("session_shutdown", async (event, ctx) => {
    await deps.onSessionShutdown(event, ctx);
  });
  pi.on("session_before_compact", async (event, ctx) => {
    await deps.onSessionBeforeCompact?.(event, ctx);
  });
  pi.on("session_compact", async (event, ctx) => {
    await deps.onSessionCompact?.(event, ctx);
  });
  pi.on("before_agent_start", async (event, ctx) => {
    return deps.onBeforeAgentStart(event, ctx);
  });
  pi.on("agent_start", async (event, ctx) => {
    await deps.onAgentStart(event, ctx);
  });
  pi.on("agent_end", async (event, ctx) => {
    await deps.onAgentEnd(event, ctx);
  });
}
