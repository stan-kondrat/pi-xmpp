/**
 * Public XMPP updates API
 * Zones: package boundary, companion extension interop
 * Exposes the stable stanza handler surface
 */

import type { XmppStanza } from "../lib/xmpp-api.ts";

export type XmppUpdateHandlerVerdict =
  | { handled: true }
  | { handled: false; reason?: string };

export interface XmppUpdateHandler {
  (stanza: XmppStanza): XmppUpdateHandlerVerdict | Promise<XmppUpdateHandlerVerdict>;
}

const UPDATE_HANDLER_REGISTRY_KEY = "__piXmppUpdateHandlers__";

/**
 * Register a raw stanza update handler.
 * Handlers receive every incoming stanza and can mark it as handled
 * to prevent further processing by the default message pipeline.
 */
export function registerXmppUpdateHandler(
  handler: XmppUpdateHandler,
): void {
  const registry = getUpdateHandlerRegistry();
  registry.push(handler);
}

function getUpdateHandlerRegistry(): XmppUpdateHandler[] {
  const globals = globalThis as Record<string, unknown>;
  if (!globals[UPDATE_HANDLER_REGISTRY_KEY]) {
    globals[UPDATE_HANDLER_REGISTRY_KEY] = [];
  }
  return globals[UPDATE_HANDLER_REGISTRY_KEY] as XmppUpdateHandler[];
}

export function getXmppUpdateHandlers(): XmppUpdateHandler[] {
  return getUpdateHandlerRegistry();
}
