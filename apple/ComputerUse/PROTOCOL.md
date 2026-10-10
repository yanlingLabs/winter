# Winter Computer Use helper protocol

**Protocol version: 1**

Helper version: `1.5.1` (the contents of [`VERSION`](VERSION))

This is the wire contract between **Winter Computer Use** (the signed helper app built from this folder) and
its two clients: the Winter daemon (`winter-core`) and Winter.app. It is written from the code in
`WinterComputerUse/` (the shell: socket, auth, dispatch, view stream) and `WinterCUCore/` (the engine: every
method's params, results and errors). Where this file and the code disagree, the code is right and this file
is a bug. Paths outside this folder (`packages/…`, `scripts/…`, `apple/WinterKit`) are in the Winter repository,
which builds, embeds and drives the helper; nothing in this folder depends on them.

The protocol number above must equal, at all times:

| Where | Name |
| --- | --- |
| `WinterComputerUse/Sources/WinterComputerUseShell/JSONRPC.swift` | `RPCWire.protocolVersion` |
| `packages/core/src/computer-use/protocol.ts` (the daemon) | `HELPER_PROTOCOL` |
| `apple/WinterKit` (Winter.app's client) | `ComputerUseHelperProtocol.version` |
| `scripts/cu-live/swift/ViewProbe/Core.swift` (the live suite's app client) | `ProbeProtocol.protocolVersion` |
| every client's `hello` | `params.protocol` |

`scripts/computer-helper-lib.test.ts` reads the `**Protocol version: N**` line of this file and checks it
against those constants; keep that line's exact format.

The **helper version** is a separate semver string in `apple/ComputerUse/VERSION`, independent of Winter's
own `VERSION`. The build scripts stamp it into the helper's `Info.plist` (`CFBundleShortVersionString` and
`CFBundleVersion`): `bun run version:sync`, `bun run dev:helper` and `bun run verify:computer-helper` stamp it;
`scripts/release.ts` and `scripts/embed-computer-helper.sh` check the built helper carries it. The helper
reports it as `helperVersion` in `hello` and `status`.

## 1. Transport

- **Socket:** `<home>/run/computer-use.sock`, a Unix stream socket created by the helper with mode `0600`
  (set through the umask before `bind`, so the file is never wider). `<home>` is the Winter home the helper
  serves (§2.4). The helper creates `<home>/run/` with mode `0700` if it is missing; it never creates the home.
- **Framing:** NDJSON. Every message is one JSON-RPC 2.0 object on one line, terminated by `\n`. Blank lines
  (spaces, tabs, `\r` only) are ignored.
- **Line caps:** a request line is at most **1 MiB**; a longer one is answered with an `invalid_params` error
  (`id: null`) and the connection is closed. A response line is at most **16 MiB**; a result that would be
  longer is answered with `invalid_params` ("the result is larger than the 16 MiB line cap — ask for a smaller
  image budget or region") instead.
- **Requests:** `jsonrpc` must be `"2.0"`, `method` a non-empty string, `id` a string or a number, `params`
  absent, `null` or an object (absent/`null` reads as `{}`). A line with no `id` (or `id: null`) is a
  notification; notifications only travel helper → client, so the helper ignores one.
- **Concurrency and order:** after `hello`, every request runs in its own task, so a slow call never queues
  another behind it (`cancel` in particular). Answers are written through one serial queue per connection in
  **completion order**, not request order; notifications interleave with them. Match answers by `id`.
- **In-flight cap:** at most 64 unanswered requests per connection; more are answered `busy` (retryable).
- **Encoding:** responses are written without escaping `/` (base64 payloads are full of them). Clients must not
  depend on key order or whitespace inside an object.
- **Frame coalescing:** `view.frame` lines (§7.2) are coalesced per target per connection: if the previous frame
  for a target has not been written to the socket yet, the newer one replaces it. A slow reader sees the newest
  frame, never a growing queue.

## 2. Identity and authentication

### 2.1 The peer check (before anything is read)

On accept, before reading a byte, the helper identifies the peer: `getsockopt(LOCAL_PEERTOKEN)` gives its
`audit_token_t` (pid plus pid version, immune to pid reuse) → `SecCodeCopyGuestWithAttributes` with
`kSecGuestAttributeAudit` → `SecCodeCheckValidity` against each client kind's designated requirement. The
peer is accepted with the **set** of client kinds its code satisfies. A peer that satisfies none (or whose
token cannot be read) is closed with **no response at all**.

### 2.2 Client kinds

| `client` | Who | Designated requirement (dist / dev) |
| --- | --- | --- |
| `daemon` | `winter-core` | `identifier "winter-core"` / `identifier "com.winter.core.dev"` |
| `app` | Winter.app | `identifier "com.winter.app"` / `identifier "com.winter.app.dev"` |

Each requirement is stated in full as
`identifier "<id>" and anchor apple generic and certificate leaf[subject.OU] = "37N77U9RSZ"` (Winter's team).
The shipped daemon's identifier is `winter-core` (the release signs the embedded binary without
`--identifier`, so codesign names it after the file).

The daemon in turn verifies the helper: it checks the `pid` from `hello`'s result against
`identifier "com.winter.computeruse"` (dist) / `"com.winter.computeruse.dev"` (dev) with the same team
anchor, and drops the connection if it does not match.

### 2.3 Method allowlist per client

| Client | May call after `hello` | Receives |
| --- | --- | --- |
| `daemon` | every method except `view.*` | `escPressed`, `targetLost`, `permissionsChanged` |
| `app` | `status`, `view.subscribe`, `view.unsubscribe` | `view.bound`, `view.released`, `view.frame`, `view.cursor` for the sessions it subscribed to |

Any other call is refused `not_allowed` with `data.reason: "client"`. Only `daemon` connections own sessions
(§8.2); an `app` connection owns nothing and never keeps a session alive or ends one.

### 2.4 The helper's own identities and its home

The helper reads its profile from its own bundle id, never from an argument:

| Profile | Bundle id | Serves | Built by |
| --- | --- | --- | --- |
| dist | `com.winter.computeruse` | `~/.winter` | the Release build, embedded at `Winter.app/Contents/Helpers/Winter Computer Use.app` |
| dev | `com.winter.computeruse.dev` | `~/.winter-dev` | `bun run dev:helper` (into `dist/dev/`) |
| test | `com.winter.computeruse.test` | the `WINTER_CU_HOME` it is given | `bun run verify:computer-helper` only (§9) |

`WINTER_CU_HOME` (an absolute path) overrides the home for dev and test builds that are not installed inside
an app (`…/X.app/Contents/Helpers/Y.app`); dist ignores it. The home is canonicalised with `realpath(3)` and
must exist. An Xcode Debug build of the target gets the placeholder id `com.winter.computeruse.xcode-debug`
and refuses to start. A helper that cannot start exits with status 78.

## 3. `hello`

The first request on every connection must be `hello`.

```json
{"jsonrpc":"2.0","id":1,"method":"hello","params":{"protocol":1,"client":"daemon","home":"/Users/me/.winter"}}
```

| Param | Type | |
| --- | --- | --- |
| `protocol` | integer | the protocol version the client speaks |
| `client` | `"daemon"` \| `"app"` | the kind the client claims; its code must satisfy it (§2.1) |
| `home` | string | the Winter home the client belongs to; compared after `realpath` |

Result: `{"protocol": 1, "helperVersion": "1.1.0", "pid": 4242}` — the helper's protocol, its version and
its pid (the daemon verifies that pid's code signature).

Refusals — each is answered, then the connection is **closed**:

| Condition | `data.code` | `data` |
| --- | --- | --- |
| the first request is not `hello` | `protocol_mismatch` | — (message: "the first request must be hello") |
| params do not decode | `invalid_params` | — |
| `protocol` differs | `protocol_mismatch` | `expected`: the helper's protocol; `helperVersion`: its version |
| `client` is not `daemon`/`app` | `protocol_mismatch` | — |
| the peer's code does not satisfy the claimed `client` | `not_allowed` | `reason: "identity"` |
| `home` is not the home this helper serves | `home_mismatch` | `home`: the home it serves |

Only a `protocol_mismatch` that carries `data.expected` is a version mismatch; the two without it are client
bugs. A second `hello` on a ready connection is `invalid_params` (the connection stays open). Before `hello`
succeeds, an unparseable line is answered and the connection closed.

## 4. Methods

Frames are `[x, y, w, h]` and points `[x, y]`, in global screen points with a top-left origin unless stated.
Every method that names a `targetId` fails `target_lost` when the target is unknown or its app/window is gone;
its `data.reason` says which (§5).
Engine methods that read the accessibility tree fail `permission_missing` (`permission: "accessibility"`)
without the grant; captures fail `permission_missing` (`"screenRecording"`) without that one.

### 4.1 Shell and grants

| Method | Params | Result |
| --- | --- | --- |
| `status` | `{}` | `{helperVersion, permissions: {accessibility: bool, screenRecording: bool}}` — reads the grants, never prompts |
| `permissions.request` | `{kind: "accessibility" \| "screenRecording"}` | `{opened: true}` — already granted: nothing; else raises the system prompt, makes sure the helper is listed in the Privacy pane, and opens the pane (bounded to ~3 s for Screen Recording's registration) |
| `script.active` | `{sessionId, active: bool}` | `{}` — while any session is active the Esc tap is armed (§7.1) and the helper does not idle-quit |

### 4.2 Discovery and opening

| Method | Params | Result |
| --- | --- | --- |
| `apps.list` | `{}` | `{apps: [{name, bundleId, running, pid?}]}` |
| `screen.windows` | `{}` | `{windows: [{app, bundleId, pid, windowId, title, frame, onScreen}]}` — every window of every app but the helper's own, larger than 1 pt; titles need Screen Recording |
| `apps.openDocument` | `{urls: [string], app?, sessionId, mirror, privatePath?}` | `{app: {name, bundleId, pid}, windowID?}` — opens paths/URLs with `app` (a name, bundle id or path) or the default handler, **without activating it**; `windowID` is the new window to bind when one appeared. Protected paths are `refused` (`privacy_pane`) |
| `apps.defaultOpener` | `{urls: [string], app?}` | `{bundleId, name, path}` — who would open them; opens nothing |

### 4.3 Targets

| Method | Params | Result |
| --- | --- | --- |
| `target.bind` | `{sessionId, app, window?, mirror: bool, privatePath?: bool}` | `{targetId, app: {name, bundleId, pid}, window: {id, title, frame}, detail?}` |
| `target.useWindow` | `{targetId, window}` | `{window: {id, title, frame}, detail?}` |
| `target.windows` | `{targetId}` | `{windows: [{id, title, focused}]}` — windows on other Spaces or in full screen included, `focused: false` |
| `target.release` | `{targetId}` | `{}` — idempotent |

- `app` is a name, a bundle id or a path; an installed app that is not running is launched in the background.
  `window` is a title (substring) or a window id (number). `privatePath` (absent = `true`) allows reaching a
  window on another Space or in full screen through private APIs. `mirror` says whether Winter.app may be sent
  frames of it (§7.3).
- The bind waits for a usable window (8 s after a launch, 3 s otherwise). It is idempotent: binding the same
  app again in the same session, while its window exists, returns the same `targetId`. Target ids (`t1`,
  `t2`, …) are never reused within one helper run.
- `detail` says what the bind had to do (bound a window on another Space in place, moved one here, …).
- Errors: `no_window` (the app runs with no window), `window_elsewhere` (unreachable on another Space),
  `refused` (`winter_itself`, `privacy_pane`, …), `invalid_params`.
- `useWindow` onto another window resets the target's refs and snapshot history.

### 4.4 Observation

| Method | Params | Result |
| --- | --- | --- |
| `target.snapshot` | `{targetId, since?, full?, within?, settle?: {maxMs}, callId?}` | `{snapshotId, text, isDiff, changedRatio, settled, waitedMs}` |
| `target.find` | `{targetId, query}` | `{elements: [{ref, role, name?, value?, states?}], page?, note?}` |
| `target.screenshot` | `{targetId, region?, budget, settle?: {maxMs}, callId?}` | `{imageBase64, mime: "image/jpeg", width, height, shotId, settled, waitedMs, pointsWidth?, pointsHeight?, detail?}` |
| `screen.screenshot` | `{display?, displayId?, excludeBundleIds: [string], budget}` | `{imageBase64, mime: "image/jpeg", width, height, shotId, detail?}` |
| `screen.appAt` | `{shotId, point}` | `{app, bundleId, windowId}` |

- `snapshot`: `text` is the window's accessibility state with numbered refs. With `since` (a previous
  `snapshotId` of the same scope) and not `full`, the answer is a diff when at most half of it changed
  (`isDiff: true`). `within` scopes it to one ref. `settle` first waits for 150 ms of quiet, up to `maxMs`.
  A window with no accessibility answers a one-paragraph `text` instead.
- `find`: `query` is a string or `{role?, name?, text?}`. A window with no accessibility answers `[]`. `page` is
  the window's page number (as the state header says it); `note` says when the page changed since the last
  whole-window `snapshot`, or the read was cut short.
- A `snapshot`'s header ends with `page N` (the window's page, numbered: it goes up when the page's URL — an
  in-page `#fragment` aside — or, with none, its title changes; absent when it shows no web page), `state N`
  (the snapshot's number), and, when the read stopped at its budget, `read cut short: at least N elements not
  read (the "more" markers show where)`.
- `budget`: `{maxLongEdge, tile?, maxTiles?, quality}` (JPEG quality 0…1). `region` is in window points.
  `pointsWidth`/`pointsHeight` are the captured area in window points (a click's point is in image pixels).
- `screen.screenshot`: `display` is an index into the active displays (0 = main) or `"all"`; `displayId`
  (a `CGDirectDisplayID`) wins over it. `shotId`s are `screen.i<N>`; the last 16 are remembered. `detail` says
  where Winter's own windows are in the image (image pixels): a picture of an app inside one is Winter's live
  mirror of it, not the app.
- `target.screenshot` of a window that is not on screen (taken from the window server) carries a `detail`
  that begins with what is known of the picture's freshness: `freshness unknown` (the first one), `live` (it
  changed since the last one), `stale since N s ago` (unchanged although input was sent or the app's content
  changed since), or `likely current` (unchanged, and nothing done since).
- `screen.appAt`: `point` in image pixels of that screen shot (or of a target's window shot). A point on a
  Winter window is `refused` (`winter_itself`); no window there, or an unknown shot, is `invalid_params`.

### 4.5 Actions

`target.act` — `{targetId, sessionId, callId, action, access, allowForeground, privatePath}` →
`{rung, detail?, input?, inputUnknown?, focusNow?, focusLost?, pageNow?}`.

- `callId` is required (it is what `cancel` names). `access` is `"full"` or `"click"`; with `"click"` only
  `click`, `scroll` and `action` are allowed, anything else is `not_allowed` (`reason: "click_only"`).
- `rung` is how the action got through: `1` accessibility, `2` events posted to the app's pid, `3` the
  private event path (needs `privatePath: true`), `4` the foreground and the real pointer (needs
  `allowForeground: true`). `detail` reports what else happened (what moved the user's view and was put back,
  what was opened).
- For `type`, `paste`, `key` and `setValue`: `input` names the element that received the input
  (`[14] text area "Comment"`; for a window with no accessibility, `the window (it has no accessibility here)`);
  `inputUnknown: true` instead when the app reported no focused element. A `key` that went to a menu item
  carries neither (its `detail` names the item).
- For any act: when the bound window's focus moved during it, `focusNow` says where it is now (name and role
  only — never a value, a secure field included), or `focusLost: true` when it was known before and the app
  reports none now. The focus is the bound window's own: the app's focused element when it lies in that window
  (where its keys go), else — for a window that is not its app's key window — the element marked focused in the
  window's web content.
- `pageNow`: the act changed the bound window's page — its web area's URL (or, with none, the window's title)
  is different after it: a link navigated, a tab switched; an in-page `#fragment` jump is not (a `#/…` or `#!…`
  route is). The page's title now; refs read before it are gone, and no `focusNow`/`focusLost` is sent with it
  (that read named the old page). A tab the act opened in the window's own tab bar is said in `detail`
  ("a new tab opened in …"), whether or not it is the one showing.
- A `key` chord that is a menu command (⌘L → Open Location…) is pressed only when the bound window is the
  app's main window after aiming (a menu command acts on the main window, which can be another of its windows —
  the user's); otherwise `unsupported`, nothing done. A `type`/`paste` with no `into` never goes into a focus
  that is provably in another window of the app. `Return` in a text field outside the page (a browser's address
  field) watches the page for a load; when none starts, its `detail` says so.
- A keyboard focus blip holds the window key a moment after its last key (the app takes queued keys then).
- `menu` walks the app's menu bar; when that has no `path[0]` and the bound window's page has its own menu bar
  (an `AXMenuBar` in its web area) that does, each level is opened with a window-targeted click and verified by
  the menu it shows, and the last item clicked and verified by its menu closing (`detail` says which). A page menu
  that does not open is `unsupported`; a missing item is `invalid_params` naming what the page's menu has.
- `type` and `paste` with no `into` refuse (`refused`) a focus that is not a text field (`focus_not_editable`),
  and several lines or more than 200 characters for a single-line field or for a browser's own field outside the
  page (`wrong_field_shape`); the message names the focus (and the page's editable element).
- A `type`'s `detail` begins with what the field RECEIVED: `received: verified …` (a field that shows its text
  holds it), `received: partly (the field holds the first M of N characters …)`, `received: none of it …`, or
  `received: unverifiable …` (nothing reads it back). Longer or multi-line text into a field that reads back goes
  as a paste and its `detail` begins `as a paste (…)`; multi-line text into an editor that can't be read back goes
  as keys, a newline as Return. Plain ASCII characters are their layout's keys (Shift at most); Option-layer and
  non-ASCII characters go as Unicode with no modifier flags. A `type` whose focus leaves the field partway stops
  (`refused`, `focus_moved`) — a Tab, or a Return that moves the focus, moves it on purpose.
- `action` is an object discriminated by `kind`, its fields beside it:

| `kind` | Fields |
| --- | --- |
| `click` | `ref?`, `point?`, `shotId?`, `button?: "left"\|"right"\|"middle"`, `count?`, `modifiers?: [string]` |
| `setValue` | `ref`, `value` |
| `type` | `text`, `into?` (ref) |
| `paste` | `text`, `into?`, `format?: "text"\|"html"\|"markdown"` |
| `key` | `combo` (e.g. `"cmd+s"`), `into?`, `repeat?` |
| `scroll` | `ref?`, `point?`, `shotId?`, `direction: "up"\|"down"\|"left"\|"right"`, `pages?` |
| `drag` | `from: {ref?, point?}`, `to: {ref?, point?}`, `shotId?` |
| `select` | `ref`, `text`, `before?`, `after?`, `caret?: "start"\|"end"` |
| `action` | `ref`, `name` (an accessibility action) |
| `menu` | `path: [string]` |
| `hover` | `ref` or `point` (+ `shotId`), `ms?` (0–5000, default 600): the pointer rests there — window-targeted moves, never the user's cursor (with `click_only` access too) |

A `point` is in image pixels of `shotId` (a screenshot of this target or of the screen), or of the target's
latest screenshot when `shotId` is absent. An unknown `kind` is `invalid_params`.

Errors include `stale_ref` (`ref`), `needs_foreground`, `window_elsewhere`, `refused` (the floors: §6),
`busy` (retryable), `busy` with `uncertain: true` (the action was sent but not confirmed — it may have
happened; never retried), `cancelled`, `unsupported`.

`target.foreground` — `{targetId}` → `{front, detail?}`: the user agreed (the daemon's card, the script's
`requestForeground(reason)`) that the app may come to the front and stay there until the session's script ends.
The helper brings it forward and holds it: its acts then run as with `allowForeground: true`, the user-view guard
and the Focus Guardian leave it alone, and at `script.active` `false` (or `session.ended`) the front goes back to
the app that had it — if the held app still has it (a switch the user made meanwhile is left alone). `front:
false` (with `detail`) when macOS did not bring it forward. A window on another desktop is bound with a `detail`
that says what working it there costs and names this way out.

### 4.6 Waits

| Method | Params | Result |
| --- | --- | --- |
| `target.waitIdle` | `{targetId, quietMs, timeoutMs, callId?}` | `{settled, waitedMs}` — `settled: false` at the timeout, never an error |
| `target.waitFor` | `{targetId, cond: {text?, ref?, gone?, title?}, timeoutMs, callId?}` | `{met: true, waitedMs}` |

`cond` needs at least one field (else `invalid_params`); `gone` is a ref (number) or text that must
disappear. At the timeout `waitFor` fails `wait_timeout` with `data: {seen, waitedMs}`.

### 4.7 AppleScript

| Method | Params | Result |
| --- | --- | --- |
| `target.applescript` | `{targetId, source, language?, timeoutMs?, callId?}` | `{result: string \| null, detail?}` |
| `target.scriptingDictionary` | `{targetId, search?}` | `{scriptable, text?, truncated?}` |

`source` is 1…64,000 bytes and may address only the bound app; `language` may only be `"applescript"`
(the default). `timeoutMs` defaults to 10,000 and is clamped to 500…120,000 (plus 60 s when macOS will ask
the user for Automation consent). `result` is cut at 64,000 bytes. Refusals are `refused` with
`reason: "applescript"` (the script names another app, uses JXA, …) or `"automation_denied"`.

### 4.8 Lifecycle and cancellation

| Method | Params | Result |
| --- | --- | --- |
| `cancel` | `{callId}` | `{}` |
| `turn.ended` | `{sessionId}` | `{}` |
| `session.ended` | `{sessionId}` | `{}` |

- `cancel` stops every unanswered request whose `params.callId` equals `callId`, on any connection: each is
  answered `cancelled` (a request that finished first keeps its answer). `target.act` always carries a
  `callId`; `target.snapshot`, `target.screenshot`, `target.waitIdle`, `target.waitFor` and
  `target.applescript` take an optional one. `cancel`'s own `callId` names the call to stop, not itself.
- `turn.ended`: the session's turn is over — the on-screen cursor fades, a pending focus restore is flushed,
  and the session's views may pause (§7.3).
- `session.ended`: every target of the session is released (a `view.released` each), its Esc arming and
  per-session state go. The shell's half happens even when the engine's fails.

### 4.9 Winter.app's view methods

| Method | Params | Result |
| --- | --- | --- |
| `view.subscribe` | `{sessionId, frames: bool, maxFps?, maxWidth?}` | `{targets: [{targetId, pid, windowId, appName, bundleId, windowSize: [w, h]}]}` |
| `view.unsubscribe` | `{sessionId}` | `{}` |

`view.subscribe` answers the session's bound targets now (sorted by `targetId`); repeating it replaces that
connection's options. `maxFps` defaults to 10 and is clamped to 1…30; `maxWidth` defaults to 720 and is
clamped to 64…2560 (pixels). A connection that subscribes with `frames: true` (and did not have frames for
that session before) is sent each bound target's last frame at once. Closing the connection ends its
subscriptions.

## 5. Errors

Every error is a JSON-RPC error object whose `data.code` is the code to branch on; `message` is one
human sentence (never echoing request content such as typed text):

```json
{"jsonrpc":"2.0","id":7,"error":{"code":-32000,"message":"[12] is gone — call state()","data":{"code":"stale_ref","ref":12}}}
```

The numeric `error.code` is only a JSON-RPC courtesy: `-32602` for `invalid_params`, `-32601` for
`unsupported`, `-32000` for everything else. Malformed lines (not a JSON object, wrong `jsonrpc`, no
`method`, a bad `id` or non-object `params`) are `invalid_params`; an unknown method and an internal helper
failure are `unsupported`; a Swift task cancellation is `cancelled`.

| `data.code` | `data` fields | Meaning |
| --- | --- | --- |
| `protocol_mismatch` | `expected?`, `helperVersion?` | §3 |
| `home_mismatch` | `home` | §3 |
| `not_allowed` | `reason`: `identity` \| `client` \| `click_only` | the client or the user's setting does not allow it |
| `permission_missing` | `permission`: `accessibility` \| `screenRecording` | the helper lacks that grant |
| `target_lost` | `reason`: `app_quit` \| `window_closed` \| `helper_restart` \| `unknown` | the target is gone; `reason` is what the helper observed (below) |
| `stale_ref` | `ref` | the element is gone — snapshot again |
| `needs_foreground` | — | the app accepts this input only in the foreground |
| `window_elsewhere` | — | the window is on another Space / in full screen and could not be reached |
| `no_window` | — | the app runs but has no open window |
| `refused` | `reason` (§6) | a floor refused it |
| `wait_timeout` | `seen`, `waitedMs` | `waitFor` ran out |
| `cancelled` | `typed?`, `total?` | `cancel`, or the connection closed; a type or paste stopped while typing keys says how many of its characters had gone out (`typed` of `total`): the field is partly filled |
| `invalid_params` | — | bad params, an unknown shot, an oversize line or result |
| `unsupported` | `axError?` | unknown method, an element that does not support it, an internal failure |
| `busy` | `retryable` (default `true`), `uncertain?`, `axError?` | retry, unless `uncertain: true` (then `retryable: false`: it may have happened) |

`target_lost` reasons — what the helper observed, so a client never calls a closed window a quit app:

| `reason` | When |
| --- | --- |
| `app_quit` | the target's app is no longer running (checked on use, while typing, or when macOS reports it terminated) |
| `window_closed` | the app runs but the bound window is gone (a window the helper cannot find is classified by whether its app still runs) |
| `helper_restart` | the `targetId` was never issued by this helper run (`t<N>` past its counter): it came from before a restart |
| `unknown` | anything else, e.g. an id this run issued and has since released |

The same four values are the `targetLost` notification's `reason` (§7.1); a helper never sends another. The
daemon words each one ("Notes quit — open it again with apps.open()", "Notes's window closed — call apps.open or
useWindow to pick another", …) and reads an absent `reason` (an older helper) as `unknown`.

`refused` reasons: `secure_field`, `auth_dialog`, `privacy_pane`, `winter_itself`, `save_path`,
`focus_unknown`, `focus_not_placed`, `focus_not_editable`, `wrong_field_shape`, `focus_moved`, `applescript`, `automation_denied`.
`focus_moved` stops a `type` whose focus left the field partway (`data.typed` / `data.total` say how far it got).

## 6. Floors

Before an action reaches an app, and per character for text input, the engine refuses (`refused`, with the
reasons above): typing into a secure field, acting in an authentication dialog, the Privacy & Security
settings, any Winter window, saving to a protected location, typing with the focus unreadable while the window
holds a password or payment field, and typing when the named field could not be focused.

## 7. Notifications

Notifications are `{"jsonrpc":"2.0","method":…,"params":…}` lines with no `id`.

### 7.1 To the daemon

| Method | Params | When |
| --- | --- | --- |
| `escPressed` | `{sessionIds: [string]}` | the user pressed Esc while scripts ran; the ids of every session marked active by `script.active` (sorted) |
| `targetLost` | `{targetId, reason: "app_quit" \| "window_closed" \| "helper_restart" \| "unknown"}` | a bound target's app quit or its window closed (§5's reasons; the helper itself sends `app_quit` and `window_closed` here) |
| `permissionsChanged` | `{permissions: {accessibility, screenRecording}}` | a grant changed (each change once) |

They go to every ready `daemon` connection, never to Winter.app.

### 7.2 To Winter.app (`view.*`)

Sent to every connection subscribed to the session (`view.frame` only to those subscribed with
`frames: true`). Every params object carries `sessionId` and `targetId`.

| Method | Params |
| --- | --- |
| `view.bound` | `{sessionId, targetId, pid, windowId, appName, bundleId, windowSize: [w, h]}` |
| `view.released` | `{sessionId, targetId}` |
| `view.frame` | `{sessionId, targetId, seq, width, height, windowSize: [w, h], jpeg}` |
| `view.cursor` | `{sessionId, targetId, kind, point: [x, y], dragTo?, frame?: [x, y, w, h], text?, count?, button?}` |

- `view.bound` is sent when a session binds a target, or a target moves to another window (`useWindow`, or a
  bind of the same target on another window). Re-binding the same target on the same window says nothing; a
  new size reaches the app on the next `view.frame`'s `windowSize`. `windowSize` is never `[0, 0]` when the
  window server knows the window's size.
- `view.released` is sent once per target, for any release: `target.release`, the app quitting or the window
  closing, `session.ended`, or the daemon's connection closing. Going off screen is **not** a release.
- `view.frame`: `jpeg` is base64 JPEG, `width`/`height` its pixel size (at most the subscribers' lowest
  `maxWidth`), `windowSize` the window's size in points. `seq` counts the frames sent for that target, from 1.
  A frame whose pixels equal the last one sent is not sent again. The line is coalesced per target (§1).
- `view.cursor` mirrors the agent cursor, with `point`, `dragTo` and `frame` **relative to the window's
  top-left** (where the window is now, re-read at most every 0.5 s). `kind` and its payload pass through as
  the engine reports them: `move`; `press` (`count`, `button`); `type`; `drag` (`dragTo`); `target` (`frame`,
  the element about to be acted on); `key` (`text` = the combo); `scroll` (`text` = the direction);
  `waitBegin` (`text` optional) / `waitEnd`; `refused`; `foreground` (`text` = `"on"`/`"off"`); `done`;
  `caption` (`text`, absent to clear).

### 7.3 When frames flow

A target is captured only while it is bound with `mirror: true` and its session has at least one `frames: true`
subscriber; at the **lowest** `maxFps` and `maxWidth` those subscribers asked for. Observable behaviour:

| Rule | Value |
| --- | --- |
| full rate after an action (a bind counts as one) | until 3 s without one |
| idle rate | 1 fps (rate and width change in place; the stream is not restarted) |
| last frames subscriber gone | the capture is kept 5 s in case one comes back |
| window off every screen (another Space or display, minimized) | no live stream; stills instead: every 0.5 s while worked in, every 1 s otherwise, every 30 s after 3 empty ones in a row; the view is kept, the last frame stays |
| pause | a target with no action for 3 s whose picture has not changed for 5 s (an on-screen stream: only once its session's turn has ended, else after 30 s unchanged) sends nothing new; one still every 30 s checks it, and a changed picture resumes it |
| resume | an action, a changed picture, a new frames subscriber, or the window going off or back on screen |

A paused or off-screen target is never released for it, and an unchanged frame is never sent twice.

## 8. Lifecycle

### 8.1 Launch and quit

- The helper must be launched through LaunchServices (`open -g -a <path to the app>`), never spawned as a
  child: TCC attributes a child's Accessibility and Screen Recording to its parent. The daemon launches it by
  path (dist: inside Winter.app; dev: `dist/dev/`) and verifies it by code signature after `hello`.
- One helper per home: a helper that finds a live listener on the socket refuses to start; a stale socket
  file is replaced.
- **Idle quit:** after 10 minutes with no bound target and no active script, the helper quits (if a request is
  still in flight, the countdown starts over). Open connections do not keep it running; the daemon relaunches
  it on its next call.
- `SIGTERM` quits the same way. On quit the socket file is removed (if it is still the helper's) and every
  connection closed.
- **Socket watchdog:** every 2 s (and whenever LaunchServices re-opens the running app) the helper re-binds
  if its socket file was deleted.

### 8.2 Sessions and connections

- A `daemon` connection that sends a request with `params.sessionId` owns that session. When the last
  connection that owned a session closes, the helper cancels that connection's in-flight requests, waits for
  them to wind down (at most 2 s), and runs `session.ended` for the session.
- An `app` connection closing ends only its subscriptions.
- The daemon keeps one persistent connection; a closed connection means the helper is gone.

## 9. Test-only routes

None of this exists in a dev or release binary; `scripts/release.ts` scans the shipped helper for the
`WINTER_CU_TEST_` prefix.

- **Test build** (`bun run verify:computer-helper`): compiled with the `WINTER_CU_TEST_BUILD` condition and the
  bundle id `com.winter.computeruse.test`. It reads `WINTER_CU_TEST_DAEMON_REQUIREMENT` (the requirement it
  accepts as the daemon — required, `always` accepts any signed peer), `WINTER_CU_TEST_APP_REQUIREMENT` (as
  Winter.app; absent → `never`) and `WINTER_CU_TEST_IDLE_SECONDS` (a shorter idle quit), and serves the home in
  `WINTER_CU_HOME`. A test-id bundle without the hooks refuses to start.
- **Live-test instance** (`bun run e2e:cu-live`): a **dev** helper whose `WINTER_CU_HOME` lies inside a
  `winter-cu-live-<…>` directory directly under the temp dir accepts the suite's test identities
  `com.winter.core.cutest` (daemon) and `com.winter.app.cutest` (app) **instead of** the dev daemon and
  Winter Dev, and answers one extra daemon method:

| Method | Params | Result |
| --- | --- | --- |
| `test.activate` | `{pid}` | `{frontmostSet, raised, frontmost}` — puts the suite's own "user's app" in front |

## 10. Compatibility and versioning

### 10.1 Checking at `hello`

Both clients send their protocol number in `hello` and compare the helper's answer: the `protocol` of the
result, or `data.expected` of a `protocol_mismatch` refusal. A helper protocol lower than the client's means
the helper is too old; higher, too new. Either way the fix is the same — Winter and its helper ship together.

- **The daemon** refuses typed: `HelperProtocolMismatchError`, a `helper_unavailable` with
  `reason: "protocol_mismatch"`, not retryable, its message "Winter Computer Use is too old for this Winter …
  — update Winter" (or "too new"). The mismatch is also reported in Settings → Computer Use through
  `computerUse.status`'s `helper.protocolMismatch`.
- **Winter.app** (WinterKit's `LiveComputerUseHelperClient`) throws
  `HelperClientError.protocolMismatch(helper:client:)` with the same sentence; it is terminal (no retry) and
  the in-window mirror stays off.
- A `protocol_mismatch` with no `expected` (§3: a client bug, or a helper too old to say) reads, on both
  clients, "Winter Computer Use speaks a different helper protocol than this Winter (N) — update Winter".

### 10.2 Bump rules

- **Protocol number:** any change a client could observe — a method added or removed, a param or result
  field added, removed or changed in meaning, an error code or `data` field, a notification — bumps the
  number, in every place listed at the top, together (the repo test fails until they agree).
- A purely **additive, optional** field that every client ignores may stay on the same number, but it must be
  listed in the changelog below.
- **Helper version** (`VERSION`) follows semver: **major** for a protocol bump, **minor** for an additive
  feature, **patch** for a fix with no wire change.

### 10.3 Changelog

| Protocol | Helper | Change |
| --- | --- | --- |
| 1 | 1.0.0 | Initial: the methods, errors, notifications and `view.*` stream above. `protocol_mismatch` refusals of `hello` carry `helperVersion` beside `expected` (additive). |
| 1 | 1.1.0 | `target_lost` errors carry `data.reason` (`app_quit`, `window_closed`, `helper_restart`, `unknown`) and the `targetLost` notification's `reason` takes the same four values (additive: a client that ignores it is unaffected; one that reads it must treat an absent reason as `unknown`). |
| 1 | 1.2.0 | A type or paste stopped while typing keys carries `data.typed` and `data.total` (on `cancelled`, and on any other error it hit mid-typing, whose message also says it); `target.act` results for `type`, `paste`, `key` and `setValue` carry `input` / `inputUnknown` (§4.5) — additive: a client that ignores them is unaffected. |
| 1 | 1.3.0 | `target.act` results carry `focusNow` / `focusLost` (§4.5); `refused` gains the reasons `focus_not_editable` and `wrong_field_shape` for `type`/`paste` with no `into` — additive. |
| 1 | 1.4.0 | `target.act` results carry `pageNow` (§4.5); `target.snapshot` with a `within` ref that is gone answers the whole window, its text starting `[N] is gone (the page changed) — showing the whole window`, instead of `stale_ref` — additive. |
| 1 | 1.5.0 | The `hover` action (§4.5); every window-targeted click now arrives by a short path of window-targeted moves (hover), never moving the user's cursor — additive (an older helper refuses `hover` as an unknown kind). |
| 1 | 1.5.1 | No wire change: a press on web content that accessibility shows no effect of is followed by a click only when that is safe (pixels unchanged on screen, a readable state for a toggle, never off screen unless the app is learned, never a name that may act unseen); otherwise its `detail` says so. |
