import { randomUUID } from "node:crypto";
import type { z } from "zod";
import type { PanelTabKind } from "@norma/protocol";
import type { SessionHub } from "../sessions/hub";

// ================================================================================================
// B2 Task 4 — the ONE code path that mints a panel tab.
//
// This function is an EXTRACTION, not a new door. Its body is exactly what `panel.openTab`'s handler
// (ipc/server.ts) has run since Plan A, moved here the moment a SECOND caller appeared: the agent's
// `browser` tool's `open` verb. The rule it protects is the one that handler's own comment states —
// "the daemon mints the id, the caller never supplies one; exactly one code path creates a tab, and
// it always runs here, regardless of who asked" — and that rule is what makes an agent-opened tab and
// a user-opened tab indistinguishable downstream. Two hand-copies of a two-append sequence would have
// made "exactly one code path" false on the day it started to matter most.
//
// Deliberately NOT in `panel/store.ts`: that file is PURE (its own doc comment), and this appends.
// ================================================================================================

/** What a tab is opened WITH — the already-validated shape of `PanelOpenTabParams` (methods.ts).
 *  Callers must parse through that schema first: it is where the `web`-kind http/https scheme guard
 *  and the url/title caps live, and this function deliberately re-checks none of them (a second,
 *  independently-drifting copy of a policy is worse than one). Both callers do:
 *  `panel.openTab`'s handler via `parseParams`, the browser tool via a direct `.parse`. */
export interface PanelTabMint {
  sessionId: string;
  kind: z.infer<typeof PanelTabKind>;
  url?: string;
  title?: string;
  /** diff-tabs Task 7: set only when `kind === "diff"` — mirrors `PanelTabOpenedEvent.diffId`/
   *  `PanelOpenTabParams.diffId` (protocol/events.ts and methods.ts, both Task 3) verbatim. Pure
   *  passthrough, exactly like `url`/`title` above: this function neither mints nor validates it —
   *  `PanelOpenTabParams`'s own regex (`DIFF_ID_SHAPE`) is the one and only shape gate, run by
   *  `parseParams` before either caller ever reaches here. */
  diffId?: string;
}

/** Mint a tab and return its daemon-generated id. THROWS whatever `hub.append` throws — in practice
 *  an unknown `sessionId`; both callers turn that into their own surface's shape (an RPC NOT_FOUND,
 *  or a tool error naming the session).
 *
 *  TWO appends, not one, and the second is load-bearing: opening a tab ACTIVATES it. Both folds
 *  (`foldPanelTabs` here and its Swift mirror) set `activeTabId` only from `panel_tab_activated`, so
 *  a tab opened without it is open but never active — and with no active tab the panel shows nothing,
 *  which is the bug panel-cef Task 6b diagnosed and fixed at this exact spot. See that handler's own
 *  (retained) comment in ipc/server.ts for the full account of why the fix lives at the mint rather
 *  than in either fold or in a follow-up RPC from the app. */
export function mintPanelTab(hub: Pick<SessionHub, "append">, p: PanelTabMint): string {
  const tabId = randomUUID();
  hub.append(p.sessionId, {
    type: "panel_tab_opened", sessionId: p.sessionId, tabId, kind: p.kind, url: p.url, title: p.title,
    diffId: p.diffId,
  });
  hub.append(p.sessionId, { type: "panel_tab_activated", sessionId: p.sessionId, tabId });
  return tabId;
}
