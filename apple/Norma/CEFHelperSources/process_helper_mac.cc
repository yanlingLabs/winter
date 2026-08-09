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
// This file does not run yet, and cannot succeed if it did: Task 4 vendors CEF for HEADERS only —
// the framework itself is not embedded into Contents/Frameworks/ until a later task, so step 2's
// dlopen (and, if CEF_USE_SANDBOX fires first, step 1's dlopen of Libraries/libcef_sandbox.dylib)
// will fail and this main() will return 1 the first time anything actually tries to launch one of
// these bundles. Building the correct static shape — five bundles, at the exact path CEF looks
// for them, with the correct three-step main — is Task 4's job. Making it live is not.

#include "include/cef_app.h"
#include "include/wrapper/cef_library_loader.h"

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

  CefMainArgs main_args(argc, argv);
  return CefExecuteProcess(main_args, nullptr, nullptr);
}
