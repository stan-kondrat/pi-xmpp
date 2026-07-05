/**
 * Type declarations for @xmpp/client
 */

declare module "@xmpp/client" {
  export interface XmppClientOptions {
    service: string;
    domain?: string;
    username?: string;
    password?: string;
    resource?: string;
    credentials?: { username: string; password: string };
  }

  export interface XmppJid {
    local: string;
    domain: string;
    resource: string;
    toString(): string;
    bare(): string;
  }

  export interface XmppEntity {
    reconnect: {
      delay: number;
    };
  }

  export interface XmppStreamFeatures {
    register: (features: unknown) => void;
  }

  export interface XmppClient {
    jid?: XmppJid;
    status: string;
    options: XmppClientOptions;
    entity: XmppEntity;
    reconnect: { delay: number };
    start(): Promise<void>;
    stop(): Promise<void>;
    send(stanza: unknown): Promise<void>;
    on(event: "status", handler: (status: string) => void): void;
    on(event: "error", handler: (error: Error) => void): void;
    on(event: "online", handler: (jid: XmppJid) => void): void;
    on(event: "offline", handler: () => void): void;
    on(event: "stanza", handler: (stanza: unknown) => void): void;
    on(event: string, handler: (...args: unknown[]) => void): void;
  }

  export function client(options: XmppClientOptions): XmppClient;

  export function xml(
    name: string,
    attrs?: Record<string, string>,
    ...children: (string | ReturnType<typeof xml>)[]
  ): ReturnType<typeof xml>;

  export function jid(jid: string): XmppJid;
}
