// NormaOfficeHelper bridging header — Office Stage A Task 3.
//
// Exposes LibreOfficeKit's C API to Swift (SWIFT_OBJC_BRIDGING_HEADER, scoped to the
// NormaOfficeHelper target ONLY in project.yml — neither Norma.app nor NormaOfficeHelperFixture
// link this; see LOKBridge.swift's own header for why the fixture stays LOK-free). `LOK_USE_UNSTABLE_API`
// unlocks the LibreOfficeKitDocumentClass members Task 3 needs (documentLoad's siblings:
// getDocumentType, getParts, getPartName, getDocumentSize, initializeForRendering, registerCallback,
// paintTile, getTileMode) — without it, LibreOfficeKit.h compiles down to a handful of stable-only
// entry points (destroy/documentLoad/getError/getVersionInfo/saveAs), per that header's own
// `#if defined LOK_USE_UNSTABLE_API || defined LIBO_INTERNAL_ONLY` guard.
//
// Deliberately does NOT include LibreOfficeKitEnums.h: spikes/office-lok-gate/main.c's own header
// comment (independently re-confirmed while building this bridge) found it is not safely importable
// outside a C++ translation unit — two of its static-inline helpers
// (lokCallbackTypeToString/lokMouseEventTypeToString) use static_cast<>/nullptr unconditionally,
// with NO #ifdef __cplusplus guard around those two functions specifically (unlike the enum
// declarations above them, which import fine standalone) — so pulling it into a plain-C Swift
// bridging header fails the same way a plain C translation unit does. LOKBridge.swift transcribes
// the handful of enum integers it needs instead (documented with header-line citations), the same
// workaround the spike already used for LOK_TILEMODE_RGBA/BGRA.
//
// Zero source patches: this is a NEW file, not an edit to any vendored LOK header (T1's vendored
// copies under Sources/OfficeKit/include/ are untouched).
#define LOK_USE_UNSTABLE_API
#include "LibreOfficeKit.h"
#include "LibreOfficeKitInit.h"

// Office Stage B Task 1 — the seatbelt. These three functions are macOS's PRIVATE
// (Apple-System-Private-Interface, undocumented) sandboxing API — not declared in the public SDK's
// deprecated <sandbox.h>, which exposes only `sandbox_init(profile, flags, errorbuf)` gated to
// `flags == SANDBOX_NAMED` (one of the canned `kSBXProfile*` string constants) — unusable for a
// custom SBPL text profile. Declared here by hand, the same posture this header already takes
// toward LibreOfficeKitEnums.h's own C++-only landmines: verified against a real linked-and-run
// binary before being trusted, not assumed from memory (see main.swift's own header and
// task-1-report.md for the standalone-C-harness proof these exact signatures/return-value
// contracts hold on this SDK/OS, checked before any Swift code called them).
#include <stdint.h>
#include <sys/types.h>

// Applies `profile` (raw SBPL text — `flags` MUST be 0 here, never SANDBOX_NAMED, which would
// instead treat `profile` as a canned-name constant) to the CURRENT process. `parameters` is a
// NULL-terminated, alternating key/value C-string array, substituted into the profile text
// everywhere it references `(param "KEY")` — verified empirically to handle a space-containing
// value correctly with no caller-side escaping (production's real `--state-path` lives under
// `~/Library/Application Support/...`, which always contains a space). Returns 0 on success; -1
// with `*errorbuf` set to a human-readable reason otherwise (free with `sandbox_free_error`).
int sandbox_init_with_parameters(const char *profile, uint64_t flags, const char *const parameters[], char **errorbuf);
void sandbox_free_error(char *errorbuf);

// Fixed 3-argument form, DELIBERATELY not the real symbol's true variadic signature — Swift cannot
// import a true C variadic, and this call site never passes one. AAPCS64 passes a variadic
// function's own NAMED leading parameters identically to a fixed-arity declaration of the same
// leading parameters (only the trailing `...` tail's marshaling differs), so this is ABI-safe on
// this project's arm64-only target — confirmed directly (a standalone harness declaring BOTH the
// fully variadic and this exact fixed-arity form observed identical return values against the same
// real symbol, sandboxed and not). `sandbox_check(getpid(), NULL, 0)` — `operation` NULL, `type`
// 0 — is the verified-empirically "is this process sandboxed AT ALL" idiom: measured directly, a
// real unsandboxed run returns 0 and a real `sandbox-exec (deny default)` child returns 1.
int sandbox_check(pid_t pid, const char *operation, int type);
