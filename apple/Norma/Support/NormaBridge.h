#ifndef MultitouchBridge_h
#define MultitouchBridge_h

#include <CoreFoundation/CoreFoundation.h>

// panel-cef Task 3: this is how `main.swift` can name `NormaApplication` at all — the
// Objective-C++ subclass that owns `NSApp`. Kept CEF-free by construction: the header declares
// nothing but the class, and the `CefAppProtocol` conformance lives in a class extension inside
// `NormaApplication.mm`, so nothing here pulls a CEF type into a Swift compile.
#import "NormaApplication.h"

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
