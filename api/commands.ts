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

/** pi-xmpp version */
export { VERSION } from "../lib/version.ts";
