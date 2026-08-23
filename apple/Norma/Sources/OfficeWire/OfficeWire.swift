import Foundation

/// Office Stage A, Task 2 — **the whole vocabulary spoken over the office helper's Unix socket**,
/// compiled into BOTH `Norma` (the app) and `NormaOfficeHelper` (the helper) via two separate
/// xcodegen `sources` entries pointing at this one file — never a framework, per the brief
/// ("NOT a framework — keep it simple").
///
/// ## The transport deviation from the brief — read this before anything else in this file
///
/// The brief's Files section describes an XPC protocol (`OfficeHelperXPC` with
/// `open(docId:path:reply:)` / `close(docId:)` / `ping(reply:)`) for the app↔helper control plane,
/// with a *separate* NDJSON Unix socket reserved for the daemon's agent role. **Controller
/// resolution (pre-dispatch, recorded in the task-2 dispatch note in progress.md) overrides this
/// for Stage A**: an `NSXPCListenerEndpoint` cannot cross a plain Unix socket — it is a mach
/// object — so bootstrapping real XPC between an app and a helper it spawned directly (no
/// launchd, no prior mach handshake) needs a channel to hand the endpoint across in the first
/// place, which begs the question. The ONE constraint that actually forces XPC is IOSurface
/// (mach-port) transfer for tiles, and tiles are Task 4's problem, not this one.
///
/// So for Stage A: **both roles speak the same NDJSON-over-Unix-socket wire**, discriminated by
/// `role` in the `hello` frame. `open`/`close`/`ping` — the brief's app-role XPC methods — are
/// request/response frame PAIRS here instead of XPC calls-with-reply-blocks. The daemon's agent
/// role gets the same `hello` handshake (the "listener + role handshake land now" the plan's
/// architecture note promises); it has no further verbs in Stage A (Stage C is the consumer).
/// Task 4 owns the real surface-transport decision (XPC service target vs. a minimal mach
/// bootstrap vs. an mmap fallback) for IOSurfaces specifically, with a measurement argument.
///
/// ## The frame set
///
/// One flat `OfficeWireFrame` enum for both directions — client→helper requests
/// (`hello`/`ping`/`open`/`close`) and helper→client replies (`helloOk`/`refused`/`pong`/
/// `opened`/`closed`/`error`) — because both ends decode the same wire and a single exhaustive
/// vocabulary is what keeps them from drifting apart (the `wireTypes` parity discipline this
/// repo already uses for `TRANSIENT_EVENT_TYPES` and `EditorBridgeInbound`/`Outbound`).
///
/// **Every frame carries `seq`.** The caller mints it; the callee echoes it. This is how a
/// caller matches a reply to the request that provoked it on a connection that may have several
/// requests in flight (the same anchor discipline `EditorBridgeOutbound.pullContent`'s `seq`
/// documents at length).
///
/// **Refuse, never ignore.** A line the helper cannot map to a known request type gets
/// `error{seq,reason:"unknown"}` back — never silence. This is the `EditorBridgeHub` hub's own
/// rule, applied to a socket instead of a `cefQuery` slot: an unanswered line strands whatever
/// asked for something on the other end of a request/response protocol exactly as an unanswered
/// query strands a CEF callback.
public enum OfficeWireFrame: Equatable, Sendable {
    // MARK: Requests (client -> helper)

    /// Must be the FIRST frame on every connection — the helper refuses anything else as the
    /// opener (see `OfficeHelperServer`). `role` is bookkeeping for Stage A (Stage C's job is
    /// giving the daemon its own distinct credential); Task 2 checks `token` against the ONE
    /// value the helper was launched with, for either role — a disclosed Stage A simplification,
    /// not a security boundary between app and daemon (there is only one client at a time in
    /// Stage A; nothing consumes the agent role's own verbs yet).
    case hello(seq: UInt64, role: OfficeWireRole, token: String)
    /// A bare liveness probe, answerable at any point after a successful `hello`.
    case ping(seq: UInt64)
    /// Track a document as open. Task 3: `open` is now REAL — the helper's `LOKBridge` actually
    /// calls `documentLoad`. **Not idempotent for a docId already open** (a Task 2 simplification
    /// this task retires now that handles are real): a second `open` of the same `docId` gets
    /// `error{reason:"alreadyOpen"}` — see `OfficeHelperServer.handlePostAuthLine`'s own comment
    /// for the reasoning (a silent re-load would leak or double-own a real LOK document handle;
    /// `close` first is the honest way to reload). `path` is a plain filesystem path, converted to
    /// a `file://` URL internally — the caller never constructs the URL itself.
    case open(seq: UInt64, docId: String, path: String)
    /// Stop tracking a document — destroys its LOK handle for real (Task 3). Idempotent (unlike
    /// `open` above): closing an untracked `docId` still acks `closed` rather than erroring —
    /// there is no unsafe double-destruction risk here (a `docId` either has a live handle to
    /// destroy or it doesn't; either way "not open anymore" is true after this).
    case close(seq: UInt64, docId: String)

    /// Office Stage B Task 2 — ask the helper to render `docId`'s CURRENT in-memory state to a
    /// fresh file, in the document's own format, under the helper's own `--state-path` (never at
    /// the real document path — the seatbelt's write fence only ever allows writes under
    /// `--state-path`, Task 1's invariant, unchanged and untouched by this task). The APP is what
    /// places the helper's answer onto the real path afterward (`OfficeRuntime.perform`'s `.save`
    /// effect) — see `saved`'s own header for the two-step split this shape exists to honor, and
    /// why the helper is never asked to write to the real path directly.
    ///
    /// **Fix round 4 (NEW-2) — `part` added, and it means something different here than on the
    /// input verbs.** On `keyEvent`/`mouseEvent`, `part` says "where this event is aimed." Here it
    /// says "which part the USER is actually on," and its only job is to be asserted onto LOK
    /// immediately before the write, so that the saved view state records the user's own active
    /// part rather than whatever the last tile paint happened to leave current. That is not the
    /// same thing: LOK's current part is process state that ordinary PAINT traffic moves, and a
    /// prefetch chunk cut by a part switch is still delivered afterward — so a paint carrying the
    /// OLD part can re-park LOK there after the switch, with no corrective paint to follow if the
    /// new part's tiles are already cached. Before this field, `saveAs` asserted no part at all and
    /// simply inherited that race. Resolved from the SAME `DocumentEntry.activePart` the input
    /// verbs read (`OfficeRuntimeReducer`'s `.saveRequested`), so "the user's part" has exactly one
    /// definition across this wire.
    case save(seq: UInt64, docId: String, part: Int)

    /// Office Stage B Task 4 — **the real edit verb.** LOK's `postKeyEvent(nType, nCharCode,
    /// nKeyCode)` (`LibreOfficeKit.h`), unchanged parameter-for-parameter across the wire.
    ///
    /// **Fix round 1, F2 (CRITICAL) — `part` added.** `postKeyEvent` has NO part parameter in LOK's
    /// own C signature (unlike `paintPartTile`'s explicit `nPart`) — it always targets whatever
    /// `getPart()`/the document's current part happens to be, a genuinely STATEFUL LOK-side notion
    /// painting never has to deal with. Before this field existed, a keystroke posted while viewing
    /// sheet 2 could silently land on sheet 0 (whatever LOK's internal "current part" happened to be
    /// last set to, never communicated over this wire at all) — persisted by save, no visible
    /// repaint to notice by. `part` carries the SAME value `subscribeTiles`/`tileRequest` already
    /// scope painting by (`OfficeRuntimeState.DocumentEntry.activePart`, resolved at enqueue time —
    /// see `OfficeRuntime.postKeyEvent`'s own doc); the helper is what turns this into a real
    /// `setPart` call immediately before the post — see `LOKBridge.postKeyOnDedicatedThread`'s own
    /// header for why that stateful step cannot be avoided the way `paintPartTile`'s avoids it.
    ///
    /// `charCode` is the Unicode scalar the key produces (0 for a non-printing key — arrows, Delete, bare
    /// modifiers); `keyCode` is a FULL VCL-packed value — `com.sun.star.awt.Key`'s base code (e.g.
    /// `512` for `A`) OR'd with SHIFTED modifier bits (`0x1000`/`0x2000`/`0x4000`/`0x8000` for
    /// Shift/Mod1/Mod2/Mod3), never the bare, unshifted `KeyModifier` group's `1/2/4/8`. This is not
    /// a guess: `SfxLokHelper::postKeyEventAsync` (`sfx2/source/view/lokhelper.cxx`) constructs
    /// `KeyEvent(nCharCode, nKeyCode, nRepeat)`, whose second parameter converts via
    /// `vcl::KeyCode(sal_uInt16 nKey, sal_uInt16 nModifier = 0)` — a SINGLE-argument implicit
    /// conversion (`nModifier` defaults to 0), so the ENTIRE incoming `int` becomes
    /// `nKeyCodeAndModifiers` verbatim (`include/vcl/keycod.hxx`). `OfficeInputCodes` is the one
    /// place that builds this packed value; see its own header for the AppKit-keyCode source and the
    /// cross-check against this repo's own independent `ComputerCapabilities.cuKeyCode` table.
    case keyEvent(seq: UInt64, docId: String, part: Int, type: OfficeKeyEventType, charCode: Int, keyCode: Int)
    /// Office Stage B Task 4 — LOK's `postMouseEvent(nType, nX, nY, nCount, nButtons, nModifier)`.
    /// **Fix round 1, F2 — `part` added, same reasoning and same resolution point as `keyEvent`'s
    /// own doc comment above**: `postMouseEvent` has no part parameter either, `xTwips`/`yTwips`
    /// are only meaningful once the RIGHT part is current (a document-space coordinate is anchored
    /// to whichever part LOK considers active), so this is not merely "which part gets the click" —
    /// an un-scoped `setPart` mismatch would misinterpret the coordinates themselves, against
    /// whatever part LOK happened to have current.
    /// `xTwips`/`yTwips` are DOCUMENT-space twips (LOK's own coordinate system for this call —
    /// confirmed against `ScModelObj::postMouseEvent`, `sc/source/ui/unoobj/docuno.cxx`, which
    /// converts them via `GetPPTX()`/`GetPPTY()` the same way every other twips-space input this
    /// wire already carries is converted). `buttons` is VCL's `MOUSE_LEFT`(1)/`MIDDLE`(2)/`RIGHT`(4)
    /// bitmask (`include/vcl/event.hxx`) — UNLIKE `keyEvent`'s `keyCode`, this is NOT combined with
    /// `modifiers`: `MouseEvent`'s own constructor takes `nButtons`/`nModifier` as two SEPARATE
    /// `sal_uInt16` parameters, packed into the same low/high-bit split internally
    /// (`GetButtons()`/`IsShift()` etc. mask the identical field two different ways) but never
    /// combined by a CALLER. `modifiers` uses the SAME shifted encoding `keyEvent.keyCode`'s
    /// modifier half does (`OfficeInputCodes.modifierMask`) — confirmed by `MouseEvent::IsShift()`
    /// checking `mnCode & KEY_SHIFT` (`0x1000`), the identical constant `KeyCode::IsShift()` checks.
    case mouseEvent(seq: UInt64, docId: String, part: Int, type: OfficeMouseEventType, xTwips: Int64, yTwips: Int64,
                     count: Int, buttons: Int, modifiers: Int)

    /// Office Stage B Task 5 — LOK's `postWindowExtTextInputEvent(pThis, nWindowId, nType, pText)`
    /// (`LibreOfficeKit.h`; `nWindowId` always `0` — see `LOKBridge.postExtTextInputOnDedicatedThread`'s
    /// own header for why `0` resolves to the SAME document-instance-scoped window `postKey`/
    /// `postMouse` already target, not a process-global one). This is the MARKED/preedit half of IME
    /// composition — `NSTextInputClient.setMarkedText(_:...)` calls through here with `type: .input`
    /// on every keystroke of a multi-stage compose (LOK underlines whatever `text` names, replacing
    /// any previously-marked run); `type: .end` COMMITS — LOK's own `SfxLokHelper::postExtTextEventAsync`
    /// (`sfx2/source/view/lokhelper.cxx`) sets `LOK_EXT_TEXTINPUT_END`'s final text unconditionally to
    /// EMPTY, ignoring `pText` entirely, so "end" always commits whatever is CURRENTLY marked, never
    /// text passed alongside it — `text` on an `.end` frame is therefore always sent empty by this
    /// bridge's own caller (`OfficeRuntime.postExtTextInput`), a documented-not-decorative convention,
    /// not a wire requirement `OfficeWireCodec` itself enforces. A plain, non-marked `insertText:`
    /// (typing an ordinary ASCII character, no composition) does NOT come through here at all — see
    /// `OfficeTileCanvasView.insertText(_:replacementRange:)`'s own header for why that case rides the
    /// already-proven `postKeyEvent`-per-scalar path instead, reserving this newer, less-exercised verb
    /// strictly for genuine marked text.
    ///
    /// `part` — same resolved-at-enqueue-time meaning and same ordering-chain membership as
    /// `keyEvent`/`mouseEvent`'s own `part` (see `OfficeRuntime.postExtTextInput`'s own header): a
    /// composition keystroke must reach LOK in the SAME relative order as any key/mouse event typed
    /// or clicked around it, or a click-mid-compose / arrow-key-mid-compose can reorder against it.
    case extTextInputEvent(seq: UInt64, docId: String, part: Int, type: OfficeExtTextInputType, text: String)

    // MARK: Office Stage B Task 6 — clipboard, undo/redo, the second ("agent") view

    /// Reads the CURRENT text selection back to the caller — never mutates the document. `part`
    /// is asserted onto LOK immediately before the read (`setView` + type-gated `setPart`,
    /// exactly `save`'s own prefix): `getTextSelection`'s own answer is genuinely view-dependent —
    /// LOK's own `doc_createView` calls `forceSetClipboardForCurrentView` (confirmed by reading
    /// `desktop/source/lib/init.cxx` at this repo's vendored pin), so a stale current-view/part
    /// left over from unrelated paint traffic could answer with the WRONG selection.
    case clipboardCopy(seq: UInt64, docId: String, part: Int)
    /// Same read as `clipboardCopy`, but ALSO deletes the selection afterward (`.uno:Cut`,
    /// fire-and-forget exactly like `undo`/`redo` below) — the text returned is what was selected
    /// just BEFORE the cut; it is never re-read after (there would be nothing left to read).
    case clipboardCut(seq: UInt64, docId: String, part: Int)
    /// Writes `text` at the current caret via LOK's own `paste()`, which — confirmed by reading
    /// `doc_paste` at the vendored pin — internally stages the bytes (`doc_setClipboard`) then
    /// dispatches `.uno:Paste` through the SAME process-global-current-frame `comphelper::
    /// dispatchCommand` mechanism the `.uno:Save` follow-up's own fix-round-2 citation already
    /// found in `LOKBridge`. `part` is carried for the identical reason `clipboardCopy` carries it.
    case clipboardPaste(seq: UInt64, docId: String, part: Int, text: String)
    /// `.uno:Undo`, dispatched via `postUnoCommand` against the document's OWN primary view (never
    /// a caller-supplied view id — see `LOKBridge.OpenDocument.viewId`, the identical view every
    /// `postKey`/`postMouse`/`save` already targets). No `part` field: `.uno:Save`'s own
    /// fix-round-2 citation already established `postUnoCommand`'s dispatch resolves through the
    /// process-global "active frame," never a part-scoped call — and the brief's own words for
    /// this door are "view-scoped (setView prefix)"; `setPart` was never asked for and is not
    /// added speculatively.
    case undo(seq: UInt64, docId: String)
    /// `.uno:Redo`, same posture as `undo` above.
    case redo(seq: UInt64, docId: String)
    /// The two-writer groundwork: mints a SECOND LOK view for `docId` on demand (`createView()`),
    /// for a future AI collaborator's own edits — never used by the app today (the brief's own
    /// words), only by the live characterization drill (`OfficeRuntimeLiveTests`). Refused
    /// (`error{reason:"agentViewExists"}`) if this docId already has one — deliberate, not "return
    /// the existing id": a second mint is a caller bug this wire makes visible, never silently
    /// tolerated.
    case createView(seq: UInt64, docId: String)
    /// Posts a key event through the AGENT view specifically (never the primary view `keyEvent`
    /// targets) — the only way to actually PRODUCE an edit "as" the second view, needed to drive
    /// the two-writer characterization drill. Refused (`error{reason:"noAgentView"}`) if
    /// `createView` was never called for this docId. Same shape as `keyEvent` in every other
    /// respect (`part`/`type`/`charCode`/`keyCode`). Deliberately NOT reachable from
    /// `OfficeRuntime`/`Driver` — the drill talks to `OfficeHelperClient` directly, the same
    /// raw-probe precedent Task 5's ext-text-input investigation already set.
    case agentKeyEvent(seq: UInt64, docId: String, part: Int, type: OfficeKeyEventType, charCode: Int, keyCode: Int)

    /// Task 4 — registers this connection as a tile-push subscriber for `docId` (must already be
    /// open — by ANY connection, not necessarily this one; see `OfficeHelperServer`'s multicast
    /// seam) and reports the tile-set the CURRENT viewport needs, computed via
    /// `TileMath.viewportTileKeys` — bookkeeping only, no painting happens here (the app decides
    /// what to `tileRequest`, lazily, per the brief's own "app re-requests lazily"). Re-subscribing
    /// (same connection, same or a different viewport) is idempotent: it just recomputes and
    /// re-reports the key list; it does not duplicate this connection in the doc's subscriber list.
    case subscribeTiles(seq: UInt64, docId: String, part: Int, zoomPPT: Int, viewportTwips: OfficeTwipsRect)
    /// Task 4 — the inverse of `subscribeTiles`: this connection stops receiving `invalidated`
    /// pushes for `docId`. Independent of `open`/`close` — a connection may unsubscribe from tile
    /// pushes while keeping (or not owning) the document open, and closing a document implicitly
    /// drops every subscriber (including the owner) without a separate `unsubscribe` needed.
    case unsubscribe(seq: UInt64, docId: String)
    /// Task 4 — asks for pixel data for specific tile coordinates. Answered in two stages: an
    /// immediate `tileRequestAccepted`/`error` reply (this frame's own `seq`), then EACH key's
    /// pixels stream separately as `tile`/`tileFailed` PUSHES (helper-minted seq) as they finish
    /// painting on the LOK thread — painting takes real, sometimes-slow time, so it is never made
    /// to block this request's own reply. Does not require an active `subscribeTiles` — a
    /// connection may fetch specific tiles without being a standing subscriber, though in practice
    /// every Stage-A caller subscribes first to learn which keys exist.
    case tileRequest(seq: UInt64, docId: String, keys: [TileKey])

    // MARK: office-agent-tools T3 — sheets info/read, the agent's first real verbs

    /// Asks for `docId`'s sheet names, each one's used range, and which part is currently active.
    /// Read-only — never mutates the document, never touches `dirty`. `setView` prefix (unconditional,
    /// same discipline `save`/`clipboardCopy` already carry) because `getPart()` (the active-part
    /// query) is genuinely view-dependent the same way `getTextSelection` is; no `setPart` at all —
    /// `sheetsInfo` reads EVERY part regardless of which one is current (`getPartName`/`getDataArea`
    /// are both `nPart`-addressed, not current-view-addressed), the same "no setPart needed" shape
    /// `undo`/`redo` already have for the identical reason (a call with nothing view-current-scoped
    /// to assert).
    case sheetsInfo(seq: UInt64, docId: String)
    /// Asks for a value or formula grid over one rectangular range on ONE named sheet. `sheet` is a
    /// NAME, resolved to a part index on the helper side (never the app side — sheet-name lookup
    /// needs `getPartName`, a LOK call this wire's client half has no other reason to make) so an
    /// unknown name can be refused with the workbook's own real sheet list rather than a bare index
    /// out of range.
    ///
    /// **`range` is an ALREADY-FORMATTED A1 string ("A1:C10"), not column/row integers — a deliberate
    /// cross-target constraint, not a style choice.** `NormaOfficeHelper` (this frame's receiving
    /// target) compiles `Sources/OfficeWire` + `Sources/OfficeHelper` only (`project.yml`) — it never
    /// sees `Sources/AppShell/PanelDocumentTab.swift`, where Stage B T8's
    /// `officeColumnLetters`/`officeCellReference` (and this task's own inverse,
    /// `officeParseRange`/`officeReadRangeMaxCells`) live. The APP resolves and cell-count-caps the
    /// operand into an `OfficeCellRange` (`OfficeCommandConsumer`, before this frame is ever built)
    /// and formats its two corners back into the A1 string LOK's own `.uno:GoToCell` `ToPoint`
    /// argument wants — the helper never re-derives column math from integers, it passes this string
    /// straight through. This is "reuse T8's conversion, don't write a second one" applied literally:
    /// writing a column-letters function inside `Sources/OfficeHelper` to satisfy this frame would BE
    /// the second implementation the brief forbids, even in a different language boundary.
    case sheetsRead(seq: UInt64, docId: String, sheet: String, range: String, formulas: Bool)

    // MARK: office-agent-tools T4 — sheets write verbs

    /// Writes each `(cellAddresses[i], cellValues[i])` pair, in order, on ONE named sheet.
    /// **`cellAddresses` is a flat, already-formatted list of A1 cell references ("B2"), computed
    /// APP-side — never column integers, and never a single range string this frame would have to
    /// walk itself.** Same cross-target constraint `sheetsRead`'s own `range` field carries (see
    /// that case's own header): `NormaOfficeHelper` never compiles `Sources/AppShell`, where the A1
    /// column math (`officeCellReference`) lives, so per-cell addressing has to arrive pre-computed
    /// rather than be re-derived helper-side from `range` + a grid position. `cellValues[i]` is
    /// exactly what gets TYPED into `cellAddresses[i]` — a leading `=` becomes a formula, exactly
    /// like a human typing it (this bridge's own write mechanism is real synthetic text entry, not a
    /// paste — see `LOKBridge.sheetsSetOnDedicatedThread`'s own header for why, and for the
    /// apostrophe-escape convention the app applies before this frame is ever built). `cellAddresses`
    /// and `cellValues` MUST be the same length — the helper refuses (`malformed`) rather than
    /// guess if they are not. `range` is carried too, ALREADY FORMATTED (mirroring `sheetsRead`),
    /// purely so the post-write verification read (this bridge's own defense-in-depth, not the
    /// caller's job to ask for separately) can re-select the exact block it just wrote.
    case sheetsSet(seq: UInt64, docId: String, sheet: String, range: String, cellAddresses: [String], cellValues: [String])
    /// office-agent-tools T4 — insert/delete N whole rows or columns, starting at `selectionRange`'s
    /// own row/column span. **One wire pair covers all four daemon-visible verbs**
    /// (`insert_rows`/`insert_cols`/`delete_rows`/`delete_cols`) — `office.sheets.*`'s own four
    /// `panel_command.action` strings are unaffected (Task 1's already-shipped, frozen enum); this is
    /// an APP-INTERNAL wire, free to consolidate what the daemon-visible surface does not. `dimension`/
    /// `op` are real Swift enums, not raw strings — an unrecognized value refuses to decode
    /// (`malformed`) rather than silently falling through to a default case helper-side.
    ///
    /// **`selectionRange` is a PRE-FORMATTED row-only ("3:5") or column-only ("C:E") span** — the
    /// research this task's own report cites (`sc/source/core/tool/address.cxx`'s range parser)
    /// confirms `.uno:GoToCell`'s own `ToPoint` argument accepts exactly this Name-Box-style
    /// addressing, expanding the OTHER axis to the sheet's full width/height itself — this bridge
    /// never has to compute that expansion. Built app-side (`officeCellReference`'s own row/column
    /// letter math), same cross-target reasoning as `sheetsSet.cellAddresses` above.
    case sheetsResize(seq: UInt64, docId: String, sheet: String, dimension: OfficeSheetsResizeDimension,
                      op: OfficeSheetsResizeOp, selectionRange: String)
    /// office-agent-tools T4 — add/delete/rename a sheet. One wire pair for three daemon-visible
    /// verbs, same reasoning as `sheetsResize` above. `name` is the NEW sheet's name for `.add`, the
    /// EXISTING sheet's name for `.delete`/`.rename`; `newName` is `.rename`-only (`nil` otherwise —
    /// decode refuses a `.rename` with no `newName`, and a non-`.rename` op that supplies one, rather
    /// than silently ignoring either mismatch).
    case sheetsManageSheet(seq: UInt64, docId: String, op: OfficeSheetsManageSheetOp, name: String, newName: String?)

    // MARK: Responses (helper -> client)

    /// `hello` succeeded: `token` matched. `lokVersion` is now (Task 3) the REAL
    /// `getVersionInfo()` `BuildId`, when this connection's peer is a real, LOK-booted helper.
    /// `NormaOfficeHelperFixture` (no real LOK — see `OfficeDocumentBridge`'s fake implementation)
    /// still honestly reports `officeWireStageALOKVersionPlaceholder` — that constant did not
    /// retire, it narrowed: it is now the fixture's own true self-description, not a Stage-A-wide
    /// placeholder.
    case helloOk(seq: UInt64, lokVersion: String)
    /// `hello` failed (token mismatch, or a malformed hello) — always the LAST frame the helper
    /// sends before it closes the connection; see `OfficeHelperServer`'s pre-auth gate.
    case refused(seq: UInt64, reason: String)
    /// Answers `ping`.
    case pong(seq: UInt64)
    /// Answers a successful `open`: the document loaded. Task 3 adds the three fields the brief's
    /// carry names literally (`opened{docId,type,parts,sizeTwips}`) — `type`/`parts`/`sizeTwips`
    /// mirror `OfficeDocumentEvent.opened`'s own payload (see that enum's header for why the two
    /// are not the same Swift case reused: this is a direct, seq-correlated RPC reply;
    /// `OfficeDocumentEvent` is the separate, general vocabulary for asynchronous pushes).
    case opened(seq: UInt64, docId: String, type: OfficeDocumentKind, parts: Int, sizeTwips: OfficeDocumentSize)
    /// Answers a failed `open` (Task 3 — new case; Task 2's `open` could not fail). `docId` echoes
    /// which open this answers (the brief's own shape is bare `openFailed{reason}`; `docId` is
    /// added here for symmetry with every other doc-scoped frame in this file and because a future
    /// pipelined client benefits from not having to track "which seq was which open" — a disclosed,
    /// minor literal deviation, not a semantic one). A garbage/corrupt file, an unreadable path, or
    /// any other `documentLoad` failure lands here — the helper always SURVIVES this (see
    /// `OfficeHelperServer`'s own comment on why a failed `documentLoad` never tears down the LOK
    /// kit, only the one document attempt).
    case openFailed(seq: UInt64, docId: String, reason: String)
    /// Answers a successful `close`.
    case closed(seq: UInt64, docId: String)
    /// Office Stage B Task 2 — answers a successful `save`: `tempPath` is where the helper rendered
    /// the document, ALWAYS under its own `--state-path` (`<state-path>/saves/<docId>-<seq>.<ext>`,
    /// `<ext>` the document's OWN format captured at open — see `LOKBridge`'s own doc). The helper's
    /// write fence has no concept of the real document path, and must never be asked to write
    /// there: placing these bytes onto the real path is entirely the APP's job — fsync+rename,
    /// cross-volume-safe (`OfficeRuntime.perform`'s `.save` case handles the EXDEV case a
    /// state-path-to-document-directory copy can hit, since the two need not share a filesystem).
    case saved(seq: UInt64, docId: String, tempPath: String)
    /// Office Stage B Task 2 — answers a failed `save`: a `saveAs` failure (a real disk problem
    /// under the helper's own `--state-path`, or a LOK internal save error). The helper always
    /// SURVIVES this, the same posture `openFailed` already has for a bad `open`.
    case saveFailed(seq: UInt64, docId: String, reason: String)
    /// Office Stage B Task 4 — answers `keyEvent`: the key was POSTED to LOK — not a claim it
    /// already took effect (`postKeyEvent` is `void` on LOK's own side, exactly as fire-and-forget
    /// as `postUnoCommand` was for the now-removed DEBUG-only `debugEdit` door this replaces — the
    /// "posted, not a claim of effect" wording is that retired reply's own, deliberately repeated
    /// here). The real effect is observed the same way every other Stage A/B async effect is:
    /// through the `documentEvent`/`invalidated` pushes that follow.
    case keyEventOk(seq: UInt64, docId: String)
    /// Office Stage B Task 4 — answers `mouseEvent`, same posture as `keyEventOk` above.
    case mouseEventOk(seq: UInt64, docId: String)
    /// Office Stage B Task 5 — answers `extTextInputEvent`, same "posted, not a claim of effect"
    /// posture as `keyEventOk`/`mouseEventOk` above.
    case extTextInputEventOk(seq: UInt64, docId: String)
    /// Office Stage B Task 6 — answers `clipboardCopy`: `text` is exactly what `getTextSelection`
    /// returned, or `""` for LOK's own `nullptr` "no selection" answer (never a distinct
    /// empty-vs-absent case on this wire — `""` already means "nothing to put on the pasteboard"
    /// to every caller).
    case clipboardCopyOk(seq: UInt64, docId: String, text: String)
    /// Office Stage B Task 6 — answers `clipboardCut`: `text` is what was selected just before the
    /// cut, same `""` -> "nothing selected" convention as `clipboardCopyOk`.
    case clipboardCutOk(seq: UInt64, docId: String, text: String)
    /// Office Stage B Task 6 — answers a successful `clipboardPaste`. `paste()` is LOK's one
    /// clipboard door with a real, synchronous success/failure return — a `false` throws
    /// `SaveError.pasteFailed` server-side and surfaces as `.error`, never silently swallowed the
    /// way `postKeyEvent`'s `void` return forces `keyEventOk` to be.
    case clipboardPasteOk(seq: UInt64, docId: String)
    /// Office Stage B Task 6 — answers `undo`: the command was DISPATCHED, not a claim it changed
    /// anything (an empty undo stack, or an LO-internal refusal, both dispatch cleanly and both
    /// answer `undoOk`; see `LOKBridge.undoOnDedicatedThread`'s own header for why this bridge
    /// cannot tell the difference without widening scope beyond what Task 6 asks for).
    case undoOk(seq: UInt64, docId: String)
    /// Office Stage B Task 6 — answers `redo`, same posture as `undoOk`.
    case redoOk(seq: UInt64, docId: String)
    /// Office Stage B Task 6 — answers a successful `createView`: `viewId` is `createView()`'s OWN
    /// return value (never re-derived via `getView()`, which becomes ambiguous the instant a
    /// second view exists — see `LOKBridge.createAgentViewOnDedicatedThread`'s own header). The
    /// dispatch context's own name for this reply, kept verbatim.
    case agentViewReady(seq: UInt64, docId: String, viewId: Int32)
    /// Office Stage B Task 6 — answers `agentKeyEvent`, same "posted, not a claim of effect"
    /// posture every other `...Ok` input reply already has.
    case agentKeyEventOk(seq: UInt64, docId: String)
    /// Answers anything the helper refuses post-auth: an unknown frame type (`reason:"unknown"`,
    /// the brief's literal pin), a known type whose fields don't decode (`reason:"malformed"`),
    /// or a structurally valid frame that is never legal for a client to SEND (a reply shape —
    /// `reason:"unexpected"`), or a second `open` of an already-open `docId` (`reason:"alreadyOpen"`).
    case error(seq: UInt64, reason: String)
    /// Task 3 — the ONE new case for everything the helper pushes WITHOUT being asked: `seq` here
    /// is minted by the HELPER itself (a dedicated per-connection `OfficeWireSeqAllocator`, never
    /// the client's), because there is no client request to echo — it identifies wire ordering,
    /// not request/response correlation (contrast every other frame's `seq`, which the caller
    /// mints and the callee echoes). `docId` identifies which open document this is about.
    /// `event` is the payload — see `OfficeDocumentEvent`'s own header for the full vocabulary and
    /// why only two of its five cases are ever actually sent this way in Stage A.
    ///
    /// **Why a separate case instead of routing `invalidated`/`modifiedChanged` through `opened`/
    /// `closed` somehow**: those two are direct, seq-correlated replies consumed by
    /// `OfficeWireConnection`'s single-outstanding-request waiter; `documentEvent` frames are
    /// UNPROMPTED and must never compete for that same waiter slot — see
    /// `OfficeWireConnection.onDocumentEvent`'s own header for the real bug this shape avoids (a
    /// push arriving between two ordinary requests, misdelivered to whichever call is currently
    /// awaiting a reply). Routing by CASE (not by inspecting `seq`) is what lets the connection
    /// layer separate the two streams without knowing anything about outstanding request seqs.
    case documentEvent(seq: UInt64, docId: String, event: OfficeDocumentEvent)

    /// Task 4 — answers `subscribeTiles`: the tile-set the requested viewport currently needs
    /// (`TileMath.viewportTileKeys`, computed at request time — not cached against a future
    /// viewport change; the caller re-`subscribeTiles`s whenever its own viewport moves enough to
    /// matter, same "app decides, lazily" posture as tile fetching itself).
    case subscribed(seq: UInt64, docId: String, keys: [TileKey])
    /// Answers `unsubscribe`.
    case unsubscribed(seq: UInt64, docId: String)
    /// Answers `tileRequest`: the request itself was well-formed and `docId` is open — NOT a claim
    /// that every key will succeed; each key's own outcome arrives later as a `tile`/`tileFailed`
    /// push. A malformed request or an unopened `docId` gets `error{seq,reason}` instead of this.
    case tileRequestAccepted(seq: UInt64, docId: String)
    /// Task 4 — one tile's pixel payload, PUSHED (never a direct reply — see `tileRequest`'s own
    /// header) in response to a `tileRequest` that named this `key`. `seq` is minted by the
    /// receiving CONNECTION's own `OfficeWireSeqAllocator` (F8, T3 review: moved from a single
    /// server-wide allocator to one-per-`ConnectionWriter`, matching this doc comment's own
    /// original claim — see `OfficeHelperServer.ConnectionWriter`). `width`/`height` are always
    /// `TileMath.tilePixelSize` today but are sent explicitly rather than assumed, so a future
    /// change to that constant on one side alone cannot silently misinterpret the other side's
    /// pixel buffer.
    ///
    /// **Task 5.5 — rung 2 of the surface-transport decision (task-4-report.md rung 1; the T4
    /// review's own ruling): `pixels` is the raw RGBA buffer, never base64.** The wire envelope for
    /// THIS ONE frame type is no longer "one NDJSON line" the way every other frame in this file
    /// still is: `encodedLine()` for `.tile` emits only the HEADER (type/seq/docId/key/generation/
    /// width/height/`byteCount`), newline-terminated exactly like any other line; the `byteCount`
    /// raw bytes of `pixels` follow IMMEDIATELY after, with no framing of their own (no length
    /// prefix beyond `byteCount` itself, no trailing delimiter) — see `tilePayload` below, and
    /// `OfficeWireConnection.ingest`'s own header for why a plain newline scan cannot be used to
    /// find where the payload ends (raw RGBA bytes routinely contain `0x0A`). `OfficeHelperServer`'s
    /// `pushFrame`/`writeFrameLocked` write both parts under the SAME connection write-lock hold, so
    /// no other frame (a reply, or another push) can ever land bytes between the header and its
    /// payload. This case's own Swift shape is otherwise unchanged from rung 1 — `pixels` is exactly
    /// what `pixelsBase64` used to decode to, byte-for-byte (the transport envelope changed; the
    /// pixel content did not — the live product-path hash pins are the tripwire for that claim).
    case tile(seq: UInt64, docId: String, key: TileKey, generation: Int, width: Int, height: Int, pixels: Data)
    /// The failure counterpart to `tile` — refuse-never-ignore extended to the per-key granularity
    /// `tileRequest` introduces: every key named in an accepted `tileRequest` gets EITHER a `tile`
    /// OR a `tileFailed` push, never silence, even though the request itself already succeeded.
    case tileFailed(seq: UInt64, docId: String, key: TileKey, reason: String)
    /// Task 4 — pushed to every current subscriber of `docId` (the multicast fan-out —
    /// `OfficeHelperServer`'s `DocEntry.connections`) whenever a real invalidation bumps one or
    /// more cached tile generations (`TileCache.invalidate`'s return value, translated 1:1 into
    /// this frame's `keys`). Deliberately NOT scoped to any one subscriber's own last-known
    /// viewport — the helper reports every bumped key regardless of who currently cares, and each
    /// subscriber filters locally against its own active tile-set (the same "app decides, lazily"
    /// posture `tileRequest` already has) rather than the server tracking per-connection viewports
    /// on an ongoing basis. Shares its base name with `OfficeDocumentEvent.invalidated` by design.
    /// (matching this file's own established precedent of `OfficeWireFrame.opened`/`closed`
    /// sharing names with their `OfficeDocumentEvent` counterparts) — the two are DIFFERENT wire
    /// shapes serving different purposes: `OfficeDocumentEvent.invalidated` carries LOK's raw,
    /// untranslated rects/part (unchanged since Task 3); THIS case carries the already-computed
    /// tile coordinates those rects touched. Both are sent — see `OfficeHelperServer.routeDocumentEvent`.
    case invalidated(seq: UInt64, docId: String, keys: [TileKey])

    // MARK: office-agent-tools T3 — sheets info/read replies

    /// Answers a successful `sheetsInfo`. `activeSheet` is the NAME of the part `getPart()` reports
    /// current at the moment this ran (never an index — the caller already has names via `sheets`,
    /// and a bare index would make it re-derive the mapping this frame already computed once).
    case sheetsInfoOk(seq: UInt64, docId: String, sheets: [OfficeSheetInfo], activeSheet: String)
    /// Answers a successful `sheetsRead`: one string per cell, laid out `rows[row][column]`, ALWAYS
    /// `(endRow-startRow+1)` rows of `(endColumn-startColumn+1)` strings each — a wholly empty cell is
    /// `""`, never an absent element, so a caller can index this by the SAME 0-based offsets it sent
    /// without re-deriving the range's own shape from the reply.
    case sheetsReadOk(seq: UInt64, docId: String, rows: [[String]])

    // MARK: office-agent-tools T4 — sheets write replies

    /// Answers a successful `sheetsSet`: how many cells were written — `cellAddresses.count`, echoed
    /// back rather than re-derived by the caller, so a caller who counts differently (an off-by-one
    /// in its own grid math) sees a mismatch rather than trusting its own count silently.
    case sheetsSetOk(seq: UInt64, docId: String, cellsWritten: Int)
    /// Answers a successful `sheetsResize`: the sheet's own dimensions AFTER the operation —
    /// `getDataArea`'s own used-range answer (`sheetsInfo`'s identical mechanism), not merely "ok."
    /// A model that just inserted 2 rows can see the sheet actually grew, without a second `info`
    /// call.
    case sheetsResizeOk(seq: UInt64, docId: String, usedEndColumn: Int, usedEndRow: Int)
    /// Answers a successful `sheetsManageSheet`: the workbook's full sheet-name list AFTER the
    /// operation, in part order — the same "smallest useful truth" shape `sheetsInfo` already
    /// returns, and the only way a caller learns whether `add`'s requested name survived Calc's own
    /// silent sanitization (`CreateValidTabName`) verbatim or was altered.
    case sheetsManageSheetOk(seq: UInt64, docId: String, sheets: [String])

    /// The wire vocabulary, in frame-declaration order. A test walks this list the same way
    /// `EditorBridgeInbound.wireTypes`'s own test does — one fixture per name, decode, assert the
    /// case names itself the same way — so this array and `decode`/`wireType` cannot drift apart
    /// unnoticed.
    /// Office Stage B Task 4 — reverted to a plain array literal: the DEBUG-only `debugEdit`/
    /// `debugEditOk` entries (which previously forced a closure-building shape, since `#if` cannot
    /// appear directly inside `[...]`'s element list) are gone — real edit verbs replace them.
    /// Order still matches frame-declaration order.
    public static let wireTypes: [String] = [
        "hello", "ping", "open", "close", "save", "keyEvent", "mouseEvent", "extTextInputEvent",
        // Office Stage B Task 6 — clipboard, undo/redo, the second ("agent") view.
        "clipboardCopy", "clipboardCut", "clipboardPaste", "undo", "redo", "createView", "agentKeyEvent",
        "subscribeTiles", "unsubscribe", "tileRequest",
        // office-agent-tools T3 — sheets info/read.
        "sheetsInfo", "sheetsRead",
        // office-agent-tools T4 — sheets write verbs.
        "sheetsSet", "sheetsResize", "sheetsManageSheet",
        "helloOk", "refused", "pong", "opened", "openFailed", "closed", "saved", "saveFailed",
        "keyEventOk", "mouseEventOk", "extTextInputEventOk",
        "clipboardCopyOk", "clipboardCutOk", "clipboardPasteOk", "undoOk", "redoOk",
        "agentViewReady", "agentKeyEventOk",
        "error", "documentEvent",
        "subscribed", "unsubscribed", "tileRequestAccepted", "tile", "tileFailed", "invalidated",
        "sheetsInfoOk", "sheetsReadOk",
        "sheetsSetOk", "sheetsResizeOk", "sheetsManageSheetOk",
    ]

    public var wireType: String {
        switch self {
        case .hello: return "hello"
        case .ping: return "ping"
        case .open: return "open"
        case .close: return "close"
        case .save: return "save"
        case .keyEvent: return "keyEvent"
        case .mouseEvent: return "mouseEvent"
        case .extTextInputEvent: return "extTextInputEvent"
        case .clipboardCopy: return "clipboardCopy"
        case .clipboardCut: return "clipboardCut"
        case .clipboardPaste: return "clipboardPaste"
        case .undo: return "undo"
        case .redo: return "redo"
        case .createView: return "createView"
        case .agentKeyEvent: return "agentKeyEvent"
        case .subscribeTiles: return "subscribeTiles"
        case .unsubscribe: return "unsubscribe"
        case .tileRequest: return "tileRequest"
        case .sheetsInfo: return "sheetsInfo"
        case .sheetsRead: return "sheetsRead"
        case .sheetsSet: return "sheetsSet"
        case .sheetsResize: return "sheetsResize"
        case .sheetsManageSheet: return "sheetsManageSheet"
        case .helloOk: return "helloOk"
        case .refused: return "refused"
        case .pong: return "pong"
        case .opened: return "opened"
        case .openFailed: return "openFailed"
        case .closed: return "closed"
        case .saved: return "saved"
        case .saveFailed: return "saveFailed"
        case .keyEventOk: return "keyEventOk"
        case .mouseEventOk: return "mouseEventOk"
        case .extTextInputEventOk: return "extTextInputEventOk"
        case .clipboardCopyOk: return "clipboardCopyOk"
        case .clipboardCutOk: return "clipboardCutOk"
        case .clipboardPasteOk: return "clipboardPasteOk"
        case .undoOk: return "undoOk"
        case .redoOk: return "redoOk"
        case .agentViewReady: return "agentViewReady"
        case .agentKeyEventOk: return "agentKeyEventOk"
        case .error: return "error"
        case .documentEvent: return "documentEvent"
        case .subscribed: return "subscribed"
        case .unsubscribed: return "unsubscribed"
        case .tileRequestAccepted: return "tileRequestAccepted"
        case .tile: return "tile"
        case .tileFailed: return "tileFailed"
        case .invalidated: return "invalidated"
        case .sheetsInfoOk: return "sheetsInfoOk"
        case .sheetsReadOk: return "sheetsReadOk"
        case .sheetsSetOk: return "sheetsSetOk"
        case .sheetsResizeOk: return "sheetsResizeOk"
        case .sheetsManageSheetOk: return "sheetsManageSheetOk"
        }
    }

    public var seq: UInt64 {
        switch self {
        case .hello(let seq, _, _): return seq
        case .ping(let seq): return seq
        case .open(let seq, _, _): return seq
        case .close(let seq, _): return seq
        case .save(let seq, _, _): return seq
        case .keyEvent(let seq, _, _, _, _, _): return seq
        case .mouseEvent(let seq, _, _, _, _, _, _, _, _): return seq
        case .extTextInputEvent(let seq, _, _, _, _): return seq
        case .clipboardCopy(let seq, _, _): return seq
        case .clipboardCut(let seq, _, _): return seq
        case .clipboardPaste(let seq, _, _, _): return seq
        case .undo(let seq, _): return seq
        case .redo(let seq, _): return seq
        case .createView(let seq, _): return seq
        case .agentKeyEvent(let seq, _, _, _, _, _): return seq
        case .subscribeTiles(let seq, _, _, _, _): return seq
        case .unsubscribe(let seq, _): return seq
        case .tileRequest(let seq, _, _): return seq
        case .sheetsInfo(let seq, _): return seq
        case .sheetsRead(let seq, _, _, _, _): return seq
        case .sheetsSet(let seq, _, _, _, _, _): return seq
        case .sheetsResize(let seq, _, _, _, _, _): return seq
        case .sheetsManageSheet(let seq, _, _, _, _): return seq
        case .helloOk(let seq, _): return seq
        case .refused(let seq, _): return seq
        case .pong(let seq): return seq
        case .opened(let seq, _, _, _, _): return seq
        case .openFailed(let seq, _, _): return seq
        case .closed(let seq, _): return seq
        case .saved(let seq, _, _): return seq
        case .saveFailed(let seq, _, _): return seq
        case .keyEventOk(let seq, _): return seq
        case .mouseEventOk(let seq, _): return seq
        case .extTextInputEventOk(let seq, _): return seq
        case .clipboardCopyOk(let seq, _, _): return seq
        case .clipboardCutOk(let seq, _, _): return seq
        case .clipboardPasteOk(let seq, _): return seq
        case .undoOk(let seq, _): return seq
        case .redoOk(let seq, _): return seq
        case .agentViewReady(let seq, _, _): return seq
        case .agentKeyEventOk(let seq, _): return seq
        case .error(let seq, _): return seq
        case .documentEvent(let seq, _, _): return seq
        case .subscribed(let seq, _, _): return seq
        case .unsubscribed(let seq, _): return seq
        case .tileRequestAccepted(let seq, _): return seq
        case .tile(let seq, _, _, _, _, _, _): return seq
        case .tileFailed(let seq, _, _, _): return seq
        case .invalidated(let seq, _, _): return seq
        case .sheetsInfoOk(let seq, _, _, _): return seq
        case .sheetsReadOk(let seq, _, _): return seq
        case .sheetsSetOk(let seq, _, _): return seq
        case .sheetsResizeOk(let seq, _, _, _): return seq
        case .sheetsManageSheetOk(let seq, _, _): return seq
        }
    }

    /// One NDJSON line: `type` + `seq` + this case's own fields, `\n`-terminated, nothing else on
    /// the line. `.sortedKeys` for a deterministic byte encoding (useful for eyeballing a capture
    /// or pinning a fixture; not load-bearing for correctness since decode compares structurally).
    public func encodedLine() -> Data {
        var payload: [String: Any] = ["type": wireType, "seq": seq]
        switch self {
        case .hello(_, let role, let token):
            payload["role"] = role.rawValue
            payload["token"] = token
        case .ping, .pong:
            break
        case .open(_, let docId, let path):
            payload["docId"] = docId
            payload["path"] = path
        case .close(_, let docId), .closed(_, let docId):
            payload["docId"] = docId
        case .save(_, let docId, let part):
            payload["docId"] = docId
            payload["part"] = part
        case .keyEvent(_, let docId, let part, let type, let charCode, let keyCode):
            payload["docId"] = docId
            payload["part"] = part
            payload["eventType"] = type.rawValue
            payload["charCode"] = charCode
            payload["keyCode"] = keyCode
        case .mouseEvent(_, let docId, let part, let type, let xTwips, let yTwips, let count, let buttons, let modifiers):
            payload["docId"] = docId
            payload["part"] = part
            payload["eventType"] = type.rawValue
            payload["xTwips"] = xTwips
            payload["yTwips"] = yTwips
            payload["count"] = count
            payload["buttons"] = buttons
            payload["modifiers"] = modifiers
        case .extTextInputEvent(_, let docId, let part, let type, let text):
            payload["docId"] = docId
            payload["part"] = part
            payload["eventType"] = type.rawValue
            payload["text"] = text
        case .keyEventOk(_, let docId), .mouseEventOk(_, let docId), .extTextInputEventOk(_, let docId):
            payload["docId"] = docId
        case .clipboardCopy(_, let docId, let part), .clipboardCut(_, let docId, let part):
            payload["docId"] = docId
            payload["part"] = part
        case .clipboardPaste(_, let docId, let part, let text):
            payload["docId"] = docId
            payload["part"] = part
            payload["text"] = text
        case .undo(_, let docId), .redo(_, let docId), .createView(_, let docId):
            payload["docId"] = docId
        case .agentKeyEvent(_, let docId, let part, let type, let charCode, let keyCode):
            payload["docId"] = docId
            payload["part"] = part
            payload["eventType"] = type.rawValue
            payload["charCode"] = charCode
            payload["keyCode"] = keyCode
        case .clipboardCopyOk(_, let docId, let text), .clipboardCutOk(_, let docId, let text):
            payload["docId"] = docId
            payload["text"] = text
        case .clipboardPasteOk(_, let docId), .undoOk(_, let docId), .redoOk(_, let docId),
             .agentKeyEventOk(_, let docId):
            payload["docId"] = docId
        case .agentViewReady(_, let docId, let viewId):
            payload["docId"] = docId
            payload["viewId"] = viewId
        case .saved(_, let docId, let tempPath):
            payload["docId"] = docId
            payload["tempPath"] = tempPath
        case .saveFailed(_, let docId, let reason):
            payload["docId"] = docId
            payload["reason"] = reason
        case .opened(_, let docId, let type, let parts, let size):
            payload["docId"] = docId
            payload["docType"] = type.rawValue
            payload["parts"] = parts
            payload["widthTwips"] = size.widthTwips
            payload["heightTwips"] = size.heightTwips
        case .openFailed(_, let docId, let reason):
            payload["docId"] = docId
            payload["reason"] = reason
        case .helloOk(_, let lokVersion):
            payload["lokVersion"] = lokVersion
        case .refused(_, let reason), .error(_, let reason):
            payload["reason"] = reason
        case .documentEvent(_, let docId, let event):
            payload["docId"] = docId
            for (key, value) in event.encodedFields() { payload[key] = value }
        case .subscribeTiles(_, let docId, let part, let zoomPPT, let viewportTwips):
            payload["docId"] = docId
            payload["part"] = part
            payload["zoomPPT"] = zoomPPT
            payload["viewportTwips"] = Self.encodeRect(viewportTwips)
        case .unsubscribe(_, let docId), .unsubscribed(_, let docId), .tileRequestAccepted(_, let docId):
            payload["docId"] = docId
        case .tileRequest(_, let docId, let keys):
            payload["docId"] = docId
            payload["keys"] = keys.map { $0.jsonObject() }
        case .sheetsInfo(_, let docId):
            payload["docId"] = docId
        case .sheetsRead(_, let docId, let sheet, let range, let formulas):
            payload["docId"] = docId
            payload["sheet"] = sheet
            payload["range"] = range
            payload["formulas"] = formulas
        case .sheetsInfoOk(_, let docId, let sheets, let activeSheet):
            payload["docId"] = docId
            payload["sheets"] = sheets.map { $0.jsonObject() }
            payload["activeSheet"] = activeSheet
        case .sheetsReadOk(_, let docId, let rows):
            payload["docId"] = docId
            payload["rows"] = rows
        case .sheetsSet(_, let docId, let sheet, let range, let cellAddresses, let cellValues):
            payload["docId"] = docId
            payload["sheet"] = sheet
            payload["range"] = range
            payload["cellAddresses"] = cellAddresses
            payload["cellValues"] = cellValues
        case .sheetsResize(_, let docId, let sheet, let dimension, let op, let selectionRange):
            payload["docId"] = docId
            payload["sheet"] = sheet
            payload["dimension"] = dimension.rawValue
            payload["op"] = op.rawValue
            payload["selectionRange"] = selectionRange
        case .sheetsManageSheet(_, let docId, let op, let name, let newName):
            payload["docId"] = docId
            payload["op"] = op.rawValue
            payload["name"] = name
            if let newName { payload["newName"] = newName }
        case .sheetsSetOk(_, let docId, let cellsWritten):
            payload["docId"] = docId
            payload["cellsWritten"] = cellsWritten
        case .sheetsResizeOk(_, let docId, let usedEndColumn, let usedEndRow):
            payload["docId"] = docId
            payload["usedEndColumn"] = usedEndColumn
            payload["usedEndRow"] = usedEndRow
        case .sheetsManageSheetOk(_, let docId, let sheets):
            payload["docId"] = docId
            payload["sheets"] = sheets
        case .subscribed(_, let docId, let keys), .invalidated(_, let docId, let keys):
            payload["docId"] = docId
            payload["keys"] = keys.map { $0.jsonObject() }
        case .tile(_, let docId, let key, let generation, let width, let height, let pixels):
            // Task 5.5: the header line carries `byteCount`, never the pixel bytes themselves —
            // see this case's own doc comment. `encodedLine()` for `.tile` is therefore ONLY ever
            // half of the wire envelope; callers that need the other half read `tilePayload` below.
            payload["docId"] = docId
            payload["key"] = key.jsonObject()
            payload["generation"] = generation
            payload["width"] = width
            payload["height"] = height
            payload["byteCount"] = pixels.count
        case .tileFailed(_, let docId, let key, let reason):
            payload["docId"] = docId
            payload["key"] = key.jsonObject()
            payload["reason"] = reason
        }
        let line: String
        if let json = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]),
           let rendered = String(data: json, encoding: .utf8) {
            line = rendered
        } else {
            // Unreachable — every payload above is strings and a UInt64 — but a frame that fails
            // to render is not silence: fall back to the bare envelope so the seq still crosses.
            line = "{\"type\":\"\(wireType)\",\"seq\":\(seq)}"
        }
        return Data((line + "\n").utf8)
    }

    /// Plain decode: a known frame, or `nil`. Used where the caller only cares "did this parse" —
    /// a client reading a reply, or a round-trip test. Servers wanting the seq-recovering
    /// three-way split (needed to answer an unknown TYPE with its own `seq`) use
    /// `OfficeWireCodec.decodeInbound` instead.
    public static func decode(_ line: String) -> OfficeWireFrame? {
        if case .frame(let frame) = OfficeWireCodec.decodeInbound(line) { return frame }
        return nil
    }

    /// Task 5.5 — the raw bytes that must follow this frame's `encodedLine()` header on the wire,
    /// or `nil` for every frame except `.tile` (the ONE case whose envelope is more than one NDJSON
    /// line — see that case's own doc comment). `OfficeHelperServer.writeFrameLocked` writes
    /// `encodedLine()` then, if this is non-nil, these bytes too, under the SAME connection
    /// write-lock hold — the two writes must never be split across an interleaving push.
    public var tilePayload: Data? {
        if case .tile(_, _, _, _, _, _, let pixels) = self { return pixels }
        return nil
    }

    // MARK: - Task 4 shared field encoders (rects, tile-key arrays)

    static func encodeRect(_ rect: OfficeTwipsRect) -> [String: Any] {
        ["x": rect.x, "y": rect.y, "width": rect.width, "height": rect.height]
    }

    static func decodeRect(_ object: Any?) -> OfficeTwipsRect? {
        guard let dict = object as? [String: Any],
              let x = int64Value(dict["x"]), let y = int64Value(dict["y"]),
              let width = int64Value(dict["width"]), let height = int64Value(dict["height"]) else {
            return nil
        }
        return OfficeTwipsRect(x: x, y: y, width: width, height: height)
    }

    static func decodeTileKeys(_ object: Any?) -> [TileKey]? {
        guard let array = object as? [[String: Any]] else { return nil }
        var keys: [TileKey] = []
        keys.reserveCapacity(array.count)
        for item in array {
            guard let key = TileKey.decode(item) else { return nil }
            keys.append(key)
        }
        return keys
    }

    /// office-agent-tools T3 — `sheetsInfoOk.sheets`.
    static func decodeSheetInfos(_ object: Any?) -> [OfficeSheetInfo]? {
        guard let array = object as? [[String: Any]] else { return nil }
        var sheets: [OfficeSheetInfo] = []
        sheets.reserveCapacity(array.count)
        for item in array {
            guard let sheet = OfficeSheetInfo.decode(item) else { return nil }
            sheets.append(sheet)
        }
        return sheets
    }

    /// office-agent-tools T3 — `sheetsReadOk.rows`, a plain `[[String]]`: every element of the
    /// outer array must itself be an array of strings, never mixed types — `as? [[String]]` alone
    /// would accept `[[String: Any]]`'s sibling shapes too loosely under `JSONSerialization`'s own
    /// bridging, so this walks and re-validates one level deep rather than trusting a single cast.
    static func decodeRows(_ object: Any?) -> [[String]]? {
        guard let array = object as? [[Any]] else { return nil }
        var rows: [[String]] = []
        rows.reserveCapacity(array.count)
        for row in array {
            guard let strings = row as? [String] else { return nil }
            rows.append(strings)
        }
        return rows
    }
}

/// office-agent-tools T3 — one sheet's own facts, as `sheetsInfoOk` reports them: its name, and its
/// used range's bottom-right corner (0-based, INCLUSIVE — `(usedEndColumn: -1, usedEndRow: -1)` is
/// the wholly-empty-sheet sentinel: `getDataArea`'s own raw output cannot distinguish "nothing used"
/// from "only A1 used" any other way, and `-1` composes correctly with `OfficeCellRange`-style
/// inclusive-end arithmetic — a caller who blindly adds 1 to get a count sees `0`, the right answer,
/// rather than special-casing `(0,0)` twice for two different meanings).
public struct OfficeSheetInfo: Equatable, Sendable {
    public let name: String
    public let usedEndColumn: Int
    public let usedEndRow: Int
    public init(name: String, usedEndColumn: Int, usedEndRow: Int) {
        self.name = name
        self.usedEndColumn = usedEndColumn
        self.usedEndRow = usedEndRow
    }

    /// Manual JSON encode/decode, matching this file's own established discipline (`TileKey`'s own
    /// header) rather than introducing `Codable` for just this one type.
    func jsonObject() -> [String: Any] {
        ["name": name, "usedEndColumn": usedEndColumn, "usedEndRow": usedEndRow]
    }

    static func decode(_ object: [String: Any]) -> OfficeSheetInfo? {
        guard let name = object["name"] as? String,
              let usedEndColumn = intValue(object["usedEndColumn"]),
              let usedEndRow = intValue(object["usedEndRow"]) else {
            return nil
        }
        return OfficeSheetInfo(name: name, usedEndColumn: usedEndColumn, usedEndRow: usedEndRow)
    }
}

// MARK: - office-agent-tools T4 — the resize/manage-sheet wire's own strict enums

/// `sheetsResize`'s axis. A raw `String` field this bridge cannot recognize refuses to decode
/// (`malformed`) rather than falling through to a default case helper-side — advisor guidance for
/// this task's own wire consolidation (see `sheetsResize`'s own header for why one wire pair covers
/// four daemon-visible verbs).
public enum OfficeSheetsResizeDimension: String, Equatable, Sendable {
    case row
    case col
}

/// `sheetsResize`'s operation.
public enum OfficeSheetsResizeOp: String, Equatable, Sendable {
    case insert
    case delete
}

/// `sheetsManageSheet`'s operation.
public enum OfficeSheetsManageSheetOp: String, Equatable, Sendable {
    case add
    case delete
    case rename
}

/// `hello`'s role field. `agent` is the daemon (Stage C consumer; the handshake alone lands now).
public enum OfficeWireRole: String, Equatable, Sendable {
    case app
    case agent
}

/// LOK's `LibreOfficeKitKeyEventType` (`LibreOfficeKitEnums.h:1076-1080`) — a direct 1:1 mirror
/// (`rawValue` IS the wire integer, no translation table needed, unlike `OfficeDocumentKind`):
/// `LOK_KEYEVENT_KEYINPUT = 0` (implicit first enumerator), `LOK_KEYEVENT_KEYUP = 1`.
public enum OfficeKeyEventType: Int, Equatable, Sendable {
    case keyInput = 0
    case keyUp = 1
}

/// LOK's `LibreOfficeKitMouseEventType` (`LibreOfficeKitEnums.h:1253-1261`) — same direct 1:1
/// mirror as `OfficeKeyEventType`: `LOK_MOUSEEVENT_MOUSEBUTTONDOWN = 0`,
/// `LOK_MOUSEEVENT_MOUSEBUTTONUP = 1`, `LOK_MOUSEEVENT_MOUSEMOVE = 2`.
public enum OfficeMouseEventType: Int, Equatable, Sendable {
    case buttonDown = 0
    case buttonUp = 1
    case move = 2
}

/// LOK's `LibreOfficeKitExtTextInputType` (`LibreOfficeKitEnums.h:1084-1093`) — same direct 1:1
/// mirror as `OfficeKeyEventType`/`OfficeMouseEventType`: `rawValue` IS the wire integer, no
/// translation. LOK declares THREE enumerators (`LOK_EXT_TEXTINPUT = 0`, `LOK_EXT_TEXTINPUT_POS = 1`,
/// `LOK_EXT_TEXTINPUT_END = 2`) — this bridge only ever SENDS two of them. `POS` (cf.
/// `SalEvent::ExtTextInputPos`) is an IME candidate-window positioning query; Norma answers that need
/// itself, locally, via `NSTextInputClient.firstRect(forCharacterRange:)` reading the already-tracked
/// caret rect — there is nothing to ask LOK for. **`.end`'s rawValue is therefore `2`, deliberately
/// skipping `1`** — a sequential `case input = 0, end = 1` would silently post `LOK_EXT_TEXTINPUT_POS`
/// instead of the real commit, and composition would never land; see `OfficeWireCodecTests`'s own
/// fixture for the pinned raw value.
public enum OfficeExtTextInputType: Int, Equatable, Sendable {
    case input = 0
    // LOK_EXT_TEXTINPUT_POS = 1 is intentionally not modeled — this bridge never sends it; see this
    // enum's own header.
    case end = 2
}

/// LOK's `LibreOfficeKitDocumentType` (`LibreOfficeKitEnums.h:22-27`), transcribed rather than
/// imported — that header is not safely importable outside a C++ translation unit (see
/// `LOKBridge.swift`'s header for the full reason) — restricted to the three kinds the brief names
/// (`documentType (text/spreadsheet/presentation)`) plus `drawing`/`other` for TOTALITY: LOK's
/// `getDocumentType()` returns a plain `int`, and every one of its five values must map to
/// something rather than trap, even though none of Task 3's six fixtures produce `drawing`/`other`.
public enum OfficeDocumentKind: String, Equatable, Sendable {
    case text
    case spreadsheet
    case presentation
    case drawing
    case other

    /// `nType` is LOK's raw `int` from `getDocumentType()`. `LOK_DOCTYPE_TEXT = 0` (implicit
    /// first enumerator), `SPREADSHEET = 1`, `PRESENTATION = 2`, `DRAWING = 3`, `OTHER = 4` —
    /// `LibreOfficeKitEnums.h:22-27`.
    init(lokDocumentType nType: Int32) {
        switch nType {
        case 0: self = .text
        case 1: self = .spreadsheet
        case 2: self = .presentation
        case 3: self = .drawing
        default: self = .other
        }
    }
}

/// A document's page/canvas size in twips (1/1440 inch — LOK's native unit), from
/// `getDocumentSize()`'s two `long*` out-params. `Int64`: C `long` is 64-bit on arm64 Darwin, and
/// this crosses the wire as a JSON number either way, so there is no reason to narrow it.
public struct OfficeDocumentSize: Equatable, Sendable {
    public let widthTwips: Int64
    public let heightTwips: Int64
    public init(widthTwips: Int64, heightTwips: Int64) {
        self.widthTwips = widthTwips
        self.heightTwips = heightTwips
    }
}

/// The metadata a successful `open` reports — `OfficeWireFrame.opened`'s payload, decoupled from
/// the wire type itself so `OfficeDocumentBridge` (`OfficeHelperServer.swift`, helper-side only)
/// doesn't need to depend on wire framing. Lives HERE, not beside `OfficeDocumentBridge` itself,
/// because BOTH sides need it: the app's `OfficeHelperClient.open()` (`AppShell`, compiled into
/// `Norma`) returns it, and `OfficeHelperServer.swift`'s `Sources/OfficeHelper` tree — where
/// `OfficeDocumentBridge` itself lives — is EXCLUDED from `Norma`'s own sources sweep (project.yml:
/// `Sources/OfficeHelper/main.swift` would collide with `Sources/App/main.swift`, so the whole
/// directory is excluded, not just that one file) — a type the app needs cannot live in a file the
/// app never compiles.
public struct OfficeDocumentMetadata: Equatable, Sendable {
    public let type: OfficeDocumentKind
    public let parts: Int
    public let sizeTwips: OfficeDocumentSize
    public init(type: OfficeDocumentKind, parts: Int, sizeTwips: OfficeDocumentSize) {
        self.type = type
        self.parts = parts
        self.sizeTwips = sizeTwips
    }
}

/// One invalidation rectangle in document (twips) coordinates — LOK's `LOK_CALLBACK_INVALIDATE_TILES`
/// payload format, `"x, y, width, height"` (`LibreOfficeKitEnums.h:124-126`).
public struct OfficeTwipsRect: Equatable, Sendable {
    public let x: Int64
    public let y: Int64
    public let width: Int64
    public let height: Int64
    public init(x: Int64, y: Int64, width: Int64, height: Int64) {
        self.x = x
        self.y = y
        self.width = width
        self.height = height
    }
}

/// Task 3 — the callback event vocabulary produced for T4/T5, exactly the five cases the brief
/// names (`opened{type,parts,sizeTwips}`, `openFailed{reason}`, `invalidated{rectsTwips,part}`,
/// `modifiedChanged{Bool}`, `closed`). Lives here (not in `OfficeHelper` or `AppShell`) because
/// BOTH the helper (constructs it from LOK callbacks) and the app (decodes it off the wire) need
/// the same type — the same reason `OfficeWireFrame` itself is shared.
///
/// **Only two cases are ever actually sent this way in Stage A**: `invalidated`/`modifiedChanged`,
/// via `OfficeWireFrame.documentEvent` (the async push case — see its own header). `opened`/
/// `openFailed`/`closed` are covered for Stage A's own `open`/`close` verbs by the DIRECT,
/// seq-correlated reply frames (`OfficeWireFrame.opened`/`.openFailed`/`.closed`), which is simpler
/// and lower-risk than routing a synchronous RPC reply through the same channel as an unprompted
/// push. This enum still declares all five: it is the complete, general vocabulary "everything
/// that can happen to a document" — the brief's own words, "consumed by T4/T5" — and a future
/// multi-client/multicast/replay-on-attach consumer (the T4 carry already anticipates this) has a
/// natural, ALREADY-DEFINED case to push `opened`/`closed` through uniformly once one exists,
/// without a wire-shape change. A disclosed design choice, not an oversight.
public enum OfficeDocumentEvent: Equatable, Sendable {
    case opened(type: OfficeDocumentKind, parts: Int, sizeTwips: OfficeDocumentSize)
    case openFailed(reason: String)
    /// Task 5 — `LOK_CALLBACK_INVALIDATE_VISIBLE_CURSOR`'s parsed rect: the blinking text caret's
    /// own position/size. Never carries "no cursor" — LOK only ever fires this with a real
    /// rectangle (see `parseCaretRect`'s own header for the empirical capture this is built from);
    /// Norma owns the actual BLINK timing itself (`LOK_CALLBACK_CURSOR_VISIBLE`, type 5, is
    /// deliberately not wired — a disclosed Task 5 scope decision, not an oversight).
    case caretRect(OfficeTwipsRect)
    /// Task 5 — `LOK_CALLBACK_TEXT_SELECTION`'s parsed rect LIST: one rect per visual line the
    /// selection spans (a multi-line selection is NOT one bounding box). Empty means no selection —
    /// LOK's own payload is `""` or (observed live from Calc specifically, an undocumented
    /// divergence) the bare string `"EMPTY"`; both fold to `[]` here, mirroring `.invalidated`'s own
    /// established leniency for the identical sentinel on a different callback.
    case textSelection([OfficeTwipsRect])
    /// Task 5 — `LOK_CALLBACK_TEXT_SELECTION_START`'s parsed rect: the selection anchor's own
    /// cursor-shaped rectangle (used to draw a selection handle). Per LO's own source
    /// (`SwSelPaintRects::getLOKPayload`, `sw/source/core/crsr/viscrs.cxx`, read at the pinned
    /// commit) this callback simply does not fire at all when there is no selection — never observed
    /// live with an empty payload, so unlike `textSelection` there is no "no selection" case to fold.
    case textSelectionStart(OfficeTwipsRect)
    /// Task 5 — the selection's trailing edge, `TEXT_SELECTION_END`'s counterpart to
    /// `textSelectionStart` above. Same "always a real rect" posture.
    case textSelectionEnd(OfficeTwipsRect)
    /// Task 5 — `LOK_CALLBACK_CELL_CURSOR`'s parsed payload (Calc only) — see `OfficeCellCursor`'s
    /// own header for the two shapes (a real cell, or the in-cell-edit `"EMPTY"` window).
    case cellCursor(OfficeCellCursor)
    /// `rectsTwips` is plural/an array (the brief's own field name) even though a single stock LOK
    /// `LOK_CALLBACK_INVALIDATE_TILES` firing carries exactly one rectangle, or the string
    /// `"EMPTY"` meaning "the whole document" — represented here as an EMPTY array, documented at
    /// the one call site that constructs it (`LOKBridge`'s callback trampoline). The array shape is
    /// forward-compatible with a future coalesced/batched-rects producer without another wire
    /// change. `part` is present because `LOK_FEATURE_PART_IN_INVALIDATION_CALLBACK` is enabled at
    /// boot (`LOKBridge`), which appends the part number as the payload's 5th value.
    ///
    /// **Fix round 1, F3 — corrected: `"EMPTY"` DOES carry a part number, always, once the
    /// part-in-invalidation feature is on.** `RectangleAndPart::toString()` (LO core,
    /// `desktop/inc/lib/init.hxx`) is unconditional about this: `if (m_nPart >= -1) return
    /// (isInfinite() ? "EMPTY" : rect) + ", " + part + ", " + mode;` — a whole-document
    /// invalidation is `"EMPTY, <part>, <mode>"` on the wire, not bare `"EMPTY"`, whenever
    /// `isPartInInvalidation()` is true (which `LOKBridge` always sets). `part` for this case can
    /// legitimately be `-1` — LO's own "all parts" sentinel (`init.hxx`'s own `m_nPart(INT_MIN)`/
    /// "-1 is reserved to mean 'all parts'" comment; `SfxLokHelper::notifyInvalidation`'s single-
    /// rectangle overload can be called with an explicit `-1`) — harmless here since the EMPTY case
    /// already bumps every part regardless (`TileCache.invalidate`'s own doc), but a NON-empty rect
    /// can carry `-1` too; see that method's own fix-round doc for how it now honors that.
    case invalidated(rectsTwips: [OfficeTwipsRect], part: Int)
    case modifiedChanged(Bool)
    case closed
    /// Office Stage B Task 7 — the helper's own `OfficeAutosaveScheduler` fired and
    /// `OfficeDocumentBridge.saveAsSidecar` wrote (or refreshed) `docId`'s sidecar at
    /// `<state-path>/autosave/<docId>.<ext>`. `ext` is the extension ACTUALLY written — native for
    /// an already-ODF document, the ODF sibling for an OOXML one (`OfficeSaveFormat.autosaveFormat`)
    /// — not necessarily the document's own real extension, which is why this carries it rather
    /// than leaving the app to assume. `isODFFallback` is that same fact restated as a bool, purely
    /// so the app never has to re-derive "was this a fallback" by comparing extensions itself
    /// (`OfficeRuntime`'s own manifest write and, eventually, the recovery banner's format
    /// disclosure both read it directly). The helper never learns `docId`'s real PATH (the
    /// Collabora jail — `OfficeRuntime.stageDocument`'s own header), so this is the one thing this
    /// event exists to carry: the app is the only side that can turn `docId` back into a real path
    /// and write the manifest entry this task's recovery flow reads at open time.
    case autosaved(ext: String, isODFFallback: Bool)
    /// Task 8 — `LOK_CALLBACK_CELL_FORMULA`'s parsed payload (Calc only): "the text content of the
    /// formula bar" (`LibreOfficeKitEnums.h:345-347`), verbatim. Confirmed live (a probe against
    /// `two-sheet.ods`'s own real seed content, `OfficeHelperLiveTests
    /// .testProbeInvestigatesWhetherCellFormulaCallbacksExistForTheFormulaBarsContent`) to fire on
    /// EVERY cell move — including onto a genuinely empty cell, which sends the empty string, not
    /// a sentinel and not silence — AND per keystroke while typing an in-cell edit BEFORE it
    /// commits (live edit-buffer text), all independent of `CELL_CURSOR`'s own `"EMPTY"` window
    /// during that same edit. A SEPARATE `OfficeCursorStore` field pair from `cellCursor`, never
    /// folded together — that same probe found the two callbacks' own ORDERING differs by
    /// scenario (content before ref on a plain navigate; ref-goes-empty before content on entering
    /// edit mode), so treating one as derived from the other would silently mix two independently
    /// timed LOK callbacks into one field.
    case cellFormula(String)

    /// This case's own fields, flattened into the SAME single-level JSON object
    /// `OfficeWireFrame.encodedLine()` builds for a `.documentEvent` frame — `kind` is the
    /// discriminant (named `kind`, not `type`, to not collide with the outer frame's own `type`
    /// key, which is always the literal string `"documentEvent"`). Matches this file's established
    /// flat, single-nesting-level style (no case anywhere in `OfficeWireFrame` nests a JSON object).
    func encodedFields() -> [String: Any] {
        switch self {
        case .opened(let type, let parts, let size):
            return ["kind": "opened", "docType": type.rawValue, "parts": parts,
                    "widthTwips": size.widthTwips, "heightTwips": size.heightTwips]
        case .openFailed(let reason):
            return ["kind": "openFailed", "reason": reason]
        case .invalidated(let rects, let part):
            let encodedRects = rects.map { rect -> [String: Any] in
                ["x": rect.x, "y": rect.y, "width": rect.width, "height": rect.height]
            }
            return ["kind": "invalidated", "rectsTwips": encodedRects, "part": part]
        case .modifiedChanged(let modified):
            return ["kind": "modifiedChanged", "modified": modified]
        case .closed:
            return ["kind": "closed"]
        case .autosaved(let ext, let isODFFallback):
            return ["kind": "autosaved", "ext": ext, "isODFFallback": isODFFallback]
        case .caretRect(let rect):
            return ["kind": "caretRect"].merging(Self.encodeBareRect(rect)) { _, new in new }
        case .textSelection(let rects):
            return ["kind": "textSelection", "rectsTwips": rects.map { Self.encodeBareRect($0) }]
        case .textSelectionStart(let rect):
            return ["kind": "textSelectionStart"].merging(Self.encodeBareRect(rect)) { _, new in new }
        case .textSelectionEnd(let rect):
            return ["kind": "textSelectionEnd"].merging(Self.encodeBareRect(rect)) { _, new in new }
        case .cellCursor(let cell):
            switch cell {
            case .empty:
                return ["kind": "cellCursor", "empty": true]
            case .at(let rect, let column, let row):
                return ["kind": "cellCursor", "empty": false, "column": column, "row": row]
                    .merging(Self.encodeBareRect(rect)) { _, new in new }
            }
        case .cellFormula(let text):
            return ["kind": "cellFormula", "text": text]
        }
    }

    private static func encodeBareRect(_ rect: OfficeTwipsRect) -> [String: Any] {
        ["x": rect.x, "y": rect.y, "width": rect.width, "height": rect.height]
    }

    /// The inverse of `encodedFields()`, reading from the SAME flat object a `.documentEvent`
    /// frame decodes (`object` already has `type`/`seq`/`docId` verified by the caller —
    /// `OfficeWireCodec.decodeInbound`'s `"documentEvent"` case). `nil` for any unrecognized
    /// `kind` or missing/mistyped field — the caller folds that into the frame-level `"malformed"`
    /// rejection, same discipline as every other case in this file.
    static func decodeFields(_ object: [String: Any]) -> OfficeDocumentEvent? {
        guard let kind = object["kind"] as? String else { return nil }
        switch kind {
        case "opened":
            guard let typeRaw = object["docType"] as? String, let type = OfficeDocumentKind(rawValue: typeRaw),
                  let parts = intValue(object["parts"]),
                  let widthTwips = int64Value(object["widthTwips"]),
                  let heightTwips = int64Value(object["heightTwips"]) else { return nil }
            return .opened(type: type, parts: parts, sizeTwips: OfficeDocumentSize(widthTwips: widthTwips, heightTwips: heightTwips))
        case "openFailed":
            guard let reason = object["reason"] as? String else { return nil }
            return .openFailed(reason: reason)
        case "invalidated":
            guard let rawRects = object["rectsTwips"] as? [[String: Any]],
                  let part = intValue(object["part"]) else { return nil }
            var rects: [OfficeTwipsRect] = []
            for rawRect in rawRects {
                guard let x = int64Value(rawRect["x"]), let y = int64Value(rawRect["y"]),
                      let width = int64Value(rawRect["width"]), let height = int64Value(rawRect["height"]) else {
                    return nil
                }
                rects.append(OfficeTwipsRect(x: x, y: y, width: width, height: height))
            }
            return .invalidated(rectsTwips: rects, part: part)
        case "modifiedChanged":
            // Same NSNumber-boolean-trap shape as everywhere else in this file, inverted: THIS
            // field must actually BE a boolean (every other use rejects one).
            guard let number = object["modified"] as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else {
                return nil
            }
            return .modifiedChanged(number.boolValue)
        case "closed":
            return .closed
        case "autosaved":
            // Wire strictness (house norm): both fields required, `isODFFallback` boolean-typed via
            // the SAME NSNumber/CFBoolean discriminator `modifiedChanged`/`cellCursor` above use —
            // a malformed or missing field here rejects the whole frame rather than silently
            // defaulting, matching every other case in this switch.
            guard let ext = object["ext"] as? String, !ext.isEmpty,
                  let number = object["isODFFallback"] as? NSNumber,
                  CFGetTypeID(number) == CFBooleanGetTypeID() else {
                return nil
            }
            return .autosaved(ext: ext, isODFFallback: number.boolValue)
        case "caretRect":
            guard let rect = decodeBareRect(object) else { return nil }
            return .caretRect(rect)
        case "textSelection":
            guard let rawRects = object["rectsTwips"] as? [[String: Any]] else { return nil }
            var rects: [OfficeTwipsRect] = []
            for rawRect in rawRects {
                guard let rect = decodeBareRect(rawRect) else { return nil }
                rects.append(rect)
            }
            return .textSelection(rects)
        case "textSelectionStart":
            guard let rect = decodeBareRect(object) else { return nil }
            return .textSelectionStart(rect)
        case "textSelectionEnd":
            guard let rect = decodeBareRect(object) else { return nil }
            return .textSelectionEnd(rect)
        case "cellCursor":
            guard let number = object["empty"] as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else {
                return nil
            }
            if number.boolValue { return .cellCursor(.empty) }
            guard let rect = decodeBareRect(object), let column = intValue(object["column"]),
                  let row = intValue(object["row"]) else {
                return nil
            }
            return .cellCursor(.at(rectTwips: rect, column: column, row: row))
        case "cellFormula":
            // Wire strictness (house norm): `text` is required — a missing field rejects the
            // whole frame rather than silently defaulting to "", which would be indistinguishable
            // from a genuinely empty cell's own real, meaningful payload (see this case's own
            // header on `OfficeDocumentEvent`).
            guard let text = object["text"] as? String else { return nil }
            return .cellFormula(text)
        default:
            return nil
        }
    }

    private static func decodeBareRect(_ object: [String: Any]) -> OfficeTwipsRect? {
        guard let x = int64Value(object["x"]), let y = int64Value(object["y"]),
              let width = int64Value(object["width"]), let height = int64Value(object["height"]) else {
            return nil
        }
        return OfficeTwipsRect(x: x, y: y, width: width, height: height)
    }

    // MARK: - LOK raw callback payload parsing

    /// Parses `LOK_CALLBACK_INVALIDATE_TILES`'s raw payload: `"x, y, width, height"` in twips,
    /// `"x, y, width, height, part, mode"` with `LOK_FEATURE_PART_IN_INVALIDATION_CALLBACK` set
    /// (always, in `LOKBridge`), or `"EMPTY"` — with the SAME optional `", part, mode"` suffix —
    /// meaning "the whole document" (`LibreOfficeKitEnums.h:120-129`). `nil` for anything that
    /// doesn't parse as either shape.
    ///
    /// **Fix round 1, F3 (CRITICAL — a real, confirmed bug, not a hardening nice-to-have): a bare
    /// `trimmed == "EMPTY"` exact-match used to be the ONLY accepted whole-document shape.** With
    /// `LOK_FEATURE_PART_IN_INVALIDATION_CALLBACK` on (always, in `LOKBridge`), LO's own writer
    /// (`RectangleAndPart::toString()`, `desktop/inc/lib/init.hxx`, fetched and read directly, not
    /// guessed) NEVER emits bare `"EMPTY"` — it unconditionally appends `", " + part + ", " + mode`
    /// whenever `m_nPart >= -1`, i.e. the real wire shape is `"EMPTY, 0, 0"` (or whatever part/mode
    /// happen to be). The old exact-match rejected that: it fell through to the numeric-rect branch,
    /// `Int64("EMPTY")` failed, and the WHOLE callback was silently dropped — a genuine
    /// whole-document invalidation that never reached `TileCache.invalidate` at all, leaving stale
    /// pixels no scroll/zoom could ever correct (nothing re-marks a key "stale" if the invalidation
    /// that should have done so was never parsed in the first place). Fixed below by matching on
    /// `fields[0] == "EMPTY"` rather than the whole trimmed string, mirroring LO's OWN reader's
    /// leniency (`RectangleAndPart::Create`, same file: part is read if present, mode is optional
    /// even then) — this parser now accepts bare `"EMPTY"`, `"EMPTY, <part>"`, and `"EMPTY, <part>,
    /// <mode>"` alike, discarding mode (`OfficeDocumentEvent.invalidated` carries no mode field).
    ///
    /// Lives here (not on `LOKBridge`, its one real caller) so a test can reach it at all:
    /// `LOKBridge` is a `type: tool` Xcode target no test bundle can import. Task 4's live callback
    /// probe (`OfficeHelperLiveTests.testRealLOKCallbackProbeCapturesRawPayloadsAndCrossChecksThe
    /// Parsers`) DOES now provoke real LOK callbacks over open+paintTile+close, so this parser is no
    /// longer permanently zero-coverage against real firings — but that probe observed **zero**
    /// `LOK_CALLBACK_INVALIDATE_TILES` firings against a view-only document with no edit verb
    /// available (Stage A ships none); Task 4's OWN live edit tests are what first observed a real
    /// firing (the 6-field, non-EMPTY rect shape) — see `OfficeHelperLiveTests`' criterion-1 test.
    /// The EMPTY shape specifically remains cross-checked only against real UPSTREAM SOURCE (this
    /// comment's own citations), not yet against a captured live EMPTY firing — Stage B's own edit
    /// traffic so far has stayed within one already-visible tile range, never triggered a genuine
    /// whole-document invalidation (a format change, a huge paste, a full recalc). Revisit the day
    /// one is captured live.
    ///
    /// **Re-judged leniency (Task 4, debt #1), one clause at a time:**
    /// - `"EMPTY"` and the 4-field shape: both structurally reachable and both covered by the table
    ///   test; no real firing was observed to cross-check either, but neither is a leniency question
    ///   — they're the two documented shapes, not a fallback.
    /// - **The `fields[4] ?? 0` part-defaulting IS the leniency in question, and it stays
    ///   unjudged, honestly**: zero real `INVALIDATE_TILES` firings means zero real 5-field-vs-4-field
    ///   payloads to check the default against. `LOK_FEATURE_PART_IN_INVALIDATION_CALLBACK` is set
    ///   unconditionally in `LOKBridge`, so production should always get 5 fields when this callback
    ///   ever DOES fire — but that claim is a header-doc reading, not something Task 4's probe
    ///   confirmed live. Structurally unreachable until a Stage-B edit verb exists to provoke a real
    ///   invalidation; revisit this comment the day one does. **Fix round 1 update**: Task 4's own
    ///   live edit traffic DID cross-check this — real firings observed 6 fields, always with a
    ///   parseable `fields[4]`, never exercising the default. The default itself (garbage or a
    ///   missing 5th field) is still unexercised by real data.
    static func parseInvalidateTiles(_ payload: String) -> OfficeDocumentEvent? {
        let trimmed = payload.trimmingCharacters(in: .whitespaces)
        let fields = trimmed.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }
        guard let first = fields.first else { return nil }
        if first == "EMPTY" {
            // Fix round 1, F3: part (and, if present, mode) after "EMPTY" — see this function's own
            // header. `part` can legitimately be `-1` ("all parts") — passed through unchanged;
            // `TileCache.invalidate`'s empty-rects branch already ignores `part` entirely, so `-1`
            // is indistinguishable from any other value there (harmless either way).
            let part = fields.count >= 2 ? (Int(fields[1]) ?? 0) : 0
            return .invalidated(rectsTwips: [], part: part)
        }
        guard fields.count >= 4,
              let x = Int64(fields[0]), let y = Int64(fields[1]),
              let width = Int64(fields[2]), let height = Int64(fields[3]) else {
            return nil
        }
        // `Int` parses a leading "-" natively — `part == -1` ("all parts," the same LO sentinel the
        // EMPTY branch above can carry) survives this unchanged; `TileCache.invalidate`'s own
        // fix-round update is what makes a NON-empty rect actually honor it.
        let part = fields.count >= 5 ? (Int(fields[4]) ?? 0) : 0
        return .invalidated(rectsTwips: [OfficeTwipsRect(x: x, y: y, width: width, height: height)], part: part)
    }

    /// Parses `LOK_CALLBACK_STATE_CHANGED`'s raw payload. That callback fires for many `.uno:*`
    /// state changes (Bold, Italic, ...) — `LibreOfficeKitEnums.h:224-229`'s own doc comment gives
    /// `.uno:Bold=true` as its example. Stage A only cares about `.uno:ModifiedStatus` (dirty
    /// tracking); every other state-changed payload is ignored (returns `nil`, folded into "not a
    /// callback type this vocabulary covers" by the caller). Same test-reachability rationale as
    /// `parseInvalidateTiles` above — UNLIKE that function, this one WAS cross-checked against a
    /// real firing: Task 4's live probe observed a genuine `.uno:ModifiedStatus=false` payload from
    /// opening `gate.xlsx`, and this function parsed it correctly (`.modifiedChanged(false)`).
    ///
    /// **Re-judged leniency (Task 4, debt #1): the `== "true"` fallback-to-false for any non-"true"
    /// suffix.** The one real firing observed was a clean, well-formed `"false"` — the leniency
    /// itself (what happens on garbage after the `=`) remains unexercised by real data. Kept as the
    /// safe default: every real `.uno:ModifiedStatus` firing this codebase's own LOK vendor tree is
    /// documented to emit is exactly `"true"` or `"false"` (`LibreOfficeKitEnums.h`'s own example),
    /// so folding anything else to `false` fails closed (never reports "dirty" on a payload shape
    /// nobody has ever actually seen) rather than crashing or mis-parsing outward.
    static func parseModifiedStatus(_ payload: String) -> OfficeDocumentEvent? {
        let prefix = ".uno:ModifiedStatus="
        guard payload.hasPrefix(prefix) else { return nil }
        return .modifiedChanged(payload.dropFirst(prefix.count) == "true")
    }

    // MARK: - Task 5: caret, selection, cell-cursor raw payload parsing
    //
    // Every shape below is built from a REAL captured firing, not from the enum header's own doc
    // comments alone — `OfficeHelperLiveTests.testRealLOKCallbackProbeCapturesCaretSelectionAndCell
    // CursorRawPayloads` is where each was first observed; see that test's own header for the full
    // methodology and why more than one input door (keyboard AND mouse, Writer AND Calc) was probed
    // before writing any of this. The header comments for these five LOK callback types describe a
    // shape at least one of them does NOT actually produce at this vendored pin (`LOK_FEATURE_
    // VIEWID_IN_VISCURSOR_INVALIDATION_CALLBACK`'s own JSON format for `INVALIDATE_VISIBLE_CURSOR` —
    // see `parseCaretRect`'s own header) — the T4 lesson, generalized past `INVALIDATE_TILES`'s own
    // "EMPTY carries no part" mistake to the whole callback vocabulary.

    /// Shared core: a bare `"x, y, width, height"` rect, the SAME shape `INVALIDATE_TILES`'s own
    /// non-EMPTY branch parses, reused here rather than re-derived — every one of Task 5's five new
    /// callback types builds on this same primitive (`CELL_CURSOR` extends it with two more fields;
    /// `TEXT_SELECTION` repeats it, semicolon-joined). `>= 4`, never `== 4` — mirrors
    /// `parseInvalidateTiles`'s own established leniency for a payload that turns out to carry more
    /// fields than any live capture has shown so far, even though every firing THIS task's own probe
    /// observed carried exactly 4.
    private static func parseBareRect(_ text: String) -> OfficeTwipsRect? {
        let fields = text.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }
        guard fields.count >= 4,
              let x = Int64(fields[0]), let y = Int64(fields[1]),
              let width = Int64(fields[2]), let height = Int64(fields[3]) else {
            return nil
        }
        return OfficeTwipsRect(x: x, y: y, width: width, height: height)
    }

    /// Parses `LOK_CALLBACK_INVALIDATE_VISIBLE_CURSOR`'s raw payload.
    ///
    /// **Empirically a bare `"x, y, width, height"` rect, identical for every scenario probed** —
    /// Writer's main document caret (typing in the body) AND Calc's in-cell edit caret (typing inside
    /// a cell) both produced this exact shape; `width` was `0` in every one of the six real firings
    /// observed (a caret is a vertical line, no horizontal extent). The enum header's own doc comment
    /// (`LibreOfficeKitEnums.h:131-140`) describes a DIFFERENT "new format" — a JSON object with
    /// `viewId`/`rectangle`/`misspelledWord` — gated on `LOK_FEATURE_VIEWID_IN_VISCURSOR_INVALIDATION_
    /// CALLBACK`; source-reading ahead of the probe (`SfxLokHelper::notifyCursorInvalidation`,
    /// `sfx2/source/view/lokhelper.cxx`, pinned commit `11482c8f`) found that function's own
    /// `bControlEvent == false` branch never closes the `"rectangle"` value's own JSON string before
    /// appending `" }"` — looks structurally incapable of producing valid JSON — but the probe's own
    /// real captures show this path is simply never reached by ordinary document-caret movement in
    /// this build at all (every real firing is the plain rect, not JSON, malformed or otherwise).
    /// Accepted anyway, defensively, as a fallback — cheap, matches the header's own documented
    /// alternative, and costs nothing against a future LOK version or an untested path (a floating
    /// dialog's own cursor, reached with `nWindowId != 0`) that DOES emit it.
    static func parseCaretRect(_ payload: String) -> OfficeDocumentEvent? {
        if let rect = parseBareRect(payload) {
            return .caretRect(rect)
        }
        guard let data = payload.data(using: .utf8),
              let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let rectString = object["rectangle"] as? String,
              let rect = parseBareRect(rectString) else {
            return nil
        }
        return .caretRect(rect)
    }

    /// Parses `LOK_CALLBACK_TEXT_SELECTION`'s raw payload: `"rect1[; rect2[; ...]]"`
    /// (`LibreOfficeKitEnums.h:142-149`'s own documented shape, confirmed live for the single-rect
    /// case — every selection this task's own probe produced fit on one line, so the semicolon-joined
    /// multi-rect shape is accepted by construction of this parser but not itself cross-checked
    /// against a real multi-line-selection firing; disclosed, not chased further, the same posture
    /// `parseInvalidateTiles`'s own header takes toward its own never-observed EMPTY-with-garbage
    /// case). Empty selection folds BOTH real shapes observed live to `[]`: LOK's documented `""`,
    /// AND (Calc-specific, undocumented, found by reading `sc/source/ui/view/gridwin.cxx:7005` ahead
    /// of the probe though not itself re-triggered by this task's own Writer-focused probe run) the
    /// bare string `"EMPTY"` — mirrors `parseInvalidateTiles`'s own established EMPTY leniency on a
    /// different callback entirely.
    static func parseTextSelection(_ payload: String) -> OfficeDocumentEvent? {
        let trimmed = payload.trimmingCharacters(in: .whitespaces)
        if trimmed.isEmpty || trimmed == "EMPTY" {
            return .textSelection([])
        }
        var rects: [OfficeTwipsRect] = []
        for piece in trimmed.split(separator: ";") {
            guard let rect = parseBareRect(String(piece)) else { return nil }
            rects.append(rect)
        }
        return .textSelection(rects)
    }

    /// Parses `LOK_CALLBACK_TEXT_SELECTION_START`'s raw payload — a bare rect, confirmed live
    /// (Writer, keyboard shift-selection). Per `SwSelPaintRects::getLOKPayload`
    /// (`sw/source/core/crsr/viscrs.cxx`, read at the pin) this callback does not fire AT ALL when
    /// there is no selection (`if (!size()) return {}` — no payload, not an empty one), consistent
    /// with the probe's own capture: no START/END line was ever observed accompanying a
    /// selection-collapse. `nil` for anything that doesn't parse as a bare rect — there is no
    /// documented or observed "empty" shape for this callback to be lenient toward.
    static func parseTextSelectionStart(_ payload: String) -> OfficeDocumentEvent? {
        guard let rect = parseBareRect(payload) else { return nil }
        return .textSelectionStart(rect)
    }

    /// The trailing-edge counterpart to `parseTextSelectionStart` — same shape, same posture,
    /// confirmed live the same way.
    static func parseTextSelectionEnd(_ payload: String) -> OfficeDocumentEvent? {
        guard let rect = parseBareRect(payload) else { return nil }
        return .textSelectionEnd(rect)
    }

    /// Parses `LOK_CALLBACK_CELL_CURSOR`'s raw payload (Calc only).
    ///
    /// **A SIX-field payload, not the four-field shape the enum header's own doc comment would
    /// suggest by analogy with `INVALIDATE_TILES`** — confirmed live (two real firings, A1 and a
    /// distant cell) and cross-checked against source ahead of the probe
    /// (`ScViewData::describeCellCursorAt`, `sc/source/ui/view/viewdata.cxx`, pinned commit
    /// `11482c8f`, the non-print-twips branch this helper's own registry configuration takes —
    /// `LibreOfficeKit::isCompatFlagSet(Compat::scPrintTwipsMsgs)` is never set here): `"x, y, width,
    /// height, col, row"` — the trailing `col`/`row` are the cell's own 0-based column/row indices,
    /// which `TileMath`'s existing rect-only vocabulary has no field for. Kept, not discarded — this
    /// is the brief's own named T8 feed ("CELL_CURSOR parsing you build now feeds it"), and the parse
    /// stays pure and reusable exactly as asked: this function has no opinion about the formula
    /// bar/cell-ref strip that will eventually read `column`/`row`.
    ///
    /// **The bare `"EMPTY"` sentinel — confirmed live, during in-cell edit mode.** Unlike
    /// `INVALIDATE_TILES`'s `"EMPTY, <part>, <mode>"`, this one carries no trailing fields at all —
    /// `ScGridWindow::getCellCursor()` (`sc/source/ui/view/gridwin.cxx`) returns the bare literal
    /// whenever `mpOOCursors` is unset, which the probe's own capture shows happens the moment a cell
    /// enters text-edit mode (the grid's own "current cell" concept doesn't apply while editing text
    /// inside one) — `column`/`row` are genuinely unknown in that state, not merely omitted, which is
    /// exactly why `OfficeCellCursor` models this as its own case rather than a rect-optional pair
    /// carrying stale/sentinel numbers.
    static func parseCellCursor(_ payload: String) -> OfficeDocumentEvent? {
        let trimmed = payload.trimmingCharacters(in: .whitespaces)
        if trimmed == "EMPTY" {
            return .cellCursor(.empty)
        }
        let fields = trimmed.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }
        guard fields.count >= 6,
              let x = Int64(fields[0]), let y = Int64(fields[1]),
              let width = Int64(fields[2]), let height = Int64(fields[3]),
              let column = Int(fields[4]), let row = Int(fields[5]) else {
            return nil
        }
        return .cellCursor(.at(rectTwips: OfficeTwipsRect(x: x, y: y, width: width, height: height), column: column, row: row))
    }

    /// Parses `LOK_CALLBACK_CELL_FORMULA`'s raw payload (Calc only) — "the text content of the
    /// formula bar" (`LibreOfficeKitEnums.h:345-347`). **Never rejects anything** — unlike every
    /// other parser in this file, there is no structure here to malform: the payload IS the text,
    /// verbatim, confirmed live (`OfficeHelperLiveTests
    /// .testProbeInvestigatesWhetherCellFormulaCallbacksExistForTheFormulaBarsContent`'s own real
    /// capture) to arrive as a plain string in every observed shape — a cell's literal content
    /// ("NORMA GATE", "42"), the empty string for a genuinely empty cell, and the live,
    /// uncommitted in-progress edit-buffer text while typing. A bare `""` is therefore NOT an
    /// error sentinel the way it is for `parseTextSelectionStart`/`parseCellCursor` — it is the
    /// real, meaningful "this cell has no content" shape, and must fold as such, never as a
    /// rejected/ignored firing.
    static func parseCellFormula(_ payload: String) -> OfficeDocumentEvent? {
        .cellFormula(payload)
    }
}

/// Task 5 — `LOK_CALLBACK_CELL_CURSOR`'s two real shapes (Calc only), kept as its own type rather
/// than an `(OfficeTwipsRect?, Int, Int)` tuple with meaningless sentinel numbers when empty — see
/// `OfficeDocumentEvent.parseCellCursor`'s own header for the empirical basis of both cases.
public enum OfficeCellCursor: Equatable, Sendable {
    /// A real cell is current: its own rect (twips) plus its 0-based `(column, row)` — the T8
    /// formula-bar/cell-ref strip's own feed.
    case at(rectTwips: OfficeTwipsRect, column: Int, row: Int)
    /// No cell cursor to report right now (observed live: while a cell is in text-edit mode) — LOK's
    /// own bare `"EMPTY"` sentinel, carrying no column/row at all.
    case empty
}

/// Task 2 introduced this as a Stage-A-wide placeholder (no LibreOfficeKit loaded anywhere yet).
/// Task 3 NARROWS it rather than retiring it: the real `NormaOfficeHelper` now reports the real
/// `getVersionInfo()` `BuildId` (see `OfficeHelperServer`'s `hello` handler and `LOKBridge`), but
/// `NormaOfficeHelperFixture` (`OfficeSupervisorTests`' spy binary) still has no real LOK — see
/// `Tests/OfficeHelperFixtureSources/main.swift`'s fake `OfficeDocumentBridge` — and reporting this
/// exact string remains its own honest self-description, not a stand-in for something realer. Four
/// pinned call sites move together with any future change here: this constant, `OfficeHelperServer`
/// (the fixture's fake bridge), `OfficeHelperLiveSmokeTests` (now real-LOK, no longer uses this
/// constant), and `OfficeSupervisorTests` (still fixture-backed, still uses it) — grep before
/// touching any one of them.
public let officeWireStageALOKVersionPlaceholder = "lok-not-loaded"

/// Task 5.5 — a `.tile` frame's HEADER, decoded from its NDJSON line alone — everything
/// `OfficeWireFrame.tile` carries except the pixel bytes themselves, which are never part of the
/// line (see that case's own doc comment). Lives here, not as a nested type, because both
/// `OfficeWireCodec.decodeInbound` (produces it) and `OfficeWireConnection.ingest` (the one real
/// consumer — combines it with `byteCount` raw bytes read off the stream to synthesize a complete
/// `OfficeWireFrame.tile`) need it, and it is meaningless without the codec that produces it.
public struct TileWireHeader: Equatable, Sendable {
    public let seq: UInt64
    public let docId: String
    public let key: TileKey
    public let generation: Int
    public let width: Int
    public let height: Int
    /// How many raw bytes follow this header line on the wire. Structurally validated here only as
    /// "a non-negative integer" (`OfficeWireCodec.decodeInbound`'s own decode-level contract,
    /// mirroring `unsignedSeq`'s discipline) — the SEMANTIC policy question ("is this a size we are
    /// willing to trust/allocate for") is deliberately NOT this type's job; see
    /// `OfficeWireConnection.ingest`'s own exact-size-or-refuse check, which is where that decision
    /// is made and documented.
    public let byteCount: Int
    public init(seq: UInt64, docId: String, key: TileKey, generation: Int, width: Int, height: Int, byteCount: Int) {
        self.seq = seq
        self.docId = docId
        self.key = key
        self.generation = generation
        self.width = width
        self.height = height
        self.byteCount = byteCount
    }
}

/// The result of trying to read one NDJSON line as a frame a HELPER must answer. Three-way so the
/// helper can always echo the caller's real `seq` when it has one, and only fall back to the
/// seq-unknown sentinel when the line gave it no seq at all.
///
/// **Task 5.5 adds a fourth case, `.tilePending`, for exactly one wire type (`"tile"`)**: unlike
/// every other frame, a `.tile` line alone is never a COMPLETE frame anymore — the pixel bytes
/// that used to live inline (`pixelsBase64`) now follow the line as raw, out-of-band bytes (see
/// `OfficeWireFrame.tile`'s own doc comment). `.frame`'s own contract — "this line, and only this
/// line, decoded to a full, usable value" — would be dishonest for `"tile"`, so it gets its own
/// outcome instead of `.frame(.tile(..., pixels: Data()))` with a fake empty payload. Both server
/// switches over this enum (`OfficeHelperServer.handleOpeningLine`/`.handlePostAuthLine`) gain one
/// new arm each for it — a CLIENT should never legitimately send a `"tile"` line (tile is a
/// PUSH-only, helper->client shape), so both arms simply refuse it exactly like any other
/// helper-only frame a client tried to send (`"not authenticated"` / `"unexpected"`).
/// `OfficeWireFrame.decode(_:)` returns `nil` for a `"tile"` line, consistent with its own
/// documented contract ("did this parse to a full, usable frame") — the one real consumer that
/// needs the header (`OfficeWireConnection.ingest`) calls `OfficeWireCodec.decodeInbound` directly
/// instead, precisely so it can see this case.
public enum OfficeWireInbound: Equatable, Sendable {
    /// Decoded completely.
    case frame(OfficeWireFrame)
    /// A `.tile` header line decoded completely, but the frame it describes is not yet complete —
    /// `header.byteCount` raw bytes must still be read off the stream before a real
    /// `OfficeWireFrame.tile` exists. See this enum's own header for why this cannot simply be
    /// `.frame(.tile(...))`.
    case tilePending(TileWireHeader)
    /// The envelope decoded (a JSON object with a string `type` and a recoverable non-negative
    /// integer `seq`), but the frame itself didn't: either `type` is not one of
    /// `OfficeWireFrame.wireTypes` (reason `"unknown"` — the brief's literal pin) or it IS a known
    /// type whose required fields are missing or mistyped (reason `"malformed"`).
    case rejected(seq: UInt64, reason: String)
    /// **office-plumbing wave fix (T5.5 review Minor-B)** — a `"tile"`-typed line whose OWN
    /// structure failed to decode (a missing/mistyped `docId`/`key`/`generation`/`width`/`height`/
    /// `byteCount`). Deliberately NOT folded into `.rejected`, even though the two carry the same
    /// `(seq, reason)` shape: every OTHER wire type's malformed line is self-contained — nothing on
    /// the wire depends on having decoded it, so `.rejected`'s own "log and keep scanning" handling
    /// (`OfficeWireConnection.ingest`) is safe. A `"tile"` line is different — on a well-formed
    /// stream, raw pixel bytes ALWAYS follow it, whether or not THIS reader could parse the header
    /// naming them. If this case fell through to `.rejected`'s treatment, `ingest` would newline-scan
    /// straight into up to a tile's worth of raw RGBA bytes hunting for `0x0A` — pixel bytes
    /// routinely contain it (~1/256 of a ~1MiB payload, on the order of 4,000 spurious "lines") —
    /// producing thousands of pointless decode-and-log cycles instead of the one honest outcome:
    /// this stream can no longer be trusted to be in sync, exactly the reasoning the byteCount-
    /// mismatch refusal (`ingest`'s own `.tilePending` case) already acts on for a structurally-VALID
    /// header carrying an untrustworthy size.
    case tileHeaderMalformed(seq: UInt64, reason: String)
    /// Not even an envelope: not valid JSON, not a JSON object, no string `type`, or `seq` itself
    /// missing/mistyped/negative. Nothing here is trustworthy enough to echo — a reply, if the
    /// caller chooses to send one, must use the seq-unknown sentinel (`0`) with reason
    /// `"malformed"`.
    case unreadable
}

public enum OfficeWireCodec {
    /// The seq value a helper sends back when the inbound line was `.unreadable` — no real seq
    /// exists to echo. `0` is never a seq a well-behaved client mints (see
    /// `OfficeWireSeqAllocator`, which starts at 1), so a client CAN tell a sentinel-seq error
    /// apart from a genuine echo if it wants to, without that distinction being load-bearing for
    /// the refuse-never-ignore contract itself (a reply was still sent either way).
    public static let unreadableSeqSentinel: UInt64 = 0

    /// The full three-way inbound decode. Total: never throws, always returns one of the three
    /// cases above.
    public static func decodeInbound(_ line: String) -> OfficeWireInbound {
        guard let data = line.data(using: .utf8),
              let parsed = try? JSONSerialization.jsonObject(with: data),
              let object = parsed as? [String: Any],
              let type = object["type"] as? String,
              let seq = unsignedSeq(object["seq"]) else {
            return .unreadable
        }

        switch type {
        case "hello":
            guard let roleRaw = object["role"] as? String,
                  let role = OfficeWireRole(rawValue: roleRaw),
                  let token = object["token"] as? String else {
                return .rejected(seq: seq, reason: "malformed")
            }
            return .frame(.hello(seq: seq, role: role, token: token))
        case "ping":
            return .frame(.ping(seq: seq))
        case "open":
            guard let docId = object["docId"] as? String, let path = object["path"] as? String else {
                return .rejected(seq: seq, reason: "malformed")
            }
            return .frame(.open(seq: seq, docId: docId, path: path))
        case "close":
            guard let docId = object["docId"] as? String else {
                return .rejected(seq: seq, reason: "malformed")
            }
            return .frame(.close(seq: seq, docId: docId))
        case "save":
            // Fix round 4 (NEW-2) — `part` is REQUIRED, exactly like `keyEvent`/`mouseEvent`'s own.
            // Deliberately not defaulted to 0 on a missing field: a `save` frame with no part is a
            // sender that predates this field, and silently substituting sheet 1 for "whatever the
            // user is on" is the precise failure this field exists to prevent. Both ends of this
            // wire ship in the SAME app bundle (the helper is embedded), so there is no mixed-version
            // case to be lenient for — the same reasoning `keyEvent`'s own required `part` already
            // rests on.
            guard let docId = object["docId"] as? String, let part = intValue(object["part"]) else {
                return .rejected(seq: seq, reason: "malformed")
            }
            return .frame(.save(seq: seq, docId: docId, part: part))
        case "keyEvent":
            guard let docId = object["docId"] as? String, let part = intValue(object["part"]),
                  let typeRaw = intValue(object["eventType"]), let type = OfficeKeyEventType(rawValue: typeRaw),
                  let charCode = intValue(object["charCode"]), let keyCode = intValue(object["keyCode"]) else {
                return .rejected(seq: seq, reason: "malformed")
            }
            return .frame(.keyEvent(seq: seq, docId: docId, part: part, type: type, charCode: charCode, keyCode: keyCode))
        case "mouseEvent":
            guard let docId = object["docId"] as? String, let part = intValue(object["part"]),
                  let typeRaw = intValue(object["eventType"]), let type = OfficeMouseEventType(rawValue: typeRaw),
                  let xTwips = int64Value(object["xTwips"]), let yTwips = int64Value(object["yTwips"]),
                  let count = intValue(object["count"]), let buttons = intValue(object["buttons"]),
                  let modifiers = intValue(object["modifiers"]) else {
                return .rejected(seq: seq, reason: "malformed")
            }
            return .frame(.mouseEvent(seq: seq, docId: docId, part: part, type: type, xTwips: xTwips, yTwips: yTwips,
                                       count: count, buttons: buttons, modifiers: modifiers))
        case "extTextInputEvent":
            guard let docId = object["docId"] as? String, let part = intValue(object["part"]),
                  let typeRaw = intValue(object["eventType"]), let type = OfficeExtTextInputType(rawValue: typeRaw),
                  let text = object["text"] as? String else {
                return .rejected(seq: seq, reason: "malformed")
            }
            return .frame(.extTextInputEvent(seq: seq, docId: docId, part: part, type: type, text: text))
        case "keyEventOk":
            guard let docId = object["docId"] as? String else {
                return .rejected(seq: seq, reason: "malformed")
            }
            return .frame(.keyEventOk(seq: seq, docId: docId))
        case "mouseEventOk":
            guard let docId = object["docId"] as? String else {
                return .rejected(seq: seq, reason: "malformed")
            }
            return .frame(.mouseEventOk(seq: seq, docId: docId))
        case "extTextInputEventOk":
            guard let docId = object["docId"] as? String else {
                return .rejected(seq: seq, reason: "malformed")
            }
            return .frame(.extTextInputEventOk(seq: seq, docId: docId))
        case "clipboardCopy":
            guard let docId = object["docId"] as? String, let part = intValue(object["part"]) else {
                return .rejected(seq: seq, reason: "malformed")
            }
            return .frame(.clipboardCopy(seq: seq, docId: docId, part: part))
        case "clipboardCut":
            guard let docId = object["docId"] as? String, let part = intValue(object["part"]) else {
                return .rejected(seq: seq, reason: "malformed")
            }
            return .frame(.clipboardCut(seq: seq, docId: docId, part: part))
        case "clipboardPaste":
            guard let docId = object["docId"] as? String, let part = intValue(object["part"]),
                  let text = object["text"] as? String else {
                return .rejected(seq: seq, reason: "malformed")
            }
            return .frame(.clipboardPaste(seq: seq, docId: docId, part: part, text: text))
        case "undo":
            guard let docId = object["docId"] as? String else {
                return .rejected(seq: seq, reason: "malformed")
            }
            return .frame(.undo(seq: seq, docId: docId))
        case "redo":
            guard let docId = object["docId"] as? String else {
                return .rejected(seq: seq, reason: "malformed")
            }
            return .frame(.redo(seq: seq, docId: docId))
        case "createView":
            guard let docId = object["docId"] as? String else {
                return .rejected(seq: seq, reason: "malformed")
            }
            return .frame(.createView(seq: seq, docId: docId))
        case "agentKeyEvent":
            guard let docId = object["docId"] as? String, let part = intValue(object["part"]),
                  let typeRaw = intValue(object["eventType"]), let type = OfficeKeyEventType(rawValue: typeRaw),
                  let charCode = intValue(object["charCode"]), let keyCode = intValue(object["keyCode"]) else {
                return .rejected(seq: seq, reason: "malformed")
            }
            return .frame(.agentKeyEvent(seq: seq, docId: docId, part: part, type: type, charCode: charCode, keyCode: keyCode))
        case "clipboardCopyOk":
            guard let docId = object["docId"] as? String, let text = object["text"] as? String else {
                return .rejected(seq: seq, reason: "malformed")
            }
            return .frame(.clipboardCopyOk(seq: seq, docId: docId, text: text))
        case "clipboardCutOk":
            guard let docId = object["docId"] as? String, let text = object["text"] as? String else {
                return .rejected(seq: seq, reason: "malformed")
            }
            return .frame(.clipboardCutOk(seq: seq, docId: docId, text: text))
        case "clipboardPasteOk":
            guard let docId = object["docId"] as? String else {
                return .rejected(seq: seq, reason: "malformed")
            }
            return .frame(.clipboardPasteOk(seq: seq, docId: docId))
        case "undoOk":
            guard let docId = object["docId"] as? String else {
                return .rejected(seq: seq, reason: "malformed")
            }
            return .frame(.undoOk(seq: seq, docId: docId))
        case "redoOk":
            guard let docId = object["docId"] as? String else {
                return .rejected(seq: seq, reason: "malformed")
            }
            return .frame(.redoOk(seq: seq, docId: docId))
        case "agentViewReady":
            guard let docId = object["docId"] as? String, let viewId = intValue(object["viewId"]) else {
                return .rejected(seq: seq, reason: "malformed")
            }
            return .frame(.agentViewReady(seq: seq, docId: docId, viewId: Int32(truncatingIfNeeded: viewId)))
        case "agentKeyEventOk":
            guard let docId = object["docId"] as? String else {
                return .rejected(seq: seq, reason: "malformed")
            }
            return .frame(.agentKeyEventOk(seq: seq, docId: docId))
        case "saved":
            guard let docId = object["docId"] as? String, let tempPath = object["tempPath"] as? String else {
                return .rejected(seq: seq, reason: "malformed")
            }
            return .frame(.saved(seq: seq, docId: docId, tempPath: tempPath))
        case "saveFailed":
            guard let docId = object["docId"] as? String, let reason = object["reason"] as? String else {
                return .rejected(seq: seq, reason: "malformed")
            }
            return .frame(.saveFailed(seq: seq, docId: docId, reason: reason))
        case "helloOk":
            guard let lokVersion = object["lokVersion"] as? String else {
                return .rejected(seq: seq, reason: "malformed")
            }
            return .frame(.helloOk(seq: seq, lokVersion: lokVersion))
        case "refused":
            guard let reason = object["reason"] as? String else {
                return .rejected(seq: seq, reason: "malformed")
            }
            return .frame(.refused(seq: seq, reason: reason))
        case "pong":
            return .frame(.pong(seq: seq))
        case "opened":
            guard let docId = object["docId"] as? String,
                  let typeRaw = object["docType"] as? String, let type = OfficeDocumentKind(rawValue: typeRaw),
                  let parts = intValue(object["parts"]),
                  let widthTwips = int64Value(object["widthTwips"]),
                  let heightTwips = int64Value(object["heightTwips"]) else {
                return .rejected(seq: seq, reason: "malformed")
            }
            return .frame(.opened(seq: seq, docId: docId, type: type, parts: parts,
                                   sizeTwips: OfficeDocumentSize(widthTwips: widthTwips, heightTwips: heightTwips)))
        case "openFailed":
            guard let docId = object["docId"] as? String, let reason = object["reason"] as? String else {
                return .rejected(seq: seq, reason: "malformed")
            }
            return .frame(.openFailed(seq: seq, docId: docId, reason: reason))
        case "closed":
            guard let docId = object["docId"] as? String else {
                return .rejected(seq: seq, reason: "malformed")
            }
            return .frame(.closed(seq: seq, docId: docId))
        case "error":
            guard let reason = object["reason"] as? String else {
                return .rejected(seq: seq, reason: "malformed")
            }
            return .frame(.error(seq: seq, reason: reason))
        case "documentEvent":
            guard let docId = object["docId"] as? String,
                  let event = OfficeDocumentEvent.decodeFields(object) else {
                return .rejected(seq: seq, reason: "malformed")
            }
            return .frame(.documentEvent(seq: seq, docId: docId, event: event))
        case "subscribeTiles":
            guard let docId = object["docId"] as? String,
                  let part = intValue(object["part"]), let zoomPPT = intValue(object["zoomPPT"]),
                  let viewportTwips = OfficeWireFrame.decodeRect(object["viewportTwips"]) else {
                return .rejected(seq: seq, reason: "malformed")
            }
            return .frame(.subscribeTiles(seq: seq, docId: docId, part: part, zoomPPT: zoomPPT, viewportTwips: viewportTwips))
        case "unsubscribe":
            guard let docId = object["docId"] as? String else {
                return .rejected(seq: seq, reason: "malformed")
            }
            return .frame(.unsubscribe(seq: seq, docId: docId))
        case "tileRequest":
            guard let docId = object["docId"] as? String,
                  let keys = OfficeWireFrame.decodeTileKeys(object["keys"]) else {
                return .rejected(seq: seq, reason: "malformed")
            }
            return .frame(.tileRequest(seq: seq, docId: docId, keys: keys))
        case "subscribed":
            guard let docId = object["docId"] as? String,
                  let keys = OfficeWireFrame.decodeTileKeys(object["keys"]) else {
                return .rejected(seq: seq, reason: "malformed")
            }
            return .frame(.subscribed(seq: seq, docId: docId, keys: keys))
        case "unsubscribed":
            guard let docId = object["docId"] as? String else {
                return .rejected(seq: seq, reason: "malformed")
            }
            return .frame(.unsubscribed(seq: seq, docId: docId))
        case "tileRequestAccepted":
            guard let docId = object["docId"] as? String else {
                return .rejected(seq: seq, reason: "malformed")
            }
            return .frame(.tileRequestAccepted(seq: seq, docId: docId))
        case "tile":
            // Task 5.5: `byteCount` replaces `pixelsBase64` — this is a HEADER-only decode now
            // (`.tilePending`, never `.frame`), see `OfficeWireInbound`'s own doc comment. Structural
            // validation only: a present, non-negative integer (mirrors `unsignedSeq`'s own
            // NSNumber-boolean-trap discipline one line down, applied to a plain `Int` rather than a
            // `UInt64`). Whether THIS PARTICULAR value is a byte count the reader is willing to
            // trust/buffer for is a separate, semantic question `OfficeWireConnection.ingest` decides
            // — not this decode-level structural check.
            guard let docId = object["docId"] as? String,
                  let key = TileKey.decode(object["key"] as? [String: Any] ?? [:]),
                  let generation = intValue(object["generation"]),
                  let width = intValue(object["width"]), let height = intValue(object["height"]),
                  let byteCount = intValue(object["byteCount"]), byteCount >= 0 else {
                // Wave fix (T5.5 review Minor-B): `.tileHeaderMalformed`, never `.rejected` — see
                // `OfficeWireInbound`'s own header for why "tile" alone needs this distinction.
                return .tileHeaderMalformed(seq: seq, reason: "malformed")
            }
            return .tilePending(TileWireHeader(seq: seq, docId: docId, key: key, generation: generation,
                                                width: width, height: height, byteCount: byteCount))
        case "tileFailed":
            guard let docId = object["docId"] as? String,
                  let key = TileKey.decode(object["key"] as? [String: Any] ?? [:]),
                  let reason = object["reason"] as? String else {
                return .rejected(seq: seq, reason: "malformed")
            }
            return .frame(.tileFailed(seq: seq, docId: docId, key: key, reason: reason))
        case "invalidated":
            guard let docId = object["docId"] as? String,
                  let keys = OfficeWireFrame.decodeTileKeys(object["keys"]) else {
                return .rejected(seq: seq, reason: "malformed")
            }
            return .frame(.invalidated(seq: seq, docId: docId, keys: keys))
        case "sheetsInfo":
            guard let docId = object["docId"] as? String else {
                return .rejected(seq: seq, reason: "malformed")
            }
            return .frame(.sheetsInfo(seq: seq, docId: docId))
        case "sheetsRead":
            guard let docId = object["docId"] as? String, let sheet = object["sheet"] as? String,
                  let range = object["range"] as? String, let formulas = object["formulas"] as? Bool else {
                return .rejected(seq: seq, reason: "malformed")
            }
            return .frame(.sheetsRead(seq: seq, docId: docId, sheet: sheet, range: range, formulas: formulas))
        case "sheetsInfoOk":
            guard let docId = object["docId"] as? String,
                  let sheets = OfficeWireFrame.decodeSheetInfos(object["sheets"]),
                  let activeSheet = object["activeSheet"] as? String else {
                return .rejected(seq: seq, reason: "malformed")
            }
            return .frame(.sheetsInfoOk(seq: seq, docId: docId, sheets: sheets, activeSheet: activeSheet))
        case "sheetsReadOk":
            guard let docId = object["docId"] as? String,
                  let rows = OfficeWireFrame.decodeRows(object["rows"]) else {
                return .rejected(seq: seq, reason: "malformed")
            }
            return .frame(.sheetsReadOk(seq: seq, docId: docId, rows: rows))
        case "sheetsSet":
            guard let docId = object["docId"] as? String, let sheet = object["sheet"] as? String,
                  let range = object["range"] as? String,
                  let cellAddresses = object["cellAddresses"] as? [String],
                  let cellValues = object["cellValues"] as? [String],
                  cellAddresses.count == cellValues.count else {
                return .rejected(seq: seq, reason: "malformed")
            }
            return .frame(.sheetsSet(seq: seq, docId: docId, sheet: sheet, range: range,
                                     cellAddresses: cellAddresses, cellValues: cellValues))
        case "sheetsResize":
            guard let docId = object["docId"] as? String, let sheet = object["sheet"] as? String,
                  let dimensionRaw = object["dimension"] as? String,
                  let dimension = OfficeSheetsResizeDimension(rawValue: dimensionRaw),
                  let opRaw = object["op"] as? String, let op = OfficeSheetsResizeOp(rawValue: opRaw),
                  let selectionRange = object["selectionRange"] as? String else {
                return .rejected(seq: seq, reason: "malformed")
            }
            return .frame(.sheetsResize(seq: seq, docId: docId, sheet: sheet, dimension: dimension,
                                        op: op, selectionRange: selectionRange))
        case "sheetsManageSheet":
            guard let docId = object["docId"] as? String,
                  let opRaw = object["op"] as? String, let op = OfficeSheetsManageSheetOp(rawValue: opRaw),
                  let name = object["name"] as? String else {
                return .rejected(seq: seq, reason: "malformed")
            }
            let newName = object["newName"] as? String
            // `.rename` MUST carry a `newName`; every other op must NOT — a mismatch either
            // direction refuses rather than silently ignoring/inventing one (this frame's own
            // header: "refuses... rather than silently ignoring either mismatch").
            guard (op == .rename) == (newName != nil) else {
                return .rejected(seq: seq, reason: "malformed")
            }
            return .frame(.sheetsManageSheet(seq: seq, docId: docId, op: op, name: name, newName: newName))
        case "sheetsSetOk":
            guard let docId = object["docId"] as? String, let cellsWritten = intValue(object["cellsWritten"]) else {
                return .rejected(seq: seq, reason: "malformed")
            }
            return .frame(.sheetsSetOk(seq: seq, docId: docId, cellsWritten: cellsWritten))
        case "sheetsResizeOk":
            guard let docId = object["docId"] as? String,
                  let usedEndColumn = intValue(object["usedEndColumn"]),
                  let usedEndRow = intValue(object["usedEndRow"]) else {
                return .rejected(seq: seq, reason: "malformed")
            }
            return .frame(.sheetsResizeOk(seq: seq, docId: docId, usedEndColumn: usedEndColumn, usedEndRow: usedEndRow))
        case "sheetsManageSheetOk":
            guard let docId = object["docId"] as? String, let sheets = object["sheets"] as? [String] else {
                return .rejected(seq: seq, reason: "malformed")
            }
            return .frame(.sheetsManageSheetOk(seq: seq, docId: docId, sheets: sheets))
        default:
            // The type itself is unrecognized — the brief's exact case: error{seq,reason:"unknown"}.
            return .rejected(seq: seq, reason: "unknown")
        }
    }

    /// A non-negative whole number that fits a `UInt64`. Mirrors `EditorBridgeInbound.unsigned`'s
    /// discipline exactly (same file, same reasoning): `NSNumber`'s conditional cast to `UInt64`
    /// is value-preserving, so `-1`/`1.5` already answer `nil` on their own; the boolean check in
    /// front keeps a JSON `true` from arriving as `1`.
    private static func unsignedSeq(_ value: Any?) -> UInt64? {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else {
            return nil
        }
        return number as? UInt64
    }
}

/// Same NSNumber-boolean-trap discipline as `OfficeWireCodec.unsignedSeq` (same file, same
/// reasoning), for a plain (possibly negative) `Int`/`Int64` field — `parts`/twips coordinates are
/// not `seq`s, no non-negative constraint. Free top-level functions (not members of
/// `OfficeWireCodec`) so both `OfficeWireCodec.decodeInbound` and `OfficeDocumentEvent.decodeFields`
/// below can use them without either type reaching into the other's internals.
func intValue(_ value: Any?) -> Int? {
    guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
    return number as? Int
}
func int64Value(_ value: Any?) -> Int64? {
    guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
    return number as? Int64
}

/// Mints strictly increasing `seq` values for one connection's OUTBOUND frames, starting at 1
/// (never 0 — see `OfficeWireCodec.unreadableSeqSentinel`). Not thread-safe by itself; callers
/// that touch it from more than one queue must serialize (both `OfficeHelperServer`'s
/// per-connection handler and `OfficeWireConnection` already run their own frame traffic on one
/// queue each).
public final class OfficeWireSeqAllocator {
    private var next: UInt64 = 1
    public init() {}
    public func nextSeq() -> UInt64 {
        defer { next += 1 }
        return next
    }
}

/// A tiny `--flag value` CLI parser shared by `NormaOfficeHelper`'s real `main.swift` and the
/// test-only fixture's `main.swift` (`Tests/OfficeHelperFixtureSources`) — one implementation so
/// the two argument grammars cannot drift. Unknown/malformed tokens are ignored rather than
/// fatally erroring: both call sites already validate the specific flags THEY require and report
/// clearly on those (see each `main.swift`), so a stray argument here has somewhere better to be
/// caught than a generic parser.
///
/// A bare flag (no following value, or immediately followed by another `--flag`) maps to nothing
/// — checked explicitly, not merely "whatever happens to be next": every flag this repo's two
/// call sites actually use always carries a value, but a parser that instead swallowed the NEXT
/// flag's own name as if it were this flag's value would silently corrupt parsing the first time
/// either `main.swift` grows a genuine bare/boolean flag.
public enum OfficeWireArgs {
    public static func parse(_ arguments: [String]) -> [String: String] {
        var result: [String: String] = [:]
        var index = 0
        while index < arguments.count {
            let token = arguments[index]
            guard token.hasPrefix("--") else {
                index += 1
                continue
            }
            let key = String(token.dropFirst(2))
            if index + 1 < arguments.count, !arguments[index + 1].hasPrefix("--") {
                result[key] = arguments[index + 1]
                index += 2
            } else {
                index += 1 // bare flag: no value follows (or the next token is itself a flag)
            }
        }
        return result
    }
}
