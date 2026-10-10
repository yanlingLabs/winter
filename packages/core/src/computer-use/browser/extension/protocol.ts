// ComputerV2 Phase 2 — Winter for Chrome: the wire between the daemon and `winter-browser-host` (the native host in
// the Winter Computer Use bundle), and through it the Winter for Chrome extension. The written contract is
// apple/ComputerUse/WinterBrowserHost/PROTOCOL.md; the two numbers below live in three places (here,
// the host's HostProtocol.swift and the extension's src/protocol.ts) and a repo test keeps them equal.
//
// Hops: extension ⇄ host is Chrome native messaging (a 4-byte little-endian length + UTF-8 JSON); host ⇄ daemon is
// NDJSON on `<home>/run/browser.sock`. Every message on both hops is one JSON-RPC 2.0 object; ids are strings, each
// side prefixing its own (`d…` daemon, `e…` extension, `h…` host). After `host.hello` the host only relays.

/** Covers `host.hello`, the framing and the relay rules. Bump on any observable change to them. */
export const BROWSER_HOST_PROTOCOL = 1;
/** Covers the extension's `hello` and every message after it. Bump on any observable change to them. */
export const EXTENSION_PROTOCOL = 1;

/** `<home>/run/<this>`, created by the daemon at boot (mode 0600, a stale file unlinked first). */
export const BROWSER_HOST_SOCKET_NAME = "browser.sock";

/** Host → daemon lines (an extension message may be a 3 MiB JPEG in base64). */
export const HOST_TO_DAEMON_MAX_LINE = 16 * 1024 * 1024;
/** Daemon → host lines: the host forwards each as one native message, and Chrome takes at most 1 MiB from a host. */
export const DAEMON_TO_HOST_MAX_LINE = 1024 * 1024;

/** JSON-RPC error codes this wire uses; the typed reason is always `error.data.code`. */
export const RPC_ERROR = -32000;
export const RPC_METHOD_NOT_FOUND = -32601;
export const RPC_INVALID_PARAMS = -32602;

/** `host.hello`'s typed refusals (`error.data.code`). */
export type HostHelloRefusal = "protocol_mismatch" | "not_allowed" | "disabled";
/** Why `not_allowed` (`error.data.reason`). */
export type HostNotAllowedReason = "origin" | "signature" | "browser";

export interface HostHelloParams {
  protocol: number;
  client: "browser-host";
  hostVersion: string;
  hostPid: number;
  /** The caller Chrome named on the host's command line: `chrome-extension://<id>/`. */
  origin: string;
  /** The browser that launched the host (its parent process). */
  browserBundleId: string;
  browserPid: number;
}

export interface HostHelloResult {
  protocol: number;
  daemonVersion: string;
}

export interface ExtensionHelloParams {
  protocol: number;
  extensionVersion: string;
  /** A UUID the extension keeps in `chrome.storage.local`: one per browser profile, stable across service-worker restarts. */
  instanceId: string;
}

export interface ExtensionHelloResult {
  protocol: number;
  backend: { id: string; name: string };
}

/** The host's notification to the extension about its daemon link (never sent to the daemon). */
export type HostDaemonState = "connected" | "unavailable" | "unverified" | "refused";

/** Daemon → extension requests (spine §6.4). */
export const EXTENSION_METHODS = [
  "tabs.list", "tabs.create", "tabs.close", "tabs.keep", "debugger.attach", "debugger.detach", "cdp.send", "cdp.subscribe", "overlay", "ping",
] as const;
export type ExtensionMethod = (typeof EXTENSION_METHODS)[number];

/** Extension → daemon notifications (spine §6.4). */
export const EXTENSION_NOTIFICATIONS = ["cdp.event", "tab.gone", "stop.pressed", "debugger.detached"] as const;

/** `debugger.detached`'s reasons: Chrome's two (`chrome.debugger.onDetach`) plus the extension's own idle detach. */
export type DebuggerDetachReason = "canceled_by_user" | "target_closed" | "idle";
