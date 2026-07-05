/**
 * Public XMPP status API
 * Zones: package boundary, companion extension interop
 * Exposes compact status-line registration for companion extensions
 */

export {
  registerXmppStatusLineProvider,
  type XmppStatusLineProvider,
  type XmppStatusLineProviderContext,
  type XmppStatusLineProviderResult,
} from "../lib/status.ts";
