// panel-cef Task 4: the out-of-process helper's main.
//
// One executable, compiled into all FIVE helper bundles (base, Alerts, GPU, Plugin, Renderer —
// CEF's own `cmake/cef_variables.cmake:398-404` defines exactly these five suffixes as
// `CEF_HELPER_APP_SUFFIXES`, measured in docs/research/2026-08-09-cef-spike.md, correction #1; an
// earlier plan draft assumed four). Chromium's browser process picks which bundle to launch per
// subprocess role by NAME (`Norma Helper.app`, `Norma Helper (GPU).app`, ...) — this file does not
// know or care which variant it was built as. All five do exactly the same three things.
//
// Deliberately outside `Sources/` (a sibling directory, matching `HelperSources/`'s precedent for
// `NormaHelper`): the Norma app target's `sources: - path: Sources` is a recursive sweep, and a
// second `main()` compiled into that target would collide with `Sources/App/main.swift` at link.
//
// Verbatim shape from `process_helper_mac.cc`, as quoted by docs/research/2026-08-09-cef-spike.md
// (Q5) — not paraphrased:
//   1. Load the macOS sandbox for this process (CefScopedSandboxContext) — gated by
//      CEF_USE_SANDBOX exactly as CEF's own source gates it, and defined for these five targets in
//      project.yml. Confirmed client-side-only: absent from every vendored CEF header and from
//      every libcef_dll source file (grepped), so defining it here cannot change how the wrapper
//      library or the framework itself were built.
//   2. dlopen the CEF framework from its expected location relative to this executable
//      (CefScopedLibraryLoader::LoadInHelper() — never linked directly; see cef_library_loader.h,
//      "Loading at runtime instead of linking directly is a requirement of the macOS sandbox
//      implementation").
//   3. Hand off to CefExecuteProcess, which dispatches this process to whatever role Chromium's
//      own command-line arguments assign it (renderer, GPU, utility, ...) and does not return
//      until that subprocess exits.
//
// STATUS: LIVE. Task 4 built the static shape only — five bundles at the exact path CEF looks for
// them, with the correct three-step main — and could not run: it vendored CEF for HEADERS, so
// step 2's dlopen (and, if CEF_USE_SANDBOX fires first, step 1's dlopen of
// Libraries/libcef_sandbox.dylib) had no framework to find and this main() would have returned 1.
// Task 5's "Embed CEF framework" phase put the framework into Contents/Frameworks/ and Task 6a ran
// the whole process tree against it: these bundles now launch and serve real renderer, GPU and
// utility processes. The branch's headline result IS that they succeed.

// editor-plumbing Task 2 ADDS a FOURTH step, between 2 and 3: a `CefApp`. This main passed
// `nullptr` from Task 4 until now, which was correct for an embedder with no custom schemes and
// became wrong the moment `norma-editor://` existed. `cef_app.h`'s own comment on
// `OnRegisterCustomSchemes` — "called on the main thread for each process and the registered
// schemes should be the same across all processes" — is a requirement, not advice: a custom scheme
// registered only in the browser process is not a standard, secure scheme in any RENDERER, so the
// editor page would have no real origin, no secure context, and therefore no workers, no ES modules
// and no `fetch`. Nothing in this repo can catch that (no test boots CEF); it would surface as a
// blank editor in Task 5's live harness.
//
// The app class is shared with the browser process's own `NormaApp` through
// `Sources/CEF/NormaEditorScheme.h` — one `AddCustomScheme` call with one set of flags, reached
// from here via a HEADER_SEARCH_PATHS entry on the `CEFHelper` target template. See that header for
// why the two processes have different app CLASSES but must not have different scheme LISTS.

#include "include/cef_app.h"
#include "include/wrapper/cef_library_loader.h"

#include "NormaEditorScheme.h"

#if defined(CEF_USE_SANDBOX)
#include "include/cef_sandbox_mac.h"
#endif

int main(int argc, char* argv[]) {
#if defined(CEF_USE_SANDBOX)
  CefScopedSandboxContext sandbox_context;
  if (!sandbox_context.Initialize(argc, argv)) {
    return 1;
  }
#endif

  CefScopedLibraryLoader library_loader;
  if (!library_loader.LoadInHelper()) {
    return 1;
  }

  // Constructed AFTER the loader, not before: `NormaSubprocessApp`'s reference counting is CEF's
  // (`IMPLEMENT_REFCOUNTING`), and this file never links the framework — it dlopens it above.
  // One app for every role this executable is dispatched to; it registers the scheme and does
  // nothing else.
  CefMainArgs main_args(argc, argv);
  CefRefPtr<CefApp> app(new NormaSubprocessApp());
  return CefExecuteProcess(main_args, app, nullptr);
}
