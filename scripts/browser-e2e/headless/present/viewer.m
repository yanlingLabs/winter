// ComputerV2 Phase 4 — the PROOF VIEWER for a headless presentation (apple/Winter/Sources/HeadlessPresent): a
// windowless stand-in for Winter.app's panel that drives the real viewer core (`WinterPresentConsumer`) the way the
// panel will — every frame read on the GPU into a display texture of its own, its slot given back only when that
// read completed — and measures what the panel would see. It never draws on screen.
//
// Built and ad-hoc signed by `present-proof.ts` (the producer accepts it by its cdhash). Commands on stdin, one JSON
// object per line; results on stdout, one JSON object per line:
//   {"cmd":"press"}               a key press ('k'): the proof page toggles a marker's colour on each one; the frame
//                                 whose probe pixel first shows the new colour closes that press's input→pixel time
//   {"cmd":"click","x":..,"y":..} a left click at CSS pixels
//   {"cmd":"key","code":..,"native":..}  a non-character key (an arrow, Return)
//   {"cmd":"type","text":".."}     characters
//   {"cmd":"lag","ms":N}          hold every frame N ms before reading it (a slow viewer: the producer must drop)
//   {"cmd":"scale","value":S}     render at S device pixels per CSS pixel (a new pool generation)
//   {"cmd":"stats"}               print what was measured
//   {"cmd":"bye"}                 stop presenting and exit; {"cmd":"die"}: exit at once, no goodbye
#import <Foundation/Foundation.h>
#import <Metal/Metal.h>
#include <mach/mach_time.h>
#include <unistd.h>

#import "WinterPresentConsumer.h"

static double Ms(uint64_t ticks) {
  static mach_timebase_info_data_t base;
  if (base.denom == 0) mach_timebase_info(&base);
  return (double)ticks * base.numer / base.denom / 1e6;
}

static double Pct(NSArray<NSNumber *> *v, double p) {
  if (v.count == 0) return -1;
  NSArray<NSNumber *> *s = [v sortedArrayUsingSelector:@selector(compare:)];
  return s[(NSUInteger)MIN((double)s.count - 1, floor(p * (double)(s.count - 1) + 0.5))].doubleValue;
}

static void Emit(NSDictionary *object) {
  NSData *data = [NSJSONSerialization dataWithJSONObject:object options:0 error:nil];
  fwrite(data.bytes, 1, data.length, stdout);
  fputc('\n', stdout);
  fflush(stdout);
}

@interface Viewer : NSObject <WinterPresentConsumerDelegate>
@property(nonatomic) WinterPresentConsumer *consumer;
@end

@implementation Viewer {
  id<MTLDevice> _device;
  id<MTLCommandQueue> _queue;
  dispatch_queue_t _work;
  id<MTLTexture> _display;  // what the panel would draw from: the viewer's own texture
  id<MTLBuffer> _probe;     // one BGRA pixel at the marker
  int _probeX, _probeY;     // CSS pixels
  int _lagMs;
  uint64_t _frames, _droppedReported, _lastSequence, _outOfOrder, _lastGeneration;
  NSMutableArray<NSNumber *> *_frameAge, *_transport, *_copy, *_inputToPixel, *_gpuRead;
  // The key presses: the page's marker is green after an even count, magenta after an odd one.
  uint64_t _presses;
  uint64_t _pendingPress;     // 0: none waiting for its pixel
  uint64_t _pendingSentAt;
  uint32_t _lastColour;
  NSString *_endReason;
  uint64_t _welcomedAt, _firstFrameAt;
}

- (instancetype)initWithProbeX:(int)x y:(int)y {
  if ((self = [super init])) {
    _device = MTLCreateSystemDefaultDevice();
    _queue = [_device newCommandQueue];
    _work = dispatch_queue_create("winter.present.viewer", DISPATCH_QUEUE_SERIAL);
    _probe = [_device newBufferWithLength:4 options:MTLResourceStorageModeShared];
    _probeX = x;
    _probeY = y;
    _frameAge = [NSMutableArray array];
    _transport = [NSMutableArray array];
    _copy = [NSMutableArray array];
    _inputToPixel = [NSMutableArray array];
    _gpuRead = [NSMutableArray array];
  }
  return self;
}

- (id<MTLDevice>)device { return _device; }
- (dispatch_queue_t)work { return _work; }

- (void)presentConsumer:(WinterPresentConsumer *)consumer welcomedCSSWidth:(int)width height:(int)height scale:(double)scale control:(BOOL)control {
  _welcomedAt = mach_absolute_time();
  Emit(@{@"event" : @"welcome", @"cssWidth" : @(width), @"cssHeight" : @(height), @"scale" : @(scale), @"control" : @(control)});
}

- (void)presentConsumer:(WinterPresentConsumer *)consumer frame:(WinterPresentFrame *)frame {
  if (_firstFrameAt == 0) _firstFrameAt = frame.receivedAt;
  if (frame.sequence <= _lastSequence) _outOfOrder++;
  _lastSequence = frame.sequence;
  _droppedReported += frame.droppedBefore;
  if (frame.generation != _lastGeneration) {
    _lastGeneration = frame.generation;
    Emit(@{@"event" : @"generation", @"generation" : @(frame.generation), @"width" : @(frame.texture.width), @"height" : @(frame.texture.height), @"scale" : @(frame.scale)});
  }
  if (_lagMs > 0) {
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)_lagMs * NSEC_PER_MSEC), _work, ^{ [self read:frame]; });
  } else {
    [self read:frame];
  }
}

/// The panel's read: the frame copied on the GPU into the viewer's own texture, the probe pixel with it; the slot
/// goes back only when that GPU work has COMPLETED.
- (void)read:(WinterPresentFrame *)frame {
  id<MTLTexture> source = frame.texture;
  if (_display == nil || _display.width != source.width || _display.height != source.height) {
    MTLTextureDescriptor *d = [MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatBGRA8Unorm
                                                                                 width:source.width
                                                                                height:source.height
                                                                             mipmapped:NO];
    d.storageMode = MTLStorageModePrivate;
    _display = [_device newTextureWithDescriptor:d];
  }
  const NSUInteger px = MIN(source.width - 1, (NSUInteger)lround(_probeX * frame.scale));
  const NSUInteger py = MIN(source.height - 1, (NSUInteger)lround(_probeY * frame.scale));
  const uint64_t readStarted = mach_absolute_time();
  id<MTLCommandBuffer> commands = [_queue commandBuffer];
  id<MTLBlitCommandEncoder> blit = [commands blitCommandEncoder];
  [blit copyFromTexture:source sourceSlice:0 sourceLevel:0 sourceOrigin:MTLOriginMake(0, 0, 0)
             sourceSize:MTLSizeMake(source.width, source.height, 1)
              toTexture:_display destinationSlice:0 destinationLevel:0 destinationOrigin:MTLOriginMake(0, 0, 0)];
  [blit copyFromTexture:source sourceSlice:0 sourceLevel:0 sourceOrigin:MTLOriginMake(px, py, 0) sourceSize:MTLSizeMake(1, 1, 1)
               toBuffer:_probe destinationOffset:0 destinationBytesPerRow:4 destinationBytesPerImage:4];
  [blit endEncoding];
  WinterPresentConsumer *consumer = self.consumer;
  const uint32_t slot = frame.slot, generation = frame.generation;
  [commands addCompletedHandler:^(id<MTLCommandBuffer> done) {
    const uint64_t completedAt = mach_absolute_time();
    [consumer releaseSlot:slot generation:generation];
    const uint8_t *bgra = (const uint8_t *)self->_probe.contents;
    const uint32_t colour = ((uint32_t)bgra[2] << 16) | ((uint32_t)bgra[1] << 8) | bgra[0];
    dispatch_async(self->_work, ^{ [self frame:frame completedAt:completedAt readStarted:readStarted colour:colour]; });
  }];
  [commands commit];
}

- (void)frame:(WinterPresentFrame *)frame completedAt:(uint64_t)completedAt readStarted:(uint64_t)readStarted colour:(uint32_t)colour {
  _frames++;
  [_frameAge addObject:@(Ms(completedAt - frame.paintedAt))];
  [_transport addObject:@(Ms(frame.receivedAt - frame.copiedAt))];
  [_copy addObject:@(Ms(frame.copiedAt - frame.paintedAt))];
  [_gpuRead addObject:@(Ms(completedAt - readStarted))];
  if (_pendingPress != 0) {
    // Green (#00ff00) after an even number of presses, magenta (#ff00ff) after an odd one (with room for colour
    // management on the way).
    const int r = (colour >> 16) & 0xff, g = (colour >> 8) & 0xff, b = colour & 0xff;
    const BOOL green = g > 180 && r < 90 && b < 90, magenta = r > 180 && b > 180 && g < 90;
    if (_pendingPress % 2 == 0 ? green : magenta) {
      [_inputToPixel addObject:@(Ms(completedAt - _pendingSentAt))];
      _pendingPress = 0;
    }
  }
  _lastColour = colour;
}

- (void)presentConsumer:(WinterPresentConsumer *)consumer cursor:(int)cursorType {
  Emit(@{@"event" : @"cursor", @"type" : @(cursorType)});
}

- (void)presentConsumer:(WinterPresentConsumer *)consumer endedWithReason:(NSString *)reason {
  _endReason = reason;
  Emit(@{@"event" : @"ended", @"reason" : reason});
}

- (WinterPresentInputMsg)input:(uint32_t)kind {
  WinterPresentInputMsg m = {};
  m.kind = kind;
  m.sentAt = mach_absolute_time();
  return m;
}

- (void)command:(NSDictionary *)c {
  NSString *cmd = c[@"cmd"];
  if ([cmd isEqualToString:@"press"]) {
    _presses++;
    WinterPresentInputMsg down = [self input:WinterPresentInputKeyDown];
    down.windowsKeyCode = 0x4B;  // VK_K
    down.nativeKeyCode = 40;     // kVK_ANSI_K
    down.character = 'k';
    down.unmodifiedCharacter = 'k';
    _pendingSentAt = down.sentAt;
    _pendingPress = _presses;
    [self.consumer sendInput:down];
    WinterPresentInputMsg ch = down;
    ch.kind = WinterPresentInputChar;
    [self.consumer sendInput:ch];
    WinterPresentInputMsg up = down;
    up.kind = WinterPresentInputKeyUp;
    [self.consumer sendInput:up];
  } else if ([cmd isEqualToString:@"click"]) {
    WinterPresentInputMsg move = [self input:WinterPresentInputMouseMove];
    move.x = [c[@"x"] intValue];
    move.y = [c[@"y"] intValue];
    [self.consumer sendInput:move];
    WinterPresentInputMsg down = move;
    down.kind = WinterPresentInputMouseDown;
    down.clickCount = 1;
    [self.consumer sendInput:down];
    WinterPresentInputMsg up = down;
    up.kind = WinterPresentInputMouseUp;
    [self.consumer sendInput:up];
  } else if ([cmd isEqualToString:@"key"]) {
    WinterPresentInputMsg down = [self input:WinterPresentInputKeyDown];
    down.windowsKeyCode = [c[@"code"] intValue];
    down.nativeKeyCode = [c[@"native"] intValue];
    [self.consumer sendInput:down];
    if ([c[@"char"] isKindOfClass:[NSNumber class]]) {
      WinterPresentInputMsg ch = down;
      ch.kind = WinterPresentInputChar;
      ch.character = ch.unmodifiedCharacter = [c[@"char"] unsignedShortValue];
      [self.consumer sendInput:ch];
    }
    WinterPresentInputMsg up = down;
    up.kind = WinterPresentInputKeyUp;
    [self.consumer sendInput:up];
  } else if ([cmd isEqualToString:@"type"]) {
    // Each character as a person types it: key down, the character, key up (letters and digits of a US layout).
    static const int letters[26] = {0, 11, 8, 2, 14, 3, 5, 4, 34, 38, 40, 37, 46, 45, 31, 35, 12, 15, 1, 17, 32, 9, 13, 7, 16, 6};
    static const int digits[10] = {29, 18, 19, 20, 21, 23, 22, 26, 28, 25};
    NSString *text = c[@"text"];
    for (NSUInteger i = 0; i < text.length; i++) {
      const unichar ch = [text characterAtIndex:i];
      WinterPresentInputMsg down = [self input:WinterPresentInputKeyDown];
      if (ch >= 'a' && ch <= 'z') {
        down.windowsKeyCode = ch - 'a' + 'A';
        down.nativeKeyCode = letters[ch - 'a'];
      } else if (ch >= '0' && ch <= '9') {
        down.windowsKeyCode = ch;
        down.nativeKeyCode = digits[ch - '0'];
      }
      down.character = down.unmodifiedCharacter = ch;
      [self.consumer sendInput:down];
      WinterPresentInputMsg chr = down;
      chr.kind = WinterPresentInputChar;
      [self.consumer sendInput:chr];
      WinterPresentInputMsg up = down;
      up.kind = WinterPresentInputKeyUp;
      [self.consumer sendInput:up];
    }
  } else if ([cmd isEqualToString:@"focus"]) {
    WinterPresentInputMsg f = [self input:WinterPresentInputFocus];
    f.x = 1;
    [self.consumer sendInput:f];
  } else if ([cmd isEqualToString:@"lag"]) {
    _lagMs = [c[@"ms"] intValue];
  } else if ([cmd isEqualToString:@"scale"]) {
    [self.consumer setScale:[c[@"value"] doubleValue]];
  } else if ([cmd isEqualToString:@"stats"]) {
    [self emitStats];
  } else if ([cmd isEqualToString:@"bye"]) {
    [self emitStats];
    [self.consumer close];
    exit(0);
  } else if ([cmd isEqualToString:@"die"]) {
    _exit(9);
  }
}

- (void)emitStats {
  Emit(@{
    @"event" : @"stats",
    @"frames" : @(_frames),
    @"droppedByProducer" : @(_droppedReported),
    @"outOfOrder" : @(_outOfOrder),
    @"reusedInFlight" : @(self.consumer.reusedInFlight),
    @"staleFrames" : @(self.consumer.staleFrames),
    @"pools" : @(self.consumer.pools),
    @"presses" : @(_presses),
    @"inputToPixelCount" : @(_inputToPixel.count),
    @"inputToPixelP50" : @(Pct(_inputToPixel, 0.5)), @"inputToPixelP95" : @(Pct(_inputToPixel, 0.95)), @"inputToPixelP99" : @(Pct(_inputToPixel, 0.99)),
    @"frameAgeP50" : @(Pct(_frameAge, 0.5)), @"frameAgeP95" : @(Pct(_frameAge, 0.95)), @"frameAgeP99" : @(Pct(_frameAge, 0.99)),
    @"copyP50" : @(Pct(_copy, 0.5)), @"copyP95" : @(Pct(_copy, 0.95)), @"copyP99" : @(Pct(_copy, 0.99)),
    @"transportP50" : @(Pct(_transport, 0.5)), @"transportP95" : @(Pct(_transport, 0.95)), @"transportP99" : @(Pct(_transport, 0.99)),
    @"gpuReadP50" : @(Pct(_gpuRead, 0.5)), @"gpuReadP95" : @(Pct(_gpuRead, 0.95)),
    @"colour" : [NSString stringWithFormat:@"%06x", _lastColour],
    // From HELLO accepted to the first frame at an already-connected viewer (no process launch in it).
    @"firstFrameAfterWelcomeMs" : @(_firstFrameAt > _welcomedAt && _welcomedAt > 0 ? Ms(_firstFrameAt - _welcomedAt) : -1),
  });
}

@end

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    NSString *service = nil, *requirement = nil;
    uint64_t nonce = 0;
    int probeX = 40, probeY = 40;
    for (int i = 1; i + 1 < argc; i += 2) {
      NSString *k = @(argv[i]), *v = @(argv[i + 1]);
      if ([k isEqualToString:@"--service"]) service = v;
      else if ([k isEqualToString:@"--nonce"]) nonce = strtoull(v.UTF8String, NULL, 16);
      else if ([k isEqualToString:@"--producer-requirement"]) requirement = v;
      else if ([k isEqualToString:@"--probe"]) {
        NSArray *xy = [v componentsSeparatedByString:@","];
        probeX = [xy[0] intValue];
        probeY = [xy[1] intValue];
      }
    }
    if (service == nil || requirement == nil || nonce == 0) {
      fprintf(stderr, "usage: viewer --service S --nonce HEX16 --producer-requirement R [--probe x,y]\n");
      return 2;
    }
    Viewer *viewer = [[Viewer alloc] initWithProbeX:probeX y:probeY];
    WinterPresentConsumer *consumer = [[WinterPresentConsumer alloc] initWithService:service nonce:nonce producerRequirement:requirement
                                                                              device:viewer.device queue:viewer.work delegate:viewer];
    viewer.consumer = consumer;
    NSString *error = nil;
    if (![consumer connectWithError:&error]) {
      Emit(@{@"event" : @"error", @"message" : error ?: @"connect failed"});
      return 1;
    }
    Emit(@{@"event" : @"connected"});
    dispatch_source_t input = dispatch_source_create(DISPATCH_SOURCE_TYPE_READ, STDIN_FILENO, 0, viewer.work);
    NSMutableData *pending = [NSMutableData data];
    dispatch_source_set_event_handler(input, ^{
      char buf[4096];
      const ssize_t n = read(STDIN_FILENO, buf, sizeof(buf));
      if (n <= 0) {
        [consumer close];
        exit(0);
      }
      [pending appendBytes:buf length:(NSUInteger)n];
      for (;;) {
        const char *bytes = pending.bytes;
        const void *nl = memchr(bytes, '\n', pending.length);
        if (nl == NULL) break;
        const NSUInteger len = (NSUInteger)((const char *)nl - bytes);
        NSData *line = [pending subdataWithRange:NSMakeRange(0, len)];
        [pending replaceBytesInRange:NSMakeRange(0, len + 1) withBytes:NULL length:0];
        NSDictionary *c = [NSJSONSerialization JSONObjectWithData:line options:0 error:nil];
        if ([c isKindOfClass:[NSDictionary class]]) [viewer command:c];
      }
    });
    dispatch_resume(input);
    dispatch_main();
  }
  return 0;
}
