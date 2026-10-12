// Winter Headless — the PRODUCER half of a headless presentation (Sources/HeadlessPresent/WinterPresentWire.h): one
// live tab shown to one authenticated viewer through an owned IOSurface pool. The tab stays this process's for its
// whole life; nothing here reloads, navigates or cancels anything of the page.
#import <AppKit/AppKit.h>

NS_ASSUME_NONNULL_BEGIN

@interface WinterHeadlessPresenter : NSObject

/// A presentation of the browser keyed by `key` (`browserId` its CEF identifier) to the viewer that names `nonce`
/// and satisfies `viewerRequirement`, at `scale` device pixels per CSS pixel. `control`: the viewer may send input.
/// `ended` runs once, on the main thread, when the presentation ends for any reason but `-stop` (the viewer said
/// bye, the viewer died, it failed authentication), with a short reason.
- (instancetype)initWithKey:(NSView *)key
                  browserId:(int)browserId
                      nonce:(uint64_t)nonce
          viewerRequirement:(NSString *)viewerRequirement
                    control:(BOOL)control
                      scale:(double)scale
                      ended:(void (^)(NSString *reason))ended NS_DESIGNATED_INITIALIZER;
- (instancetype)init NS_UNAVAILABLE;

/// Check in the service and wait for the viewer. Returns its bootstrap name, or nil with `*error`.
- (nullable NSString *)startWithError:(NSString *_Nullable *_Nullable)error;

/// End the presentation now (the viewer is told; the tab is untouched and back to its own rendering).
- (void)stop;

/// Whether the viewer may send input from now on.
@property(nonatomic) BOOL control;

/// What the presentation measured so far: frames, dropped, copy time percentiles (ms), input events.
@property(nonatomic, readonly) NSDictionary<NSString *, NSNumber *> *stats;

@end

NS_ASSUME_NONNULL_END
