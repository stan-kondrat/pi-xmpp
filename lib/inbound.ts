/**
 * XMPP inbound handler pipeline
 * Zones: xmpp inbound, message processing, prompt preparation
 * Owns stanza dispatch, handler matching, and prompt injection before enqueueing
 */

import type { XmppConfig, XmppInboundHandlerConfig } from "./config.ts";
import type { XmppMessageRoute } from "./routing.ts";

const INBOUND_HANDLER_REGISTRY_KEY = "__piXmppInboundHandlers__";

export interface XmppInboundFile {
  path: string;
  fileName?: string;
  mimeType?: string;
  kind?: string;
}

export interface XmppInboundHandlerOutput {
  file: XmppInboundFile;
  output: string;
  handler: XmppInboundHandlerConfig;
}

export interface XmppInboundHandlerProcessResult {
  rawText: string;
  handlerOutputs: string[];
  handled: boolean;
}

export interface XmppInboundProgrammaticHandlerInput {
  body: string;
  from: string;
  fromBare: string;
  type: string;
  isGroup: boolean;
  roomJid?: string;
  senderNick?: string;
  ownerJid?: string;
  config: XmppConfig;
}

export interface XmppInboundProgrammaticHandlerResult {
  handled: boolean;
  prompt?: string;
  output?: string;
}

export interface XmppInboundProgrammaticHandler {
  (
    input: XmppInboundProgrammaticHandlerInput,
  ): XmppInboundProgrammaticHandlerResult | Promise<XmppInboundProgrammaticHandlerResult>;
}

// Re-export for api surface compatibility
export type { XmppInboundHandlerConfig };

/**
 * Register a programmatic inbound handler.
 * Handlers are called in registration order. The first handler that returns
 * `{ handled: true }` wins and its prompt replaces the default message prompt.
 */
export function registerXmppInboundHandler(
  handler: XmppInboundProgrammaticHandler,
): void {
  const registry = getInboundHandlerRegistry();
  registry.push(handler);
}

function getInboundHandlerRegistry(): XmppInboundProgrammaticHandler[] {
  const globals = globalThis as Record<string, unknown>;
  if (!globals[INBOUND_HANDLER_REGISTRY_KEY]) {
    globals[INBOUND_HANDLER_REGISTRY_KEY] = [];
  }
  return globals[INBOUND_HANDLER_REGISTRY_KEY] as XmppInboundProgrammaticHandler[];
}

export function getXmppInboundHandlers(): XmppInboundProgrammaticHandler[] {
  return getInboundHandlerRegistry();
}

/**
 * Process an incoming message through the inbound handler pipeline.
 * Returns the prompt text and any handler outputs.
 */
export async function processXmppInbound(
  route: XmppMessageRoute,
  config: XmppConfig,
  ownerJid?: string,
): Promise<XmppInboundHandlerProcessResult> {
  const handlers = getXmppInboundHandlers();

  for (const handler of handlers) {
    try {
      const result = await handler({
        body: route.body,
        from: route.from,
        fromBare: route.fromBare,
        type: route.type,
        isGroup: route.isGroup,
        roomJid: route.roomJid,
        senderNick: route.senderNick,
        ownerJid,
        config,
      });

      if (result.handled) {
        return {
          rawText: result.prompt ?? route.body,
          handlerOutputs: result.output ? [result.output] : [],
          handled: true,
        };
      }
    } catch (error) {
      // Handler error, continue to next
      continue;
    }
  }

  // Default handling: use the message body as prompt
  return {
    rawText: route.body,
    handlerOutputs: [],
    handled: false,
  };
}

/**
 * Check if a message body matches an inbound handler config
 */
export function matchesInboundHandler(
  body: string,
  handler: XmppInboundHandlerConfig,
): boolean {
  if (!handler.match) return true; // Match all if no pattern
  const patterns = Array.isArray(handler.match) ? handler.match : [handler.match];
  return patterns.some((pattern) => {
    if (pattern.startsWith("/") && pattern.endsWith("/")) {
      // Regex pattern
      try {
        const regex = new RegExp(pattern.slice(1, -1));
        return regex.test(body);
      } catch {
        // Invalid regex — fall through to simple match
        return false;
      }
    }
    // Glob/simple match
    return body.includes(pattern);
  });
}
