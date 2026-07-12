/**
 * XMPP prompt injection helpers
 * Zones: pi agent prompts, xmpp guidance
 * Owns XMPP-specific system prompt suffixes injected into pi agent turns
 */

import { Type } from "@sinclair/typebox";
import type { BeforeAgentStartEvent, ExtensionAPI } from "./pi.ts";
import { XMPP_PREFIX } from "./routing.ts";
import { DEFAULT_XMPP_UI_MESSAGES } from "./config.ts";
import type { XmppUiMessageTemplates } from "./config.ts";

// ── Turn context types (subset of queue.ts for prompt building) ──

export interface XmppActiveTurn {
  accountName?: string;
  isGroup: boolean;
  roomJid?: string;
  senderNick?: string;
  fromBare: string;
}

// ── Prompt suffix builders ──

function buildXmppTurnSystemPromptSuffix(
  turn: XmppActiveTurn | undefined,
  templates: XmppUiMessageTemplates = DEFAULT_XMPP_UI_MESSAGES,
): string {
  const safe = (s: string, maxLen = 120): string =>
    s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "").slice(0, maxLen);

  const parts: string[] = [];
  parts.push("");
  parts.push(templates.systemIntro);

  if (turn?.accountName) {
    parts.push(templates.systemAccount(safe(turn.accountName, 60)));
  }

  if (turn?.isGroup) {
    parts.push(templates.systemGroupchatWarning);
    if (turn.roomJid) parts.push(templates.systemRoomLine(safe(turn.roomJid, 120)));
    if (turn.senderNick) parts.push(templates.systemNickLine(safe(turn.senderNick, 60)));
  } else {
    parts.push(templates.systemDirectMessage);
  }

  parts.push(templates.systemReplyInstruction);
  parts.push(templates.systemHelpInstruction);

  return "\n\n" + parts.join("\n");
}

export function getXmppHelpText(templates?: XmppUiMessageTemplates): string {
  return (templates ?? DEFAULT_XMPP_UI_MESSAGES).helpText;
}

export function registerXmppHelpTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "xmpp_help",
    label: "XMPP Help",
    description:
      "Read pi-xmpp usage guidance for delivery actions, formatting, and debugging.",
    parameters: Type.Object({}),
    async execute() {
      return {
        content: [{ type: "text", text: getXmppHelpText() }],
        details: {},
      };
    },
  });
}

export function buildXmppBridgeSystemPrompt(options: {
  prompt: string;
  systemPrompt: string;
  xmppPrefix?: string;
  localSystemPromptSuffix: string;
  xmppTurnSystemPromptSuffix: string;
}): { systemPrompt: string } {
  const xmppPrefix = options.xmppPrefix ?? XMPP_PREFIX;
  const trimmedPrompt = options.prompt.trimStart();
  const isXmppTurn = trimmedPrompt.startsWith(xmppPrefix);

  const suffix = isXmppTurn
    ? options.xmppTurnSystemPromptSuffix
    : options.localSystemPromptSuffix;

  return {
    systemPrompt: options.systemPrompt + suffix,
  };
}

export function createXmppBeforeAgentStartHook(
  options: {
    xmppPrefix?: string;
    localSystemPromptSuffix?: string;
    getActiveTurn?: () => XmppActiveTurn | undefined;
    uiMessageTemplates?: XmppUiMessageTemplates | (() => XmppUiMessageTemplates);
  } = {},
): (event: BeforeAgentStartEvent) => { systemPrompt: string } {
  const resolveTemplates = (): XmppUiMessageTemplates => {
    const t = options.uiMessageTemplates;
    if (typeof t === "function") return t();
    return t ?? DEFAULT_XMPP_UI_MESSAGES;
  };
  return (event) => {
    const templates = resolveTemplates();
    return buildXmppBridgeSystemPrompt({
      prompt: event.prompt,
      systemPrompt: event.systemPrompt,
      xmppPrefix: options.xmppPrefix,
      localSystemPromptSuffix:
        options.localSystemPromptSuffix ?? templates.localSuffix,
      xmppTurnSystemPromptSuffix:
        buildXmppTurnSystemPromptSuffix(options.getActiveTurn?.(), templates),
    });
  };
}
