/**
 * XMPP prompt injection helpers
 * Zones: pi agent prompts, xmpp guidance
 * Owns XMPP-specific system prompt suffixes injected into pi agent turns
 */

import { Type } from "@sinclair/typebox";
import type { BeforeAgentStartEvent, ExtensionAPI } from "./pi.ts";
import { XMPP_PREFIX } from "./routing.ts";

const LOCAL_SYSTEM_PROMPT_SUFFIX = `

XMPP bridge available. Do not use it from local/TUI prompts unless explicitly asked.`;

const XMPP_TURN_SYSTEM_PROMPT_SUFFIX = `

XMPP turn note: If context was compacted or you need the pi-xmpp bridge contract, call tool \`xmpp_help\`.`;

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
    ? `${options.xmppTurnSystemPromptSuffix}\n- The current user message came from XMPP.`
    : options.localSystemPromptSuffix;

  return {
    systemPrompt: options.systemPrompt + suffix,
  };
}

export function createXmppBeforeAgentStartHook(
  options: {
    xmppPrefix?: string;
    localSystemPromptSuffix?: string;
    xmppTurnSystemPromptSuffix?: string;
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
        options.xmppTurnSystemPromptSuffix ?? XMPP_TURN_SYSTEM_PROMPT_SUFFIX,
    });
}
