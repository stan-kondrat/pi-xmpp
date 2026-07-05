/**
 * Public XMPP outbound API
 * Zones: package boundary, companion extension interop
 * Exposes stable outbound handler and diagnostics surfaces
 */

export {
  recordXmppRuntimeEvent,
  registerXmppOutboundHandler,
  type XmppOutboundProgrammaticHandler,
} from "../lib/outbound.ts";
