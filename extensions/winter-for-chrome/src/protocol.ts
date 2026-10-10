// Winter for Chrome — the protocol numbers and message shapes it shares with Winter. The written contract is
// apple/ComputerUse/WinterBrowserHost/PROTOCOL.md; the two numbers live in three places (here, the daemon's
// computer-use/browser/extension/protocol.ts and the host's HostProtocol.swift) and a repo test keeps them equal.

/** `host.hello`, the framing and the relay rules (the host's business; the extension only reads `host.status`). */
export const BROWSER_HOST_PROTOCOL = 1;
/** The extension's `hello` and every message after it. */
export const EXTENSION_PROTOCOL = 1;

/** The error codes this side answers with (`error.data.code`) — the daemon's TransportErrorCode set. */
export type ErrorCode = "disconnected" | "tab_gone" | "attach_refused" | "not_allowed" | "cdp_error" | "timeout";

/** The host's notification about its link to Winter (`host.status { daemon, … }`). */
export type HostDaemonState = "connected" | "unavailable" | "unverified" | "refused";

/** What the daemon sees of a tab (the engine's `TransportTab`). */
export interface WireTab {
  tabKey: string;
  url: string;
  title: string;
  active: boolean;
  /** In a Winter group (opened by Winter's automation). */
  agent: boolean;
  /** The Winter session the tab's group belongs to. */
  sessionId?: string;
}

export const RPC_ERROR = -32000;
export const RPC_METHOD_NOT_FOUND = -32601;
