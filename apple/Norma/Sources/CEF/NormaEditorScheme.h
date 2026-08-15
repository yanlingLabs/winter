#ifndef NormaEditorScheme_h
#define NormaEditorScheme_h

#include "include/cef_app.h"
#include "include/cef_render_process_handler.h"
#include "include/cef_scheme.h"

// editor-plumbing Task 3 — the `cefQuery` router's configuration, which this process's RENDERER
// half must construct identically to the browser process's. See that header: "the same" is not
// something a compiler can check across two binaries, so it is something one function is.
#include "NormaEditorBridge.h"

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
/// It carries exactly two things, and `OnBeforeCommandLineProcessing` is still NOT one of them:
/// `cef_app.h:203-205` warns that editing a non-browser process's command line is undefined
/// behaviour "including crashes", which is why `NormaApp`'s own override returns immediately for a
/// non-empty process type.
///
///   1. **The scheme registration** (Task 2) — `OnRegisterCustomSchemes`, above.
///   2. **The editor bridge's RENDERER half** (Task 3) — the `CefMessageRouterRendererSide` that
///      installs `window.cefQuery` into every V8 context and carries its replies back. Task 2's
///      note here said "`GetRenderProcessHandler` and friends stay null (the bridge is a later
///      task's)"; this is that task.
///
/// **The renderer side lives here and ONLY here, and that follows from the process model rather
/// than from taste.** `cef_message_router.h` (EXAMPLE USAGE step 6) says to call the renderer-side
/// methods "from other callbacks in your CefRenderProcessHandler implementation", and the class's
/// own header says its methods "must be called on the render process main thread". Norma's browser
/// process has no renderer in it — the five helper bundles ARE the renderers, and this is the only
/// `CefApp` any of them ever sees (`process_helper_mac.cc`). `NormaApp` (the browser process's app,
/// `NormaCEF.mm`) deliberately does not implement `CefRenderProcessHandler`: nothing would ever call
/// it. That holds because Norma never runs `--single-process`, which would collapse the two — see
/// `NormaApp::OnBeforeCommandLineProcessing`, which appends one `--disable-features` value and
/// nothing else.
class NormaSubprocessApp : public CefApp, public CefRenderProcessHandler {
 public:
  NormaSubprocessApp() = default;

  void OnRegisterCustomSchemes(CefRawPtr<CefSchemeRegistrar> registrar) override {
    NormaCEFRegisterEditorScheme(registrar);
  }

  /// CEF asks for this in the render process only, which is what keeps the router out of the GPU
  /// and utility processes that share this same class.
  CefRefPtr<CefRenderProcessHandler> GetRenderProcessHandler() override { return this; }

  /// "Call from CefRenderProcessHandler::OnContextCreated. Registers the JavaScripts functions with
  /// the new context." — this is what puts `window.cefQuery` on the page.
  ///
  /// Unconditional, for every frame of every browser: the same header warns that "any browser or
  /// context instance passed into a single router callback must then be passed into all router
  /// callbacks", so filtering by URL here would mean filtering identically in `OnContextReleased`,
  /// which sees a context whose URL may already have changed. See `NormaCEFSetBridgeHandler`
  /// (`NormaCEF.h`) for what that exposure is and where it is actually contained — the browser
  /// process, which is the side that decides whether a query is answered at all.
  void OnContextCreated(CefRefPtr<CefBrowser> browser,
                        CefRefPtr<CefFrame> frame,
                        CefRefPtr<CefV8Context> context) override {
    EnsureRouter();
    if (router_) {
      router_->OnContextCreated(browser, frame, context);
    }
  }

  /// "Any pending queries associated with the released context will be canceled and
  /// Handler::OnQueryCanceled will be called in the browser process." That callback is what stops
  /// the browser side holding a `Callback` for a page that no longer exists.
  void OnContextReleased(CefRefPtr<CefBrowser> browser,
                         CefRefPtr<CefFrame> frame,
                         CefRefPtr<CefV8Context> context) override {
    if (router_) {
      router_->OnContextReleased(browser, frame, context);
    }
  }

  /// The reply channel: the browser process's `Success`/`Failure` arrive here as process messages
  /// and the router turns them back into the page's `onSuccess`/`onFailure`. Returning the router's
  /// own answer is what leaves any OTHER message for a future handler.
  bool OnProcessMessageReceived(CefRefPtr<CefBrowser> browser,
                                CefRefPtr<CefFrame> frame,
                                CefProcessId source_process,
                                CefRefPtr<CefProcessMessage> message) override {
    return router_ != nullptr &&
           router_->OnProcessMessageReceived(browser, frame, source_process, message);
  }

 private:
  /// Created on first use rather than in the constructor, for two reasons that both matter:
  ///
  ///   * this class is the app for EVERY non-browser process, and only renderers ever reach the
  ///     three callbacks above — a GPU or utility process should not build a router it can never
  ///     use;
  ///   * `CefMessageRouterConfig`'s own constructor builds `CefString`s, which reach libcef through
  ///     the function-pointer table that `CefScopedLibraryLoader` fills at `dlopen` time. In this
  ///     process that table is filled before the app is ever constructed (`process_helper_mac.cc`
  ///     loads the library first, deliberately), so eager construction would in fact be safe here —
  ///     but the same is NOT true of the browser process's client, and keeping one rule for both
  ///     sides is cheaper than keeping two.
  ///
  /// All three callers are on the render process main thread, which is where the header requires
  /// every method of the renderer-side router to be called.
  void EnsureRouter() {
    if (!router_) {
      router_ = CefMessageRouterRendererSide::Create(NormaCEFEditorBridgeRouterConfig());
    }
  }

  CefRefPtr<CefMessageRouterRendererSide> router_;

  IMPLEMENT_REFCOUNTING(NormaSubprocessApp);
  DISALLOW_COPY_AND_ASSIGN(NormaSubprocessApp);
};

#endif /* NormaEditorScheme_h */
