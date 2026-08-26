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
    ///
    /// **`repair`** rides the slot's own `SfxBoolItem Repair SID_REPAIRPACKAGE` argument
    /// (`sfx2/sdi/sfx.sdi:4719-4720`, Redo's twin at `:3590-3591`). Its ONLY job is to skip the
    /// per-view refusal every app applies in LOK mode — Writer `basesh.cxx:649-664`, Impress
    /// `viewshel.cxx:1376-1394`, Calc `tabvwshb.cxx:746,773-778` — so an undo dispatched from THIS
    /// document's primary view can take back an edit made through the AGENT view. Defaults `false`,
    /// which is byte-for-byte the pre-repair frame (the encoder omits the key entirely, and the
    /// decoder reads an absent key as `false`), so every existing caller and every pinned wire
    /// fixture is unchanged by its addition.
    case undo(seq: UInt64, docId: String, repair: Bool = false)
    /// `.uno:Redo`, same posture as `undo` above — **including `repair`, which is not optional in
    /// practice**: a repair-undone action keeps its ORIGINAL `ViewShellId` when it moves to the redo
    /// stack, so the redo gates (`sw/…/docundo.cxx:523`, `sc/…/tabvwshb.cxx:778` with
    /// `bIsUndo == false`, `sd/…/viewshel.cxx:1455`) refuse a plain redo of it from any other view.
    /// A repair undo MUST be paired with a repair redo or ⌘⇧Z silently stops working right after an
    /// agent edit is taken back.
    case redo(seq: UInt64, docId: String, repair: Bool = false)
    /// **office-live-edit R3 — how deep this document's undo and redo stacks are.**
    /// `getCommandValues(".uno:UndoCount"/".uno:RedoCount")`, a synchronous query, NOT a dispatch
    /// and NOT a state notification. It exists so one ⌘Z can undo exactly the N actions ONE agent
    /// tool call created — the count is bracketed around the call, helper-side, and rides home in
    /// the reply. See `LOKBridge.undoDepthOnDedicatedThread` for why this is reachable at all when
    /// the slot/state layer has no stack introspection.
    case undoDepth(seq: UInt64, docId: String)
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
    /// office-finish Job 2 — N `sheetsManageSheet` operations in ONE request.
    ///
    /// **Why one request and not N.** The daemon's write deadline counts a fixed number of R-bounded
    /// requests (`packages/core/src/panel/office-commands.ts` §A: open/adopt + depth + edit + depth +
    /// save = H + 4R = 210 500 ms, shipped at 215 000). That budget is per TOOL CALL, not per
    /// operation, and §A item 4 states the batch's obligation in as many words: *"This same constant
    /// also covers requirement 2's batch, which rides ONE edit request however many operations it
    /// carries (the `sheets.set` 200-cell precedent) — so the batch surface does not need a number of
    /// its own and does not move this one again."* A batch built as N wire round trips would cost
    /// H + (N+3)R and blow that budget at N = 2. This frame is what keeps the promise.
    ///
    /// Operations apply IN ORDER and stop at the first failure — they are position-based and
    /// non-idempotent, so there is no other honest order and no way to skip one and continue. The
    /// reply's `applied` count is what turns the resulting prefix into something a model can
    /// reconcile; see `sheetsManageSheetBatchOk`.
    case sheetsManageSheetBatch(seq: UInt64, docId: String, ops: [OfficeSheetsManageSheetOperation])
    /// office-agent-tools T5 — applies `bold`/`italic`/`numberFormat`/`align`/`width` over one A1
    /// `range` on ONE named sheet, every field OPTIONAL and independent: a `nil` field means "leave
    /// this attribute alone," never "reset it to default" (spec: the whole contract this verb is
    /// built around). At least one of the five is guaranteed non-nil by the time this frame is built
    /// — `OfficeCommandConsumer.handleSheetsFormat`'s own job, not re-checked here (this wire's own
    /// established precedent: `sheetsSet`'s decode does not re-check `cellAddresses.count >= 1`
    /// either — a business rule the daemon/consumer already enforced, not a structural shape this
    /// layer re-derives).
    ///
    /// **`columnSpan` is a SEPARATE, already-formatted Name-Box-style span ("A:C"), present if and
    /// only if `width` is present** — `width` is a COLUMN property, not a cell one (unlike the other
    /// four), so it needs its OWN selection distinct from `range`'s own cell-range selection: a
    /// range like "B2:B5" only spans rows 2-5 of column B, but widening column B widens the WHOLE
    /// column. Built app-side (`officeColumnLetters`, the SAME conversion `sheetsResize`'s own
    /// `selectionRange` uses), never re-derived helper-side — the identical cross-target constraint
    /// every other real-A1-math field on this wire already carries (see `sheetsRead.range`'s own
    /// header). Decode refuses a mismatch (`columnSpan` present without `width`, or vice versa)
    /// rather than silently ignoring either — the same discipline `sheetsManageSheet`'s own
    /// `newName`/`op` pairing already established on this file.
    ///
    /// **`numberFormat` is a closed PRESET enum, not a free-form format-code string — a disclosed,
    /// deliberate narrowing from spec §2's generic operand name, not an oversight.** This task's own
    /// research read the vendored engine's real Execute handlers (`sc/source/ui/view/formatsh.cxx`)
    /// and confirmed two things primary-source, not guessed: (1) `.uno:NumberFormat` looks like the
    /// obvious candidate but is NOT a format code at all — it is a four-field comma tuple
    /// (`bThousand,bNegRed,precision,leadZeroes`) fed to `GenerateFormat()`; handing it a real code
    /// like `"0.00%"` would silently comma-split into garbage, a real wrong-result trap, not a
    /// refusal. (2) The command that DOES take a format — `.uno:NumberFormatValue` — takes a
    /// pre-registered NUMERIC KEY (`SfxUInt32Item`), and registering an arbitrary code to get that
    /// key is `XNumberFormats.queryKey`/`.addNew`, a UNO Property-API call with no `.uno:` slot of
    /// its own — confirmed UNREACHABLE by reading the vendored `LibreOfficeKit.h` this bridge
    /// actually links against (`Sources/OfficeKit/include/LibreOfficeKit.h`): the only command-shaped
    /// surface on `LibreOfficeKitDocumentClass` is `postUnoCommand`/`getCommandValues`/
    /// `setBlockedCommandList` — nothing reaches a UNO service's own methods. The closed preset set
    /// below rides the SAME fixed, argument-less toolbar commands a human's own Number Format
    /// toolbar section sends (`.uno:NumberFormatStandard`/`.../Number`/`.../Percent`/`.../Currency`/
    /// `.../Date`) — arguably MORE faithful to this task's own "the same `.uno:` commands a human
    /// toolbar would send" charge than an arbitrary string would have been, since an arbitrary code
    /// has no toolbar button at all, only the Format Cells DIALOG (a headless-hang risk this bridge
    /// already paid to learn to avoid — see `sheetsManageSheetOnDedicatedThread`'s own header).
    case sheetsFormat(seq: UInt64, docId: String, sheet: String, range: String, columnSpan: String?,
                      bold: Bool?, italic: Bool?, numberFormat: OfficeSheetsNumberFormatPreset?,
                      align: OfficeSheetsAlign?, width: Double?)

    // MARK: office-agent-tools T6 — slides

    /// Asks for `docId`'s slide count and, per slide, its own PART NAME (`getPartName` — never a
    /// placeholder-text extraction; `slidesRead` is the dedicated placeholder-text verb) and its
    /// layout, WHEN this bridge can determine one (see `OfficeSlideInfo`'s own header for the
    /// disclosed fail-closed posture on layout — this task found no live-confirmed way to query it
    /// for every LOK build, so a slide with an unknown layout reports `nil`, never a guess).
    /// Read-only. `setView` prefix (unconditional, matching `sheetsInfo`'s own discipline) because
    /// `getParts`/`getPartName`/`getPartInfo` read process-global-current-view-adjacent state the
    /// same way `sheetsInfo`'s own `getPart()` probe does.
    case slidesInfo(seq: UInt64, docId: String)
    /// Asks for ONE slide's title and body placeholder text. `slide` is 0-based (the app resolves the
    /// daemon's own 1-based `slide` operand before this frame is ever built — the identical
    /// resolve-at-the-app-boundary discipline `sheetsRead`'s own `sheet` name resolves to a part
    /// index at, see that case's own header).
    case slidesRead(seq: UInt64, docId: String, slide: Int)
    /// Writes `title` and/or `body` onto ONE slide's own placeholder(s) — each field independent,
    /// `nil` meaning "leave this placeholder alone," the identical absent-means-untouched contract
    /// `sheetsFormat`'s five attribute fields already established (that case's own header). At least
    /// one of the two is guaranteed non-nil by the time this frame is built (`slides.ts`'s own job,
    /// mirroring `sheetsFormat`'s identical "not re-checked here" precedent — a business rule the
    /// daemon/consumer already enforced, not a structural shape this wire layer re-derives).
    case slidesSetText(seq: UInt64, docId: String, slide: Int, title: String?, body: String?)
    /// office-agent-tools T6 — one wire pair covers all three structural verbs (`add_slide`/
    /// `delete_slide`/`reorder`), mirroring `sheetsManageSheet`'s own consolidation of `add_sheet`/
    /// `delete_sheet`/`rename_sheet` (that case's own header: "APP-INTERNAL wire, free to consolidate
    /// what the daemon-visible surface does not" — `office.slides.*`'s own three frozen
    /// `panel_command.action` strings are unaffected). `op` decides which of `slide`/`at`/`to`/
    /// `layout` are meaningful; decode refuses any OTHER combination rather than silently ignoring a
    /// mismatched field, the identical discipline `sheetsManageSheet`'s own `op == .rename <->
    /// newName != nil` guard and `sheetsFormat`'s own `columnSpan != nil <-> width != nil` guard
    /// already established on this file:
    ///  - `.add`: `slide` and `to` MUST be nil. `at` (0-based insert position; nil appends at the
    ///    end) and `layout` are each independently optional.
    ///  - `.delete`: `slide` MUST be non-nil (0-based, the slide to remove). `at`/`to`/`layout` MUST
    ///    all be nil.
    ///  - `.reorder`: `slide` and `to` MUST both be non-nil (0-based source and target). `at`/
    ///    `layout` MUST both be nil.
    case slidesManagePage(seq: UInt64, docId: String, op: OfficeSlidesManagePageOp, slide: Int?,
                          at: Int?, to: Int?, layout: OfficeSlidesLayoutPreset?)
    /// office-finish Job 2 — N `slidesManagePage` operations in ONE request. Identical shape,
    /// identical ordering/stop-at-first-failure contract and identical one-request reasoning as
    /// `sheetsManageSheetBatch` above; see that case's header.
    case slidesManagePageBatch(seq: UInt64, docId: String, ops: [OfficeSlidesManagePageOperation])

    // MARK: office-agent-tools T7 — docs

    /// Asks for `docId`'s page count and, derived from its own text, paragraph and character counts.
    /// Read-only. **The page count is `getParts()`** — for Writer, LOK's parts ARE pages
    /// (`SwXTextDocument::getParts` is `pWrtShell->GetPageCnt()`); there is no paragraph query in LOK
    /// at all, so `paragraphs` is derived from the SAME text `docsRead` returns rather than measured
    /// independently (`LOKBridge.docsParagraphCount`'s own header). That makes `docs info` cost a
    /// whole-document read, unlike `sheetsInfo` — see that function for why the cost is accepted.
    case docsInfo(seq: UInt64, docId: String)
    /// Asks for `docId`'s whole body text — UTF-8, paragraphs separated by `\n`. **No range**: LOK
    /// exposes no character- or paragraph-indexed addressing for Writer at all (research §3.5), so
    /// the daemon's own `fromParagraph`/`toParagraph` operands are a slice the APP takes over this
    /// text, never a range this frame could ask the engine for. Read-only.
    case docsRead(seq: UInt64, docId: String)
    /// Replaces EVERY literal, case-sensitive occurrence of `find` with `replaceWith`. `find` is
    /// guaranteed non-empty and free of `\n`/`\r` by the time this frame is built (the daemon's own
    /// job — see `docs.ts`; the same "a business rule the daemon already enforced" precedent
    /// `slidesSetText`'s own header names). There is no `all` field: v1 is REPLACE_ALL only, because
    /// `SvxSearchCmd::REPLACE` is not "replace the first occurrence" — see
    /// `LOKBridge.docsReplaceOnDedicatedThread`'s own header.
    case docsReplace(seq: UInt64, docId: String, find: String, replaceWith: String)
    /// Inserts `text` at the start or the end of the body. `atStart` picks the end;
    /// `asNewParagraph` prepends a paragraph break (suffixes one, for `atStart`) so that `append`
    /// starts a real new paragraph while `insert` puts exactly the text at the position and nothing
    /// else. Both flags are decided by the app from the daemon's `verb`/`at` operands, never guessed
    /// here.
    case docsInsert(seq: UInt64, docId: String, text: String, atStart: Bool, asNewParagraph: Bool)

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
    /// office-live-edit R3 — answers `undoDepth`. Unlike `undoOk` this IS a real answer about the
    /// document's state, not an ack of a dispatch: a query that could not be answered comes back
    /// as `.error`, never as a zero.
    case undoDepthOk(seq: UInt64, docId: String, undoCount: Int, redoCount: Int)
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
    /// office-finish Job 2 — answers a `sheetsManageSheetBatch`. **This is the per-operation
    /// ledger**, and it is a count rather than an array because the execution model is a strict
    /// prefix: operations run in order and stop at the first failure, so for a batch of N,
    ///
    ///  * operations `1 ... applied` APPLIED and were verified by re-read;
    ///  * operation `applied + 1` FAILED, and `failure` says why (nil iff `applied == N`);
    ///  * operations `applied + 2 ... N` were NOT ATTEMPTED.
    ///
    /// That is complete information about every operation, in two small fields that cannot approach
    /// the 64 KiB result cap (`PanelCommandConsumer.resultMaxLength`) — an over-cap result is refused
    /// whole and the model gets silence until the deadline, so a ledger that could grow with N was
    /// not an option.
    ///
    /// `sheets` is the workbook's real post-state sheet list, re-read after the LAST applied
    /// operation — the same "smallest useful truth" `sheetsManageSheetOk` returns, and what lets a
    /// caller reconcile a partial batch against what it intended without a second call.
    case sheetsManageSheetBatchOk(seq: UInt64, docId: String, sheets: [String], applied: Int, failure: String?)
    /// office-agent-tools T5 — answers a successful `sheetsFormat`: which attribute NAMES were
    /// actually applied (`"bold"`, `"italic"`, `"numberFormat"`, `"align"`, `"width"` — a subset of
    /// those five, in that fixed order, never empty since the caller must have named at least one).
    /// The smallest useful truth, same posture `sheetsManageSheetOk`'s sheet list already has — a
    /// caller can see exactly what landed without re-deriving it from its own request.
    case sheetsFormatOk(seq: UInt64, docId: String, applied: [String])

    // MARK: office-agent-tools T6 — slides replies

    /// Answers a successful `slidesInfo`.
    case slidesInfoOk(seq: UInt64, docId: String, slides: [OfficeSlideInfo])
    /// Answers a successful `slidesRead`. `nil` means "this slide has no such placeholder at all" —
    /// distinct from `""` ("the placeholder exists and is empty") — the identical distinction
    /// `sheetsInfo`'s own `(usedEndColumn: -1, usedEndRow: -1)` sentinel exists to make for an empty
    /// SHEET, applied here per-placeholder instead: a caller (and `slides.ts`'s own `set_text`
    /// refusal, spec's own "refuses naming the reason" contract) needs to tell "nothing to read" from
    /// "read an empty string" apart.
    case slidesReadOk(seq: UInt64, docId: String, title: String?, body: String?)
    /// Answers a successful `slidesSetText`: which of `title`/`body` actually applied — a subset of
    /// `["title","body"]`, in that fixed order — the identical "smallest useful truth" shape
    /// `sheetsFormatOk.applied` already returns for its own multi-optional-field write.
    case slidesSetTextOk(seq: UInt64, docId: String, applied: [String])
    /// Answers a successful `slidesManagePage`: the presentation's slide count AFTER the operation —
    /// the same "smallest useful truth, not merely ok" posture `sheetsResizeOk`/`sheetsManageSheetOk`
    /// already have for their own structural ops.
    case slidesManagePageOk(seq: UInt64, docId: String, slideCount: Int)
    /// office-finish Job 2 — answers a `slidesManagePageBatch`. Same prefix ledger as
    /// `sheetsManageSheetBatchOk` (see its header for what `applied`/`failure` mean); `slideCount` is
    /// the presentation's real post-state slide count after the last applied operation.
    case slidesManagePageBatchOk(seq: UInt64, docId: String, slideCount: Int, applied: Int, failure: String?)

    // MARK: office-agent-tools T7 — docs replies

    /// Answers a successful `docsInfo`. `pages` may UNDER-report on a document nothing has laid out
    /// yet (`SwRootFrame::GetPageNum()` returns the cached count of page frames currently
    /// constructed, and Writer paginates lazily) — disclosed in `docs.ts`'s own description rather
    /// than presented as exact.
    case docsInfoOk(seq: UInt64, docId: String, pages: Int, paragraphs: Int, characters: Int)
    /// Answers a successful `docsRead`: the whole body text. `""` is a legitimate answer (an empty
    /// document), never an error — `SwXTextDocument::getSelection()` always constructs a transferable
    /// for a live shell, so "nothing selected" surfaces as an empty string.
    case docsReadOk(seq: UInt64, docId: String, text: String)
    /// Answers a successful `docsReplace`: how many occurrences were replaced — **counted by us**,
    /// cross-checked against the engine's own boolean, never reported when the two disagree
    /// (`LOKBridge.docsReplaceOnDedicatedThread`).
    case docsReplaceOk(seq: UInt64, docId: String, replaced: Int)
    /// Answers a successful `docsInsert`: the document's paragraph count AFTER the insert — the same
    /// "smallest useful truth, not merely ok" posture `slidesManagePageOk` has.
    case docsInsertOk(seq: UInt64, docId: String, paragraphs: Int)

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
        "clipboardCopy", "clipboardCut", "clipboardPaste", "undo", "redo", "undoDepth", "createView", "agentKeyEvent",
        "subscribeTiles", "unsubscribe", "tileRequest",
        // office-agent-tools T3 — sheets info/read.
        "sheetsInfo", "sheetsRead",
        // office-agent-tools T4 — sheets write verbs.
        "sheetsSet", "sheetsResize", "sheetsManageSheet", "sheetsManageSheetBatch",
        // office-agent-tools T5 — sheets format.
        "sheetsFormat",
        // office-agent-tools T6 — slides.
        "slidesInfo", "slidesRead", "slidesSetText", "slidesManagePage", "slidesManagePageBatch",
        // office-agent-tools T7 — docs.
        "docsInfo", "docsRead", "docsReplace", "docsInsert",
        "helloOk", "refused", "pong", "opened", "openFailed", "closed", "saved", "saveFailed",
        "keyEventOk", "mouseEventOk", "extTextInputEventOk",
        "clipboardCopyOk", "clipboardCutOk", "clipboardPasteOk", "undoOk", "redoOk", "undoDepthOk",
        "agentViewReady", "agentKeyEventOk",
        "error", "documentEvent",
        "subscribed", "unsubscribed", "tileRequestAccepted", "tile", "tileFailed", "invalidated",
        "sheetsInfoOk", "sheetsReadOk",
        "sheetsSetOk", "sheetsResizeOk", "sheetsManageSheetOk", "sheetsManageSheetBatchOk",
        "sheetsFormatOk",
        "slidesInfoOk", "slidesReadOk", "slidesSetTextOk", "slidesManagePageOk", "slidesManagePageBatchOk",
        "docsInfoOk", "docsReadOk", "docsReplaceOk", "docsInsertOk",
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
        case .undoDepth: return "undoDepth"
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
        case .sheetsManageSheetBatch: return "sheetsManageSheetBatch"
        case .sheetsFormat: return "sheetsFormat"
        case .slidesInfo: return "slidesInfo"
        case .slidesRead: return "slidesRead"
        case .slidesSetText: return "slidesSetText"
        case .slidesManagePage: return "slidesManagePage"
        case .slidesManagePageBatch: return "slidesManagePageBatch"
        case .docsInfo: return "docsInfo"
        case .docsRead: return "docsRead"
        case .docsReplace: return "docsReplace"
        case .docsInsert: return "docsInsert"
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
        case .undoDepthOk: return "undoDepthOk"
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
        case .sheetsManageSheetBatchOk: return "sheetsManageSheetBatchOk"
        case .sheetsFormatOk: return "sheetsFormatOk"
        case .slidesInfoOk: return "slidesInfoOk"
        case .slidesReadOk: return "slidesReadOk"
        case .slidesSetTextOk: return "slidesSetTextOk"
        case .slidesManagePageOk: return "slidesManagePageOk"
        case .slidesManagePageBatchOk: return "slidesManagePageBatchOk"
        case .docsInfoOk: return "docsInfoOk"
        case .docsReadOk: return "docsReadOk"
        case .docsReplaceOk: return "docsReplaceOk"
        case .docsInsertOk: return "docsInsertOk"
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
        case .undo(let seq, _, _): return seq
        case .redo(let seq, _, _): return seq
        case .undoDepth(let seq, _): return seq
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
        case .sheetsManageSheetBatch(let seq, _, _): return seq
        case .sheetsFormat(let seq, _, _, _, _, _, _, _, _, _): return seq
        case .slidesInfo(let seq, _): return seq
        case .slidesRead(let seq, _, _): return seq
        case .slidesSetText(let seq, _, _, _, _): return seq
        case .slidesManagePage(let seq, _, _, _, _, _, _): return seq
        case .slidesManagePageBatch(let seq, _, _): return seq
        case .docsInfo(let seq, _): return seq
        case .docsRead(let seq, _): return seq
        case .docsReplace(let seq, _, _, _): return seq
        case .docsInsert(let seq, _, _, _, _): return seq
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
        case .undoDepthOk(let seq, _, _, _): return seq
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
        case .sheetsManageSheetBatchOk(let seq, _, _, _, _): return seq
        case .sheetsFormatOk(let seq, _, _): return seq
        case .slidesInfoOk(let seq, _, _): return seq
        case .slidesReadOk(let seq, _, _, _): return seq
        case .slidesSetTextOk(let seq, _, _): return seq
        case .slidesManagePageOk(let seq, _, _): return seq
        case .slidesManagePageBatchOk(let seq, _, _, _, _): return seq
        case .docsInfoOk(let seq, _, _, _, _): return seq
        case .docsReadOk(let seq, _, _): return seq
        case .docsReplaceOk(let seq, _, _): return seq
        case .docsInsertOk(let seq, _, _): return seq
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
        case .createView(_, let docId), .undoDepth(_, let docId):
            payload["docId"] = docId
        case .undoDepthOk(_, let docId, let undoCount, let redoCount):
            payload["docId"] = docId
            payload["undoCount"] = undoCount
            payload["redoCount"] = redoCount
        case .undo(_, let docId, let repair), .redo(_, let docId, let repair):
            payload["docId"] = docId
            // Emitted ONLY when true. An always-present `"repair":false` would change the bytes of
            // every undo frame this bridge has ever sent and red the pinned wire fixtures for no
            // behavioural gain — the decoder already reads an absent key as `false`.
            if repair { payload["repair"] = true }
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
        case .sheetsManageSheetBatch(_, let docId, let ops):
            payload["docId"] = docId
            payload["ops"] = ops.map { $0.jsonObject() }
        case .sheetsFormat(_, let docId, let sheet, let range, let columnSpan, let bold, let italic,
                           let numberFormat, let align, let width):
            payload["docId"] = docId
            payload["sheet"] = sheet
            payload["range"] = range
            if let columnSpan { payload["columnSpan"] = columnSpan }
            if let bold { payload["bold"] = bold }
            if let italic { payload["italic"] = italic }
            if let numberFormat { payload["numberFormat"] = numberFormat.rawValue }
            if let align { payload["align"] = align.rawValue }
            if let width { payload["width"] = width }
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
        case .sheetsManageSheetBatchOk(_, let docId, let sheets, let applied, let failure):
            payload["docId"] = docId
            payload["sheets"] = sheets
            payload["applied"] = applied
            if let failure { payload["failure"] = failure }
        case .sheetsFormatOk(_, let docId, let applied):
            payload["docId"] = docId
            payload["applied"] = applied
        case .slidesInfo(_, let docId):
            payload["docId"] = docId
        case .slidesRead(_, let docId, let slide):
            payload["docId"] = docId
            payload["slide"] = slide
        case .slidesSetText(_, let docId, let slide, let title, let body):
            payload["docId"] = docId
            payload["slide"] = slide
            if let title { payload["title"] = title }
            if let body { payload["body"] = body }
        case .slidesManagePage(_, let docId, let op, let slide, let at, let to, let layout):
            payload["docId"] = docId
            payload["op"] = op.rawValue
            if let slide { payload["slide"] = slide }
            if let at { payload["at"] = at }
            if let to { payload["to"] = to }
            if let layout { payload["layout"] = layout.rawValue }
        case .slidesManagePageBatch(_, let docId, let ops):
            payload["docId"] = docId
            payload["ops"] = ops.map { $0.jsonObject() }
        case .slidesInfoOk(_, let docId, let slides):
            payload["docId"] = docId
            payload["slides"] = slides.map { $0.jsonObject() }
        case .slidesReadOk(_, let docId, let title, let body):
            payload["docId"] = docId
            if let title { payload["title"] = title }
            if let body { payload["body"] = body }
        case .slidesSetTextOk(_, let docId, let applied):
            payload["docId"] = docId
            payload["applied"] = applied
        case .slidesManagePageOk(_, let docId, let slideCount):
            payload["docId"] = docId
            payload["slideCount"] = slideCount
        case .slidesManagePageBatchOk(_, let docId, let slideCount, let applied, let failure):
            payload["docId"] = docId
            payload["slideCount"] = slideCount
            payload["applied"] = applied
            if let failure { payload["failure"] = failure }
        case .docsInfo(_, let docId), .docsRead(_, let docId):
            payload["docId"] = docId
        case .docsReplace(_, let docId, let find, let replaceWith):
            payload["docId"] = docId
            payload["find"] = find
            payload["replaceWith"] = replaceWith
        case .docsInsert(_, let docId, let text, let atStart, let asNewParagraph):
            payload["docId"] = docId
            payload["text"] = text
            payload["atStart"] = atStart
            payload["asNewParagraph"] = asNewParagraph
        case .docsInfoOk(_, let docId, let pages, let paragraphs, let characters):
            payload["docId"] = docId
            payload["pages"] = pages
            payload["paragraphs"] = paragraphs
            payload["characters"] = characters
        case .docsReadOk(_, let docId, let text):
            payload["docId"] = docId
            payload["text"] = text
        case .docsReplaceOk(_, let docId, let replaced):
            payload["docId"] = docId
            payload["replaced"] = replaced
        case .docsInsertOk(_, let docId, let paragraphs):
            payload["docId"] = docId
            payload["paragraphs"] = paragraphs
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

    /// office-agent-tools T6 — `slidesInfoOk.slides`, mirroring `decodeSheetInfos` exactly.
    static func decodeSlideInfos(_ object: Any?) -> [OfficeSlideInfo]? {
        guard let array = object as? [[String: Any]] else { return nil }
        var slides: [OfficeSlideInfo] = []
        slides.reserveCapacity(array.count)
        for item in array {
            guard let slide = OfficeSlideInfo.decode(item) else { return nil }
            slides.append(slide)
        }
        return slides
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

/// office-agent-tools T6 — one slide's own facts, as `slidesInfoOk` reports them: its own PART NAME
/// (`getPartName`) and its title placeholder text, when one exists.
///
/// **`name` is NOT a title — controller ruling 2, slides-lok-research.md §7.** `SdPage::GetName()`
/// (`sd/source/core/sdpage.cxx:2648-2695`) returns a user-set real name UNCONDITIONALLY when one was
/// ever set, but for a NEVER-RENAMED page it computes a positional default LIVE, on every call:
/// `"Slide " + currentPageNumber`. For an untitled deck, `name` is just a restatement of the index,
/// recomputed fresh after every reorder — never a title, never stable identity for a renamed-vs-not
/// slide the caller can't otherwise distinguish. `slides.ts`'s own tool description says this
/// plainly, not just this doc comment: every verb targets a slide BY INDEX ONLY, never by `name`.
///
/// **`title` is genuinely `nil`-able, and NOT the same "unknown, might exist" fail-closed posture
/// `layout` used to have here.** The mechanism `LOKBridge.slidesInfoOnDedicatedThread` uses to read it
/// is the SAME one `slidesRead` uses (see that case's own header) — `nil` means this slide's title
/// placeholder genuinely does not exist, `""` means it exists and is empty, exactly the distinction
/// `slidesReadOk` already draws for the identical reason.
///
/// **`layout` was REMOVED from this struct — controller ruling 1, research §3.** `getPartInfo` (the
/// only LOK-side per-part JSON) carries no layout field at either of its two emission sites, and no
/// `getCommandValues` query exposes one either: LOK gives NO layout read-back at all, ever, for any
/// slide. `add_slide`'s own `layout` operand is write-only by necessity, not by this bridge's own
/// choice to narrow it — there was never a wire shape to design here that could have reported one.
public struct OfficeSlideInfo: Equatable, Sendable {
    public let name: String
    public let title: String?
    public init(name: String, title: String?) {
        self.name = name
        self.title = title
    }

    func jsonObject() -> [String: Any] {
        var object: [String: Any] = ["name": name]
        if let title { object["title"] = title }
        return object
    }

    static func decode(_ object: [String: Any]) -> OfficeSlideInfo? {
        guard let name = object["name"] as? String else { return nil }
        return OfficeSlideInfo(name: name, title: object["title"] as? String)
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

/// office-finish Job 2 — the caps a BATCH of position-based operations is bounded by, on BOTH ends
/// of this wire. Two independent ceilings, each computed rather than picked:
///
/// * `maxOperationsPerBatch` is a TIME bound. A batch is deliberately ONE wire request carrying N
///   operations (see `sheetsManageSheetBatch`'s own header for why it must be), so the whole batch
///   lives inside ONE `requestTimeout` — 30 s (`OfficeHelperSupervisor.Configuration
///   .handshakeTimeout`, reused as `requestTimeout`). N is therefore capped so that N × the measured
///   per-operation cost stays far below 30 s, not merely under it. See
///   `.superpowers/research/office-finish-report.md` for the measurement this number is set from.
/// * The BYTE bound is the daemon's, not this file's: `PANEL_COMMAND_ARGS_MAX_JSON_BYTES` (8 KiB,
///   `packages/protocol/src/events.ts`) caps the serialized `args`, and the tool refuses over-size
///   batches with a specific message BEFORE dispatch rather than letting the wire's own `.refine`
///   produce an opaque schema error. It is stated here so the two are findable together; enforcing
///   it here would be too late to say anything useful.
///
/// A batch is never empty: an empty `ops` is malformed, not a no-op that reports success.
public enum OfficeWireBatchLimits {
    public static let maxOperationsPerBatch = 20
}

/// office-finish Job 2 — ONE operation inside a `sheetsManageSheetBatch`. The exact operand triple
/// the single-op `sheetsManageSheet` frame already carries, with the identical `op == .rename` <->
/// `newName != nil` pairing rule enforced at decode — per element, so a malformed element refuses
/// the WHOLE batch rather than being skipped (a skipped op reported as success is the
/// silent-wrong-answer outcome this arc rates as worse than a crash).
public struct OfficeSheetsManageSheetOperation: Equatable, Sendable {
    public let op: OfficeSheetsManageSheetOp
    public let name: String
    public let newName: String?

    public init(op: OfficeSheetsManageSheetOp, name: String, newName: String?) {
        self.op = op
        self.name = name
        self.newName = newName
    }

    func jsonObject() -> [String: Any] {
        var object: [String: Any] = ["op": op.rawValue, "name": name]
        if let newName { object["newName"] = newName }
        return object
    }

    static func decode(_ object: [String: Any]) -> OfficeSheetsManageSheetOperation? {
        guard let opRaw = object["op"] as? String, let op = OfficeSheetsManageSheetOp(rawValue: opRaw),
              let name = object["name"] as? String else { return nil }
        let newName = object["newName"] as? String
        guard (op == .rename) == (newName != nil) else { return nil }
        return OfficeSheetsManageSheetOperation(op: op, name: name, newName: newName)
    }
}

/// office-finish Job 2 — ONE operation inside a `slidesManagePageBatch`, carrying the same operand
/// set (and the same per-op combination rules) the single-op `slidesManagePage` frame already
/// defines: `.add` may carry `at`/`layout` and must not carry `slide`/`to`; `.delete` must carry
/// `slide` and nothing else; `.reorder` must carry `slide` and `to` and nothing else. Enforced per
/// element at decode, for the same reason the sheets element enforces its own.
public struct OfficeSlidesManagePageOperation: Equatable, Sendable {
    public let op: OfficeSlidesManagePageOp
    public let slide: Int?
    public let at: Int?
    public let to: Int?
    public let layout: OfficeSlidesLayoutPreset?

    public init(op: OfficeSlidesManagePageOp, slide: Int?, at: Int?, to: Int?,
                layout: OfficeSlidesLayoutPreset?) {
        self.op = op
        self.slide = slide
        self.at = at
        self.to = to
        self.layout = layout
    }

    func jsonObject() -> [String: Any] {
        var object: [String: Any] = ["op": op.rawValue]
        if let slide { object["slide"] = slide }
        if let at { object["at"] = at }
        if let to { object["to"] = to }
        if let layout { object["layout"] = layout.rawValue }
        return object
    }

    static func decode(_ object: [String: Any]) -> OfficeSlidesManagePageOperation? {
        guard let opRaw = object["op"] as? String,
              let op = OfficeSlidesManagePageOp(rawValue: opRaw) else { return nil }
        let slide = intValue(object["slide"])
        let at = intValue(object["at"])
        let to = intValue(object["to"])
        // A `slide`/`at`/`to` KEY that is present but not integer-shaped is malformed — never folded
        // into "absent". `intValue` answers a wrong type and an absent key with the same `nil`, so
        // presence has to be checked separately, exactly as `OfficeCommandConsumer.isPresent` does
        // one layer up.
        for key in ["slide", "at", "to"] where object[key] != nil && intValue(object[key]) == nil {
            return nil
        }
        let layout: OfficeSlidesLayoutPreset?
        if let raw = object["layout"] as? String {
            guard let parsed = OfficeSlidesLayoutPreset(rawValue: raw) else { return nil }
            layout = parsed
        } else if object["layout"] != nil {
            return nil
        } else {
            layout = nil
        }
        switch op {
        case .add: guard slide == nil, to == nil else { return nil }
        case .delete: guard slide != nil, at == nil, to == nil, layout == nil else { return nil }
        case .reorder: guard slide != nil, to != nil, at == nil, layout == nil else { return nil }
        }
        return OfficeSlidesManagePageOperation(op: op, slide: slide, at: at, to: to, layout: layout)
    }
}

/// `sheetsManageSheet`'s operation.
public enum OfficeSheetsManageSheetOp: String, Equatable, Sendable {
    case add
    case delete
    case rename
}

/// office-agent-tools T5 — `sheetsFormat`'s horizontal alignment. Same strict-enum, refuse-don't-
/// default-on-unrecognized discipline as `OfficeSheetsResizeDimension`/`Op` above. v1 has no
/// vertical-alignment case — not exposed, not planned for this pass (`sheets.ts`'s own doc says so).
// F3: `CaseIterable` so the consumer's refusal can NAME the legal set instead of hand-listing
// it — a hand-listed set is a second source of truth that drifts the moment a case is added.
public enum OfficeSheetsAlign: String, Equatable, Sendable, CaseIterable {
    case left
    case center
    case right
}

/// office-agent-tools T5 — `sheetsFormat`'s number-format PRESET (a closed set, not an arbitrary
/// format-code string — see `sheetsFormat`'s own case header for the full, source-grounded reasoning
/// this narrowing rests on). `general` doubles as both the caller's own "clear back to the default
/// format" request AND this bridge's own internal normalizer for every OTHER preset, if the preset
/// commands turn out to TOGGLE rather than set an absolute state (see `LOKBridge
/// .sheetsFormatOnDedicatedThread`'s own header for which one this engine build actually is).
// F3: `CaseIterable` so the consumer's refusal can NAME the legal set instead of hand-listing
// it — a hand-listed set is a second source of truth that drifts the moment a case is added.
public enum OfficeSheetsNumberFormatPreset: String, Equatable, Sendable, CaseIterable {
    case general
    case number
    case percent
    case currency
    case date
}

// MARK: - office-agent-tools T6 — the slides wire's own strict enums

/// `slidesManagePage`'s operation. Same refuse-don't-default-on-unrecognized discipline as
/// `OfficeSheetsResizeOp`/`OfficeSheetsManageSheetOp` above.
public enum OfficeSlidesManagePageOp: String, Equatable, Sendable {
    case add
    case delete
    case reorder
}

/// `add_slide`'s own `layout` preset — WRITE-ONLY (slides-lok-research.md §3/ruling 1: `getPartInfo`
/// carries no layout field at either JSON-emission site, and no `getCommandValues` query exposes one
/// either — LOK gives no layout READ-BACK at all, so this preset only ever flows INTO a document via
/// `.uno:AssignLayout`, never back out through `slidesInfo`). A CLOSED enum, not LOK's raw numeric
/// `AutoLayout` id (35 values, `include/xmloff/autolayout.hxx`) or a free-form name — mirroring
/// `OfficeSheetsNumberFormatPreset`'s own precedent. These 16 are the exact UI-EXPOSED subset the
/// vendored product's own `simpress/popupmenu/page.xml` `SlideLayoutMenu` offers a human (research
/// §4) — not the full internal enum, and not guessed: every raw integer below is cited to that XML's
/// own `WhatLayout:long=` values. Raw string values are snake_case to match `slides.ts`'s own zod
/// enum verbatim — this is a WIRE string, decoded on both ends independently, so the two must agree
/// byte-for-byte.
public enum OfficeSlidesLayoutPreset: String, Equatable, Sendable {
    case titleSlide = "title_slide"                     // AutoLayout 0
    case titleContent = "title_content"                 // AutoLayout 1
    case titleTwoContent = "title_two_content"           // AutoLayout 3
    case titleContentTwoContent = "title_content_two_content"           // AutoLayout 12
    case titleContentOverContent = "title_content_over_content"         // AutoLayout 14
    case titleTwoContentContent = "title_two_content_content"           // AutoLayout 15
    case titleTwoContentOverContent = "title_two_content_over_content"  // AutoLayout 16
    case titleFourContent = "title_four_content"         // AutoLayout 18
    case titleOnly = "title_only"                        // AutoLayout 19
    case blank = "blank"                                 // AutoLayout 20
    case verticalTitleVerticalContentOverVerticalContent = "vertical_title_vertical_content_over_vertical_content" // AutoLayout 27
    case verticalTitleVerticalContent = "vertical_title_vertical_content"   // AutoLayout 28
    case titleVerticalContent = "title_vertical_content"                   // AutoLayout 29
    case titleTwoVerticalContent = "title_two_vertical_content"            // AutoLayout 30
    case centeredText = "centered_text"                  // AutoLayout 32
    case titleSixContent = "title_six_content"           // AutoLayout 34

    /// The real LOK `AutoLayout` integer this preset maps to — `.uno:AssignLayout`'s own `WhatLayout`
    /// argument (`SfxUInt32Item`, `sd/sdi/sdraw.sdi:2137-2138`). Never invented, never the full
    /// 35-value internal enum — see this type's own header for the citation.
    public var autoLayoutValue: Int {
        switch self {
        case .titleSlide: return 0
        case .titleContent: return 1
        case .titleTwoContent: return 3
        case .titleContentTwoContent: return 12
        case .titleContentOverContent: return 14
        case .titleTwoContentContent: return 15
        case .titleTwoContentOverContent: return 16
        case .titleFourContent: return 18
        case .titleOnly: return 19
        case .blank: return 20
        case .verticalTitleVerticalContentOverVerticalContent: return 27
        case .verticalTitleVerticalContent: return 28
        case .titleVerticalContent: return 29
        case .titleTwoVerticalContent: return 30
        case .centeredText: return 32
        case .titleSixContent: return 34
        }
    }
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
            // ABSENT means `false` — the pre-repair frame shape, which every pinned fixture and
            // every shipped caller still emits. A PRESENT-but-wrong-typed `repair` is NOT silently
            // read as absent: it is malformed, and refused. Reading `"true"` (a string) as `false`
            // would be this arc's own silent-wrong-answer class on the one operand that decides
            // whether an undo may cross views — and a repair undo that quietly declines to cross is
            // indistinguishable, at every layer above, from an undo that had nothing to do.
            guard let undoRepair = decodedRepairFlag(object) else {
                return .rejected(seq: seq, reason: "malformed")
            }
            return .frame(.undo(seq: seq, docId: docId, repair: undoRepair))
        case "redo":
            guard let docId = object["docId"] as? String else {
                return .rejected(seq: seq, reason: "malformed")
            }
            guard let redoRepair = decodedRepairFlag(object) else {
                return .rejected(seq: seq, reason: "malformed")
            }
            return .frame(.redo(seq: seq, docId: docId, repair: redoRepair))
        case "createView":
            guard let docId = object["docId"] as? String else {
                return .rejected(seq: seq, reason: "malformed")
            }
            return .frame(.createView(seq: seq, docId: docId))
        case "undoDepth":
            guard let docId = object["docId"] as? String else {
                return .rejected(seq: seq, reason: "malformed")
            }
            return .frame(.undoDepth(seq: seq, docId: docId))
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
        case "undoDepthOk":
            // `intValue` (not `as? Int`) for the same NSNumber-boolean reason every other numeric
            // field on this wire uses it: `true` satisfies a bare `as? Int`.
            guard let docId = object["docId"] as? String,
                  let undoCount = intValue(object["undoCount"]),
                  let redoCount = intValue(object["redoCount"]), undoCount >= 0, redoCount >= 0 else {
                return .rejected(seq: seq, reason: "malformed")
            }
            return .frame(.undoDepthOk(seq: seq, docId: docId, undoCount: undoCount, redoCount: redoCount))
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
        case "sheetsManageSheetBatch":
            guard let docId = object["docId"] as? String,
                  let ops = decodeBatchOps(object["ops"], OfficeSheetsManageSheetOperation.decode) else {
                return .rejected(seq: seq, reason: "malformed")
            }
            return .frame(.sheetsManageSheetBatch(seq: seq, docId: docId, ops: ops))
        case "sheetsFormat":
            guard let docId = object["docId"] as? String, let sheet = object["sheet"] as? String,
                  let range = object["range"] as? String else {
                return .rejected(seq: seq, reason: "malformed")
            }
            let columnSpan = object["columnSpan"] as? String
            let bold = object["bold"] as? Bool
            let italic = object["italic"] as? Bool
            let align = (object["align"] as? String).flatMap(OfficeSheetsAlign.init(rawValue:))
            let width = doubleValue(object["width"])
            // A `numberFormat` KEY present but unrecognized is malformed (the strict-enum discipline
            // every other new-in-this-file string field already has) — distinct from the key being
            // ABSENT, which is a legitimate `nil` (this attribute untouched).
            let numberFormat: OfficeSheetsNumberFormatPreset?
            if let raw = object["numberFormat"] as? String {
                guard let parsed = OfficeSheetsNumberFormatPreset(rawValue: raw) else {
                    return .rejected(seq: seq, reason: "malformed")
                }
                numberFormat = parsed
            } else {
                numberFormat = nil
            }
            // `columnSpan` present iff `width` present — same paired-field discipline
            // `sheetsManageSheet`'s own `op == .rename` <-> `newName != nil` guard already established
            // on this file (that case's own header).
            guard (columnSpan != nil) == (width != nil) else {
                return .rejected(seq: seq, reason: "malformed")
            }
            return .frame(.sheetsFormat(seq: seq, docId: docId, sheet: sheet, range: range,
                                        columnSpan: columnSpan, bold: bold, italic: italic,
                                        numberFormat: numberFormat, align: align, width: width))
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
        case "sheetsManageSheetBatchOk":
            guard let docId = object["docId"] as? String, let sheets = object["sheets"] as? [String],
                  let applied = intValue(object["applied"]), applied >= 0 else {
                return .rejected(seq: seq, reason: "malformed")
            }
            let failure = object["failure"] as? String
            guard object["failure"] == nil || failure != nil else { return .rejected(seq: seq, reason: "malformed") }
            return .frame(.sheetsManageSheetBatchOk(seq: seq, docId: docId, sheets: sheets,
                                                    applied: applied, failure: failure))
        case "sheetsFormatOk":
            guard let docId = object["docId"] as? String, let applied = object["applied"] as? [String] else {
                return .rejected(seq: seq, reason: "malformed")
            }
            return .frame(.sheetsFormatOk(seq: seq, docId: docId, applied: applied))
        case "slidesInfo":
            guard let docId = object["docId"] as? String else {
                return .rejected(seq: seq, reason: "malformed")
            }
            return .frame(.slidesInfo(seq: seq, docId: docId))
        case "slidesRead":
            guard let docId = object["docId"] as? String, let slide = intValue(object["slide"]) else {
                return .rejected(seq: seq, reason: "malformed")
            }
            return .frame(.slidesRead(seq: seq, docId: docId, slide: slide))
        case "slidesSetText":
            guard let docId = object["docId"] as? String, let slide = intValue(object["slide"]) else {
                return .rejected(seq: seq, reason: "malformed")
            }
            return .frame(.slidesSetText(seq: seq, docId: docId, slide: slide,
                                         title: object["title"] as? String, body: object["body"] as? String))
        case "slidesManagePage":
            guard let docId = object["docId"] as? String,
                  let opRaw = object["op"] as? String, let op = OfficeSlidesManagePageOp(rawValue: opRaw) else {
                return .rejected(seq: seq, reason: "malformed")
            }
            let slide = intValue(object["slide"])
            let at = intValue(object["at"])
            let to = intValue(object["to"])
            let layout: OfficeSlidesLayoutPreset?
            if let raw = object["layout"] as? String {
                guard let parsed = OfficeSlidesLayoutPreset(rawValue: raw) else {
                    return .rejected(seq: seq, reason: "malformed")
                }
                layout = parsed
            } else {
                layout = nil
            }
            // Per-op paired-field guard — this case's own header states the contract; a mismatch
            // refuses rather than silently ignoring an inapplicable field, the same discipline
            // `sheetsManageSheet`/`sheetsFormat`'s own paired-field guards already established.
            let shapeIsValid: Bool
            switch op {
            case .add: shapeIsValid = slide == nil && to == nil
            case .delete: shapeIsValid = slide != nil && at == nil && to == nil && layout == nil
            case .reorder: shapeIsValid = slide != nil && to != nil && at == nil && layout == nil
            }
            guard shapeIsValid else { return .rejected(seq: seq, reason: "malformed") }
            return .frame(.slidesManagePage(seq: seq, docId: docId, op: op, slide: slide, at: at, to: to, layout: layout))
        case "slidesManagePageBatch":
            guard let docId = object["docId"] as? String,
                  let ops = decodeBatchOps(object["ops"], OfficeSlidesManagePageOperation.decode) else {
                return .rejected(seq: seq, reason: "malformed")
            }
            return .frame(.slidesManagePageBatch(seq: seq, docId: docId, ops: ops))
        case "slidesInfoOk":
            guard let docId = object["docId"] as? String,
                  let slides = OfficeWireFrame.decodeSlideInfos(object["slides"]) else {
                return .rejected(seq: seq, reason: "malformed")
            }
            return .frame(.slidesInfoOk(seq: seq, docId: docId, slides: slides))
        case "slidesReadOk":
            guard let docId = object["docId"] as? String else {
                return .rejected(seq: seq, reason: "malformed")
            }
            return .frame(.slidesReadOk(seq: seq, docId: docId,
                                        title: object["title"] as? String, body: object["body"] as? String))
        case "slidesSetTextOk":
            guard let docId = object["docId"] as? String, let applied = object["applied"] as? [String] else {
                return .rejected(seq: seq, reason: "malformed")
            }
            return .frame(.slidesSetTextOk(seq: seq, docId: docId, applied: applied))
        case "slidesManagePageOk":
            guard let docId = object["docId"] as? String, let slideCount = intValue(object["slideCount"]) else {
                return .rejected(seq: seq, reason: "malformed")
            }
            return .frame(.slidesManagePageOk(seq: seq, docId: docId, slideCount: slideCount))
        case "slidesManagePageBatchOk":
            guard let docId = object["docId"] as? String, let slideCount = intValue(object["slideCount"]),
                  let applied = intValue(object["applied"]), applied >= 0 else {
                return .rejected(seq: seq, reason: "malformed")
            }
            let failure = object["failure"] as? String
            guard object["failure"] == nil || failure != nil else { return .rejected(seq: seq, reason: "malformed") }
            return .frame(.slidesManagePageBatchOk(seq: seq, docId: docId, slideCount: slideCount,
                                                   applied: applied, failure: failure))
        case "docsInfo":
            guard let docId = object["docId"] as? String else { return .rejected(seq: seq, reason: "malformed") }
            return .frame(.docsInfo(seq: seq, docId: docId))
        case "docsRead":
            guard let docId = object["docId"] as? String else { return .rejected(seq: seq, reason: "malformed") }
            return .frame(.docsRead(seq: seq, docId: docId))
        case "docsReplace":
            // `find` non-empty and newline-free is re-checked HERE, not merely trusted from the
            // daemon: an empty `find` would make our own occurrence count 0 while the engine's
            // behaviour on an empty search string is unspecified from source, and a `find` spanning a
            // paragraph break can never match (the engine's matcher does not cross a paragraph node)
            // while OUR literal count over `\n`-joined text happily would — a guaranteed
            // count/engine divergence, i.e. a guaranteed trip of the ruling-1 tripwire, on input a
            // model can produce by accident. Refused at the wire rather than discovered mid-verb.
            guard let docId = object["docId"] as? String,
                  let find = object["find"] as? String, !find.isEmpty,
                  !find.contains("\n"), !find.contains("\r"),
                  let replaceWith = object["replaceWith"] as? String,
                  !replaceWith.contains("\n"), !replaceWith.contains("\r") else {
                return .rejected(seq: seq, reason: "malformed")
            }
            return .frame(.docsReplace(seq: seq, docId: docId, find: find, replaceWith: replaceWith))
        case "docsInsert":
            guard let docId = object["docId"] as? String,
                  let text = object["text"] as? String, !text.isEmpty,
                  let atStart = object["atStart"] as? Bool,
                  let asNewParagraph = object["asNewParagraph"] as? Bool else {
                return .rejected(seq: seq, reason: "malformed")
            }
            return .frame(.docsInsert(seq: seq, docId: docId, text: text, atStart: atStart,
                                      asNewParagraph: asNewParagraph))
        case "docsInfoOk":
            guard let docId = object["docId"] as? String, let pages = intValue(object["pages"]),
                  let paragraphs = intValue(object["paragraphs"]),
                  let characters = intValue(object["characters"]) else {
                return .rejected(seq: seq, reason: "malformed")
            }
            return .frame(.docsInfoOk(seq: seq, docId: docId, pages: pages, paragraphs: paragraphs,
                                      characters: characters))
        case "docsReadOk":
            guard let docId = object["docId"] as? String, let text = object["text"] as? String else {
                return .rejected(seq: seq, reason: "malformed")
            }
            return .frame(.docsReadOk(seq: seq, docId: docId, text: text))
        case "docsReplaceOk":
            guard let docId = object["docId"] as? String, let replaced = intValue(object["replaced"]) else {
                return .rejected(seq: seq, reason: "malformed")
            }
            return .frame(.docsReplaceOk(seq: seq, docId: docId, replaced: replaced))
        case "docsInsertOk":
            guard let docId = object["docId"] as? String, let paragraphs = intValue(object["paragraphs"]) else {
                return .rejected(seq: seq, reason: "malformed")
            }
            return .frame(.docsInsertOk(seq: seq, docId: docId, paragraphs: paragraphs))
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
/// office-agent-tools T5 — same NSNumber-boolean-trap discipline as `intValue`/`int64Value` above,
/// for `sheetsFormat.width` (points — a fractional value, unlike every other numeric field this wire
/// has carried so far, which is why this helper did not already exist).
func doubleValue(_ value: Any?) -> Double? {
    guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
    return number as? Double
}

/// The `repair` flag on `undo`/`redo`, decoded with the SAME NSNumber discipline `intValue` uses,
/// pointed the other way: a real JSON boolean is exactly an `NSNumber` whose CoreFoundation type id
/// IS `CFBooleanGetTypeID()`. Without that check `"repair": 1` — a NUMBER — would satisfy a plain
/// `as? Bool` and silently arm cross-view undo, which is the same trap `intValue` exists to close
/// from the other side (`true` satisfying `as? Int`).
///
/// Three-way on purpose, and the three are NOT interchangeable:
/// - key ABSENT → `false`. The pre-repair frame shape; every shipped caller and every pinned wire
///   fixture still emits it, and they must keep decoding to the identical frame.
/// - key present and a real boolean → that value.
/// - key present and ANYTHING else → `nil`, which the caller turns into `.rejected(reason:
///   "malformed")`. Deliberately NOT folded into the absent case: a caller that meant `"true"` and
///   got a plain non-repair undo would see the wire's own success reply and a document that did not
///   change — this bridge cannot tell those apart afterwards (`undoOk` acks the DISPATCH, never the
///   effect), so the only place the mistake is still visible is here.
func decodedRepairFlag(_ object: [String: Any]) -> Bool? {
    guard let raw = object["repair"] else { return false }
    guard let number = raw as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else { return nil }
    return number.boolValue
}

/// Mints strictly increasing `seq` values for one connection's OUTBOUND frames, starting at 1
/// (never 0 — see `OfficeWireCodec.unreadableSeqSentinel`).
///
/// **office-finish Job 1 — now lock-guarded, and the previous header's exemption was false.** It
/// read: *"Not thread-safe by itself; callers that touch it from more than one queue must serialize
/// (both `OfficeHelperServer`'s per-connection handler and `OfficeWireConnection` already run their
/// own frame traffic on one queue each)."* `OfficeWireConnection` runs its READER on one task; it
/// has never serialized its writers, and `OfficeHelperClient.postKey`/`save`/… are called from
/// whatever task `OfficeHelperRequestQueue.run`'s operation closure happens to be on — a `Task {}`
/// body, not a `@MainActor` context. What actually held the invariant was that one app-wide FIFO,
/// at 29 call sites, plus the convention that nothing else holds a client. The DEBUG office harness
/// already breaks that convention deliberately.
///
/// That mattered little while a duplicate seq merely produced a confusing `.unexpectedReply`. It
/// matters completely now that `OfficeWireConnection` **routes replies by seq**: two callers handed
/// the same number would have their answers swapped, silently and plausibly — the
/// silent-wrong-answer outcome this project rates as worse than a crash. The lock is the cheapest
/// possible way to make the demultiplexer's key actually unique, and it costs one uncontended
/// `NSLock` per outbound frame.
public final class OfficeWireSeqAllocator {
    private let lock = NSLock()
    private var next: UInt64 = 1
    public init() {}
    public func nextSeq() -> UInt64 {
        lock.lock()
        defer { next += 1; lock.unlock() }
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

/// office-finish Job 2 — the shared `ops` decode both batch frames use: an array of JSON objects,
/// non-empty, at most `OfficeWireBatchLimits.maxOperationsPerBatch`, every element decoding cleanly
/// through `element`. `nil` on ANY of those failing — a malformed or over-long batch is refused
/// whole, never trimmed and never partially accepted, because a trimmed batch of position-based
/// operations silently means something different from what was asked.
private func decodeBatchOps<T>(_ raw: Any?, _ element: ([String: Any]) -> T?) -> [T]? {
    guard let array = raw as? [Any], !array.isEmpty,
          array.count <= OfficeWireBatchLimits.maxOperationsPerBatch else { return nil }
    var out: [T] = []
    out.reserveCapacity(array.count)
    for entry in array {
        guard let object = entry as? [String: Any], let decoded = element(object) else { return nil }
        out.append(decoded)
    }
    return out
}
