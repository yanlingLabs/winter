#ifndef NormaEditorBridge_h
#define NormaEditorBridge_h

#include "include/wrapper/cef_message_router.h"

/// editor-plumbing Task 3 — **the editor bridge's router CONFIGURATION, shared by the process that
/// answers queries and the processes that send them.**
///
/// This header exists for the same reason `NormaEditorScheme.h` does, and the requirement is stated
/// just as plainly: `include/wrapper/cef_message_router.h`, EXAMPLE USAGE step 1 — "The
/// configuration must be the same in both the browser and renderer processes. If using multiple
/// routers in the same application make sure to specify unique function names for each router
/// configuration." The two sides live in different binaries (`Sources/CEF/NormaCEF.mm` in the app,
/// `CEFHelperSources/process_helper_mac.cc` in all five helpers), so "the same" is not something a
/// compiler can check — it is something one function has to be.
///
/// Getting it wrong is silent in the worst way: a renderer that installs `window.somethingElse` and
/// a browser process listening for `cefQuery` produce a page with a bridge function that nothing
/// answers, and every query fails with the router's own -1. Nothing in this repo can catch that
/// (no test boots CEF).
///
/// **The defaults are kept, deliberately.** `js_query_function` stays `cefQuery` and
/// `js_cancel_function` stays `cefQueryCancel` (the struct's own documented defaults). Renaming them
/// would buy a cosmetic `window.normaQuery` at the cost of a second place for the two processes to
/// disagree, and the page does not call either one directly anyway — `bridge-protocol.js` (Task 4)
/// wraps `cefQuery` and exposes Norma's own shape to the editor. `message_size_threshold` is CEF's
/// (16 KB), above which a query travels by shared memory instead of an IPC message: exactly the
/// right behaviour for a channel whose payload is a whole file's text.
inline CefMessageRouterConfig NormaCEFEditorBridgeRouterConfig() {
  return CefMessageRouterConfig();
}

#endif /* NormaEditorBridge_h */
