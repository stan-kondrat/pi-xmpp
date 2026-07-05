/**
 * XMPP outbound surface helpers
 * Zones: xmpp outbound, message delivery
 * Owns configured outbound handler execution, text transforms, and direct message sending
 */

import type { XmppClientInstance } from "./xmpp-api.ts";
import { getBareJid } from "./routing.ts";

const OUTBOUND_HANDLER_REGISTRY_KEY = "__piXmppOutboundHandlers__";

export interface XmppOutboundProgrammaticHandlerInput {
  body: string;
  to: string;
  toBare: string;
  type: string;
  isGroup: boolean;
}

export interface XmppOutboundProgrammaticHandlerResult {
  handled: boolean;
  body?: string;
}

export interface XmppOutboundProgrammaticHandler {
  (
    input: XmppOutboundProgrammaticHandlerInput,
  ):
    | XmppOutboundProgrammaticHandlerResult
    | Promise<XmppOutboundProgrammaticHandlerResult>;
}

/**
 * Register a programmatic outbound handler.
 * Handlers can transform or intercept outgoing messages.
 */
export function registerXmppOutboundHandler(
  handler: XmppOutboundProgrammaticHandler,
): void {
  const registry = getOutboundHandlerRegistry();
  registry.push(handler);
}

function getOutboundHandlerRegistry(): XmppOutboundProgrammaticHandler[] {
  const globals = globalThis as Record<string, unknown>;
  if (!globals[OUTBOUND_HANDLER_REGISTRY_KEY]) {
    globals[OUTBOUND_HANDLER_REGISTRY_KEY] = [];
  }
  return globals[OUTBOUND_HANDLER_REGISTRY_KEY] as XmppOutboundProgrammaticHandler[];
}

export function getXmppOutboundHandlers(): XmppOutboundProgrammaticHandler[] {
  return getOutboundHandlerRegistry();
}

export interface XmppSendMessageOptions {
  type?: string;
  subject?: string;
  thread?: string;
}

/**
 * Send a message via the XMPP client.
 * Runs through the outbound handler pipeline before sending.
 */
export async function sendXmppMessage(
  client: XmppClientInstance,
  to: string,
  body: string,
  options?: XmppSendMessageOptions,
): Promise<void> {
  const toBare = getBareJid(to);
  const isGroup = options?.type === "groupchat";
  let finalBody = body;
  let handled = false;

  // Run through outbound handler pipeline
  const handlers = getXmppOutboundHandlers();
  for (const handler of handlers) {
    try {
      const result = await handler({
        body: finalBody,
        to,
        toBare,
        type: options?.type ?? "chat",
        isGroup,
      });
      if (result.handled) {
        handled = true;
        if (result.body !== undefined) {
          finalBody = result.body;
        }
        break;
      }
    } catch {
      // Silently continue
    }
  }

  if (!handled) {
    await client.sendMessage(to, finalBody, {
      type: options?.type,
      subject: options?.subject,
      thread: options?.thread,
    });
  }
}

/**
 * Record a runtime event for diagnostics.
 * Companion extensions can call this to surface diagnostics.
 */
export type XmppRuntimeEventRecorder = (
  category: string,
  error: unknown,
  details?: Record<string, unknown>,
) => void;

const EVENT_RECORDER_KEY = "__piXmppEventRecorder__";

export function bindXmppRuntimeEventRecorder(
  recorder: XmppRuntimeEventRecorder,
): void {
  (globalThis as Record<string, unknown>)[EVENT_RECORDER_KEY] = recorder;
}

export function recordXmppRuntimeEvent(
  category: string,
  error: unknown,
  details?: Record<string, unknown>,
): void {
  const recorder = (globalThis as Record<string, unknown>)[
    EVENT_RECORDER_KEY
  ] as XmppRuntimeEventRecorder | undefined;
  if (typeof recorder === "function") {
    recorder(category, error, details);
  }
}
