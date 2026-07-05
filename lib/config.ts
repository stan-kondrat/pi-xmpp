/**
 * XMPP bridge config and pairing helpers
 * Zones: xmpp config, pairing, filesystem
 * Owns persisted JID/session pairing state, local config storage, live config controls, and first-user pairing side effects
 */

import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

function getAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR
    ? resolve(process.env.PI_CODING_AGENT_DIR)
    : join(homedir(), ".pi", "agent");
}

function getConfigPath(): string {
  return join(getAgentDir(), "xmpp.json");
}

export interface XmppTimeConfig {
  injectionMode?: "hidden" | "always" | "interval";
  interval?: number;
}

export interface ResolvedXmppTimeConfig {
  injectionMode: "hidden" | "always" | "interval";
  interval: number;
  timezone: string;
}

export interface XmppConfig {
  jid?: string;
  password?: string;
  service?: string;
  domain?: string;
  resource?: string;
  allowedJid?: string;
  autoReconnect?: boolean;
  autoJoinRooms?: string[];
  inboundHandlers?: XmppInboundHandlerConfig[];
  outboundHandlers?: XmppOutboundHandlerConfig[];
  time?: XmppTimeConfig;
}

export interface XmppInboundHandlerConfig {
  match?: string | string[];
  type?: string | string[];
  template?: string | string[];
  args?: string[];
  defaults?: Record<string, unknown>;
  timeout?: number | string;
}

export interface XmppOutboundHandlerConfig {
  type?: string;
  match?: string | string[];
  output?: string;
  timeout?: number | string;
}

export interface XmppConfigStore {
  get: () => XmppConfig;
  set: (config: XmppConfig) => void;
  update: (mutate: (config: XmppConfig) => void) => void;
  getJid: () => string | undefined;
  hasJid: () => boolean;
  getAllowedJid: () => string | undefined;
  getInboundHandlers: () => XmppInboundHandlerConfig[] | undefined;
  getOutboundHandlers: () => XmppOutboundHandlerConfig[] | undefined;
  setAllowedJid: (jid: string) => void;
  load: () => Promise<void>;
  persist: (config?: XmppConfig) => Promise<void>;
}

export interface XmppConfigStoreOptions {
  initialConfig?: XmppConfig;
  agentDir?: string;
  configPath?: string;
  recordRuntimeEvent?: (
    category: string,
    error: unknown,
    details?: Record<string, unknown>,
  ) => void;
}

export interface XmppInvalidConfigRecovery {
  configPath: string;
  recoveryPath: string;
  error: unknown;
}

function isEmptyXmppConfig(config: XmppConfig): boolean {
  return Object.keys(config).length === 0;
}

function getInvalidXmppConfigRecoveryPath(configPath: string): string {
  return `${configPath}.invalid-${process.pid}-${Date.now()}`;
}

export async function readXmppConfig(
  configPath: string,
  options: {
    onInvalidConfig?: (recovery: XmppInvalidConfigRecovery) => void;
  } = {},
): Promise<XmppConfig> {
  if (!existsSync(configPath)) return {};
  const content = await readFile(configPath, "utf8");
  try {
    return JSON.parse(content) as XmppConfig;
  } catch (error) {
    const recoveryPath = getInvalidXmppConfigRecoveryPath(configPath);
    await rename(configPath, recoveryPath);
    options.onInvalidConfig?.({ configPath, recoveryPath, error });
    return {};
  }
}

export async function writeXmppConfig(
  agentDir: string,
  configPath: string,
  config: XmppConfig,
): Promise<void> {
  await mkdir(agentDir, { recursive: true });
  const tempConfigPath = `${configPath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tempConfigPath, JSON.stringify(config, null, "\t") + "\n", {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(tempConfigPath, 0o600);
  await rename(tempConfigPath, configPath);
  await chmod(configPath, 0o600);
}

export function createXmppConfigStore(
  options: XmppConfigStoreOptions = {},
): XmppConfigStore {
  let config: XmppConfig = options.initialConfig ?? {};
  const agentDir = options.agentDir ?? getAgentDir();
  const configPath = options.configPath ?? getConfigPath();
  return {
    get: () => config,
    set: (nextConfig) => {
      config = nextConfig;
    },
    update: (mutate) => {
      mutate(config);
    },
    getJid: () => config.jid,
    hasJid: () => !!config.jid,
    getAllowedJid: () => config.allowedJid,
    getInboundHandlers: () => config.inboundHandlers,
    getOutboundHandlers: () => config.outboundHandlers,
    setAllowedJid: (jid) => {
      config.allowedJid = jid;
    },
    load: async () => {
      config = await readXmppConfig(configPath, {
        onInvalidConfig: (recovery) => {
          options.recordRuntimeEvent?.("config", recovery.error, {
            phase: "load",
            configPath: recovery.configPath,
            recoveryPath: recovery.recoveryPath,
          });
        },
      });
    },
    persist: async (nextConfig = config) => {
      await writeXmppConfig(agentDir, configPath, nextConfig);
    },
  };
}

function getSystemTimezone(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return tz && tz.length > 0 ? tz : "UTC";
  } catch {
    return "UTC";
  }
}

export function resolveXmppTimeConfig(
  raw: XmppTimeConfig | undefined,
): ResolvedXmppTimeConfig {
  const injectionMode: "hidden" | "always" | "interval" =
    raw?.injectionMode === "always" || raw?.injectionMode === "interval"
      ? raw.injectionMode
      : "hidden";
  const interval =
    typeof raw?.interval === "number" && raw.interval > 0
      ? raw.interval
      : 60 * 60 * 1000;
  const timezone = getSystemTimezone();
  return { injectionMode, interval, timezone };
}

export interface XmppAuthorizationState {
  kind: "pair" | "allow" | "deny";
  jid?: string;
}

export function getXmppAuthorizationState(
  fromJid: string,
  allowedJid?: string,
): XmppAuthorizationState {
  if (allowedJid === undefined) {
    return { kind: "pair", jid: fromJid };
  }
  if (fromJid === allowedJid) {
    return { kind: "allow" };
  }
  return { kind: "deny" };
}

export function normalizeJid(jid: string): string {
  // Remove resource part for comparison
  const idx = jid.indexOf("/");
  return idx >= 0 ? jid.slice(0, idx) : jid;
}
