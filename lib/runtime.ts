/**
 * XMPP bridge runtime-state helpers
 * Zones: pi agent runtime state, xmpp session, shared coordination
 * Owns small session-local runtime primitives shared by orchestration
 */

const XMPP_TYPING_LABEL_INTERVAL_MS = 2500;

export interface XmppRuntimeQueueCounters {
  nextQueuedXmppItemOrder: number;
  nextQueuedXmppControlOrder: number;
}

export interface XmppRuntimeLifecycleFlags {
  activeXmppToolExecutions: number;
  xmppTurnDispatchPending: boolean;
  compactionInProgress: boolean;
}

export interface XmppBridgeRuntimeState
  extends XmppRuntimeQueueCounters, XmppRuntimeLifecycleFlags {
  abortHandler?: () => void;
  chatStateInterval?: ReturnType<typeof setInterval>;
}

export interface XmppRuntimeQueuePort {
  allocateItemOrder: () => number;
  allocateControlOrder: () => number;
}

export interface XmppRuntimeLifecyclePort {
  getActiveToolExecutions: () => number;
  setActiveToolExecutions: (count: number) => void;
  resetActiveToolExecutions: () => void;
  hasDispatchPending: () => boolean;
  setDispatchPending: (pending: boolean) => void;
  clearDispatchPending: () => void;
  isCompactionInProgress: () => boolean;
  setCompactionInProgress: (inProgress: boolean) => void;
}

export interface XmppRuntimeAbortPort {
  hasHandler: () => boolean;
  setHandler: (abortHandler: () => void) => void;
  clearHandler: () => void;
  getHandler: () => (() => void) | undefined;
  abortTurn: () => boolean;
}

export interface XmppBridgeRuntime {
  state: XmppBridgeRuntimeState;
  queue: XmppRuntimeQueuePort;
  lifecycle: XmppRuntimeLifecyclePort;
  abort: XmppRuntimeAbortPort;
}

export function createXmppBridgeRuntimeState(): XmppBridgeRuntimeState {
  return {
    nextQueuedXmppItemOrder: 0,
    nextQueuedXmppControlOrder: 0,
    activeXmppToolExecutions: 0,
    xmppTurnDispatchPending: false,
    compactionInProgress: false,
  };
}

export function createXmppBridgeRuntime(
  state = createXmppBridgeRuntimeState(),
): XmppBridgeRuntime {
  return {
    state,
    queue: {
      allocateItemOrder: () => state.nextQueuedXmppItemOrder++,
      allocateControlOrder: () => state.nextQueuedXmppControlOrder++,
    },
    lifecycle: {
      getActiveToolExecutions: () => state.activeXmppToolExecutions,
      setActiveToolExecutions: (count) => {
        state.activeXmppToolExecutions = count;
      },
      resetActiveToolExecutions: () => {
        state.activeXmppToolExecutions = 0;
      },
      hasDispatchPending: () => state.xmppTurnDispatchPending,
      setDispatchPending: (pending) => {
        state.xmppTurnDispatchPending = pending;
      },
      clearDispatchPending: () => {
        state.xmppTurnDispatchPending = false;
      },
      isCompactionInProgress: () => state.compactionInProgress,
      setCompactionInProgress: (inProgress) => {
        state.compactionInProgress = inProgress;
      },
    },
    abort: {
      hasHandler: () => typeof state.abortHandler === "function",
      setHandler: (abortHandler) => {
        state.abortHandler = abortHandler;
      },
      clearHandler: () => {
        state.abortHandler = undefined;
      },
      getHandler: () => state.abortHandler,
      abortTurn: () => {
        if (typeof state.abortHandler === "function") {
          state.abortHandler();
          state.abortHandler = undefined;
          return true;
        }
        return false;
      },
    },
  };
}

export function createXmppChatStateSender(
  sendChatState: (to: string, state: string) => void,
  getActiveTurnTarget: () => string | undefined,
) {
  let interval: ReturnType<typeof setInterval> | undefined;

  return {
    start: (jid: string) => {
      sendChatState(jid, "active");
      interval = setInterval(() => {
        const target = getActiveTurnTarget();
        if (target) sendChatState(target, "active");
      }, XMPP_TYPING_LABEL_INTERVAL_MS);
    },
    stop: () => {
      const target = getActiveTurnTarget();
      if (target) sendChatState(target, "inactive");
      if (interval) {
        clearInterval(interval);
        interval = undefined;
      }
    },
    pause: () => {
      const target = getActiveTurnTarget();
      if (target) sendChatState(target, "paused");
      if (interval) {
        clearInterval(interval);
        interval = undefined;
      }
    },
  };
}
