#ifndef NormaEditorScheme_h
#define NormaEditorScheme_h

#include "include/cef_app.h"
#include "include/cef_scheme.h"

/// editor-plumbing Task 2 — the `norma-editor://` scheme's REGISTRATION, shared by every process.
///
/// **This header exists because the browser process and the helper processes do not share a
/// `CefApp` class, and this task's brief assumed they did.** They never have:
/// `Sources/CEF/NormaCEF.mm` constructs `NormaApp` and hands it to `CefInitialize`, while
/// `CEFHelperSources/process_helper_mac.cc` — the ONE source compiled into all five
/// `Norma Helper*.app` bundles — called `CefExecuteProcess(main_args, nullptr, nullptr)`. A null
/// app is exactly right for an embedder with no custom schemes, which is what Norma was until now.
///
/// `cef_app.h` (the `OnRegisterCustomSchemes` comment) states the requirement: the method "is
/// called on the main thread for each process and the registered schemes should be the same across
/// all processes", and `cef_scheme.h`'s `CefRegisterSchemeHandlerFactory` repeats it — "if
/// |scheme_name| is a custom scheme then you must also implement the
/// CefApp::OnRegisterCustomSchemes() method in all processes". Registered in the browser process
/// alone, `norma-editor://` would be a NON-STANDARD scheme as far as every renderer is concerned:
/// no proper origin, no secure context, and therefore no ES modules, no web workers and no `fetch`
/// — which is to say, no Monaco. That failure is invisible to this repo's tests (nothing here can
/// boot CEF) and would surface only in Task 5's live harness, as a page that loads and then does
/// nothing.
///
/// So the flags live HERE, once, and BOTH app classes call the same function: `NormaApp`
/// (browser process, `NormaCEF.mm`) and `NormaSubprocessApp` (below, every non-browser process).
/// Pure C++ with no Objective-C, because the helper's translation unit is a `.cc` — the helper
/// targets reach this file through a `HEADER_SEARCH_PATHS` entry added in `project.yml`.

/// The scheme, spelled once. `NormaCEF.h`'s `kNormaEditorScheme` is defined from this — the Swift
/// side and the C++ side cannot drift.
inline constexpr char kNormaEditorSchemeName[] = "norma-editor";

/// The four options, and each one is load-bearing:
///
///   * `STANDARD` — makes `norma-editor://app/editor.html` a URL with a real origin and a
///     hierarchical path. Without it relative URLs do not resolve and every other flag here is
///     documented as having no effect (`cef_types.h`: CORS and CSP options apply "only for schemes
///     where CEF_SCHEME_OPTION_STANDARD is set").
///   * `SECURE` — a secure context, which is what web workers, ES modules and `crypto.subtle`
///     require. Monaco runs its language services in workers.
///   * `CORS_ENABLED` — the page is served from host `app` and Monaco from host `assets`, i.e.
///     two ORIGINS, so worker and `fetch` loads across them are cross-origin requests. The
///     handler's `Access-Control-Allow-Origin` answer is only consulted for a CORS-enabled scheme.
///   * `FETCH_ENABLED` — Monaco's loader and its workers use `fetch`, not just `<script>`.
///
/// Not set, deliberately: `LOCAL` (file-like restrictions this does not want), `DISPLAY_ISOLATED`
/// (it would forbid the two hosts referencing each other, which is the whole layout), and
/// `CSP_BYPASSING` (the page has no CSP to bypass and should never be able to bypass one).
inline void NormaCEFRegisterEditorScheme(CefRawPtr<CefSchemeRegistrar> registrar) {
  if (registrar == nullptr) {
    return;
  }
  registrar->AddCustomScheme(kNormaEditorSchemeName,
                             CEF_SCHEME_OPTION_STANDARD | CEF_SCHEME_OPTION_SECURE |
                                 CEF_SCHEME_OPTION_CORS_ENABLED | CEF_SCHEME_OPTION_FETCH_ENABLED);
}

/// The `CefApp` every NON-browser process gets — renderer, GPU, utility, all of them, since one
/// `CefExecuteProcess` serves every role the five helper bundles are launched for.
///
/// It implements `OnRegisterCustomSchemes` and NOTHING ELSE, and the omissions are deliberate:
/// `GetRenderProcessHandler` and friends stay null (the bridge is a later task's), and
/// `OnBeforeCommandLineProcessing` is NOT overridden here — `cef_app.h:203-205` warns that editing
/// a non-browser process's command line is undefined behaviour "including crashes", which is why
/// `NormaApp`'s own override returns immediately for a non-empty process type.
class NormaSubprocessApp : public CefApp {
 public:
  NormaSubprocessApp() = default;

  void OnRegisterCustomSchemes(CefRawPtr<CefSchemeRegistrar> registrar) override {
    NormaCEFRegisterEditorScheme(registrar);
  }

 private:
  IMPLEMENT_REFCOUNTING(NormaSubprocessApp);
  DISALLOW_COPY_AND_ASSIGN(NormaSubprocessApp);
};

#endif /* NormaEditorScheme_h */
