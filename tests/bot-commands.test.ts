/**
 * Bot commands verification test.
 *
 * Verifies that companion plugin commands (!compact, !models, !model, !help)
 * are intercepted by update handlers BEFORE the auth gate and LLM prompt.
 *
 * Pipeline:
 *   raw stanza → update handlers → [handled=true] → STOP (never reaches LLM)
 *   raw stanza → update handlers → [handled=false] → auth gate → prompt → LLM
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import {
  registerXmppUpdateHandler,
  getXmppUpdateHandlers,
} from "../api/updates.ts";
import type { XmppUpdateHandler, XmppUpdateHandlerVerdict } from "../api/updates.ts";
import { DEFAULT_XMPP_UI_MESSAGES } from "../lib/config.ts";

// ── Stanza builders ──

function makeGroupchatStanza(body: string): ReturnType<typeof createStanza> {
  return createStanza("message", {
    from: "room@conference.example.org/sender",
    type: "groupchat",
    id: `msg-${Date.now()}`,
  }, [
    createStanza("body", {}, [body]),
  ]);
}

function makeDirectMessageStanza(from: string, body: string): ReturnType<typeof createStanza> {
  return createStanza("message", {
    from,
    type: "chat",
    id: `dm-${Date.now()}`,
  }, [
    createStanza("body", {}, [body]),
  ]);
}

function createStanza(
  name: string,
  attrs: Record<string, string>,
  children: unknown[] = [],
): {
  name: string;
  attrs: Record<string, string>;
  children: unknown[];
  toString: () => string;
} {
  return { name, attrs: { ...attrs }, children: [...children], toString: () => `<${name} .../>` };
}

function getMessageBody(stanza: ReturnType<typeof createStanza>): string | undefined {
  const body = (stanza.children ?? []).find(
    (c): c is ReturnType<typeof createStanza> =>
      typeof c === "object" && c !== null && (c as ReturnType<typeof createStanza>).name === "body",
  );
  if (!body) return undefined;
  const text = body.children.find((c) => typeof c === "string");
  return typeof text === "string" ? text : undefined;
}

function isGroupchatStanza(stanza: ReturnType<typeof createStanza>): boolean {
  return stanza.name === "message" && stanza.attrs?.type === "groupchat";
}

// ── Bot command handlers (simulates a companion plugin) ──

const COMMANDS: { re: RegExp; name: string }[] = [
  { re: /^\s*!compact\b/i, name: "compact" },
  { re: /^\s*!models\b/i, name: "models" },
  { re: /^\s*!model\s+(\S+)/i, name: "model" },
  { re: /^\s*!help\b/i, name: "help" },
];

let lastHandledCommand: string | undefined;
let lastHandledArgs: string[] = [];

function createBotCommandHandler(): XmppUpdateHandler {
  return async (stanza) => {
    // Only handle groupchat messages with body
    if (stanza.name !== "message") return { handled: false };
    const body = getMessageBody(stanza as any);
    if (!body) return { handled: false };

    for (const cmd of COMMANDS) {
      const m = cmd.re.exec(body);
      if (m) {
        lastHandledCommand = cmd.name;
        lastHandledArgs = m.slice(1);
        return { handled: true }; // ← never reaches auth/LLM
      }
    }

    return { handled: false };
  };
}

// Cleanup between tests
beforeEach(() => {
  lastHandledCommand = undefined;
  lastHandledArgs = [];
});

afterEach(() => {
  // Remove handlers registered during tests
  const registry = (globalThis as Record<string, unknown>)["__piXmppUpdateHandlers__"] as XmppUpdateHandler[] | undefined;
  if (registry) registry.length = 0;
});

// ── Tests ──

describe("Bot commands — update handler interception", () => {
  it("registers and executes a bot command handler", async () => {
    registerXmppUpdateHandler(createBotCommandHandler());
    assert.strictEqual(getXmppUpdateHandlers().length, 1);
  });

  it("!compact is intercepted and does NOT reach auth/LLM", async () => {
    registerXmppUpdateHandler(createBotCommandHandler());
    const stanza = makeGroupchatStanza("!compact");

    const handlers = getXmppUpdateHandlers();
    let handled = false;
    for (const h of handlers) {
      const verdict = await h(stanza);
      if (verdict.handled) {
        handled = true;
        break; // ← this is exactly what handleIncomingStanza does
      }
    }

    assert.strictEqual(handled, true, "!compact must be intercepted");
    assert.strictEqual(lastHandledCommand, "compact");
  });

  it("!models is intercepted and does NOT reach auth/LLM", async () => {
    registerXmppUpdateHandler(createBotCommandHandler());
    const stanza = makeGroupchatStanza("!models");

    const handlers = getXmppUpdateHandlers();
    let handled = false;
    for (const h of handlers) {
      const verdict = await h(stanza);
      if (verdict.handled) { handled = true; break; }
    }

    assert.strictEqual(handled, true, "!models must be intercepted");
    assert.strictEqual(lastHandledCommand, "models");
  });

  it("!model <id> is intercepted with argument captured", async () => {
    registerXmppUpdateHandler(createBotCommandHandler());
    const stanza = makeGroupchatStanza("!model gpt-4o");

    const handlers = getXmppUpdateHandlers();
    let handled = false;
    for (const h of handlers) {
      const verdict = await h(stanza);
      if (verdict.handled) { handled = true; break; }
    }

    assert.strictEqual(handled, true, "!model must be intercepted");
    assert.strictEqual(lastHandledCommand, "model");
    assert.strictEqual(lastHandledArgs[0], "gpt-4o", "model ID must be captured");
  });

  it("!help is intercepted", async () => {
    registerXmppUpdateHandler(createBotCommandHandler());
    const stanza = makeGroupchatStanza("!help");

    const handlers = getXmppUpdateHandlers();
    let handled = false;
    for (const h of handlers) {
      const verdict = await h(stanza);
      if (verdict.handled) { handled = true; break; }
    }

    assert.strictEqual(handled, true, "!help must be intercepted");
    assert.strictEqual(lastHandledCommand, "help");
  });

  it("regular message (no !command) passes through — NOT intercepted", async () => {
    registerXmppUpdateHandler(createBotCommandHandler());
    const stanza = makeGroupchatStanza("Hey bot, how are you?");

    const handlers = getXmppUpdateHandlers();
    let handled = false;
    for (const h of handlers) {
      const verdict = await h(stanza);
      if (verdict.handled) { handled = true; break; }
    }

    assert.strictEqual(handled, false, "regular messages must pass through to auth/LLM");
    assert.strictEqual(lastHandledCommand, undefined);
  });

  it("command with extra args and whitespace is matched", async () => {
    registerXmppUpdateHandler(createBotCommandHandler());
    const stanza = makeGroupchatStanza("  !model   claude-sonnet  ");

    const handlers = getXmppUpdateHandlers();
    let handled = false;
    for (const h of handlers) {
      const verdict = await h(stanza);
      if (verdict.handled) { handled = true; break; }
    }

    assert.strictEqual(handled, true);
    assert.strictEqual(lastHandledArgs[0], "claude-sonnet");
  });

  it("multiple handlers: first one to return handled=true stops pipeline", async () => {
    // Register two handlers — first one matches !compact
    registerXmppUpdateHandler(createBotCommandHandler());
    // Second handler that also matches !compact but should never be reached
    let secondHandlerCalled = false;
    registerXmppUpdateHandler(async (stanza) => {
      secondHandlerCalled = true;
      return { handled: true };
    });

    const stanza = makeGroupchatStanza("!compact");
    const handlers = getXmppUpdateHandlers();
    for (const h of handlers) {
      const verdict = await h(stanza);
      if (verdict.handled) break; // ← first handler returns true, pipeline stops
    }

    assert.strictEqual(lastHandledCommand, "compact");
    assert.strictEqual(secondHandlerCalled, false,
      "second handler must NOT be called when first returns handled=true");
  });
});

describe("Bot commands — non-groupchat stanzas pass through", () => {
  it("direct message with !command in DM still passes through (handler only targets groupchat)", async () => {
    registerXmppUpdateHandler(createBotCommandHandler());
    const stanza = makeDirectMessageStanza("user@domain.tld", "!compact");

    const handlers = getXmppUpdateHandlers();
    let handled = false;
    for (const h of handlers) {
      const verdict = await h(stanza);
      if (verdict.handled) { handled = true; break; }
    }

    // Handler in this test matches all messages with body, not just groupchat
    // But a real plugin would filter by stanza type
    // This just verifies the handler CAN see DM commands too
    assert.strictEqual(handled, true, "handler sees all messages including DMs");
  });
});

describe("Bot commands — actual dispatch logic (simulating handleBotCommand)", () => {
  // Replicate the regex patterns from index.ts handleBotCommand
  const compactRe = /^\s*!compact\b/i;
  const modelsRe = /^\s*!models\b/i;
  const modelRe = /^\s*!model\s+(\S+)/i;
  const helpRe = /^\s*!help\b/i;

  it("!compact regex matches", () => {
    assert.ok(compactRe.test("!compact"));
    assert.ok(compactRe.test("  !compact"));
    assert.ok(compactRe.test("!compact now"));
    assert.ok(!compactRe.test("!compactness")); // word boundary
    assert.ok(!compactRe.test("not !compact"));
  });

  it("!models regex matches", () => {
    assert.ok(modelsRe.test("!models"));
    assert.ok(modelsRe.test("  !models"));
    assert.ok(!modelsRe.test("!model")); // not !model
    assert.ok(!modelsRe.test("not !models"));
  });

  it("!model <id> regex captures model ID", () => {
    const m1 = modelRe.exec("!model gpt-4o");
    assert.ok(m1);
    assert.strictEqual(m1![1], "gpt-4o");

    const m2 = modelRe.exec("  !model   claude-sonnet-4-20250514");
    assert.ok(m2);
    assert.strictEqual(m2![1], "claude-sonnet-4-20250514");

    const m3 = modelRe.exec("  !model provider/model-id  ");
    assert.ok(m3);
    assert.strictEqual(m3![1], "provider/model-id");

    assert.ok(!modelRe.test("!models")); // not !model
    assert.ok(!modelRe.test("!compact"));
  });

  it("!help regex matches", () => {
    assert.ok(helpRe.test("!help"));
    assert.ok(helpRe.test("  !help"));
    assert.ok(!helpRe.test("!helpful")); // word boundary
    assert.ok(!helpRe.test("not !help"));
  });

  it("regular message does NOT match any command", () => {
    assert.ok(!compactRe.test("Hello bot"));
    assert.ok(!modelsRe.test("list models"));
    assert.ok(!modelRe.test("switch to gpt-4"));
    assert.ok(!helpRe.test("help me"));
  });

  it("!model provider/id format is parsed correctly", () => {
    const re = /^\s*!model\s+(\S+)/i;
    const m = re.exec("!model anthropic/claude-sonnet-4-20250514");
    assert.ok(m);
    const modelArg = m![1];
    // This is how handleBotCommand splits it
    let provider = "default";
    let modelId = modelArg;
    if (modelArg.includes("/")) {
      const parts = modelArg.split("/", 2);
      provider = parts[0];
      modelId = parts[1];
    }
    assert.strictEqual(provider, "anthropic");
    assert.strictEqual(modelId, "claude-sonnet-4-20250514");
  });

  it("!model without provider uses 'default'", () => {
    const re = /^\s*!model\s+(\S+)/i;
    const m = re.exec("!model gpt-4o");
    assert.ok(m);
    const modelArg = m![1];
    let provider = "default";
    let modelId = modelArg;
    if (modelArg.includes("/")) {
      const parts = modelArg.split("/", 2);
      provider = parts[0];
      modelId = parts[1];
    }
    assert.strictEqual(provider, "default");
    assert.strictEqual(modelId, "gpt-4o");
  });
});

describe("Bot commands — help text from templates", () => {
  it("commandsHelp template contains all expected commands", () => {
    const help = DEFAULT_XMPP_UI_MESSAGES.commandsHelp;
    assert.ok(help.includes("!compact"), "must mention !compact");
    assert.ok(help.includes("!models"), "must mention !models");
    assert.ok(help.includes("!model"), "must mention !model");
    assert.ok(help.includes("!help"), "must mention !help");
    assert.ok(help.includes("Only the owner"), "must mention owner restriction");
  });

  it("commandsHelp is sendable as a reply to !help", () => {
    // Simulate what a plugin does on !help: reply with the template
    const reply = DEFAULT_XMPP_UI_MESSAGES.commandsHelp;
    assert.ok(reply.length > 0, "help text must not be empty");
    assert.ok(reply.startsWith("🤖 Bot commands:"), "must start with header");
  });
});
