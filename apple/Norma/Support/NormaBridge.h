#ifndef MultitouchBridge_h
#define MultitouchBridge_h

#include <CoreFoundation/CoreFoundation.h>

// panel-cef Task 3: this is how `main.swift` can name `NormaApplication` at all — the
// Objective-C++ subclass that owns `NSApp`. Kept CEF-free by construction: the header declares
// nothing but the class, and the `CefAppProtocol` conformance lives in a class extension inside
// `NormaApplication.mm`, so nothing here pulls a CEF type into a Swift compile.
#import "NormaApplication.h"

// panel-cef Task 6a: the CEF embed's entire Swift-facing surface. Kept CEF-free by the same
// construction as `NormaApplication.h` above — plain Objective-C plus an `extern "C"` block, with
// every CEF type confined to `Sources/CEF/NormaCEF.mm`.
#import "NormaCEF.h"

// editor-plumbing Task 2: the `norma-editor://` scheme's path fence. Here for the TESTS' sake and
// for no other reason — the app's own Swift never calls it (the resource handler does, from C++) —
// but CEF cannot start under XCTest, so this plain-C seam is the only way the suite can execute the
// containment property at all. See the header for why the fence is a separate file from the
// handler that uses it.
#import "NormaCEFAssetResolve.h"

typedef struct { float x; float y; } MTPoint;
typedef struct { MTPoint pos; MTPoint vel; } MTReadout;

typedef struct {
    int frame;
    double timestamp;
    int identifier;
    int state;
    int fingerID;
    int handID;
    MTReadout normalized;
    float size;
    int zero1;
    float angle;
    float majorAxis;
    float minorAxis;
    MTReadout absolute;
    int zero2[2];
    float density;
} MTTouch;

typedef void *MTDeviceRef;
typedef int (*MTContactCallbackFunction)(int device, MTTouch *touches, int nFingers, double timestamp, int frame);

#endif
