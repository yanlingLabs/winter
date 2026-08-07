# Embedding a browser, terminal, interpreter and document renderers in Norma.app

**Date:** 2026-08-07 · **Status:** research, no code written · **Question:** how hard is it to put a browser, a terminal, a code interpreter and renderers (three.js, HTML, PDF, Word, PowerPoint) inside the macOS app — and does that mean shipping Chromium?

**Short answer:** most of it is far easier than it sounds, because of two facts about *this* app specifically. And no — you almost certainly should not ship Chromium.

---

## 1. The two facts that decide most of this

### Norma is NOT App-Sandboxed

`apple/Norma/Support/Norma.entitlements` is literally `<dict/>` — empty. Norma ships as a Developer ID app (DMG + Homebrew cask + Sparkle), **not** through the Mac App Store, and the release pipeline signs with `ENABLE_HARDENED_RUNTIME=YES CODE_SIGN_INJECT_BASE_ENTITLEMENTS=NO`, so nothing is injected either.

This is the single biggest enabler and it is easy to underestimate:

- A **terminal** can `fork`/`exec` a real login shell with the user's real environment, read and write anywhere the user can, and attach a PTY. A sandboxed app cannot do this in any satisfying way — sandboxed terminals are why so many "terminal in an app" features feel crippled.
- A **code interpreter** can spawn real interpreters (`python3`, `node`, `bun`) as child processes.
- **File rendering** can open any file the user points at, with no security-scoped bookmark dance.

Hardened runtime *is* on, which constrains one thing only: writable-executable memory (JIT) and loading unsigned libraries. See §6.

### The sandboxed-execution substrate already exists

`packages/core/src/workflows/` already self-spawns the daemon's own binary as `__workflow-worker` under **`/usr/bin/sandbox-exec` (seatbelt)**, with an NDJSON stdio bridge, a capability model, a journal, and real tests including a live containment integration test. `bun run verify:workflow` proves it on the compiled artifact.

So "add a code interpreter" is mostly **a new surface over machinery Norma already has**, not new infrastructure. That is a much smaller job than it looks from the outside.

---

## 2. The browser: WKWebView, not Chromium

**Use `WKWebView`.** It is the system WebKit, it costs nothing in bundle size, Apple maintains and security-patches it, and on macOS 26 it is a fully modern engine (WebGL, WebGPU, current JS). It renders three.js, arbitrary HTML, SVG and Canvas without fuss.

### What you actually give up versus Chromium

| | WKWebView | Chromium (CEF) |
| --- | --- | --- |
| Bundle cost | **0** (system framework) | **~150–250 MB** of framework + helper apps |
| Chrome extensions | ✗ | ✓ |
| CDP / DevTools-protocol automation | ✗ | ✓ |
| Rendering identical to Chrome | ✗ | ✓ |
| 3D/WebGL performance | Reportedly weaker | Stronger |
| Notarization | Clean, nothing extra | Doable, fiddly — every nested binary signed |
| Sparkle delta updates | Small | Enormous |

### Why Chromium is the wrong default *for Norma*

Not because CEF is bad — because of Norma's release pipeline. `scripts/release.ts` produces a signed, notarized, stapled zip + DMG + appcast + Homebrew cask, and Sparkle ships **delta** updates. Adding a quarter-gigabyte framework means:

- every release uploads and every user downloads a far bigger artifact,
- the nested-signing step (already the fiddliest part of the pipeline — see the hardened-runtime comments in `release.ts`) grows a whole tree of helper executables,
- the CEF version becomes a recurring security-patch obligation *you* own, rather than one Apple ships in an OS update.

That is a **permanent tax on every release**, not a one-off integration cost.

**Choose Chromium only if you need a hard capability WebKit lacks** — realistically: Chrome extension support, or CDP-driven automation of the embedded browser. If the browser panel is for *viewing and light browsing*, WKWebView is strictly better here.

---

## 3. The terminal: genuinely easy, because of no-sandbox

Two credible options.

**[SwiftTerm](https://github.com/migueldeicaza/SwiftTerm)** — mature, SPM, and exactly shaped for this. Its macOS `TerminalView` is a reusable `NSView`, and `LocalProcessTerminalView` connects it to a Unix pseudo-terminal running a command. Already used in shipping SSH clients (Secure Shellfish, La Terminal) and **CodeEdit**. This is the low-risk choice today.

**[libghostty](https://mitchellh.com/writing/libghostty-is-coming) / GhosttyKit** — the terminal core extracted from Ghostty. Higher ceiling (GPU/Metal rendering, faster VT parsing), and there is now a pure-Swift Metal renderer plus Swift bindings, with a `GhosttyKit` SwiftPM wrapper around a libghostty XCFramework trimmed for embedded use. Announced Sept 2025, bindings "in flight" through 2026, Ghostty 1.4 due Sept 2026. **Higher ceiling, less settled** — worth watching, not worth betting the first version on.

Either way the hard part that usually bites — spawning a real shell with the user's environment — is free here, because there is no sandbox.

---

## 4. The code interpreter: mostly already built

Norma already runs model-authored JS in a **seatbelt-sandboxed subprocess** with a capability-gated bridge. Extending that to a user-facing interpreter is a matter of:

1. more languages (spawn `python3`/`node` under the same `sandbox-exec` profile),
2. a UI surface for input/output,
3. deciding the capability grants per language.

**Keep it in the daemon, not the app.** That matches Norma's own architecture rule — the daemon is the single source of truth and every client is a view over its event stream — and it keeps execution out of the UI process. It also sidesteps the JIT entitlement question entirely (§6).

**Do not** reach for in-process `JavaScriptCore` for this. It would drag a JIT entitlement into the app for no benefit over a subprocess you already know how to sandbox.

---

## 5. The renderers: all native, all cheap

| Content | Approach | Effort |
| --- | --- | --- |
| HTML, three.js, SVG, Canvas, Markdown-as-HTML | `WKWebView` (local content via `loadFileURL` or a custom scheme handler) | Low |
| **PDF** | **PDFKit** (`PDFView`) — native, with selection, search, thumbnails, annotations | Very low |
| **Word / PowerPoint / Excel** | **QuickLook** (`QLPreviewView` on AppKit) — macOS ships generators for Office and iWork formats | Very low, **read-only** |
| Images, video, audio | Native AppKit / AVKit | Very low |

The Office answer is the pleasant surprise: QuickLook previews Microsoft Office, iWork, RTF, PDF, images, text and CSV out of the box. You get *viewing* nearly for free.

**Viewing is not editing.** Editing `.docx`/`.pptx` means either a document-model library (e.g. an OOXML parser) or a web-based editor — a completely different and much larger project. Do not let "we can render PowerPoint" quietly become "we can edit PowerPoint" in planning.

---

## 6. Entitlements: what each option costs

Norma currently ships **zero** entitlements with hardened runtime enabled. Each addition is a change to `Support/Norma.entitlements` and needs a re-check of notarization.

| Feature | Entitlement needed |
| --- | --- |
| Terminal, subprocess interpreters, file rendering | **None** (no sandbox) |
| PDFKit, QuickLook | **None** |
| `WKWebView` | **Likely none** — see caveat below |
| Remote Web Inspector against a production build | `com.apple.security.web-browser` |
| In-process `JavaScriptCore` (`JSContext`) | `com.apple.security.cs.allow-jit` |
| Chromium / CEF | `allow-jit` + `allow-unsigned-executable-memory` + `disable-library-validation` |

**Caveat, flagged as unverified.** Sources conflate two different cases: JS running *in-process* via JavaScriptCore (which does need `allow-jit` on Apple Silicon) and `WKWebView`, which runs JS in Apple's own out-of-process `WebContent` service. In principle the host app should not need the entitlement for `WKWebView`; I could not confirm that from an Apple primary source. **It is cheap to settle empirically**: add a `WKWebView`, build with the existing hardened-runtime settings and empty entitlements, and see whether it crashes on first JS execution. Do that before designing around either answer.

Note that `allow-unsigned-executable-memory` is a strict superset of `allow-jit` and materially weakens the process — one more reason CEF is not free.

---

## 7. Effort, roughly ordered

| | Effort | Risk |
| --- | --- | --- |
| PDF viewer (PDFKit) | Hours | Very low |
| Office/doc preview (QuickLook) | Hours | Very low — read-only |
| HTML / three.js render surface (WKWebView) | ~A day | Low |
| Terminal panel (SwiftTerm) | Days | Low–medium |
| Code interpreter surface over the existing workflows sandbox | Days–weeks | Medium — the infra exists, the capability policy is the real design work |
| Browser panel with tabs, history, downloads, find-in-page (WKWebView) | Weeks | Medium — the *chrome* is the work, not the engine |
| Chromium/CEF instead of WKWebView | Weeks + permanent release tax | High |

**The pattern worth noticing:** every engine here is free and native. In every case the real work is the surrounding UI — tab model, session state, panel layout — which is exactly the "everything-as-tabs side panel" already sketched in the app vision. That is the actual project; the engines are the easy part.

---

## 8. Recommendation

1. **Do not ship Chromium.** Revisit only if extensions or CDP automation become a hard requirement.
2. **Start with the renderers** — PDFKit and QuickLook are hours of work and immediately useful, and they prove the panel/tab shell without engine risk.
3. **`WKWebView` for everything web**, including three.js. Settle the `allow-jit` question with a throwaway build first.
4. **Terminal on SwiftTerm**, revisiting libghostty once its Swift bindings settle (2027-ish, on its author's own timeline).
5. **Interpreter in the daemon**, on the seatbelt runtime that already exists — not in the app, and not on in-process JavaScriptCore.
6. **Budget the tab/panel shell, not the engines.** That is where the weeks go.

---

## Sources

- SwiftTerm — https://github.com/migueldeicaza/SwiftTerm
- libghostty announcement (Mitchell Hashimoto) — https://mitchellh.com/writing/libghostty-is-coming
- GhosttyKit SwiftPM wrapper — https://swiftpackageregistry.com/Lakr233/libghostty-spm
- CEF general usage / macOS bundle structure — https://chromiumembedded.github.io/cef/general_usage.html
- CEF + macOS notarization and hardened runtime — https://www.magpcss.org/ceforum/viewtopic.php?f=6&t=16481
- Chromium vs WebKit backends, trade-offs — https://support.vuplex.com/articles/standalone-browser-engines/
- What's new in WKWebView (WWDC22), `web-browser` entitlement and Remote Web Inspector — https://developer.apple.com/videos/play/wwdc2022/10049/
- QuickLook supported formats — https://www.hackingwithswift.com/example-code/libraries/how-to-preview-files-using-quick-look-and-qlpreviewcontroller
- `allow-jit` vs `allow-unsigned-executable-memory` (Apple DTS) — https://developer.apple.com/forums/thread/776290
- Hardened runtime and notarization — https://eclecticlight.co/2021/01/07/notarization-the-hardened-runtime/

## Local facts this rests on

- `apple/Norma/Support/Norma.entitlements` — empty (`<dict/>`)
- `apple/Norma/project.yml` — no App Sandbox; `scripts/release.ts` signs with `ENABLE_HARDENED_RUNTIME=YES CODE_SIGN_INJECT_BASE_ENTITLEMENTS=NO`
- `packages/core/src/workflows/sandbox.ts` + `sandbox.test.ts` — the existing `sandbox-exec` seatbelt runtime and its live containment test
- No `WebKit`/`WKWebView` usage anywhere in `apple/` today
