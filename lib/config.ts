/**
 * XMPP bridge config and pairing helpers
 * Zones: xmpp config, pairing, filesystem
 * Owns persisted JID/session pairing state, local config storage, live config controls, and first-user pairing side effects
 */

import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rename, rmdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

// ── Auto-connect lock ──
// Prevents multiple Pi instances from auto-connecting the same account.
// Uses an atomic mkdir as a filesystem lock.

const AUTO_CONNECT_LOCK = "xmpp-auto-connect.lock";

function getLockDir(accountName: string, agentDir?: string): string {
  return join(agentDir ?? getAgentDir(), AUTO_CONNECT_LOCK, accountName);
}

/**
 * Try to acquire the auto-connect lock for a specific account atomically.
 * Uses a per-account directory so different instances can auto-connect
 * different accounts simultaneously.
 * Returns true if this instance got the lock (should auto-connect).
 * Returns false if another instance holds it (skip auto-connect).
 */
export async function tryAcquireAutoConnectLock(
  accountName: string,
  agentDir?: string,
): Promise<boolean> {
  const lockDir = getLockDir(accountName, agentDir);
  await mkdir(resolve(lockDir, ".."), { recursive: true }); // ensure parent exists
  try {
    await mkdir(lockDir);
    return true;
  } catch {
    return false; // another instance holds the lock for this account
  }
}

/**
 * Release the auto-connect lock for a specific account.
 */
export async function releaseAutoConnectLock(
  accountName: string,
  agentDir?: string,
): Promise<void> {
  try {
    await rmdir(getLockDir(accountName, agentDir));
  } catch {
    // lock may already be gone
  }
}

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

/**
 * Per-account XMPP configuration.
 */
export interface XmppAccountConfig {
  name?: string;
  jid?: string;
  password?: string;
  service?: string;
  domain?: string;
  /** JID authorized to send commands (only this JID's messages are processed).
   *  When unset in a groupchat, all participants may send messages.
   *  When unset in DMs, the first sender is auto-paired. */
  ownerJid?: string;
  autoReconnect?: boolean;
  /** Auto-connect this account on startup (default: false) */
  autoConnect?: boolean;
  /** Single MUC room JID to auto-join on connect */
  roomJid?: string;
  inboundHandlers?: XmppInboundHandlerConfig[];
  outboundHandlers?: XmppOutboundHandlerConfig[];
  time?: XmppTimeConfig;
}

/** Active account config, resolved via XmppConfigStore.get(). */
export interface XmppConfig extends XmppAccountConfig {}

/**
 * Top-level file format for ~/.pi/agent/xmpp.json.
 * Key-value object where each key is an account name.
 * The special key "default" is the default account (auto-connected, used by /xmpp-connect without args).
 *
 * Also supports legacy flat format: { "jid": "...", "password": "...", ... }
 * which normalises to { "default": { "jid": "...", ... } }.
 */
export type XmppAccountsFile = Record<string, XmppAccountConfig | undefined>;

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
  /** Get the active account config */
  get: () => XmppAccountConfig;
  /** Set the active account config */
  set: (config: XmppAccountConfig) => void;
  update: (mutate: (config: XmppAccountConfig) => void) => void;
  /** Get all configured accounts */
  getAccounts: () => XmppAccountConfig[];
  /** Get the default account (by name, or first, or undefined) */
  getDefaultAccount: () => XmppAccountConfig | undefined;
  /** Look up an account by name */
  getAccountByName: (name: string) => XmppAccountConfig | undefined;
  /** Switch the active account to one from the list */
  setActiveAccount: (nameOrConfig: string | XmppAccountConfig) => void;
  /** Get name of the active account */
  getActiveAccountName: () => string | undefined;
  /** Whether auto-connect is enabled */
  getAutoConnect: () => boolean;
  getJid: () => string | undefined;
  hasJid: () => boolean;
  /** Get the owner JID for the active account */
  getOwnerJid: () => string | undefined;
  /** Set the owner JID on the active account */
  setOwnerJid: (jid: string) => void;
  getInboundHandlers: () => XmppInboundHandlerConfig[] | undefined;
  getOutboundHandlers: () => XmppOutboundHandlerConfig[] | undefined;
  load: () => Promise<void>;
  persist: (config?: XmppAccountsFile) => Promise<void>;
}

export interface XmppConfigStoreOptions {
  initialConfig?: XmppAccountConfig;
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

function isEmptyXmppConfig(config: XmppAccountConfig): boolean {
  return Object.keys(config).length === 0;
}

function getInvalidXmppConfigRecoveryPath(configPath: string): string {
  return `${configPath}.invalid-${process.pid}-${Date.now()}`;
}

/**
 * Check if a value looks like a legacy flat config (has XMPP fields at top level).
 */
function isLegacyFlatConfig(value: Record<string, unknown>): boolean {
  return typeof value.jid === "string" || typeof value.password === "string";
}

/**
 * Normalize a loaded file into the keyed-accounts format.
 * Handles:
 *   { "default": { ... }, "work": { ... } }          — keyed format
 *   { "jid": "...", "password": "...", ... }          — legacy flat -> { "default": { ... } }
 */
function normalizeAccountsFile(raw: Record<string, unknown>): {
  accounts: Map<string, XmppAccountConfig>;
  defaultName: string | undefined;
} {
  const accounts = new Map<string, XmppAccountConfig>();
  let defaultName: string | undefined;

  if (isLegacyFlatConfig(raw)) {
    // Legacy flat format — wrap into "default"
    const account: XmppAccountConfig = {};
    const f = raw as Record<string, unknown>;
    if (typeof f.jid === "string") account.jid = f.jid;
    if (typeof f.password === "string") account.password = f.password;
    if (typeof f.service === "string") account.service = f.service;
    if (typeof f.domain === "string") account.domain = f.domain;
    if (typeof f.ownerJid === "string") account.ownerJid = f.ownerJid;

    if (typeof f.autoReconnect === "boolean") account.autoReconnect = f.autoReconnect;
    if (typeof f.autoConnect === "boolean") account.autoConnect = f.autoConnect;
    // Backward compat: legacy auto → autoConnect
    else if (typeof f.auto === "boolean") account.autoConnect = f.auto;
    // Backward compat: legacy autoJoinRoom → roomJid
    if (typeof f.roomJid === "string") account.roomJid = f.roomJid;
    else if (typeof f.autoJoinRoom === "string") account.roomJid = f.autoJoinRoom;

    if (Object.keys(account).length > 0) {
      accounts.set("default", account);
      defaultName = "default";
    }
    return { accounts, defaultName };
  }

  // Keyed format: each key is an account name
  for (const [key, value] of Object.entries(raw)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const obj = value as Record<string, unknown>;
    // Skip non-account keys (legacy flat leftovers that happen to be objects)
    if (typeof obj.jid !== "string" && typeof obj.password !== "string") continue;

    const account: XmppAccountConfig = {};
    if (typeof obj.jid === "string") account.jid = obj.jid;
    if (typeof obj.password === "string") account.password = obj.password;
    if (typeof obj.service === "string") account.service = obj.service;
    if (typeof obj.domain === "string") account.domain = obj.domain;
    if (typeof obj.ownerJid === "string") account.ownerJid = obj.ownerJid;

    if (typeof obj.autoReconnect === "boolean") account.autoReconnect = obj.autoReconnect;
    if (typeof obj.autoConnect === "boolean") account.autoConnect = obj.autoConnect;
    // Backward compat: legacy auto → autoConnect
    else if (typeof obj.auto === "boolean") account.autoConnect = obj.auto;
    // Backward compat: legacy autoJoinRoom → roomJid
    if (typeof obj.roomJid === "string") account.roomJid = obj.roomJid;
    else if (typeof obj.autoJoinRoom === "string") account.roomJid = obj.autoJoinRoom;

    accounts.set(key, account);
  }

  // Determine default: if "default" key exists, it's the default. Otherwise first account.
  if (accounts.has("default")) {
    defaultName = "default";
  } else if (accounts.size > 0) {
    defaultName = accounts.keys().next().value;
  }

  return { accounts, defaultName };
}

/**
 * Read and normalize the config file.
 */
export async function readXmppConfig(
  configPath: string,
  options: {
    onInvalidConfig?: (recovery: XmppInvalidConfigRecovery) => void;
  } = {},
): Promise<{ raw: Record<string, unknown>; accounts: Map<string, XmppAccountConfig>; defaultName: string | undefined }> {
  if (!existsSync(configPath)) return { raw: {}, accounts: new Map(), defaultName: undefined };
  const content = await readFile(configPath, "utf8");
  try {
    const raw = JSON.parse(content) as Record<string, unknown>;
    const normalized = normalizeAccountsFile(raw);
    return { raw, ...normalized };
  } catch (error) {
    const recoveryPath = getInvalidXmppConfigRecoveryPath(configPath);
    await rename(configPath, recoveryPath);
    options.onInvalidConfig?.({ configPath, recoveryPath, error });
    return { raw: {}, accounts: new Map(), defaultName: undefined };
  }
}

/**
 * Build a persistable XmppAccountsFile (keyed-object) from the store state.
 */
function buildPersistableFile(
  accountsMap: Map<string, XmppAccountConfig>,
): XmppAccountsFile {
  const file: XmppAccountsFile = {};
  // Single unnamed account → write as legacy flat format for backward compat
  if (accountsMap.size === 1 && accountsMap.has("default") && !accountsMap.get("default")?.jid) {
    // Empty — just return
    return file;
  }

  for (const [name, account] of accountsMap) {
    if (Object.keys(account).length === 0) continue;
    file[name] = { ...account };
    // Remove the in-memory-only name field if present
    delete (file[name] as Record<string, unknown>).name;
  }

  return file;
}

export async function writeXmppConfig(
  agentDir: string,
  configPath: string,
  config: XmppAccountsFile,
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

function resolveOwnerJid(account: XmppAccountConfig): string | undefined {
  return account.ownerJid;
}

export function createXmppConfigStore(
  options: XmppConfigStoreOptions = {},
): XmppConfigStore {
  const initial = options.initialConfig;
  let accountsMap = new Map<string, XmppAccountConfig>(
    initial && Object.keys(initial).length > 0
      ? [["default", { ...initial }]]
      : [],
  );
  let defaultName: string | undefined = accountsMap.has("default") ? "default" : undefined;
  let activeName: string | undefined = defaultName;
  const agentDir = options.agentDir ?? getAgentDir();
  const configPath = options.configPath ?? getConfigPath();

  function getActive(): XmppAccountConfig {
    if (activeName && accountsMap.has(activeName)) {
      return accountsMap.get(activeName)!;
    }
    return {};
  }

  return {
    get: () => getActive(),
    set: (nextConfig) => {
      const name = activeName ?? nextConfig.name ?? "default";
      accountsMap.set(name, nextConfig);
      activeName = name;
      if (!defaultName) defaultName = name;
    },
    update: (mutate) => {
      const active = getActive();
      if (Object.keys(active).length > 0 || activeName) {
        const name = activeName ?? "default";
        const updated = { ...active };
        mutate(updated);
        accountsMap.set(name, updated);
      }
    },
    getAccounts: () => {
      const result: XmppAccountConfig[] = [];
      for (const [name, account] of accountsMap) {
        result.push({ ...account, name });
      }
      return result;
    },
    getDefaultAccount: () => {
      if (defaultName && accountsMap.has(defaultName)) {
        return { ...accountsMap.get(defaultName)!, name: defaultName };
      }
      if (accountsMap.size > 0) {
        const firstName = accountsMap.keys().next().value as string;
        return { ...accountsMap.get(firstName)!, name: firstName };
      }
      return undefined;
    },
    getAccountByName: (name) => {
      const account = accountsMap.get(name);
      return account ? { ...account, name } : undefined;
    },
    setActiveAccount: (nameOrConfig) => {
      if (typeof nameOrConfig === "string") {
        if (accountsMap.has(nameOrConfig)) {
          activeName = nameOrConfig;
        }
      } else {
        const name = nameOrConfig.name ?? "default";
        accountsMap.set(name, nameOrConfig);
        activeName = name;
      }
    },
    getActiveAccountName: () => activeName,
    getAutoConnect: () => {
      const active = getActive();
      return active.autoConnect === true;
    },
    getJid: () => getActive().jid,
    hasJid: () => !!getActive().jid,
    getOwnerJid: () => resolveOwnerJid(getActive()),
    setOwnerJid: (jid) => {
      const active = getActive();
      if (Object.keys(active).length > 0 || activeName) {
        accountsMap.set(activeName ?? "default", { ...active, ownerJid: jid });
      }
    },
    getInboundHandlers: () => getActive().inboundHandlers,
    getOutboundHandlers: () => getActive().outboundHandlers,
    load: async () => {
      const result = await readXmppConfig(configPath, {
        onInvalidConfig: (recovery) => {
          options.recordRuntimeEvent?.("config", recovery.error, {
            phase: "load",
            configPath: recovery.configPath,
            recoveryPath: recovery.recoveryPath,
          });
        },
      });
      accountsMap = result.accounts;
      defaultName = result.defaultName;
      activeName = defaultName;
    },
    persist: async () => {
      const file = buildPersistableFile(accountsMap);
      await writeXmppConfig(agentDir, configPath, file);
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
