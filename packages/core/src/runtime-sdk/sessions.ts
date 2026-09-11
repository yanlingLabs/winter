// G-13: the nine standalone SDK session functions, behind a door that can only be opened with an
// explicit home.
//
// TWO SEPARATE FAILURES, and the fix for one is not the fix for the other.
//
//  1. WHICH PRODUCT'S STORE. Those nine run OUTSIDE a query — no `RuntimeConfig`, no wiring — so
//     the only way they can learn which product's store to open is to be TOLD. Called bare they
//     fall through to `resolveWinterHome()` with no brand, which reads `WINTER_HOME`,
//     `WINTER_PROFILE` and `~/.winter`; the SDK's own header (`sdk/src/sessions.ts:36-44`) records
//     a reuser whose `deleteSession(id)` deleted a WINTER session. `{ brand: NORMA_BRAND }`, applied
//     last and not overridable, fixes that.
//
//  2. WHICH HOME. The brand does NOT fix this. With a Norma brand and no `NORMA_HOME` in the
//     environment, `listSessions()` / `deleteSession(id)` resolve `~/.norma` — the user's live
//     daily driver — from any test, CLI subcommand or lane that called them without thinking. A doc
//     comment is not a fence, so THERE IS NO DOOR HERE THAT TAKES NO HOME: `normaSessions(home)` is
//     the only export, and `home` is a required argument.
//
// `packages/core` therefore never imports the nine from the SDK directly; it calls
// `normaSessions(home)` with the daemon's own `NORMA_HOME`, which under `NORMA_BRAND` is the same
// directory Winter would resolve for itself.
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
 * What a caller may still say. `SessionQueryOptions` is not exported by the SDK, and two of its
 * three fields are deliberately absent here: `brand` is this module's to supply, and `winterHome`
 * is `normaSessions`'s required argument rather than an option a caller can forget.
 */
export interface NormaSessionOptions {
  /** A session's own directory, when the caller already knows it. */
  directory?: string;
}

/** Every one of the nine, bound to one home and to Norma's brand. */
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
 * THE ONLY DOOR. `home` is the daemon's `NORMA_HOME` (`dirs.home` / `resolveNormaHome()`); pass a
 * temp dir in a test.
 *
 * Both bindings are applied by this function and neither is reachable past it: `winterHome` is
 * `home`, and `brand` is `NORMA_BRAND`. A caller's `directory` still passes through — that is a
 * within-home hint, not a home.
 *
 * CLAUDE.md's standing rule still binds the CALLERS of `deleteSession`: a Norma session is never
 * deleted except by the empty-session reaper and the once-per-lifetime cleaner. This module only
 * guarantees that when one IS deleted, the store it is deleted from is the right product's, in the
 * right home.
 */
export function normaSessions(home: string): NormaSessionFunctions {
  const at = (opts?: NormaSessionOptions): { directory?: string; winterHome: string; brand: typeof NORMA_BRAND } =>
    ({ ...opts, winterHome: home, brand: NORMA_BRAND });
  return {
    listSessions: (opts) => sdkListSessions(at(opts)),
    getSessionInfo: (sessionId, opts) => sdkGetSessionInfo(sessionId, at(opts)),
    getSessionMessages: (sessionId, opts) => sdkGetSessionMessages(sessionId, at(opts)),
    renameSession: (sessionId, name, opts) => sdkRenameSession(sessionId, name, at(opts)),
    tagSession: (sessionId, tags, opts) => sdkTagSession(sessionId, tags, at(opts)),
    deleteSession: (sessionId, opts) => sdkDeleteSession(sessionId, at(opts)),
    forkSession: (sessionId, opts) => sdkForkSession(sessionId, at(opts)),
    listSubagents: (sessionId, opts) => sdkListSubagents(sessionId, at(opts)),
    getSubagentMessages: (sessionId, agentId, opts) => sdkGetSubagentMessages(sessionId, agentId, at(opts)),
  };
}
