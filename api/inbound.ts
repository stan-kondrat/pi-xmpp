/**
 * Public XMPP inbound API
 * Zones: package boundary, companion extension interop
 * Exposes the stable programmatic inbound handler surface
 */

export {
  registerXmppInboundHandler,
  type XmppInboundHandlerFile,
  type XmppInboundHandlerOutput,
  type XmppInboundProgrammaticHandler,
  type XmppInboundProgrammaticHandlerInput,
  type XmppInboundProgrammaticHandlerResult,
} from "../lib/inbound.ts";
