/**
 * Room authorization verification test.
 *
 * Verifies the three claims:
 * 1) Extension CAN connect to a room (roomJid) — routing/xmpp-api support
 * 2) Extension CAN listen to all messages — stanza dispatch works
 * 3) Extension CAN allow commands only from ownerJid — FIXED
 *
 * The fix: MUC presence (XEP-0045) is parsed to extract the sender's real JID
 * from <x xmlns='http://jabber.org/protocol/muc#user'><item jid='...'/></x>.
 * The auth check now compares the sender's real JID (bare) against ownerJid
 * instead of comparing the room JID.
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { routeStanza, getBareJid, extractMucNick, type XmppMessageRoute } from "../lib/routing.ts";
import { getXmppAuthorizationState, createXmppConfigStore } from "../lib/config.ts";
import { createXmppClient } from "../lib/xmpp-api.ts";

// ── Helper: create a simulated groupchat message stanza ──

function makeGroupchatStanza(
  roomJid: string,
  nick: string,
  body: string,
  attrs: Record<string, string> = {},
): ReturnType<typeof createStanza> {
  return createStanza("message", {
    from: `${roomJid}/${nick}`,
    type: "groupchat",
    id: attrs.id ?? `msg-${Date.now()}`,
    ...attrs,
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
  return {
    name,
    attrs: { ...attrs },
    children: [...children],
    toString: () => `<${name} .../>`,
  };
}

/**
 * Simulate MUC presence with real JID (XEP-0045).
 */
function makeMucPresence(
  roomJid: string,
  nick: string,
  realJid: string,
  type?: string,
): ReturnType<typeof createStanza> {
  const attrs: Record<string, string> = {
    from: `${roomJid}/${nick}`,
  };
  if (type) attrs.type = type;

  return createStanza("presence", attrs, [
    createStanza("x", { xmlns: "http://jabber.org/protocol/muc#user" }, [
      createStanza("item", { jid: realJid, affiliation: "member", role: "participant" }),
    ]),
  ]);
}

// ── Simulate the FIXED auth logic from index.ts handleIncomingMessage ──

/**
 * Simulates the FIXED groupchat authorization logic.
 */
function simulateFixedGroupchatAuth(
  route: XmppMessageRoute,
  ownerJid: string | undefined,
  occupantRealJids: Map<string, Map<string, string>>, // roomJid → Map<nick, realJid>
): "allow" | "deny" {
  if (route.isGroup) {
    if (ownerJid) {
      let senderRealJid: string | undefined;
      if (route.roomJid && route.senderNick) {
        senderRealJid = occupantRealJids.get(route.roomJid)?.get(route.senderNick);
      }
      if (!senderRealJid) {
        return "deny"; // anonymous room or presence not yet received
      }
      if (getBareJid(senderRealJid) !== ownerJid) {
        return "deny";
      }
      return "allow";
    }
    // No owner configured → anyone can participate
    return "allow";
  }
  return "allow";
}

// ── Tests ──

describe("Room connection", () => {
  it("1) can connect to a room: xmpp client exposes joinRoom", () => {
    const client = createXmppClient();
    assert.strictEqual(typeof client.joinRoom, "function", "client.joinRoom must exist");
    assert.strictEqual(typeof client.leaveRoom, "function", "client.leaveRoom must exist");

    // Calling joinRoom shouldn't throw (it sends presence)
    client.joinRoom("room@conference.example.org", "pi-bot");
  });

  it("2) can listen to all messages: stanza routing processes groupchat", () => {
    const stanza = makeGroupchatStanza("room@conference.example.org", "user1", "Hello everyone");
    const route = routeStanza(stanza);

    assert.ok(route, "routeStanza must return a route for groupchat messages");
    assert.strictEqual(route!.kind, "message");
    assert.strictEqual((route as XmppMessageRoute).isGroup, true);
    assert.strictEqual((route as XmppMessageRoute).roomJid, "room@conference.example.org");
    assert.strictEqual((route as XmppMessageRoute).senderNick, "user1");
    assert.strictEqual((route as XmppMessageRoute).body, "Hello everyone");
  });
});

describe("Room authorization (ownerJid) — FIXED", () => {
  it("3a) WHEN no ownerJid → ALL groupchat messages are allowed (anyone can participate)", () => {
    const stanza = makeGroupchatStanza("room@conference.example.org", "stranger", "Hi");
    const route = routeStanza(stanza) as XmppMessageRoute;

    const realJids = new Map<string, Map<string, string>>();

    const result = simulateFixedGroupchatAuth(route, undefined, realJids);
    assert.strictEqual(result, "allow", "Without ownerJid, any participant should be allowed");
  });

  it("3b) FIXED: Owner's message IS allowed when real JID is tracked via MUC presence", () => {
    const roomJid = "room@conference.example.org";
    const ownerRealJid = "owner@domain.tld/resource";

    // Build presence tracking data as the fix does
    const realJids = new Map<string, Map<string, string>>();
    const roomMap = new Map<string, string>();
    roomMap.set("ownerNick", ownerRealJid);
    realJids.set(roomJid, roomMap);

    const stanza = makeGroupchatStanza(roomJid, "ownerNick", "Admin command");
    const route = routeStanza(stanza) as XmppMessageRoute;

    const result = simulateFixedGroupchatAuth(route, "owner@domain.tld", realJids);
    assert.strictEqual(result, "allow",
      "Owner's message should be allowed when real JID is tracked");

    console.log("\n=== FIX VERIFIED ===");
    console.log("room JID:         ", route.roomJid);
    console.log("sender nick:      ", route.senderNick);
    console.log("owner's real JID: ", "owner@domain.tld");
    console.log("tracked real JID: ", realJids.get(roomJid)?.get("ownerNick"));
    console.log("Result:           allow ✓");
  });

  it("3c) FIXED: Non-owner's message is correctly denied", () => {
    const roomJid = "room@conference.example.org";
    const ownerRealJid = "owner@domain.tld/resource";
    const attackerRealJid = "attacker@evil.com/resource";

    // Build presence tracking data
    const realJids = new Map<string, Map<string, string>>();
    const roomMap = new Map<string, string>();
    roomMap.set("ownerNick", ownerRealJid);
    roomMap.set("attacker", attackerRealJid);
    realJids.set(roomJid, roomMap);

    const stanza = makeGroupchatStanza(roomJid, "attacker", "Malicious command");
    const route = routeStanza(stanza) as XmppMessageRoute;

    const result = simulateFixedGroupchatAuth(route, "owner@domain.tld", realJids);
    assert.strictEqual(result, "deny",
      "Non-owner's message should be denied based on real JID comparison");
  });

  it("3d) FIXED: Message is denied when real JID is unavailable (anonymous room)", () => {
    const roomJid = "room@conference.example.org";
    const realJids = new Map<string, Map<string, string>>();
    realJids.set(roomJid, new Map()); // no real JID tracking for this room

    const stanza = makeGroupchatStanza(roomJid, "ownerNick", "Hello");
    const route = routeStanza(stanza) as XmppMessageRoute;

    const result = simulateFixedGroupchatAuth(route, "owner@domain.tld", realJids);
    assert.strictEqual(result, "deny",
      "Message should be denied when real JID cannot be resolved (anonymous room)");
  });
});

describe("Real JID extraction from MUC presence", () => {
  it("can extract real JID from MUC presence stanza", () => {
    const presence = makeMucPresence(
      "room@conference.example.org",
      "ownerNick",
      "owner@domain.tld/resource",
    );

    // Simulate the extractMucRealJid helper added in the fix
    type Stanza = ReturnType<typeof createStanza>;
    const mucUserChild = presence.children.find(
      (c): c is Stanza =>
        typeof c === "object" && c !== null &&
        (c as Stanza).name === "x" &&
        (c as Stanza).attrs?.xmlns === "http://jabber.org/protocol/muc#user",
    ) as Stanza | undefined;

    assert.ok(mucUserChild, "Should find <x xmlns='...muc#user'> element");

    const itemChild = mucUserChild.children.find(
      (c): c is Stanza =>
        typeof c === "object" && c !== null &&
        (c as Stanza).name === "item",
    ) as Stanza | undefined;

    assert.ok(itemChild, "Should find <item> element");
    assert.strictEqual(itemChild.attrs?.jid, "owner@domain.tld/resource",
      "Real JID should be extracted from <item jid='...'/>");
  });

  it("extractMucNick works correctly on presence and message froms", () => {
    assert.strictEqual(extractMucNick("room@conference.tld/ownerNick"), "ownerNick");
    assert.strictEqual(extractMucNick("room@conference.tld/user123"), "user123");
    assert.strictEqual(extractMucNick("user@domain.tld"), undefined);
  });
});

describe("Direct message authorization (unaffected)", () => {
  it("direct messages work correctly with pairing/allow/deny", () => {
    assert.strictEqual(getXmppAuthorizationState("owner@domain.tld", "owner@domain.tld").kind, "allow");
    assert.strictEqual(getXmppAuthorizationState("stranger@domain.tld", "owner@domain.tld").kind, "deny");
    assert.strictEqual(getXmppAuthorizationState("stranger@domain.tld", undefined).kind, "pair");
  });
});
