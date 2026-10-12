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

/// A page dialog waiting for the user (`WinterPresentMsgDialog`).
@interface WinterPresentDialog : NSObject
@property(nonatomic, readonly) uint32_t dialogId;
/// `WinterPresentDialogAlert` … `WinterPresentDialogBeforeUnload`.
@property(nonatomic, readonly) uint32_t type;
@property(nonatomic, readonly, copy) NSString *message;
@property(nonatomic, readonly, copy) NSString *defaultText;
/// The origin of the page that raised it (`scheme://host[:port]`; empty when unknown) — what to name as its author.
@property(nonatomic, readonly, copy) NSString *origin;
@end

/// A file chooser waiting for the user (`WinterPresentMsgFileChooser`).
@interface WinterPresentFileChooser : NSObject
@property(nonatomic, readonly) uint32_t requestId;
/// `WinterPresentFileOpen` … `WinterPresentFileSave`.
@property(nonatomic, readonly) uint32_t mode;
/// The page's accepted types (".pdf", "image/*"), as it listed them.
@property(nonatomic, readonly, copy) NSArray<NSString *> *accept;
@end

@protocol WinterPresentConsumerDelegate <NSObject>
- (void)presentConsumer:(WinterPresentConsumer *)consumer welcomedCSSWidth:(int)width height:(int)height scale:(double)scale control:(BOOL)control;
- (void)presentConsumer:(WinterPresentConsumer *)consumer frame:(WinterPresentFrame *)frame;
- (void)presentConsumer:(WinterPresentConsumer *)consumer cursor:(int)cursorType;
/// The producer ended it, its process went away, or it could not be authenticated.
- (void)presentConsumer:(WinterPresentConsumer *)consumer endedWithReason:(NSString *)reason;
@optional
/// Version 2. The viewer now holds control (input, IME, edits, dialogs, file choosers) — or no longer does.
- (void)presentConsumer:(WinterPresentConsumer *)consumer control:(BOOL)control;
/// The shown page's address and title (after the welcome, and whenever they change).
- (void)presentConsumer:(WinterPresentConsumer *)consumer pageURL:(NSString *)url title:(NSString *)title;
/// Where the composition's characters are drawn (CSS pixels of the view, one rect per character), for the input
/// method's candidate window.
- (void)presentConsumer:(WinterPresentConsumer *)consumer imeRange:(NSRange)range characterBounds:(NSArray<NSValue *> *)rects;
/// A page dialog waits for the user: answer it once with `-replyToDialog:accept:text:`.
- (void)presentConsumer:(WinterPresentConsumer *)consumer dialog:(WinterPresentDialog *)dialog;
/// That dialog went away without the viewer's answer (answered otherwise, the page navigated): close its sheet.
- (void)presentConsumer:(WinterPresentConsumer *)consumer dialogDone:(uint32_t)dialogId;
/// The page asks the user to choose files: answer once with `-replyToFileChooser:paths:` (nil: cancelled).
- (void)presentConsumer:(WinterPresentConsumer *)consumer fileChooser:(WinterPresentFileChooser *)chooser;
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

// ---- version 2: only while the viewer holds control (the producer drops them otherwise) ----

/// The input method set the marked text (`selection` inside it; `replacement` in the field, NSNotFound: none).
- (void)setComposition:(NSString *)text selection:(NSRange)selection replacement:(NSRange)replacement;
/// The input method committed `text` (replacing `replacement`, NSNotFound: none). Longer text is sent in pieces.
- (void)commitText:(NSString *)text replacement:(NSRange)replacement;
/// The marked text is kept as typed.
- (void)finishComposing;
/// The marked text is dropped.
- (void)cancelComposition;
/// An edit command (`WinterPresentEditCopy` …). A paste carries `text` (read from the pasteboard by the caller, on the
/// user's own ⌘V); every other command ignores it. NO when a piece could not be delivered (the producer's queue was
/// full): the rest is not sent, so a paste never arrives with a hole in it.
- (BOOL)sendEdit:(uint32_t)command text:(nullable NSString *)text;
/// The user's answer to a page dialog (a prompt's `text`, else nil). Once per dialog.
- (void)replyToDialog:(uint32_t)dialogId accept:(BOOL)accept text:(nullable NSString *)text;
/// The user's choice for a file chooser: the paths of copies inside `<home>/cache/headless-uploads/` (nil or empty:
/// cancelled). Once per request.
- (void)replyToFileChooser:(uint32_t)requestId paths:(nullable NSArray<NSString *> *)paths;

/// Stop presenting (BYE) and let everything go. Safe to call twice.
- (void)close;

/// Frames that named a slot this viewer still held (a protocol violation: never expected).
@property(nonatomic, readonly) uint64_t reusedInFlight;
@property(nonatomic, readonly) uint64_t staleFrames, pools;

@end

NS_ASSUME_NONNULL_END
