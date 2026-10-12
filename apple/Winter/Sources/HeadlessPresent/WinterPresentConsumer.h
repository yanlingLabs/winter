// Headless presentation — the VIEWER half (WinterPresentWire.h): connects to a producer's service, authenticates it,
// takes its surface pools and frames, and gives each slot back once the viewer's own GPU read of it has completed.
// Winter.app's panel view and the proof tool both drive it; it draws nothing itself.
#import <Foundation/Foundation.h>
#import <Metal/Metal.h>

#import "WinterPresentWire.h"

NS_ASSUME_NONNULL_BEGIN

@class WinterPresentConsumer;

/// One frame, valid until the viewer gives its slot back (`-releaseSlot:generation:`), which it must do once — after
/// the GPU work that reads `texture` has COMPLETED (a command buffer's completed handler), never merely after it was
/// committed.
@interface WinterPresentFrame : NSObject
@property(nonatomic, readonly) id<MTLTexture> texture;
@property(nonatomic, readonly) uint32_t generation, slot;
@property(nonatomic, readonly) uint64_t sequence, paintedAt, copiedAt, receivedAt, inputSequence;
@property(nonatomic, readonly) uint32_t droppedBefore;
@property(nonatomic, readonly) double scale;
@end

@protocol WinterPresentConsumerDelegate <NSObject>
- (void)presentConsumer:(WinterPresentConsumer *)consumer welcomedCSSWidth:(int)width height:(int)height scale:(double)scale control:(BOOL)control;
- (void)presentConsumer:(WinterPresentConsumer *)consumer frame:(WinterPresentFrame *)frame;
- (void)presentConsumer:(WinterPresentConsumer *)consumer cursor:(int)cursorType;
/// The producer ended it, its process went away, or it could not be authenticated.
- (void)presentConsumer:(WinterPresentConsumer *)consumer endedWithReason:(NSString *)reason;
@end

@interface WinterPresentConsumer : NSObject

- (instancetype)initWithService:(NSString *)service
                          nonce:(uint64_t)nonce
            producerRequirement:(NSString *)producerRequirement
                         device:(id<MTLDevice>)device
                          queue:(dispatch_queue_t)queue
                       delegate:(id<WinterPresentConsumerDelegate>)delegate NS_DESIGNATED_INITIALIZER;
- (instancetype)init NS_UNAVAILABLE;

/// Look the service up and say HELLO. NO with `*error` when the service is not there.
- (BOOL)connectWithError:(NSString *_Nullable *_Nullable)error;

/// The viewer's GPU read of the slot completed: the producer may write it again. Any thread.
- (void)releaseSlot:(uint32_t)slot generation:(uint32_t)generation;

/// One human input event (`kind` and fields as `WinterPresentInputMsg`); the header and `sequence` are filled here.
/// Returns its sequence. Any thread.
- (uint64_t)sendInput:(WinterPresentInputMsg)input;

/// Render at `scale` device pixels per CSS pixel from now on (a new pool generation follows).
- (void)setScale:(double)scale;

/// Stop presenting (BYE) and let everything go. Safe to call twice.
- (void)close;

/// Frames that named a slot this viewer still held (a protocol violation: never expected).
@property(nonatomic, readonly) uint64_t reusedInFlight;
@property(nonatomic, readonly) uint64_t staleFrames, pools;

@end

NS_ASSUME_NONNULL_END
