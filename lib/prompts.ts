/**
 * XMPP prompt injection helpers
 * Zones: pi agent prompts, xmpp guidance
 * Owns XMPP-specific system prompt suffixes injected into pi agent turns
 */

import { Type } from "@sinclair/typebox";
import type { BeforeAgentStartEvent, ExtensionAPI } from "./pi.ts";
import { XMPP_PREFIX } from "./routing.ts";

// ── Turn context types (subset of queue.ts for prompt building) ──

export interface XmppActiveTurn {
  accountName?: string;
  isGroup: boolean;
  roomJid?: string;
  senderNick?: string;
  fromBare: string;
}

// ── Prompt suffixes ──

const LOCAL_SYSTEM_PROMPT_SUFFIX = `

XMPP bridge available. You can send messages with the \`xmpp_send\` tool
(e.g., to notify someone, answer a question, or forward results).
Do not use it from local/TUI prompts unless the user explicitly asks.`;

function buildXmppTurnSystemPromptSuffix(turn?: XmppActiveTurn): string {
  const parts: string[] = [];
  parts.push("");
  parts.push("This message came from XMPP.");

  if (turn?.accountName) {
    parts.push(`Account: ${turn.accountName}`);
  }

  if (turn?.isGroup) {
    parts.push("⚠️ This is a groupchat — everyone in the room sees replies.");
    if (turn.roomJid) parts.push(`Room: ${turn.roomJid}`);
    if (turn.senderNick) parts.push(`Sender nickname: ${turn.senderNick}`);
  } else {
    parts.push("💬 This is a direct message — only the sender sees replies.");
  }

  parts.push("Reply by calling the \`xmpp_send\` tool — do NOT output text separately after the tool call.");
  parts.push("For bridge help, call \`xmpp_help\`.");

  return "\n\n" + parts.join("\n");
}

const XMPP_HELP_TEXT = `--- XMPP BRIDGE HELP ---

How to understand XMPP turns:
- \`[xmpp|from:user@domain]\` marks XMPP origin and sender.
- \`[room:room@conference]\` indicates a groupchat (MUC) message.
- \`[nick:nickname]\` is the sender's nickname in a MUC room.
- Reply to the user's current instruction, not quoted context.

How to answer XMPP turns:
- Reply in concise, scannable text.
- For generated/requested files, mention the local path.

Assistant-authored XMPP actions:
- Use the \`xmpp_send\` tool to send direct messages or groupchat replies.

Debugging pi-xmpp:
- Inspect \`~/.pi/agent/tmp/xmpp/state.json\` for runtime state and diagnostics.
- Use \`/xmpp-status\` for compact health information.`;

export function getXmppHelpText(): string {
  return XMPP_HELP_TEXT;
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
  } = {},
): (event: BeforeAgentStartEvent) => { systemPrompt: string } {
  return (event) =>
    buildXmppBridgeSystemPrompt({
      prompt: event.prompt,
      systemPrompt: event.systemPrompt,
      xmppPrefix: options.xmppPrefix,
      localSystemPromptSuffix:
        options.localSystemPromptSuffix ?? LOCAL_SYSTEM_PROMPT_SUFFIX,
      xmppTurnSystemPromptSuffix:
        buildXmppTurnSystemPromptSuffix(options.getActiveTurn?.()),
    });
}
