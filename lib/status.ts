/**
 * XMPP bridge status and diagnostics
 * Zones: xmpp status, diagnostics
 * Owns runtime event recording, status-line providers, and status rendering
 */

import type { XmppConfig } from "./config.ts";
import type { XmppConnectionStatus } from "./xmpp-api.ts";

const STATUS_LINE_PROVIDER_KEY = "__piXmppStatusLineProviders__";

export interface XmppStatusLineProviderContext {
  config: XmppConfig;
  connectionStatus: XmppConnectionStatus;
  connectedJid?: string;
  ownerJid?: string;
  activeTurnFrom?: string;
  queuedCount: number;
}

export interface XmppStatusLineProviderResult {
  label: string;
  value: string;
  priority?: number;
}

export interface XmppStatusLineProvider {
  (
    ctx: XmppStatusLineProviderContext,
  ):
    | XmppStatusLineProviderResult
    | Promise<XmppStatusLineProviderResult>;
}

/**
 * Register a status line provider for extension diagnostics.
 * Companion extensions can add custom status lines to `/xmpp-status`.
 */
export function registerXmppStatusLineProvider(
  provider: XmppStatusLineProvider,
): void {
  const registry = getStatusLineRegistry();
  registry.push(provider);
}

function getStatusLineRegistry(): XmppStatusLineProvider[] {
  const globals = globalThis as Record<string, unknown>;
  if (!globals[STATUS_LINE_PROVIDER_KEY]) {
    globals[STATUS_LINE_PROVIDER_KEY] = [];
  }
  return globals[STATUS_LINE_PROVIDER_KEY] as XmppStatusLineProvider[];
}

export interface XmppRuntimeEventEntry {
  timestamp: number;
  category: string;
  error?: string;
  details?: Record<string, unknown>;
}

export function createXmppRuntimeEventRecorder(
  options?: { maxEntries?: number },
) {
  const maxEntries = options?.maxEntries ?? 100;
  const events: XmppRuntimeEventEntry[] = [];

  return {
    record: (
      category: string,
      error: unknown,
      details?: Record<string, unknown>,
    ) => {
      let errorStr: string | undefined;
      if (error instanceof Error) {
        errorStr = error.message;
      } else if (error != null) {
        errorStr = String(error);
      }
      events.push({
        timestamp: Date.now(),
        category,
        error: errorStr,
        details,
      });
      if (events.length > maxEntries) {
        events.splice(0, events.length - maxEntries);
      }
    },
    getEvents: () => [...events],
    clear: () => {
      events.length = 0;
    },
  };
}

export function formatXmppStatusSummary(deps: {
  config: XmppConfig;
  connectionStatus: XmppConnectionStatus;
  connectedJid?: string;
  ownerJid?: string;
  activeTurnFrom?: string;
  queuedCount: number;
  runtimeEvents: XmppRuntimeEventEntry[];
  recentErrors?: string[];
  accountName?: string;
  accountsCount?: number;
}): string {
  const lines: string[] = [
    "## XMPP Bridge Status",
    "",
    `**Connection:** ${deps.connectionStatus}`,
    `**Account:** ${deps.accountName ?? "(ad-hoc)"}`,
    `**JID:** ${deps.connectedJid ?? "not connected"}`,
    `**Configured JID:** ${deps.config.jid ?? "not configured"}`,
    `**Owner JID:** ${deps.ownerJid ?? "anyone (no restriction)"}`,
    `**Active turn:** ${deps.activeTurnFrom ?? "none"}`,
    `**Queued messages:** ${deps.queuedCount}`,
    `**Service:** ${deps.config.service ?? "auto"}`,
    `**Domain:** ${deps.config.domain ?? "auto"}`,
  ];

  if (deps.accountsCount && deps.accountsCount > 1) {
    lines.push(`**Configured accounts:** ${deps.accountsCount}`);
  }

  if (deps.config.autoJoinRoom) {
    lines.push(`**Auto-join room:** ${deps.config.autoJoinRoom}`);
  }

  if (deps.recentErrors?.length) {
    lines.push("");
    lines.push("### Recent Errors");
    for (const err of deps.recentErrors) {
      lines.push(`- ${err}`);
    }
  }

  if (deps.runtimeEvents.length > 0) {
    lines.push("");
    lines.push("### Runtime Events");
    const recent = deps.runtimeEvents.slice(-10);
    for (const event of recent) {
      const time = new Date(event.timestamp).toISOString();
      lines.push(
        `- [${time}] ${event.category}: ${event.error ?? "ok"}`,
      );
    }
  }

  return lines.join("\n");
}
