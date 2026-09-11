// G-13: the nine standalone SDK session functions, with Norma's brand pre-bound.
//
// THE BUG THIS FILE EXISTS TO PREVENT, in the SDK's own words (`sdk/src/sessions.ts:36-44`): those
// nine run OUTSIDE a query — no `RuntimeConfig`, no wiring — so the only way they can learn which
// product's store to open is to be TOLD. Called bare, they fall through to `resolveWinterHome()`
// with no brand, which reads `WINTER_HOME`, `WINTER_PROFILE` and `~/.winter`. A reuser calling
// `listSessions()` silently addressed WINTER's store, and on a machine where Winter is also
// installed `deleteSession(id)` deleted a Winter session.
//
// So: `packages/core` NEVER imports those nine from the SDK directly. It imports them from here,
// where every call carries `{ brand: NORMA_BRAND }` and therefore resolves `<NORMA_HOME>` /
// `~/.norma-dev` / `~/.norma` exactly as the daemon itself does. The brand is applied LAST and is
// not overridable through these doors — that is the whole point of the wrapper.
//
// `normaSessions(home)` additionally pre-binds `winterHome`, which every one of the nine accepts.
// Prefer it wherever the daemon's own `home` is in scope: an explicit path wins over the brand's
// env-derived resolution outright, so it is the only form that is still correct in a process whose
// environment does not carry `NORMA_HOME` (a test, a CLI subcommand, a daemon booted with an
// explicit `home`).
import {
  deleteSession as sdkDeleteSession,
  forkSession as sdkForkSession,
  getSessionInfo as sdkGetSessionInfo,
  getSessionMessages as sdkGetSessionMessages,
  getSubagentMessages as sdkGetSubagentMessages,
  listSessions as sdkListSessions,
  listSubagents as sdkListSubagents,
  renameSession as sdkRenameSession,
  tagSession as sdkTagSession,
} from "@yanlinglabs/winter-agent-sdk";
import { NORMA_BRAND } from "./brand";

/**
 * What a caller may still say. `SessionQueryOptions` is not exported by the SDK, and `brand` is
 * deliberately absent here: it is this module's to supply.
 */
export interface NormaSessionOptions {
  /** A session's own directory, when the caller already knows it. */
  directory?: string;
  /** An explicit home. Wins over the brand's env-derived resolution (surface map §6.5). */
  winterHome?: string;
}

function branded(opts?: NormaSessionOptions): NormaSessionOptions & { brand: typeof NORMA_BRAND } {
  return { ...opts, brand: NORMA_BRAND };
}

export function listSessions(opts?: NormaSessionOptions): ReturnType<typeof sdkListSessions> {
  return sdkListSessions(branded(opts));
}
export function getSessionInfo(sessionId: string, opts?: NormaSessionOptions): ReturnType<typeof sdkGetSessionInfo> {
  return sdkGetSessionInfo(sessionId, branded(opts));
}
export function getSessionMessages(sessionId: string, opts?: NormaSessionOptions): ReturnType<typeof sdkGetSessionMessages> {
  return sdkGetSessionMessages(sessionId, branded(opts));
}
export function renameSession(sessionId: string, name: string, opts?: NormaSessionOptions): ReturnType<typeof sdkRenameSession> {
  return sdkRenameSession(sessionId, name, branded(opts));
}
export function tagSession(sessionId: string, tags: string[], opts?: NormaSessionOptions): ReturnType<typeof sdkTagSession> {
  return sdkTagSession(sessionId, tags, branded(opts));
}
/** CLAUDE.md's standing rule still binds the CALLERS: a Norma session is never deleted except by
 *  the empty-session reaper and the once-per-lifetime cleaner. This wrapper only guarantees that
 *  when one IS deleted, the store it is deleted from is Norma's. */
export function deleteSession(sessionId: string, opts?: NormaSessionOptions): ReturnType<typeof sdkDeleteSession> {
  return sdkDeleteSession(sessionId, branded(opts));
}
export function forkSession(sessionId: string, opts?: NormaSessionOptions): ReturnType<typeof sdkForkSession> {
  return sdkForkSession(sessionId, branded(opts));
}
export function listSubagents(sessionId: string, opts?: NormaSessionOptions): ReturnType<typeof sdkListSubagents> {
  return sdkListSubagents(sessionId, branded(opts));
}
export function getSubagentMessages(sessionId: string, agentId: string, opts?: NormaSessionOptions): ReturnType<typeof sdkGetSubagentMessages> {
  return sdkGetSubagentMessages(sessionId, agentId, branded(opts));
}

/** Every one of the nine, bound to one home as well as the brand. */
export interface NormaSessionFunctions {
  listSessions: (opts?: NormaSessionOptions) => ReturnType<typeof sdkListSessions>;
  getSessionInfo: (sessionId: string, opts?: NormaSessionOptions) => ReturnType<typeof sdkGetSessionInfo>;
  getSessionMessages: (sessionId: string, opts?: NormaSessionOptions) => ReturnType<typeof sdkGetSessionMessages>;
  renameSession: (sessionId: string, name: string, opts?: NormaSessionOptions) => ReturnType<typeof sdkRenameSession>;
  tagSession: (sessionId: string, tags: string[], opts?: NormaSessionOptions) => ReturnType<typeof sdkTagSession>;
  deleteSession: (sessionId: string, opts?: NormaSessionOptions) => ReturnType<typeof sdkDeleteSession>;
  forkSession: (sessionId: string, opts?: NormaSessionOptions) => ReturnType<typeof sdkForkSession>;
  listSubagents: (sessionId: string, opts?: NormaSessionOptions) => ReturnType<typeof sdkListSubagents>;
  getSubagentMessages: (sessionId: string, agentId: string, opts?: NormaSessionOptions) => ReturnType<typeof sdkGetSubagentMessages>;
}

/**
 * The nine, bound to `home` — the daemon's `NORMA_HOME`, which under `NORMA_BRAND` is the same
 * directory Winter resolves for itself. A caller's own `opts.winterHome` still wins, so a tool that
 * genuinely needs another home can say so; the brand cannot be overridden either way.
 */
export function normaSessions(home: string): NormaSessionFunctions {
  const at = (opts?: NormaSessionOptions): NormaSessionOptions => ({ winterHome: home, ...opts });
  return {
    listSessions: (opts) => listSessions(at(opts)),
    getSessionInfo: (sessionId, opts) => getSessionInfo(sessionId, at(opts)),
    getSessionMessages: (sessionId, opts) => getSessionMessages(sessionId, at(opts)),
    renameSession: (sessionId, name, opts) => renameSession(sessionId, name, at(opts)),
    tagSession: (sessionId, tags, opts) => tagSession(sessionId, tags, at(opts)),
    deleteSession: (sessionId, opts) => deleteSession(sessionId, at(opts)),
    forkSession: (sessionId, opts) => forkSession(sessionId, at(opts)),
    listSubagents: (sessionId, opts) => listSubagents(sessionId, at(opts)),
    getSubagentMessages: (sessionId, agentId, opts) => getSubagentMessages(sessionId, agentId, at(opts)),
  };
}
