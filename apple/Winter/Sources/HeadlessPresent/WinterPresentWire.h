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
// Version 2 adds what makes the shown page behave like a browser for the person using it, all of it only while the
// viewer holds CONTROL (a take-over; a watch-only viewer gets none of it):
//   - IME: the viewer's input method edits a composition (`WinterPresentMsgIme`); the producer reports where the
//     composed characters are drawn (`WinterPresentMsgImeBounds`) so the candidate window sits next to them;
//   - edit commands the user chose (`WinterPresentMsgEdit`: copy, cut, paste, select all, undo, redo, delete) — a PASTE
//     carries its text: Winter.app reads the pasteboard on the user's ⌘V and the helper never does;
//   - page dialogs (`alert`/`confirm`/`prompt`/`beforeunload`): the producer asks the viewer (`WinterPresentMsgDialog`),
//     the user answers there (`WinterPresentMsgDialogReply`), and a dialog answered or dismissed any other way is
//     withdrawn (`WinterPresentMsgDialogDone`);
//   - file choosers: the producer asks (`WinterPresentMsgFileChooser`); the viewer shows its own open panel, copies what
//     the user chose where the helper may read it (`<home>/cache/headless-uploads/`), and answers with those copies'
//     paths (`WinterPresentMsgFileReply`) — the helper accepts no path outside that folder.
// Text travels inline as UTF-16 (`WinterPresentTextMax` units a message; a longer paste or commit is sent in pieces).
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
enum { WinterPresentWireVersion = 2 };
/// UTF-16 code units of text one message carries inline.
enum { WinterPresentTextMax = 1024 };
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
  // viewer → producer, version 2 (only while the viewer holds control)
  WinterPresentMsgIme = 0x57500006,          // the input method edited, committed, finished or cancelled a composition
  WinterPresentMsgEdit = 0x57500007,         // an edit command the user chose (a paste carries its text)
  WinterPresentMsgDialogReply = 0x57500008,  // the user's answer to a page dialog
  WinterPresentMsgFileReply = 0x57500009,    // the user's choice for a file chooser (the copies' paths)
  // producer → viewer
  WinterPresentMsgWelcome = 0x57501001,  // HELLO accepted: the tab's CSS size, scale, control
  WinterPresentMsgPool = 0x57501002,     // a new generation's surfaces (port descriptors)
  WinterPresentMsgFrame = 0x57501003,    // a slot holds a new frame
  WinterPresentMsgCursor = 0x57501004,   // the page's cursor changed
  WinterPresentMsgEnded = 0x57501005,    // the producer ended the presentation (unpresent, tab gone)
  // producer → viewer, version 2
  WinterPresentMsgImeBounds = 0x57501006,    // where the composition's characters are drawn (CSS pixels)
  WinterPresentMsgDialog = 0x57501007,       // a page dialog waits for the user
  WinterPresentMsgDialogDone = 0x57501008,   // that dialog went away (answered elsewhere, the page navigated)
  WinterPresentMsgFileChooser = 0x57501009,  // the page asks the user to choose files
  WinterPresentMsgControl = 0x5750100A,      // the viewer may (1) or may no longer (0) send input
  WinterPresentMsgPage = 0x5750100B,         // the shown page's address and title (after the welcome, and on a change)
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

typedef struct {
  mach_msg_header_t header;
  uint32_t control;  // 1: the viewer holds control (input, IME, edits, dialogs, files); 0: watch only
  uint32_t reserved;
} WinterPresentControlMsg;

// ---- version 2: IME ----------------------------------------------------------------------------------------------

/// `WinterPresentImeMsg.kind`.
enum {
  WinterPresentImeSetComposition = 1,  // `text` is the marked text; `selection*` the caret/selection inside it
  WinterPresentImeCommit = 2,          // `text` is inserted, replacing `replacement*` when given
  WinterPresentImeFinish = 3,          // the marked text is kept as typed
  WinterPresentImeCancel = 4,          // the marked text is dropped
};

typedef struct {
  mach_msg_header_t header;
  uint32_t kind;
  /// UTF-16 code units in `text`.
  uint32_t length;
  /// Inside the marked text (SetComposition): the caret is `selectionStart == selectionEnd`.
  int32_t selectionStart, selectionEnd;
  /// The range of the field's text the composition replaces; -1, -1: none (the current selection).
  int32_t replacementStart, replacementEnd;
  uint64_t sequence, sentAt;
  uint16_t text[WinterPresentTextMax];
} WinterPresentImeMsg;

typedef struct {
  int32_t x, y, width, height;
} WinterPresentRect;

enum { WinterPresentImeRectsMax = 64 };

typedef struct {
  mach_msg_header_t header;
  /// The composition's range in the field's text.
  int32_t rangeStart, rangeEnd;
  uint32_t count;
  uint32_t reserved;
  /// One rectangle per composed character, CSS pixels of the view.
  WinterPresentRect rects[WinterPresentImeRectsMax];
} WinterPresentImeBoundsMsg;

// ---- version 2: edit commands --------------------------------------------------------------------------------------

/// `WinterPresentEditMsg.command`.
enum {
  WinterPresentEditCopy = 1,
  WinterPresentEditCut = 2,
  WinterPresentEditPaste = 3,  // `text` is what to paste (plain text; Winter.app read it from the pasteboard)
  WinterPresentEditSelectAll = 4,
  WinterPresentEditUndo = 5,
  WinterPresentEditRedo = 6,
  WinterPresentEditDelete = 7,
};

typedef struct {
  mach_msg_header_t header;
  uint32_t command;
  /// UTF-16 code units in `text` (a paste only).
  uint32_t length;
  uint64_t sequence, sentAt;
  uint16_t text[WinterPresentTextMax];
} WinterPresentEditMsg;

// ---- version 2: page dialogs -----------------------------------------------------------------------------------------

/// `WinterPresentDialogMsg.type`.
enum {
  WinterPresentDialogAlert = 0,
  WinterPresentDialogConfirm = 1,
  WinterPresentDialogPrompt = 2,
  WinterPresentDialogBeforeUnload = 3,  // "leave this page?"
};

enum { WinterPresentDialogDefaultMax = 256, WinterPresentOriginMax = 256 };

typedef struct {
  mach_msg_header_t header;
  /// The producer's own id for this dialog (a reply names it).
  uint32_t dialogId;
  uint32_t type;
  /// UTF-16 code units in `message` and `defaultText` (cut at their maxima).
  uint32_t messageLength, defaultLength;
  uint16_t message[WinterPresentTextMax];
  uint16_t defaultText[WinterPresentDialogDefaultMax];
  /// Bytes in `origin`: the origin of the page that raised the dialog (`scheme://host[:port]`), UTF-8, not
  /// NUL-terminated — what the viewer names as the dialog's author (never the address it was first shown at).
  uint32_t originLength;
  uint32_t reserved;
  char origin[WinterPresentOriginMax];
} WinterPresentDialogMsg;

typedef struct {
  mach_msg_header_t header;
  uint32_t dialogId;
  /// 1 OK / leave, 0 Cancel / stay.
  uint32_t accept;
  /// A prompt's answer: UTF-16 code units in `text`.
  uint32_t length;
  uint32_t reserved;
  uint16_t text[WinterPresentTextMax];
} WinterPresentDialogReplyMsg;

typedef struct {
  mach_msg_header_t header;
  uint32_t dialogId;
  uint32_t reserved;
} WinterPresentDialogDoneMsg;

// ---- version 2: the shown page ---------------------------------------------------------------------------------------

enum { WinterPresentPageURLMax = 2048, WinterPresentPageTitleMax = 256 };

typedef struct {
  mach_msg_header_t header;
  /// Bytes of `url` (UTF-8, not NUL-terminated) and UTF-16 code units of `title`, cut at their maxima.
  uint32_t urlLength, titleLength;
  char url[WinterPresentPageURLMax];
  uint16_t title[WinterPresentPageTitleMax];
} WinterPresentPageMsg;

// ---- version 2: file choosers ------------------------------------------------------------------------------------------

/// `WinterPresentFileChooserMsg.mode`.
enum {
  WinterPresentFileOpen = 0,
  WinterPresentFileOpenMultiple = 1,
  WinterPresentFileOpenFolder = 2,
  WinterPresentFileSave = 3,
};

enum { WinterPresentFileAcceptMax = 1024, WinterPresentFilePathsMax = 16384 };

typedef struct {
  mach_msg_header_t header;
  uint32_t requestId;
  uint32_t mode;
  /// Bytes in `accept`: the page's accepted types, UTF-8, comma-separated (".pdf,image/*"), not NUL-terminated.
  uint32_t acceptLength;
  uint32_t reserved;
  char accept[WinterPresentFileAcceptMax];
} WinterPresentFileChooserMsg;

typedef struct {
  mach_msg_header_t header;
  uint32_t requestId;
  /// 0: the user cancelled (no paths).
  uint32_t accept;
  /// Bytes used in `paths`, and how many paths: absolute UTF-8 paths, each NUL-terminated — copies inside
  /// `<home>/cache/headless-uploads/`, the only place the helper reads a chosen file from.
  uint32_t length, count;
  char paths[WinterPresentFilePathsMax];
} WinterPresentFileReplyMsg;

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
  WinterPresentControlMsg control;
  WinterPresentImeMsg ime;
  WinterPresentImeBoundsMsg imeBounds;
  WinterPresentEditMsg edit;
  WinterPresentDialogMsg dialog;
  WinterPresentDialogReplyMsg dialogReply;
  WinterPresentDialogDoneMsg dialogDone;
  WinterPresentFileChooserMsg fileChooser;
  WinterPresentFileReplyMsg fileReply;
  WinterPresentPageMsg page;
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
