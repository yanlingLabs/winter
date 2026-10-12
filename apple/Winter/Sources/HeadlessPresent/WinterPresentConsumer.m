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
    default:
      break;
  }
  mach_msg_destroy(header);
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
