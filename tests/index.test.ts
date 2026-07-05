import { describe, it } from "node:test";
import assert from "node:assert";
import { getBareJid, extractMucNick, isRoomJid, buildXmppPrefix, XMPP_PREFIX } from "../lib/routing.ts";
import { normalizeJid, getXmppAuthorizationState, createXmppConfigStore, resolveXmppTimeConfig } from "../lib/config.ts";
import { buildXmppTurnPrompt } from "../lib/queue.ts";
import { createXmppClient } from "../lib/xmpp-api.ts";
import { createXmppBridgeRuntime } from "../lib/runtime.ts";
import { createXmppRuntimeEventRecorder, formatXmppStatusSummary } from "../lib/status.ts";
import { createCurrentModelStore } from "../lib/model.ts";

describe("routing", () => {
  it("getBareJid strips resource", () => {
    assert.strictEqual(getBareJid("user@domain.tld/resource"), "user@domain.tld");
    assert.strictEqual(getBareJid("user@domain.tld"), "user@domain.tld");
  });

  it("extractMucNick extracts nickname", () => {
    assert.strictEqual(extractMucNick("room@conference.tld/nick"), "nick");
    assert.strictEqual(extractMucNick("user@domain.tld"), undefined);
  });

  it("isRoomJid detects conference rooms", () => {
    assert.strictEqual(isRoomJid("room@conference.example.org"), true);
    assert.strictEqual(isRoomJid("user@example.org"), false);
  });

  it("XMPP_PREFIX is correct", () => {
    assert.strictEqual(XMPP_PREFIX, "[xmpp");
  });
});

describe("config", () => {
  it("normalizeJid removes resource", () => {
    assert.strictEqual(normalizeJid("user@domain.tld/resource"), "user@domain.tld");
    assert.strictEqual(normalizeJid("user@domain.tld"), "user@domain.tld");
  });

  it("getXmppAuthorizationState returns correct states", () => {
    const pair = getXmppAuthorizationState("user@domain.tld", undefined);
    assert.strictEqual(pair.kind, "pair");

    const allow = getXmppAuthorizationState("user@domain.tld", "user@domain.tld");
    assert.strictEqual(allow.kind, "allow");

    const deny = getXmppAuthorizationState("other@domain.tld", "user@domain.tld");
    assert.strictEqual(deny.kind, "deny");
  });

  it("createXmppConfigStore works", () => {
    const store = createXmppConfigStore({
      initialConfig: { jid: "test@domain.tld", password: "secret" },
    });
    assert.strictEqual(store.getJid(), "test@domain.tld");
    assert.strictEqual(store.hasJid(), true);
  });

  it("resolveXmppTimeConfig defaults", () => {
    const resolved = resolveXmppTimeConfig(undefined);
    assert.strictEqual(resolved.injectionMode, "hidden");
    assert.strictEqual(resolved.interval, 3600000);
  });
});

describe("queue", () => {
  it("buildXmppTurnPrompt builds correct prompt", () => {
    const prompt = buildXmppTurnPrompt({
      from: "user@domain.tld/resource",
      fromBare: "user@domain.tld",
      body: "Hello world",
      type: "chat",
      isGroup: false,
      timestamp: Date.now(),
    });
    assert.match(prompt, /\[xmpp\|from:user@domain\.tld\/resource\]/);
    assert.match(prompt, /Hello world/);
  });

  it("buildXmppTurnPrompt includes room/group info", () => {
    const prompt = buildXmppTurnPrompt({
      from: "room@conference.tld/nick",
      fromBare: "room@conference.tld",
      body: "Hello room",
      type: "groupchat",
      isGroup: true,
      roomJid: "room@conference.tld",
      senderNick: "nick",
      timestamp: Date.now(),
    });
    assert.match(prompt, /\[room:room@conference\.tld\]/);
    assert.match(prompt, /\[nick:nick\]/);
    assert.match(prompt, /Hello room/);
  });
});

describe("runtime", () => {
  it("createXmppBridgeRuntime produces correct ports", () => {
    const runtime = createXmppBridgeRuntime();
    assert.strictEqual(typeof runtime.queue.allocateItemOrder, "function");
    assert.strictEqual(typeof runtime.abort.setHandler, "function");
    assert.strictEqual(typeof runtime.lifecycle.setDispatchPending, "function");
    assert.strictEqual(runtime.lifecycle.hasDispatchPending(), false);
  });

  it("abort handler works", () => {
    const runtime = createXmppBridgeRuntime();
    let aborted = false;
    runtime.abort.setHandler(() => { aborted = true; });
    assert.strictEqual(runtime.abort.hasHandler(), true);
    runtime.abort.abortTurn();
    assert.strictEqual(aborted, true);
    assert.strictEqual(runtime.abort.hasHandler(), false);
  });
});

describe("status", () => {
  it("createXmppRuntimeEventRecorder records and retrieves events", () => {
    const recorder = createXmppRuntimeEventRecorder();
    recorder.record("test", null, { detail: "value" });
    recorder.record("error", new Error("something failed"));
    const events = recorder.getEvents();
    assert.strictEqual(events.length, 2);
    assert.strictEqual(events[0].category, "test");
    assert.strictEqual(events[1].error, "something failed");
  });

  it("formatXmppStatusSummary produces output", () => {
    const summary = formatXmppStatusSummary({
      config: { jid: "user@domain.tld" },
      connectionStatus: "online",
      connectedJid: "user@domain.tld/full",
      ownerJid: "user@domain.tld",
      activeTurnFrom: "user@domain.tld",
      queuedCount: 2,
      runtimeEvents: [],
    });
    assert.match(summary, /XMPP Bridge Status/);
    assert.match(summary, /online/);
  });
});

describe("model", () => {
  it("createCurrentModelStore stores and retrieves", () => {
    const store = createCurrentModelStore((_ctx: unknown) => undefined);
    assert.strictEqual(store.getStored(), undefined);
    store.set({ provider: "test", id: "model-1" });
    assert.strictEqual(store.getStored()?.id, "model-1");
  });
});

describe("xmpp-api", () => {
  it("createXmppClient returns client interface", () => {
    const client = createXmppClient();
    assert.strictEqual(client.status, "offline");
    assert.strictEqual(client.jid, undefined);
    assert.strictEqual(typeof client.connect, "function");
    assert.strictEqual(typeof client.disconnect, "function");
    assert.strictEqual(typeof client.send, "function");
    assert.strictEqual(typeof client.sendMessage, "function");
    assert.strictEqual(typeof client.sendPresence, "function");
  });
});
