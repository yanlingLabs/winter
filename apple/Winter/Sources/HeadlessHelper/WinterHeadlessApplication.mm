#import "WinterHeadlessApplication.h"

#import <objc/runtime.h>
#include <atomic>
#include <stdio.h>

#include "include/cef_application_mac.h"

static std::atomic<long> g_refused_windows{0};

static void NoteRefusedWindow(NSWindow *window, const char *how) {
  const long n = g_refused_windows.fetch_add(1) + 1;
  // The class name only — a window's title could carry page text.
  fprintf(stderr, "WinterHeadless: refused to show a window (%s, %s, #%ld)\n",
          class_getName([window class]), how, n);
  fflush(stderr);
}

@interface WinterHeadlessApplication () <CefAppProtocol> {
 @private
  BOOL handlingSendEvent_;
}
@end

@implementation WinterHeadlessApplication

- (BOOL)isHandlingSendEvent {
  return handlingSendEvent_;
}

- (void)setHandlingSendEvent:(BOOL)handlingSendEvent {
  handlingSendEvent_ = handlingSendEvent;
}

- (void)sendEvent:(NSEvent *)event {
  CefScopedSendingEvent sendingEventScoper;
  [super sendEvent:event];
}

// Never forward, never front: nothing in this process may take the user's focus.
- (void)activateIgnoringOtherApps:(BOOL)flag {
}

- (void)activate {
}

- (BOOL)setActivationPolicy:(NSApplicationActivationPolicy)activationPolicy {
  return [super setActivationPolicy:NSApplicationActivationPolicyProhibited];
}

+ (NSInteger)refusedWindowCount {
  return (NSInteger)g_refused_windows.load();
}

+ (void)installWindowGuard {
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    Class cls = [NSWindow class];

    // `orderWindow:relativeTo:` is where `orderFront:`, `orderBack:` and `orderOut:` all arrive; only ordering
    // OUT passes.
    Method order = class_getInstanceMethod(cls, @selector(orderWindow:relativeTo:));
    typedef void (*OrderIMP)(id, SEL, NSWindowOrderingMode, NSInteger);
    OrderIMP originalOrder = (OrderIMP)method_getImplementation(order);
    method_setImplementation(order, imp_implementationWithBlock(^(NSWindow *self_, NSWindowOrderingMode place, NSInteger other) {
      if (place != NSWindowOut) {
        NoteRefusedWindow(self_, "orderWindow");
        return;
      }
      originalOrder(self_, @selector(orderWindow:relativeTo:), place, other);
    }));

    Method regardless = class_getInstanceMethod(cls, @selector(orderFrontRegardless));
    method_setImplementation(regardless, imp_implementationWithBlock(^(NSWindow *self_) {
      NoteRefusedWindow(self_, "orderFrontRegardless");
    }));

    Method keyAndFront = class_getInstanceMethod(cls, @selector(makeKeyAndOrderFront:));
    method_setImplementation(keyAndFront, imp_implementationWithBlock(^(NSWindow *self_, id sender) {
      NoteRefusedWindow(self_, "makeKeyAndOrderFront");
    }));

    Method makeKey = class_getInstanceMethod(cls, @selector(makeKeyWindow));
    method_setImplementation(makeKey, imp_implementationWithBlock(^(NSWindow *self_) {
      NoteRefusedWindow(self_, "makeKeyWindow");
    }));
  });
}

@end
