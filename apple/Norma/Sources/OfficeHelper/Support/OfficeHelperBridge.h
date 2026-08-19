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
