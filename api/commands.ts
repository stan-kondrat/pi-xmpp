/**
 * Public XMPP commands API
 * Zones: package boundary, companion extension interop
 * Exposes the stable XMPP slash-command registration surface
 */

export {
  registerXmppCommand,
  type XmppExtensionCommandContext,
  type XmppExtensionCommandRegistration,
} from "../lib/commands.ts";
