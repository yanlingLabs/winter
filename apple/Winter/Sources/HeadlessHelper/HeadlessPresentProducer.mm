#import "HeadlessPresentProducer.h"

#import <IOSurface/IOSurface.h>
#import <Metal/Metal.h>
#include <mach/mach.h>
#include <mach/mach_time.h>
#include <mach/notify.h>
#include <servers/bootstrap.h>
#include <sys/stat.h>

#import "WinterCEF.h"
#import "WinterPresentAuth.h"
#import "WinterPresentWire.h"

// Where a viewer's file-chooser answers must lie (`+setUploadsRoot:`).
static NSString *g_uploadsRoot;
// One device and queue for the helper, made on the first presentation.
static id<MTLDevice> g_device;
static id<MTLCommandQueue> g_queue;
// Every paint CEF reported for a browser (presented or not), for diagnostics. Main thread only.
static NSMutableDictionary<NSNumber *, NSNumber *> *g_paintsSeen;
// The live presentations, by browser id. Main thread only.
static NSMutableDictionary<NSNumber *, WinterHeadlessPresenter *> *g_presenters;

@interface WinterHeadlessPresenter ()
- (void)paintType:(int)type surface:(IOSurfaceRef)surface;
- (void)popupKind:(int)kind x:(int)x y:(int)y width:(int)width height:(int)height;
- (void)cursor:(int)type;
- (void)imeRangeStart:(int)start end:(int)end rects:(NSArray<NSValue *> *)rects;
- (void)dialogOpenedType:(int)type message:(NSString *)message defaultText:(NSString *)defaultText;
- (void)dialogClosed;
- (BOOL)fileChooser:(int)requestId mode:(int)mode accept:(NSArray<NSString *> *)accept;
@end

static BOOL EnsureMetal(void) {
  if (g_device != nil) return YES;
  g_device = MTLCreateSystemDefaultDevice();
  g_queue = [g_device newCommandQueue];
  return g_device != nil && g_queue != nil;
}

static void InstallObservers(void) {
  static BOOL installed = NO;
  if (installed) return;
  installed = YES;
  g_presenters = [NSMutableDictionary dictionary];
  g_paintsSeen = [NSMutableDictionary dictionary];
  WinterCEFHeadlessSetPaintObserver(^(int browserId, int type, IOSurfaceRef surface) {
    g_paintsSeen[@(browserId)] = @(g_paintsSeen[@(browserId)].unsignedLongLongValue + 1);
    [g_presenters[@(browserId)] paintType:type surface:surface];
  });
  WinterCEFHeadlessSetPopupObserver(^(int browserId, int kind, int x, int y, int width, int height) {
    [g_presenters[@(browserId)] popupKind:kind x:x y:y width:width height:height];
  });
  WinterCEFHeadlessSetCursorObserver(^(int browserId, int cursorType) {
    [g_presenters[@(browserId)] cursor:cursorType];
  });
  // Version 2: only a presenter whose viewer holds control acts on these (each checks).
  WinterCEFHeadlessSetImeObserver(^(int browserId, int start, int end, NSArray<NSValue *> *rects) {
    [g_presenters[@(browserId)] imeRangeStart:start end:end rects:rects];
  });
  WinterCEFHeadlessSetDialogObservers(
      ^(int browserId, int type, NSString *message, NSString *defaultText) {
        [g_presenters[@(browserId)] dialogOpenedType:type message:message defaultText:defaultText];
      },
      ^(int browserId) { [g_presenters[@(browserId)] dialogClosed]; });
  WinterCEFHeadlessSetFileChooserHandler(^BOOL(int browserId, int requestId, int mode, NSArray<NSString *> *accept) {
    WinterHeadlessPresenter *presenter = g_presenters[@(browserId)];
    return presenter != nil && [presenter fileChooser:requestId mode:mode accept:accept];
  });
}

/// `length` UTF-16 units of `units` (at most `max`), as a string.
static NSString *WireText(const uint16_t *units, uint32_t length, uint32_t max) {
  return [NSString stringWithCharacters:(const unichar *)units length:MIN(length, max)];
}

static double Ms(uint64_t ticks) {
  static mach_timebase_info_data_t base;
  if (base.denom == 0) mach_timebase_info(&base);
  return (double)ticks * base.numer / base.denom / 1e6;
}

static double Percentile(NSArray<NSNumber *> *values, double p) {
  if (values.count == 0) return 0;
  NSArray<NSNumber *> *sorted = [values sortedArrayUsingSelector:@selector(compare:)];
  NSUInteger i = (NSUInteger)MIN((double)sorted.count - 1, floor(p * (double)(sorted.count - 1) + 0.5));
  return sorted[i].doubleValue;
}

@implementation WinterHeadlessPresenter {
  NSView *_key;
  int _browserId;
  uint64_t _nonce;
  NSString *_requirement;
  double _scale;
  void (^_started)(void);
  void (^_ended)(NSString *);

  mach_port_t _port;            // our receive right (checked in under the service name)
  dispatch_source_t _source;
  mach_port_t _viewer;          // a send right to the viewer's port, after an authenticated HELLO
  audit_token_t _viewerToken;
  BOOL _stopped;

  uint32_t _generation;
  int _poolWidth, _poolHeight;
  IOSurfaceRef _surfaces[WinterPresentPoolSlots];
  id<MTLTexture> _textures[WinterPresentPoolSlots];
  BOOL _leased[WinterPresentPoolSlots];

  // Version 2: the dialog shown to the viewer (0: none) and the file choosers it was asked.
  uint32_t _dialogId, _nextDialogId;
  NSMutableSet<NSNumber *> *_fileRequests;

  BOOL _popupVisible;
  int _popupX, _popupY, _popupWidth, _popupHeight;  // CSS pixels
  id<MTLTexture> _popup;                            // the popup's last frame, owned

  uint64_t _sequence, _frames, _dropped, _droppedSinceFrame, _inputs, _lastInputSequence;
  // The first frame after the viewer was accepted (or after a scale change), awaited: a page with nothing moving paints
  // only when asked, so the view is asked again until a frame comes (`-kickAfter:`).
  BOOL _awaitingFrame;
  NSUInteger _kicks;
  NSMutableArray<NSNumber *> *_copyMs;
}

- (instancetype)initWithKey:(NSView *)key
                  browserId:(int)browserId
                      nonce:(uint64_t)nonce
          viewerRequirement:(NSString *)viewerRequirement
                    control:(BOOL)control
                      scale:(double)scale
                    started:(void (^)(void))started
                      ended:(void (^)(NSString *))ended {
  if ((self = [super init])) {
    _key = key;
    _browserId = browserId;
    _nonce = nonce;
    _requirement = [viewerRequirement copy];
    _control = control;
    _scale = scale >= 1.0 && scale <= 4.0 ? scale : 1.0;
    _started = [started copy];
    _ended = [ended copy];
    _copyMs = [NSMutableArray array];
    _fileRequests = [NSMutableSet set];
  }
  return self;
}

+ (void)setUploadsRoot:(NSString *)root {
  g_uploadsRoot = [root copy];
}

+ (BOOL)path:(NSString *)path isUploadInside:(NSString *)root {
  if (root.length == 0 || ![path isAbsolutePath]) return NO;
  char resolvedRoot[PATH_MAX], resolvedPath[PATH_MAX];
  if (realpath(root.fileSystemRepresentation, resolvedRoot) == NULL) return NO;
  if (realpath(path.fileSystemRepresentation, resolvedPath) == NULL) return NO;
  // The file itself must not be a link (its parents resolved above).
  struct stat st;
  if (lstat(path.fileSystemRepresentation, &st) != 0 || !S_ISREG(st.st_mode)) return NO;
  const size_t n = strlen(resolvedRoot);
  return strncmp(resolvedPath, resolvedRoot, n) == 0 && resolvedPath[n] == '/';
}

- (void)dealloc {
  [self releasePool];
}

- (nullable NSString *)startWithError:(NSString **)error {
  InstallObservers();
  if (!EnsureMetal()) {
    if (error) *error = @"no Metal device";
    return nil;
  }
  if (g_presenters[@(_browserId)] != nil) {
    if (error) *error = @"the tab is already presented";
    return nil;
  }
  NSString *name = WinterPresentServiceName();
  kern_return_t kr = bootstrap_check_in(bootstrap_port, name.UTF8String, &_port);
  if (kr != KERN_SUCCESS) {
    if (error) *error = [NSString stringWithFormat:@"the presentation service could not be checked in (%d)", kr];
    return nil;
  }
  // A small queue: a viewer that floods us is not read faster for it.
  mach_port_limits_t limits = {.mpl_qlimit = 16};
  mach_port_set_attributes(mach_task_self(), _port, MACH_PORT_LIMITS_INFO, (mach_port_info_t)&limits, MACH_PORT_LIMITS_INFO_COUNT);
  _source = dispatch_source_create(DISPATCH_SOURCE_TYPE_MACH_RECV, _port, 0, dispatch_get_main_queue());
  __weak WinterHeadlessPresenter *weak = self;
  dispatch_source_set_event_handler(_source, ^{ [weak drain]; });
  dispatch_resume(_source);
  g_presenters[@(_browserId)] = self;
  return name;
}

- (void)stop {
  [self endSaying:0 reason:nil];
}

- (void)setControl:(BOOL)control {
  if (_control == control) return;
  _control = control;
  // The user's keys reach the page only while the browser has focus: given with control, taken back with it.
  if (_viewer != MACH_PORT_NULL) {
    WinterCEFHeadlessSetUserControl(_key, control);
    WinterCEFHeadlessSendInput(_key, WinterPresentInputFocus, control ? 1 : 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
  }
  if (_viewer == MACH_PORT_NULL) return;
  WinterPresentControlMsg m = {};
  m.header.msgh_bits = MACH_MSGH_BITS(MACH_MSG_TYPE_COPY_SEND, 0);
  m.header.msgh_size = sizeof(m);
  m.header.msgh_remote_port = _viewer;
  m.header.msgh_id = WinterPresentMsgControl;
  m.control = control ? 1 : 0;
  mach_msg(&m.header, MACH_SEND_MSG | MACH_SEND_TIMEOUT, sizeof(m), 0, MACH_PORT_NULL, 100, MACH_PORT_NULL);
  if (control) {
    // A dialog the page already holds is the person's to answer now.
    [self offerHeldDialog];
  } else {
    // Control goes back to the agent: what the viewer was asked and has not answered is withdrawn.
    [self withdrawDialog];
    [self cancelFileChoosers];
  }
}

/// How many Mach port names this process holds now (a presentation that leaks a right shows here).
static NSUInteger TaskPortCount(void) {
  mach_port_name_array_t names = NULL;
  mach_port_type_array_t types = NULL;
  mach_msg_type_number_t count = 0, typeCount = 0;
  if (mach_port_names(mach_task_self(), &names, &count, &types, &typeCount) != KERN_SUCCESS) return 0;
  vm_deallocate(mach_task_self(), (vm_address_t)names, count * sizeof(*names));
  vm_deallocate(mach_task_self(), (vm_address_t)types, typeCount * sizeof(*types));
  return count;
}

- (NSDictionary<NSString *, NSNumber *> *)stats {
  return @{
    @"taskPorts" : @(TaskPortCount()),
    @"frames" : @(_frames),
    @"kicks" : @(_kicks),
    @"paintsSeen" : g_paintsSeen[@(_browserId)] ?: @0,
    @"dropped" : @(_dropped),
    @"generations" : @(_generation),
    @"inputs" : @(_inputs),
    @"copyP50Ms" : @(Percentile(_copyMs, 0.50)),
    @"copyP95Ms" : @(Percentile(_copyMs, 0.95)),
    @"copyP99Ms" : @(Percentile(_copyMs, 0.99)),
    @"copyMaxMs" : @(Percentile(_copyMs, 1.0)),
  };
}

// MARK: - Receiving

- (void)drain {
  if (_stopped) return;
  WinterPresentReceiveBuffer buffer;
  for (;;) {
    memset(&buffer, 0, sizeof(buffer.message.header));
    const mach_msg_option_t options = MACH_RCV_MSG | MACH_RCV_TIMEOUT | MACH_RCV_TRAILER_TYPE(MACH_MSG_TRAILER_FORMAT_0) |
                                      MACH_RCV_TRAILER_ELEMENTS(MACH_RCV_TRAILER_AUDIT);
    kern_return_t kr = mach_msg(&buffer.message.header, options, 0, sizeof(buffer), _port, 0, MACH_PORT_NULL);
    if (kr != KERN_SUCCESS) return;  // MACH_RCV_TIMED_OUT: drained
    [self handle:&buffer.message.header];
    if (_stopped) return;
  }
}

- (void)handle:(mach_msg_header_t *)header {
  if (header->msgh_id == MACH_NOTIFY_DEAD_NAME) {
    // The viewer's port died: the viewer is gone. The tab is not.
    const mach_dead_name_notification_t *dead = (const mach_dead_name_notification_t *)header;
    if (dead->not_port != MACH_PORT_NULL) mach_port_deallocate(mach_task_self(), dead->not_port);
    [self endSaying:-1 reason:@"the viewer went away"];
    return;
  }
  audit_token_t token;
  if (!WinterPresentAuditToken(header, &token)) {
    mach_msg_destroy(header);
    return;
  }
  if (_viewer == MACH_PORT_NULL) {
    [self hello:header token:token];
    return;
  }
  if (!WinterPresentSamePeer(token, _viewerToken)) {
    mach_msg_destroy(header);  // anyone but the authenticated viewer is ignored
    return;
  }
  switch (header->msgh_id) {
    case WinterPresentMsgRelease: {
      if (header->msgh_size < sizeof(WinterPresentReleaseMsg)) break;
      const WinterPresentReleaseMsg *m = (const WinterPresentReleaseMsg *)header;
      if (m->generation == _generation && m->slot < WinterPresentPoolSlots) _leased[m->slot] = NO;
      break;
    }
    case WinterPresentMsgInput: {
      if (header->msgh_size < sizeof(WinterPresentInputMsg) || !_control) break;
      const WinterPresentInputMsg *m = (const WinterPresentInputMsg *)header;
      _inputs++;
      _lastInputSequence = m->sequence;
      WinterCEFHeadlessSendInput(_key, (int)m->kind, m->x, m->y, m->dx, m->dy, m->button, m->clickCount, m->modifiers,
                                 m->windowsKeyCode, m->nativeKeyCode, m->character, m->unmodifiedCharacter);
      break;
    }
    case WinterPresentMsgResize: {
      if (header->msgh_size < sizeof(WinterPresentResizeMsg)) break;
      const WinterPresentResizeMsg *m = (const WinterPresentResizeMsg *)header;
      if (m->scale >= 1.0 && m->scale <= 4.0 && m->scale != _scale) {
        _scale = m->scale;
        WinterCEFHeadlessSetPresentation(_key, _scale, 60);
        [self awaitFrame];
      }
      break;
    }
    case WinterPresentMsgBye:
      [self endSaying:-1 reason:@"the viewer stopped"];
      break;
    case WinterPresentMsgIme: {
      if (!_control || header->msgh_size < offsetof(WinterPresentImeMsg, text)) break;
      const WinterPresentImeMsg *m = (const WinterPresentImeMsg *)header;
      const uint32_t fits = (uint32_t)((header->msgh_size - offsetof(WinterPresentImeMsg, text)) / sizeof(uint16_t));
      if (m->kind < WinterPresentImeSetComposition || m->kind > WinterPresentImeCancel) break;
      _inputs++;
      _lastInputSequence = m->sequence;
      WinterCEFHeadlessIme(_key, (int)m->kind, WireText(m->text, MIN(m->length, fits), WinterPresentTextMax), m->selectionStart,
                           m->selectionEnd, m->replacementStart, m->replacementEnd);
      break;
    }
    case WinterPresentMsgEdit: {
      if (!_control || header->msgh_size < offsetof(WinterPresentEditMsg, text)) break;
      const WinterPresentEditMsg *m = (const WinterPresentEditMsg *)header;
      if (m->command < WinterPresentEditCopy || m->command > WinterPresentEditDelete) break;
      const uint32_t fits = (uint32_t)((header->msgh_size - offsetof(WinterPresentEditMsg, text)) / sizeof(uint16_t));
      _inputs++;
      _lastInputSequence = m->sequence;
      WinterCEFHeadlessEdit(_key, (int)m->command,
                            m->command == WinterPresentEditPaste ? WireText(m->text, MIN(m->length, fits), WinterPresentTextMax) : nil);
      break;
    }
    case WinterPresentMsgDialogReply: {
      if (!_control || header->msgh_size < offsetof(WinterPresentDialogReplyMsg, text)) break;
      const WinterPresentDialogReplyMsg *m = (const WinterPresentDialogReplyMsg *)header;
      if (_dialogId == 0 || m->dialogId != _dialogId) break;  // not the dialog the viewer was shown (any more)
      const uint32_t fits = (uint32_t)((header->msgh_size - offsetof(WinterPresentDialogReplyMsg, text)) / sizeof(uint16_t));
      NSString *text = WireText(m->text, MIN(m->length, fits), WinterPresentTextMax);
      _dialogId = 0;
      WinterCEFResolveHeldDialog(_key, m->accept != 0 ? WinterCEFHeldDialogActionAccept : WinterCEFHeldDialogActionDismiss, text.UTF8String);
      break;
    }
    case WinterPresentMsgFileReply: {
      if (header->msgh_size < offsetof(WinterPresentFileReplyMsg, paths)) break;
      const WinterPresentFileReplyMsg *m = (const WinterPresentFileReplyMsg *)header;
      if (![_fileRequests containsObject:@(m->requestId)]) break;
      [_fileRequests removeObject:@(m->requestId)];
      const uint32_t fits = (uint32_t)(header->msgh_size - offsetof(WinterPresentFileReplyMsg, paths));
      const uint32_t length = MIN(MIN(m->length, fits), (uint32_t)WinterPresentFilePathsMax);
      NSMutableArray<NSString *> *paths = [NSMutableArray array];
      BOOL refused = NO;
      if (_control && m->accept != 0) {
        uint32_t at = 0;
        while (at < length) {
          const char *start = m->paths + at;
          const size_t n = strnlen(start, length - at);
          if (n == length - at) break;  // not NUL-terminated within the message: dropped
          NSString *path = [NSString stringWithUTF8String:start];
          if (path == nil || ![WinterHeadlessPresenter path:path isUploadInside:g_uploadsRoot]) {
            refused = YES;
          } else {
            [paths addObject:path];
          }
          at += (uint32_t)n + 1;
        }
      }
      if (refused) NSLog(@"WinterHeadless: a file-chooser answer named a file outside the uploads folder — refused");
      // Anything refused cancels the whole answer: the page gets the person's choice or nothing.
      WinterCEFHeadlessResolveFileChooser((int)m->requestId, refused ? nil : paths);
      break;
    }
    default:
      break;
  }
  mach_msg_destroy(header);
}

// MARK: - The first frame

/// A frame is owed (the viewer was just accepted, or the scale changed): until one comes, the view is asked again every
/// 250 ms, 40 times at most.
- (void)awaitFrame {
  _awaitingFrame = YES;
  [self kickAfter:0];
}

- (void)kickAfter:(NSUInteger)attempt {
  __weak WinterHeadlessPresenter *weak = self;
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 250 * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{
    WinterHeadlessPresenter *strong = weak;
    if (strong == nil || strong->_stopped || strong->_viewer == MACH_PORT_NULL || !strong->_awaitingFrame || attempt >= 40) return;
    strong->_kicks++;
    WinterCEFHeadlessSetPresentation(strong->_key, strong->_scale, 60);
    [strong kickAfter:attempt + 1];
  });
}

// MARK: - Version 2: IME bounds, dialogs, file choosers

- (void)imeRangeStart:(int)start end:(int)end rects:(NSArray<NSValue *> *)rects {
  if (_viewer == MACH_PORT_NULL || !_control) return;
  WinterPresentImeBoundsMsg m = {};
  const uint32_t count = (uint32_t)MIN(rects.count, (NSUInteger)WinterPresentImeRectsMax);
  m.header.msgh_bits = MACH_MSGH_BITS(MACH_MSG_TYPE_COPY_SEND, 0);
  m.header.msgh_size = (mach_msg_size_t)(offsetof(WinterPresentImeBoundsMsg, rects) + count * sizeof(WinterPresentRect));
  m.header.msgh_remote_port = _viewer;
  m.header.msgh_id = WinterPresentMsgImeBounds;
  m.rangeStart = start;
  m.rangeEnd = end;
  m.count = count;
  for (uint32_t i = 0; i < count; i++) {
    const NSRect r = rects[i].rectValue;
    m.rects[i] = (WinterPresentRect){(int32_t)r.origin.x, (int32_t)r.origin.y, (int32_t)r.size.width, (int32_t)r.size.height};
  }
  mach_msg(&m.header, MACH_SEND_MSG | MACH_SEND_TIMEOUT, m.header.msgh_size, 0, MACH_PORT_NULL, 0, MACH_PORT_NULL);
}

- (void)dialogOpenedType:(int)type message:(NSString *)message defaultText:(NSString *)defaultText {
  if (_viewer == MACH_PORT_NULL || !_control) return;
  [self sendDialogType:type message:message defaultText:defaultText];
}

/// The page's held dialog, if any, offered to the viewer (control was just given).
- (void)offerHeldDialog {
  int type = 0;
  NSString *message = nil, *defaultText = nil;
  if (_dialogId != 0 || !WinterCEFHeadlessCurrentDialog(_key, &type, &message, &defaultText)) return;
  [self sendDialogType:type message:message ?: @"" defaultText:defaultText ?: @""];
}

- (void)sendDialogType:(int)type message:(NSString *)message defaultText:(NSString *)defaultText {
  WinterPresentDialogMsg m;
  memset(&m, 0, sizeof(m));
  m.header.msgh_bits = MACH_MSGH_BITS(MACH_MSG_TYPE_COPY_SEND, 0);
  m.header.msgh_size = sizeof(m);
  m.header.msgh_remote_port = _viewer;
  m.header.msgh_id = WinterPresentMsgDialog;
  m.dialogId = ++_nextDialogId;
  m.type = (uint32_t)type;
  const NSUInteger messageLength = MIN(message.length, (NSUInteger)WinterPresentTextMax);
  [message getCharacters:(unichar *)m.message range:NSMakeRange(0, messageLength)];
  m.messageLength = (uint32_t)messageLength;
  const NSUInteger defaultLength = MIN(defaultText.length, (NSUInteger)WinterPresentDialogDefaultMax);
  [defaultText getCharacters:(unichar *)m.defaultText range:NSMakeRange(0, defaultLength)];
  m.defaultLength = (uint32_t)defaultLength;
  if (mach_msg(&m.header, MACH_SEND_MSG | MACH_SEND_TIMEOUT, sizeof(m), 0, MACH_PORT_NULL, 100, MACH_PORT_NULL) == KERN_SUCCESS) {
    _dialogId = m.dialogId;
  }
}

- (void)dialogClosed {
  [self withdrawDialog];
}

/// The dialog the viewer was shown went away without its answer (or control went back to the agent): withdrawn.
- (void)withdrawDialog {
  if (_dialogId == 0) return;
  const uint32_t dialogId = _dialogId;
  _dialogId = 0;
  if (_viewer == MACH_PORT_NULL) return;
  WinterPresentDialogDoneMsg m = {};
  m.header.msgh_bits = MACH_MSGH_BITS(MACH_MSG_TYPE_COPY_SEND, 0);
  m.header.msgh_size = sizeof(m);
  m.header.msgh_remote_port = _viewer;
  m.header.msgh_id = WinterPresentMsgDialogDone;
  m.dialogId = dialogId;
  mach_msg(&m.header, MACH_SEND_MSG | MACH_SEND_TIMEOUT, sizeof(m), 0, MACH_PORT_NULL, 100, MACH_PORT_NULL);
}

- (BOOL)fileChooser:(int)requestId mode:(int)mode accept:(NSArray<NSString *> *)accept {
  if (_viewer == MACH_PORT_NULL || !_control) return NO;
  WinterPresentFileChooserMsg m;
  memset(&m, 0, sizeof(m));
  m.header.msgh_bits = MACH_MSGH_BITS(MACH_MSG_TYPE_COPY_SEND, 0);
  m.header.msgh_size = sizeof(m);
  m.header.msgh_remote_port = _viewer;
  m.header.msgh_id = WinterPresentMsgFileChooser;
  m.requestId = (uint32_t)requestId;
  m.mode = (uint32_t)mode;
  NSData *list = [[accept componentsJoinedByString:@","] dataUsingEncoding:NSUTF8StringEncoding] ?: [NSData data];
  const NSUInteger n = MIN(list.length, (NSUInteger)WinterPresentFileAcceptMax);
  memcpy(m.accept, list.bytes, n);
  m.acceptLength = (uint32_t)n;
  if (mach_msg(&m.header, MACH_SEND_MSG | MACH_SEND_TIMEOUT, sizeof(m), 0, MACH_PORT_NULL, 100, MACH_PORT_NULL) != KERN_SUCCESS) return NO;
  [_fileRequests addObject:@(requestId)];
  return YES;
}

/// Every file chooser the viewer was asked and has not answered is cancelled (the page is not left waiting).
- (void)cancelFileChoosers {
  for (NSNumber *requestId in _fileRequests) WinterCEFHeadlessResolveFileChooser(requestId.intValue, nil);
  [_fileRequests removeAllObjects];
}

- (void)hello:(mach_msg_header_t *)header token:(audit_token_t)token {
  const WinterPresentHelloMsg *m = (const WinterPresentHelloMsg *)header;
  NSString *why = nil;
  BOOL ok = header->msgh_id == WinterPresentMsgHello && header->msgh_size >= sizeof(WinterPresentHelloMsg) &&
            m->version == WinterPresentWireVersion && m->nonce == _nonce && header->msgh_remote_port != MACH_PORT_NULL &&
            WinterPresentPeerSatisfies(token, _requirement, &why);
  if (!ok) {
    NSLog(@"WinterHeadless: a presentation viewer was refused (%@)", why ?: @"not a matching HELLO");
    mach_msg_destroy(header);
    return;  // the service stays up for the real viewer; the daemon unpresents on its own timeout
  }
  _viewer = header->msgh_remote_port;  // the send right the HELLO carried is ours now
  _viewerToken = token;
  mach_port_t previous = MACH_PORT_NULL;
  mach_port_request_notification(mach_task_self(), _viewer, MACH_NOTIFY_DEAD_NAME, 0, _port, MACH_MSG_TYPE_MAKE_SEND_ONCE, &previous);
  if (previous != MACH_PORT_NULL) mach_port_deallocate(mach_task_self(), previous);

  WinterPresentWelcomeMsg welcome = {};
  welcome.header.msgh_bits = MACH_MSGH_BITS(MACH_MSG_TYPE_COPY_SEND, 0);
  welcome.header.msgh_size = sizeof(welcome);
  welcome.header.msgh_remote_port = _viewer;
  welcome.header.msgh_id = WinterPresentMsgWelcome;
  welcome.version = WinterPresentWireVersion;
  welcome.control = _control ? 1 : 0;
  welcome.cssWidth = WinterCEFHeadlessViewWidth;
  welcome.cssHeight = WinterCEFHeadlessViewHeight;
  welcome.scale = _scale;
  mach_msg(&welcome.header, MACH_SEND_MSG | MACH_SEND_TIMEOUT, sizeof(welcome), 0, MACH_PORT_NULL, 100, MACH_PORT_NULL);
  // Render for the viewer from now on: its scale, a viewer's frame rate, a fresh frame now.
  WinterCEFHeadlessSetPresentation(_key, _scale, 60);
  [self awaitFrame];
  if (_control) {
    WinterCEFHeadlessSetUserControl(_key, YES);
    WinterCEFHeadlessSendInput(_key, WinterPresentInputFocus, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
    [self offerHeldDialog];  // a dialog the page already holds is the person's to answer
  }
  if (_started != nil) {
    void (^started)(void) = _started;
    _started = nil;
    started();
  }
}

// MARK: - Frames

- (void)releasePool {
  for (int i = 0; i < WinterPresentPoolSlots; i++) {
    _textures[i] = nil;
    if (_surfaces[i] != NULL) {
      CFRelease(_surfaces[i]);
      _surfaces[i] = NULL;
    }
    _leased[i] = NO;
  }
  _poolWidth = _poolHeight = 0;
}

/// A new generation sized to what CEF painted (`width`×`height` device pixels): new owned surfaces, their send
/// rights handed to the viewer once. The old generation's surfaces are the viewer's to drop when it is done reading.
- (BOOL)newPoolWidth:(int)width height:(int)height {
  [self releasePool];
  _generation++;
  WinterPresentPoolMsg pool = {};
  pool.header.msgh_bits = MACH_MSGH_BITS(MACH_MSG_TYPE_COPY_SEND, 0) | MACH_MSGH_BITS_COMPLEX;
  pool.header.msgh_size = sizeof(pool);
  pool.header.msgh_remote_port = _viewer;
  pool.header.msgh_id = WinterPresentMsgPool;
  pool.body.msgh_descriptor_count = WinterPresentPoolSlots;
  pool.generation = _generation;
  pool.pixelWidth = width;
  pool.pixelHeight = height;
  pool.scale = _scale;
  const size_t bytesPerRow = ((size_t)width * 4 + 63) & ~(size_t)63;
  NSDictionary *props = @{
    (id)kIOSurfaceWidth : @(width),
    (id)kIOSurfaceHeight : @(height),
    (id)kIOSurfaceBytesPerElement : @4,
    (id)kIOSurfaceBytesPerRow : @(bytesPerRow),
    (id)kIOSurfaceAllocSize : @(bytesPerRow * (size_t)height),
    (id)kIOSurfacePixelFormat : @(0x42475241),  // 'BGRA'
  };
  MTLTextureDescriptor *descriptor = [MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatBGRA8Unorm
                                                                                         width:width
                                                                                        height:height
                                                                                     mipmapped:NO];
  descriptor.storageMode = MTLStorageModeShared;
  descriptor.usage = MTLTextureUsageShaderRead | MTLTextureUsageShaderWrite;
  for (int i = 0; i < WinterPresentPoolSlots; i++) {
    _surfaces[i] = IOSurfaceCreate((__bridge CFDictionaryRef)props);
    if (_surfaces[i] == NULL) {
      [self releasePool];
      return NO;
    }
    _textures[i] = [g_device newTextureWithDescriptor:descriptor iosurface:_surfaces[i] plane:0];
    pool.surfaces[i].name = IOSurfaceCreateMachPort(_surfaces[i]);
    pool.surfaces[i].disposition = MACH_MSG_TYPE_MOVE_SEND;
    pool.surfaces[i].type = MACH_MSG_PORT_DESCRIPTOR;
  }
  _poolWidth = width;
  _poolHeight = height;
  kern_return_t kr = mach_msg(&pool.header, MACH_SEND_MSG | MACH_SEND_TIMEOUT, sizeof(pool), 0, MACH_PORT_NULL, 100, MACH_PORT_NULL);
  if (kr != KERN_SUCCESS) {
    mach_msg_destroy(&pool.header);
    [self releasePool];
    return NO;
  }
  return YES;
}

- (void)paintType:(int)type surface:(IOSurfaceRef)surface {
  if (_viewer == MACH_PORT_NULL || _stopped) return;
  const uint64_t paintedAt = mach_absolute_time();
  if (type == 1) {
    [self copyPopup:surface];
    [self requestRepaint];  // a view frame composes it over the page
    return;
  }
  const int width = (int)IOSurfaceGetWidth(surface), height = (int)IOSurfaceGetHeight(surface);
  if (width != _poolWidth || height != _poolHeight) {
    if (![self newPoolWidth:width height:height]) return;
  }
  int slot = -1;
  for (int i = 0; i < WinterPresentPoolSlots; i++) {
    if (!_leased[i]) {
      slot = i;
      break;
    }
  }
  if (slot < 0) {  // the viewer still reads every slot: drop, never queue
    _dropped++;
    _droppedSinceFrame++;
    return;
  }
  @autoreleasepool {
    MTLTextureDescriptor *d = [MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatBGRA8Unorm
                                                                                 width:width
                                                                                height:height
                                                                             mipmapped:NO];
    d.storageMode = MTLStorageModeShared;
    id<MTLTexture> source = [g_device newTextureWithDescriptor:d iosurface:surface plane:0];
    if (source == nil) return;
    id<MTLCommandBuffer> commands = [g_queue commandBuffer];
    id<MTLBlitCommandEncoder> blit = [commands blitCommandEncoder];
    [blit copyFromTexture:source sourceSlice:0 sourceLevel:0 sourceOrigin:MTLOriginMake(0, 0, 0) sourceSize:MTLSizeMake(width, height, 1)
                toTexture:_textures[slot] destinationSlice:0 destinationLevel:0 destinationOrigin:MTLOriginMake(0, 0, 0)];
    if (_popupVisible && _popup != nil) {
      const int px = (int)lround(_popupX * _scale), py = (int)lround(_popupY * _scale);
      const int pw = (int)MIN((NSInteger)_popup.width, (NSInteger)width - px), ph = (int)MIN((NSInteger)_popup.height, (NSInteger)height - py);
      if (px >= 0 && py >= 0 && pw > 0 && ph > 0) {
        [blit copyFromTexture:_popup sourceSlice:0 sourceLevel:0 sourceOrigin:MTLOriginMake(0, 0, 0) sourceSize:MTLSizeMake(pw, ph, 1)
                    toTexture:_textures[slot] destinationSlice:0 destinationLevel:0 destinationOrigin:MTLOriginMake(px, py, 0)];
      }
    }
    [blit endEncoding];
    [commands commit];
    [commands waitUntilCompleted];  // CEF takes its surface back when this callback returns
  }
  const uint64_t copiedAt = mach_absolute_time();
  [_copyMs addObject:@(Ms(copiedAt - paintedAt))];
  if (_copyMs.count > 20000) [_copyMs removeObjectsInRange:NSMakeRange(0, 10000)];

  WinterPresentFrameMsg frame = {};
  frame.header.msgh_bits = MACH_MSGH_BITS(MACH_MSG_TYPE_COPY_SEND, 0);
  frame.header.msgh_size = sizeof(frame);
  frame.header.msgh_remote_port = _viewer;
  frame.header.msgh_id = WinterPresentMsgFrame;
  frame.generation = _generation;
  frame.slot = (uint32_t)slot;
  frame.sequence = ++_sequence;
  frame.paintedAt = paintedAt;
  frame.copiedAt = copiedAt;
  frame.inputSequence = _lastInputSequence;
  frame.dropped = (uint32_t)_droppedSinceFrame;
  kern_return_t kr = mach_msg(&frame.header, MACH_SEND_MSG | MACH_SEND_TIMEOUT, sizeof(frame), 0, MACH_PORT_NULL, 0, MACH_PORT_NULL);
  if (kr == KERN_SUCCESS) {
    _leased[slot] = YES;
    _frames++;
    _awaitingFrame = NO;
    _droppedSinceFrame = 0;
  } else {  // the viewer's queue is full: the frame is dropped, the slot stays free
    _dropped++;
    _droppedSinceFrame++;
  }
}

- (void)copyPopup:(IOSurfaceRef)surface {
  const int width = (int)IOSurfaceGetWidth(surface), height = (int)IOSurfaceGetHeight(surface);
  if (width <= 0 || height <= 0) return;
  @autoreleasepool {
    MTLTextureDescriptor *d = [MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatBGRA8Unorm
                                                                                 width:width
                                                                                height:height
                                                                             mipmapped:NO];
    d.storageMode = MTLStorageModeShared;
    id<MTLTexture> source = [g_device newTextureWithDescriptor:d iosurface:surface plane:0];
    if (_popup == nil || (int)_popup.width != width || (int)_popup.height != height) {
      MTLTextureDescriptor *own = [MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatBGRA8Unorm
                                                                                     width:width
                                                                                    height:height
                                                                                 mipmapped:NO];
      own.storageMode = MTLStorageModePrivate;
      _popup = [g_device newTextureWithDescriptor:own];
    }
    if (source == nil || _popup == nil) return;
    id<MTLCommandBuffer> commands = [g_queue commandBuffer];
    id<MTLBlitCommandEncoder> blit = [commands blitCommandEncoder];
    [blit copyFromTexture:source sourceSlice:0 sourceLevel:0 sourceOrigin:MTLOriginMake(0, 0, 0) sourceSize:MTLSizeMake(width, height, 1)
                toTexture:_popup destinationSlice:0 destinationLevel:0 destinationOrigin:MTLOriginMake(0, 0, 0)];
    [blit endEncoding];
    [commands commit];
    [commands waitUntilCompleted];
  }
}

- (void)popupKind:(int)kind x:(int)x y:(int)y width:(int)width height:(int)height {
  if (kind == 0) {
    _popupVisible = NO;
    _popup = nil;
  } else if (kind == 1) {
    _popupVisible = YES;
  } else {
    _popupX = x;
    _popupY = y;
    _popupWidth = width;
    _popupHeight = height;
  }
  if (_viewer != MACH_PORT_NULL) [self requestRepaint];
}

/// A fresh view frame, asked for after the CEF callback we are in has returned.
- (void)requestRepaint {
  __weak WinterHeadlessPresenter *weak = self;
  dispatch_async(dispatch_get_main_queue(), ^{
    WinterHeadlessPresenter *strong = weak;
    if (strong == nil || strong->_stopped || strong->_viewer == MACH_PORT_NULL) return;
    WinterCEFHeadlessSetPresentation(strong->_key, strong->_scale, 60);
  });
}

- (void)cursor:(int)type {
  if (_viewer == MACH_PORT_NULL) return;
  WinterPresentCursorMsg m = {};
  m.header.msgh_bits = MACH_MSGH_BITS(MACH_MSG_TYPE_COPY_SEND, 0);
  m.header.msgh_size = sizeof(m);
  m.header.msgh_remote_port = _viewer;
  m.header.msgh_id = WinterPresentMsgCursor;
  m.cursorType = type;
  mach_msg(&m.header, MACH_SEND_MSG | MACH_SEND_TIMEOUT, sizeof(m), 0, MACH_PORT_NULL, 0, MACH_PORT_NULL);
}

// MARK: - Ending

/// `reason` 0: unpresented by the daemon (no `ended` call); -1: the viewer ended it (`ended` with `why`).
- (void)endSaying:(int)reason reason:(nullable NSString *)why {
  if (_stopped) return;
  WinterHeadlessPresenter *keep = self;  // the registry may hold the last reference
  (void)keep;
  _stopped = YES;
  if (_viewer != MACH_PORT_NULL) {
    if (reason == 0) {
      WinterPresentEndedMsg ended = {};
      ended.header.msgh_bits = MACH_MSGH_BITS(MACH_MSG_TYPE_COPY_SEND, 0);
      ended.header.msgh_size = sizeof(ended);
      ended.header.msgh_remote_port = _viewer;
      ended.header.msgh_id = WinterPresentMsgEnded;
      ended.reason = 0;
      mach_msg(&ended.header, MACH_SEND_MSG | MACH_SEND_TIMEOUT, sizeof(ended), 0, MACH_PORT_NULL, 50, MACH_PORT_NULL);
    }
    mach_port_deallocate(mach_task_self(), _viewer);
    _viewer = MACH_PORT_NULL;
  }
  if (_source != nil) {
    dispatch_source_cancel(_source);
    _source = nil;
  }
  if (_port != MACH_PORT_NULL) {
    mach_port_mod_refs(mach_task_self(), _port, MACH_PORT_RIGHT_RECEIVE, -1);  // the service name goes with it
    _port = MACH_PORT_NULL;
  }
  [self releasePool];
  _popup = nil;
  // Nothing the viewer was asked stays waiting on it: a held dialog stays held (the agent can answer it), file choosers
  // are cancelled.
  _dialogId = 0;
  [self cancelFileChoosers];
  // Back to the tab's own rendering: scale 1, the helper's own frame rate; the user's focus taken back.
  if (_control) WinterCEFHeadlessSendInput(_key, WinterPresentInputFocus, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
  WinterCEFHeadlessSetUserControl(_key, NO);
  WinterCEFHeadlessSetPresentation(_key, 1.0, 0);
  [g_presenters removeObjectForKey:@(_browserId)];
  _started = nil;
  if (reason != 0 && _ended != nil) {
    void (^ended)(NSString *) = _ended;
    _ended = nil;
    ended(why ?: @"ended");
  }
}

@end
