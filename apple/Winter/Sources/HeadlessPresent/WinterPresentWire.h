// ComputerV2 Phase 4 — **headless presentation**: Winter Headless (the PRODUCER, the page's one owner) shows a live
// tab to Winter.app (the VIEWER) through the GPU, never a CPU pixel path and never a second page. The tab never
// leaves the helper: presenting never reloads, navigates or cancels anything.
//
// The channel is a pair of Mach ports, both sides authenticated by code signature:
//   - for one presentation the producer checks in a receive right under a random bootstrap name
//     (`WinterPresentServiceName`), told to the viewer through the daemon;
//   - the viewer looks it up and sends HELLO carrying a send right to its OWN receive port; the producer reads the
//     viewer's audit token from the message's trailer and checks it against the viewer requirement the daemon
//     named (Winter.app's designated requirement) before it sends a single pixel. Every later message from the viewer
//     must come from the same process (pid + pidversion);
//   - the viewer checks every producer message's audit token against Winter Headless's requirement the same way.
// IOSurfaces travel as Mach port descriptors (`IOSurfaceCreateMachPort`) — the actual send rights, never an id —
// once per POOL generation; FRAME messages then name a slot of that pool. The producer copies each of CEF's borrowed
// frames into a FREE slot on the GPU and waits for the copy before CEF's callback returns (its contract); a slot is
// free again only when the viewer says its own GPU read of it completed (RELEASE). No free slot: the frame is
// dropped, never queued. A resize or a scale change starts a new generation; a stale generation's FRAME or RELEASE
// is ignored.
//
// Plain C: compiled into the producer (the helper), the viewer (Winter.app) and the proof tool alike.
#ifndef WinterPresentWire_h
#define WinterPresentWire_h

#include <mach/mach.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/// The wire's own version: a viewer and a producer of different versions refuse each other at HELLO.
enum { WinterPresentWireVersion = 1 };
/// Slots per pool generation (bounded: three frames in flight at most).
enum { WinterPresentPoolSlots = 3 };

/// Message ids (`msgh_id`).
enum {
  // viewer → producer
  WinterPresentMsgHello = 0x57500001,    // + a send right to the viewer's port (msgh_local_port, MAKE_SEND)
  WinterPresentMsgRelease = 0x57500002,  // the viewer's GPU read of a slot completed
  WinterPresentMsgInput = 0x57500003,    // one human input event (only while the viewer holds control)
  WinterPresentMsgResize = 0x57500004,   // the viewer's drawable size and scale changed
  WinterPresentMsgBye = 0x57500005,      // the viewer stops presenting
  // producer → viewer
  WinterPresentMsgWelcome = 0x57501001,  // HELLO accepted: the tab's CSS size, scale, control
  WinterPresentMsgPool = 0x57501002,     // a new generation's surfaces (port descriptors)
  WinterPresentMsgFrame = 0x57501003,    // a slot holds a new frame
  WinterPresentMsgCursor = 0x57501004,   // the page's cursor changed
  WinterPresentMsgEnded = 0x57501005,    // the producer ended the presentation (unpresent, tab gone)
};

typedef struct {
  mach_msg_header_t header;
  uint32_t version;
  uint32_t reserved;
  /// The presentation's nonce, as the daemon told both sides (a viewer that names another is refused).
  uint64_t nonce;
} WinterPresentHelloMsg;

typedef struct {
  mach_msg_header_t header;
  uint32_t version;
  /// 1 when the viewer may send input (a take-over), 0 watch only.
  uint32_t control;
  int32_t cssWidth, cssHeight;
  double scale;
} WinterPresentWelcomeMsg;

typedef struct {
  mach_msg_header_t header;
  mach_msg_body_t body;
  mach_msg_port_descriptor_t surfaces[WinterPresentPoolSlots];
  uint32_t generation;
  int32_t pixelWidth, pixelHeight;
  uint32_t reserved;
  double scale;
} WinterPresentPoolMsg;

typedef struct {
  mach_msg_header_t header;
  uint32_t generation;
  uint32_t slot;
  uint64_t sequence;
  /// `mach_absolute_time()`: the producer's paint callback entered / its GPU copy completed.
  uint64_t paintedAt, copiedAt;
  /// The last input event the producer had dispatched when this frame was painted (0: none yet).
  uint64_t inputSequence;
  /// Frames the producer dropped since the last FRAME (no free slot).
  uint32_t dropped;
  uint32_t reserved;
} WinterPresentFrameMsg;

typedef struct {
  mach_msg_header_t header;
  uint32_t generation;
  uint32_t slot;
} WinterPresentReleaseMsg;

/// Input kinds.
enum {
  WinterPresentInputMouseMove = 1,
  WinterPresentInputMouseDown = 2,
  WinterPresentInputMouseUp = 3,
  WinterPresentInputWheel = 4,
  WinterPresentInputMouseLeave = 5,
  WinterPresentInputKeyDown = 6,  // a raw key down (CEF KEYEVENT_RAWKEYDOWN)
  WinterPresentInputKeyUp = 7,
  WinterPresentInputChar = 8,     // the character a key produced (CEF KEYEVENT_CHAR)
  WinterPresentInputFocus = 9,    // x = 1 focus, 0 blur
};

typedef struct {
  mach_msg_header_t header;
  uint32_t kind;
  /// CEF's EVENTFLAG_* bits.
  uint32_t modifiers;
  /// The viewer's own sequence and `mach_absolute_time()` when the event happened (for latency).
  uint64_t sequence;
  uint64_t sentAt;
  /// Mouse: CSS pixels in the tab's view; wheel: deltas in dx/dy.
  int32_t x, y, dx, dy;
  /// Mouse: 0 left, 1 middle, 2 right; click count.
  int32_t button, clickCount;
  /// Key: Windows key code, macOS key code, the character and the unmodified character (UTF-16).
  int32_t windowsKeyCode, nativeKeyCode;
  uint16_t character, unmodifiedCharacter;
  uint32_t reserved;
} WinterPresentInputMsg;

typedef struct {
  mach_msg_header_t header;
  int32_t pixelWidth, pixelHeight;
  double scale;
} WinterPresentResizeMsg;

typedef struct {
  mach_msg_header_t header;
  /// CEF's cef_cursor_type_t.
  int32_t cursorType;
  int32_t reserved;
} WinterPresentCursorMsg;

typedef struct {
  mach_msg_header_t header;
  uint32_t reason;  // 0 unpresented, 1 the tab closed, 2 refused (authentication)
  uint32_t reserved;
} WinterPresentEndedMsg;

/// The largest message either side receives, plus room for the audit trailer.
typedef union {
  mach_msg_header_t header;
  WinterPresentHelloMsg hello;
  WinterPresentWelcomeMsg welcome;
  WinterPresentPoolMsg pool;
  WinterPresentFrameMsg frame;
  WinterPresentReleaseMsg release;
  WinterPresentInputMsg input;
  WinterPresentResizeMsg resize;
  WinterPresentCursorMsg cursor;
  WinterPresentEndedMsg ended;
} WinterPresentAnyMsg;

typedef struct {
  WinterPresentAnyMsg message;
  mach_msg_audit_trailer_t trailer;
  uint8_t slack[64];
} WinterPresentReceiveBuffer;

#ifdef __cplusplus
}
#endif

#endif /* WinterPresentWire_h */
