#import "WinterPresentConsumer.h"

#import <IOSurface/IOSurface.h>
#include <mach/mach.h>
#include <mach/mach_time.h>
#include <servers/bootstrap.h>
#include <os/lock.h>

#import "WinterPresentAuth.h"

@interface WinterPresentFrame ()
@property(nonatomic, readwrite) id<MTLTexture> texture;
@property(nonatomic, readwrite) uint32_t generation, slot;
@property(nonatomic, readwrite) uint64_t sequence, paintedAt, copiedAt, receivedAt, inputSequence;
@property(nonatomic, readwrite) uint32_t droppedBefore;
@property(nonatomic, readwrite) double scale;
@end

@implementation WinterPresentFrame
@end

@interface WinterPresentDialog ()
@property(nonatomic, readwrite) uint32_t dialogId, type;
@property(nonatomic, readwrite, copy) NSString *message, *defaultText;
@end

@implementation WinterPresentDialog
@end

@interface WinterPresentFileChooser ()
@property(nonatomic, readwrite) uint32_t requestId, mode;
@property(nonatomic, readwrite, copy) NSArray<NSString *> *accept;
@end

@implementation WinterPresentFileChooser
@end

/// `length` UTF-16 units of `units` (at most `max`), as a string.
static NSString *PresentText(const uint16_t *units, uint32_t length, uint32_t max) {
  return [NSString stringWithCharacters:(const unichar *)units length:MIN(length, max)];
}

/// A message's size rounded up to Mach's 4-byte alignment.
static mach_msg_size_t PresentRound4(size_t n) { return (mach_msg_size_t)((n + 3) & ~(size_t)3); }

/// `text` cut into pieces of at most `max` UTF-16 units, never inside a surrogate pair.
static NSArray<NSString *> *PresentPieces(NSString *text, NSUInteger max) {
  NSMutableArray<NSString *> *pieces = [NSMutableArray array];
  NSUInteger at = 0;
  while (at < text.length) {
    NSUInteger n = MIN(max, text.length - at);
    if (at + n < text.length && CFStringIsSurrogateHighCharacter([text characterAtIndex:at + n - 1])) n--;
    [pieces addObject:[text substringWithRange:NSMakeRange(at, n)]];
    at += n;
  }
  return pieces;
}

@implementation WinterPresentConsumer {
  NSString *_service;
  uint64_t _nonce;
  NSString *_producerRequirement;
  id<MTLDevice> _device;
  dispatch_queue_t _queue;
  __weak id<WinterPresentConsumerDelegate> _delegate;

  mach_port_t _producer;  // send right to the producer's service
  mach_port_t _port;      // our receive right
  dispatch_source_t _source;
  BOOL _authenticated;
  audit_token_t _producerToken;
  BOOL _closed;

  os_unfair_lock _lock;   // guards the slot bookkeeping (releases arrive from GPU completion threads)
  uint32_t _generation;
  double _scale;
  id<MTLTexture> _textures[WinterPresentPoolSlots];
  BOOL _held[WinterPresentPoolSlots];
  uint64_t _inputSequence;
}

- (instancetype)initWithService:(NSString *)service
                          nonce:(uint64_t)nonce
            producerRequirement:(NSString *)producerRequirement
                         device:(id<MTLDevice>)device
                          queue:(dispatch_queue_t)queue
                       delegate:(id<WinterPresentConsumerDelegate>)delegate {
  if ((self = [super init])) {
    _service = [service copy];
    _nonce = nonce;
    _producerRequirement = [producerRequirement copy];
    _device = device;
    _queue = queue;
    _delegate = delegate;
    _lock = OS_UNFAIR_LOCK_INIT;
    _scale = 1.0;
  }
  return self;
}

- (void)dealloc {
  [self close];
}

- (BOOL)connectWithError:(NSString **)error {
  kern_return_t kr = bootstrap_look_up(bootstrap_port, _service.UTF8String, &_producer);
  if (kr != KERN_SUCCESS) {
    if (error) *error = [NSString stringWithFormat:@"the presentation service is not there (%d)", kr];
    return NO;
  }
  kr = mach_port_allocate(mach_task_self(), MACH_PORT_RIGHT_RECEIVE, &_port);
  if (kr != KERN_SUCCESS) {
    if (error) *error = [NSString stringWithFormat:@"no receive port (%d)", kr];
    return NO;
  }
  // Learn of the producer's death through our own port.
  mach_port_t previous = MACH_PORT_NULL;
  mach_port_request_notification(mach_task_self(), _producer, MACH_NOTIFY_DEAD_NAME, 0, _port, MACH_MSG_TYPE_MAKE_SEND_ONCE, &previous);
  _source = dispatch_source_create(DISPATCH_SOURCE_TYPE_MACH_RECV, _port, 0, _queue);
  __weak WinterPresentConsumer *weak = self;
  dispatch_source_set_event_handler(_source, ^{ [weak drain]; });
  dispatch_resume(_source);

  WinterPresentHelloMsg hello = {};
  hello.header.msgh_bits = MACH_MSGH_BITS(MACH_MSG_TYPE_COPY_SEND, MACH_MSG_TYPE_MAKE_SEND);
  hello.header.msgh_size = sizeof(hello);
  hello.header.msgh_remote_port = _producer;
  hello.header.msgh_local_port = _port;
  hello.header.msgh_id = WinterPresentMsgHello;
  hello.version = WinterPresentWireVersion;
  hello.nonce = _nonce;
  kr = mach_msg(&hello.header, MACH_SEND_MSG | MACH_SEND_TIMEOUT, sizeof(hello), 0, MACH_PORT_NULL, 1000, MACH_PORT_NULL);
  if (kr != KERN_SUCCESS) {
    if (error) *error = [NSString stringWithFormat:@"HELLO was not delivered (%d)", kr];
    return NO;
  }
  return YES;
}

- (void)drain {
  WinterPresentReceiveBuffer buffer;
  for (;;) {
    if (_closed) return;
    const mach_msg_option_t options = MACH_RCV_MSG | MACH_RCV_TIMEOUT | MACH_RCV_TRAILER_TYPE(MACH_MSG_TRAILER_FORMAT_0) |
                                      MACH_RCV_TRAILER_ELEMENTS(MACH_RCV_TRAILER_AUDIT);
    kern_return_t kr = mach_msg(&buffer.message.header, options, 0, sizeof(buffer), _port, 0, MACH_PORT_NULL);
    if (kr != KERN_SUCCESS) return;
    const uint64_t receivedAt = mach_absolute_time();
    [self handle:&buffer.message.header receivedAt:receivedAt];
  }
}

- (void)handle:(mach_msg_header_t *)header receivedAt:(uint64_t)receivedAt {
  if (header->msgh_id == MACH_NOTIFY_DEAD_NAME) {
    [self endWithReason:@"the presenting browser went away"];
    return;
  }
  audit_token_t token;
  if (!WinterPresentAuditToken(header, &token)) {
    mach_msg_destroy(header);
    return;
  }
  if (!_authenticated) {
    NSString *why = nil;
    if (!WinterPresentPeerSatisfies(token, _producerRequirement, &why)) {
      mach_msg_destroy(header);
      [self endWithReason:[NSString stringWithFormat:@"the presenting browser is not Winter's (%@)", why]];
      return;
    }
    _authenticated = YES;
    _producerToken = token;
  } else if (!WinterPresentSamePeer(token, _producerToken)) {
    mach_msg_destroy(header);
    return;
  }
  id<WinterPresentConsumerDelegate> delegate = _delegate;
  switch (header->msgh_id) {
    case WinterPresentMsgWelcome: {
      if (header->msgh_size < sizeof(WinterPresentWelcomeMsg)) break;
      const WinterPresentWelcomeMsg *m = (const WinterPresentWelcomeMsg *)header;
      _scale = m->scale;
      [delegate presentConsumer:self welcomedCSSWidth:m->cssWidth height:m->cssHeight scale:m->scale control:m->control != 0];
      break;
    }
    case WinterPresentMsgPool: {
      if (!(header->msgh_bits & MACH_MSGH_BITS_COMPLEX) || header->msgh_size < sizeof(WinterPresentPoolMsg)) break;
      WinterPresentPoolMsg *m = (WinterPresentPoolMsg *)header;
      if (m->body.msgh_descriptor_count != WinterPresentPoolSlots) break;
      id<MTLTexture> textures[WinterPresentPoolSlots] = {nil};
      BOOL ok = YES;
      for (int i = 0; i < WinterPresentPoolSlots; i++) {
        IOSurfaceRef surface = IOSurfaceLookupFromMachPort(m->surfaces[i].name);
        if (surface == NULL) {
          ok = NO;
          continue;
        }
        MTLTextureDescriptor *d = [MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatBGRA8Unorm
                                                                                     width:IOSurfaceGetWidth(surface)
                                                                                    height:IOSurfaceGetHeight(surface)
                                                                                 mipmapped:NO];
        d.storageMode = MTLStorageModeShared;
        d.usage = MTLTextureUsageShaderRead;
        textures[i] = [_device newTextureWithDescriptor:d iosurface:surface plane:0];
        CFRelease(surface);
        if (textures[i] == nil) ok = NO;
      }
      mach_msg_destroy(header);  // the surface rights: the textures hold the surfaces now
      if (!ok) break;
      os_unfair_lock_lock(&_lock);
      _generation = m->generation;
      _scale = m->scale;
      for (int i = 0; i < WinterPresentPoolSlots; i++) {
        _textures[i] = textures[i];
        _held[i] = NO;  // the old generation's reads finish on their own; its slots are not ours to release
      }
      _pools++;
      os_unfair_lock_unlock(&_lock);
      return;
    }
    case WinterPresentMsgFrame: {
      if (header->msgh_size < sizeof(WinterPresentFrameMsg)) break;
      const WinterPresentFrameMsg *m = (const WinterPresentFrameMsg *)header;
      os_unfair_lock_lock(&_lock);
      const BOOL current = m->generation == _generation && m->slot < WinterPresentPoolSlots && _textures[m->slot] != nil;
      id<MTLTexture> texture = current ? _textures[m->slot] : nil;
      if (current) {
        if (_held[m->slot]) _reusedInFlight++;
        _held[m->slot] = YES;
      } else {
        _staleFrames++;
      }
      const double scale = _scale;
      os_unfair_lock_unlock(&_lock);
      if (!current) break;
      WinterPresentFrame *frame = [[WinterPresentFrame alloc] init];
      frame.texture = texture;
      frame.generation = m->generation;
      frame.slot = m->slot;
      frame.sequence = m->sequence;
      frame.paintedAt = m->paintedAt;
      frame.copiedAt = m->copiedAt;
      frame.receivedAt = receivedAt;
      frame.inputSequence = m->inputSequence;
      frame.droppedBefore = m->dropped;
      frame.scale = scale;
      [delegate presentConsumer:self frame:frame];
      break;
    }
    case WinterPresentMsgCursor: {
      if (header->msgh_size < sizeof(WinterPresentCursorMsg)) break;
      [delegate presentConsumer:self cursor:((const WinterPresentCursorMsg *)header)->cursorType];
      break;
    }
    case WinterPresentMsgEnded:
      [self endWithReason:@"the presentation ended"];
      break;
    case WinterPresentMsgControl: {
      if (header->msgh_size < sizeof(WinterPresentControlMsg)) break;
      if ([delegate respondsToSelector:@selector(presentConsumer:control:)]) {
        [delegate presentConsumer:self control:((const WinterPresentControlMsg *)header)->control != 0];
      }
      break;
    }
    case WinterPresentMsgImeBounds: {
      if (header->msgh_size < offsetof(WinterPresentImeBoundsMsg, rects)) break;
      const WinterPresentImeBoundsMsg *m = (const WinterPresentImeBoundsMsg *)header;
      const uint32_t fits = (uint32_t)((header->msgh_size - offsetof(WinterPresentImeBoundsMsg, rects)) / sizeof(WinterPresentRect));
      const uint32_t count = MIN(MIN(m->count, (uint32_t)WinterPresentImeRectsMax), fits);
      NSMutableArray<NSValue *> *rects = [NSMutableArray arrayWithCapacity:count];
      for (uint32_t i = 0; i < count; i++) {
        [rects addObject:[NSValue valueWithRect:NSMakeRect(m->rects[i].x, m->rects[i].y, m->rects[i].width, m->rects[i].height)]];
      }
      const NSRange range = m->rangeStart >= 0 && m->rangeEnd >= m->rangeStart
          ? NSMakeRange((NSUInteger)m->rangeStart, (NSUInteger)(m->rangeEnd - m->rangeStart)) : NSMakeRange(NSNotFound, 0);
      if ([delegate respondsToSelector:@selector(presentConsumer:imeRange:characterBounds:)]) {
        [delegate presentConsumer:self imeRange:range characterBounds:rects];
      }
      break;
    }
    case WinterPresentMsgDialog: {
      if (header->msgh_size < sizeof(WinterPresentDialogMsg)) break;
      const WinterPresentDialogMsg *m = (const WinterPresentDialogMsg *)header;
      if (m->type > WinterPresentDialogBeforeUnload) break;
      WinterPresentDialog *dialog = [[WinterPresentDialog alloc] init];
      dialog.dialogId = m->dialogId;
      dialog.type = m->type;
      dialog.message = PresentText(m->message, m->messageLength, WinterPresentTextMax);
      dialog.defaultText = PresentText(m->defaultText, m->defaultLength, WinterPresentDialogDefaultMax);
      // A viewer that can't show it leaves it held: the agent can still answer it after the hand-back.
      if ([delegate respondsToSelector:@selector(presentConsumer:dialog:)]) [delegate presentConsumer:self dialog:dialog];
      break;
    }
    case WinterPresentMsgDialogDone: {
      if (header->msgh_size < sizeof(WinterPresentDialogDoneMsg)) break;
      if ([delegate respondsToSelector:@selector(presentConsumer:dialogDone:)]) {
        [delegate presentConsumer:self dialogDone:((const WinterPresentDialogDoneMsg *)header)->dialogId];
      }
      break;
    }
    case WinterPresentMsgFileChooser: {
      if (header->msgh_size < sizeof(WinterPresentFileChooserMsg)) break;
      const WinterPresentFileChooserMsg *m = (const WinterPresentFileChooserMsg *)header;
      if (m->mode > WinterPresentFileSave) break;
      NSString *accept = [[NSString alloc] initWithBytes:m->accept length:MIN(m->acceptLength, (uint32_t)WinterPresentFileAcceptMax)
                                                encoding:NSUTF8StringEncoding] ?: @"";
      NSMutableArray<NSString *> *types = [NSMutableArray array];
      for (NSString *t in [accept componentsSeparatedByString:@","]) {
        NSString *trimmed = [t stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceCharacterSet];
        if (trimmed.length > 0) [types addObject:trimmed];
      }
      WinterPresentFileChooser *chooser = [[WinterPresentFileChooser alloc] init];
      chooser.requestId = m->requestId;
      chooser.mode = m->mode;
      chooser.accept = types;
      if ([delegate respondsToSelector:@selector(presentConsumer:fileChooser:)]) {
        [delegate presentConsumer:self fileChooser:chooser];
      } else {
        [self replyToFileChooser:m->requestId paths:nil];
      }
      break;
    }
    default:
      break;
  }
  mach_msg_destroy(header);
}

/// One message to the producer (a copy of the send right; never blocks long).
- (void)sendToProducer:(mach_msg_header_t *)header size:(mach_msg_size_t)size {
  os_unfair_lock_lock(&_lock);
  const mach_port_t producer = _closed ? MACH_PORT_NULL : _producer;
  os_unfair_lock_unlock(&_lock);
  if (producer == MACH_PORT_NULL) return;
  header->msgh_bits = MACH_MSGH_BITS(MACH_MSG_TYPE_COPY_SEND, 0);
  header->msgh_size = size;
  header->msgh_remote_port = producer;
  header->msgh_local_port = MACH_PORT_NULL;
  mach_msg(header, MACH_SEND_MSG | MACH_SEND_TIMEOUT, size, 0, MACH_PORT_NULL, 100, MACH_PORT_NULL);
}

- (uint64_t)nextSequence {
  os_unfair_lock_lock(&_lock);
  const uint64_t sequence = ++_inputSequence;
  os_unfair_lock_unlock(&_lock);
  return sequence;
}

- (void)sendIme:(uint32_t)kind text:(NSString *)text selection:(NSRange)selection replacement:(NSRange)replacement {
  WinterPresentImeMsg m;
  memset(&m, 0, offsetof(WinterPresentImeMsg, text));
  m.header.msgh_id = WinterPresentMsgIme;
  m.kind = kind;
  const NSUInteger length = MIN(text.length, (NSUInteger)WinterPresentTextMax);
  [text getCharacters:(unichar *)m.text range:NSMakeRange(0, length)];
  m.length = (uint32_t)length;
  m.selectionStart = selection.location == NSNotFound ? -1 : (int32_t)selection.location;
  m.selectionEnd = selection.location == NSNotFound ? -1 : (int32_t)NSMaxRange(selection);
  m.replacementStart = replacement.location == NSNotFound ? -1 : (int32_t)replacement.location;
  m.replacementEnd = replacement.location == NSNotFound ? -1 : (int32_t)NSMaxRange(replacement);
  m.sequence = [self nextSequence];
  m.sentAt = mach_absolute_time();
  [self sendToProducer:&m.header size:PresentRound4(offsetof(WinterPresentImeMsg, text) + length * sizeof(uint16_t))];
}

- (void)setComposition:(NSString *)text selection:(NSRange)selection replacement:(NSRange)replacement {
  [self sendIme:WinterPresentImeSetComposition text:text selection:selection replacement:replacement];
}

- (void)commitText:(NSString *)text replacement:(NSRange)replacement {
  NSArray<NSString *> *pieces = PresentPieces(text, WinterPresentTextMax);
  for (NSUInteger i = 0; i < pieces.count; i++) {
    // Only the first piece replaces anything; the rest go in after it.
    [self sendIme:WinterPresentImeCommit text:pieces[i] selection:NSMakeRange(NSNotFound, 0) replacement:i == 0 ? replacement : NSMakeRange(NSNotFound, 0)];
  }
}

- (void)finishComposing {
  [self sendIme:WinterPresentImeFinish text:@"" selection:NSMakeRange(NSNotFound, 0) replacement:NSMakeRange(NSNotFound, 0)];
}

- (void)cancelComposition {
  [self sendIme:WinterPresentImeCancel text:@"" selection:NSMakeRange(NSNotFound, 0) replacement:NSMakeRange(NSNotFound, 0)];
}

- (void)sendEdit:(uint32_t)command text:(NSString *)text {
  NSArray<NSString *> *pieces = command == WinterPresentEditPaste ? PresentPieces(text ?: @"", WinterPresentTextMax) : @[ @"" ];
  for (NSString *piece in pieces) {
    WinterPresentEditMsg m;
    memset(&m, 0, offsetof(WinterPresentEditMsg, text));
    m.header.msgh_id = WinterPresentMsgEdit;
    m.command = command;
    [piece getCharacters:(unichar *)m.text range:NSMakeRange(0, piece.length)];
    m.length = (uint32_t)piece.length;
    m.sequence = [self nextSequence];
    m.sentAt = mach_absolute_time();
    [self sendToProducer:&m.header size:PresentRound4(offsetof(WinterPresentEditMsg, text) + piece.length * sizeof(uint16_t))];
  }
}

- (void)replyToDialog:(uint32_t)dialogId accept:(BOOL)accept text:(NSString *)text {
  WinterPresentDialogReplyMsg m;
  memset(&m, 0, offsetof(WinterPresentDialogReplyMsg, text));
  m.header.msgh_id = WinterPresentMsgDialogReply;
  m.dialogId = dialogId;
  m.accept = accept ? 1 : 0;
  const NSUInteger length = MIN(text.length, (NSUInteger)WinterPresentTextMax);
  if (length > 0) [text getCharacters:(unichar *)m.text range:NSMakeRange(0, length)];
  m.length = (uint32_t)length;
  [self sendToProducer:&m.header size:PresentRound4(offsetof(WinterPresentDialogReplyMsg, text) + length * sizeof(uint16_t))];
}

- (void)replyToFileChooser:(uint32_t)requestId paths:(NSArray<NSString *> *)paths {
  WinterPresentFileReplyMsg m;
  memset(&m, 0, offsetof(WinterPresentFileReplyMsg, paths));
  m.header.msgh_id = WinterPresentMsgFileReply;
  m.requestId = requestId;
  size_t used = 0;
  uint32_t count = 0;
  for (NSString *path in paths ?: @[]) {
    const char *utf8 = path.fileSystemRepresentation;
    const size_t n = strlen(utf8) + 1;
    if (used + n > WinterPresentFilePathsMax) break;  // what does not fit is left out
    memcpy(m.paths + used, utf8, n);
    used += n;
    count++;
  }
  m.accept = count > 0 ? 1 : 0;
  m.length = (uint32_t)used;
  m.count = count;
  [self sendToProducer:&m.header size:PresentRound4(offsetof(WinterPresentFileReplyMsg, paths) + used)];
}

- (void)releaseSlot:(uint32_t)slot generation:(uint32_t)generation {
  os_unfair_lock_lock(&_lock);
  const BOOL send = !_closed && generation == _generation && slot < WinterPresentPoolSlots && _held[slot];
  if (send) _held[slot] = NO;
  const mach_port_t producer = _producer;
  os_unfair_lock_unlock(&_lock);
  if (!send || producer == MACH_PORT_NULL) return;
  WinterPresentReleaseMsg m = {};
  m.header.msgh_bits = MACH_MSGH_BITS(MACH_MSG_TYPE_COPY_SEND, 0);
  m.header.msgh_size = sizeof(m);
  m.header.msgh_remote_port = producer;
  m.header.msgh_id = WinterPresentMsgRelease;
  m.generation = generation;
  m.slot = slot;
  mach_msg(&m.header, MACH_SEND_MSG | MACH_SEND_TIMEOUT, sizeof(m), 0, MACH_PORT_NULL, 50, MACH_PORT_NULL);
}

- (uint64_t)sendInput:(WinterPresentInputMsg)input {
  os_unfair_lock_lock(&_lock);
  const uint64_t sequence = ++_inputSequence;
  const mach_port_t producer = _closed ? MACH_PORT_NULL : _producer;
  os_unfair_lock_unlock(&_lock);
  if (producer == MACH_PORT_NULL) return 0;
  input.header.msgh_bits = MACH_MSGH_BITS(MACH_MSG_TYPE_COPY_SEND, 0);
  input.header.msgh_size = sizeof(input);
  input.header.msgh_remote_port = producer;
  input.header.msgh_local_port = MACH_PORT_NULL;
  input.header.msgh_id = WinterPresentMsgInput;
  input.sequence = sequence;
  if (input.sentAt == 0) input.sentAt = mach_absolute_time();
  mach_msg(&input.header, MACH_SEND_MSG | MACH_SEND_TIMEOUT, sizeof(input), 0, MACH_PORT_NULL, 50, MACH_PORT_NULL);
  return sequence;
}

- (void)setScale:(double)scale {
  if (_producer == MACH_PORT_NULL || _closed) return;
  WinterPresentResizeMsg m = {};
  m.header.msgh_bits = MACH_MSGH_BITS(MACH_MSG_TYPE_COPY_SEND, 0);
  m.header.msgh_size = sizeof(m);
  m.header.msgh_remote_port = _producer;
  m.header.msgh_id = WinterPresentMsgResize;
  m.scale = scale;
  mach_msg(&m.header, MACH_SEND_MSG | MACH_SEND_TIMEOUT, sizeof(m), 0, MACH_PORT_NULL, 50, MACH_PORT_NULL);
}

- (void)close {
  if (_closed) return;
  if (_producer != MACH_PORT_NULL) {
    WinterPresentEndedMsg bye = {};
    bye.header.msgh_bits = MACH_MSGH_BITS(MACH_MSG_TYPE_COPY_SEND, 0);
    bye.header.msgh_size = sizeof(bye);
    bye.header.msgh_remote_port = _producer;
    bye.header.msgh_id = WinterPresentMsgBye;
    mach_msg(&bye.header, MACH_SEND_MSG | MACH_SEND_TIMEOUT, sizeof(bye), 0, MACH_PORT_NULL, 50, MACH_PORT_NULL);
  }
  [self teardown];
}

- (void)endWithReason:(NSString *)reason {
  if (_closed) return;
  [self teardown];
  [_delegate presentConsumer:self endedWithReason:reason];
}

- (void)teardown {
  os_unfair_lock_lock(&_lock);
  _closed = YES;
  for (int i = 0; i < WinterPresentPoolSlots; i++) {
    _textures[i] = nil;
    _held[i] = NO;
  }
  const mach_port_t producer = _producer;
  _producer = MACH_PORT_NULL;
  os_unfair_lock_unlock(&_lock);
  if (_source != nil) {
    dispatch_source_cancel(_source);
    _source = nil;
  }
  if (producer != MACH_PORT_NULL) mach_port_deallocate(mach_task_self(), producer);
  if (_port != MACH_PORT_NULL) {
    mach_port_mod_refs(mach_task_self(), _port, MACH_PORT_RIGHT_RECEIVE, -1);
    _port = MACH_PORT_NULL;
  }
}

@end
