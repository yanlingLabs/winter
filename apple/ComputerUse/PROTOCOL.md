# Winter Computer Use helper protocol

**Protocol version: 1**

Helper version: `1.14.0` (the contents of [`VERSION`](VERSION))

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
| `target.bind` | `{sessionId, app, window?, mirror: bool, privatePath?: bool}` | `{targetId, app: {name, bundleId, pid, path?, version?}, window: {id, title, frame}, detail?, webContent?}` — `path` (the running bundle's path) and `version` (its `CFBundleShortVersionString`) since 1.8.0; `webContent` since 1.9.8 (§4.12) |
| `target.useWindow` | `{targetId, window}` | `{window: {id, title, frame}, detail?, webContent?}` — `webContent` since 1.9.8 (§4.12) |
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
| `target.find` | `{targetId, query, callId?}` | `{elements: [{ref, role, name?, value?, states?}], page?, note?}` |
| `target.screenshot` | `{targetId, region?, budget, settle?: {maxMs}, callId?, live?, desktopVisit?, visitMaxMs?}` | `{imageBase64, mime: "image/jpeg", width, height, shotId, settled, waitedMs, pointsWidth?, pointsHeight?, detail?, inVisit?}` |
| `screen.screenshot` | `{display?, displayId?, excludeBundleIds: [string], budget}` | `{imageBase64, mime: "image/jpeg", width, height, shotId, detail?}` |
| `screen.appAt` | `{shotId, point}` | `{app, bundleId, windowId}` |

- `snapshot`: `text` is the window's accessibility state with numbered refs. With `since` (a previous
  `snapshotId` of the same scope) and not `full`, the answer is a diff when at most half of it changed
  (`isDiff: true`). A diff also prints, as `+ <line> — now shown, in [p] …`, what the state shows now that the
  `since` print had folded or left out of view (a scroll, a fold that opened), and a change to an element that print
  never showed carries the element's line and context. Against a folded print, `changedRatio` is also the new lines'
  share of what the print shows — new lines it SHOWS, never an addition it folds (a whole new screen of rows is the
  state again, not a longer list); only the lines a
  diff keeps under its cap count as seen afterwards, and a state printed instead keeps as seen what the `since` print
  had shown that is still there unchanged. `within` scopes it to one ref. `settle` first waits for 150 ms of quiet, up to `maxMs`.
  A window with no accessibility answers a one-paragraph `text` instead. A state is folded to 300 lines (`full`:
  everything the read saw — the read stops at 2,500 elements — held to 2,500 lines and 48 KB, a long list keeping its
  head with its tail folded, and, past either cap, a last line saying where it was cut), folded parts showing
  `(n more — state({within:N}))`: a whole-window, non-full state first folds what is out
  of view; then the window's chrome outside a web page, then subtrees inside the page, then the focus's path, then
  the page itself (never folded wholesale while anything else can be). Only an outline row is ever `collapsed` (and
  keeps its sub-rows folded); WebKit's blanket `AXDisclosing = 0` is not read as collapsed.
- `find`: `query` is a string or `{role?, name?, text?}`. A window with no accessibility answers `[]`. `page` is
  the window's page number (as the state header says it); `note` says when the page changed since the last
  whole-window `snapshot`, or the read was cut short.
- A `snapshot`'s header ends with `page N` (the window's page, numbered: it goes up when the page's URL — an
  in-page `#fragment` aside — or, with none, its title changes; absent when it shows no web page), `state N`
  (the snapshot's number), and, when the read stopped at its budget, `read cut short: at least N elements not
  read (the "more" markers show where)`.
- `budget`: `{maxLongEdge, tile?, maxTiles?, quality, maxBytes?}` (JPEG quality 0…1). With `maxBytes` (on
  `target.screenshot` and `screen.screenshot`), an encoding over it is encoded again from the SAME captured image, at
  the next lower quality of 0.8, 0.6, 0.45, 0.3 (only those below `quality`): the first that fits is returned, else the
  last — a picture is captured once. `region` is in window points.
  `pointsWidth`/`pointsHeight` are the captured area in window points (a click's point is in image pixels).
- `live: true` (the model needs what is on screen NOW): a window on screen is captured as ever; a minimized or
  hidden window (not on another desktop) takes the ordinary path. A window ON ANOTHER DESKTOP is first taken from
  the window server; when that picture is `live` (it changed since the previous one) it is returned, with no visit.
  Otherwise, without `desktopVisit: true` the request fails `needs_desktop_visit` (`why: "live"`) and nothing is
  moved; with it, the picture is taken in a DESKTOP VISIT (§4.10), the result carrying `inVisit: true` and a `detail`
  saying it was captured on the window's own desktop. A live shot of a window on the session's OPEN visit's desktop
  is an ordinary on-screen capture there (`inVisit: true`). When a visit closes, the off-screen picture of each window
  that ran in it is taken again (the way its last off-screen or live shot was) as the baseline its next one is judged
  by — a later live shot is served with no visit when the window server's copy changed since, and needs the desktop
  again when it did not.
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

`target.act` — `{targetId, sessionId, callId, action, access, allowForeground, privatePath, desktopVisit?, visitMaxMs?, linkOpensViaDaemon?}` →
`{rung, detail?, input?, inputUnknown?, focusNow?, focusLost?, pageNow?, inVisit?, guardian?, viewMovedBy?, linkOpen?}` (`guardian`, `viewMovedBy`: §4.12, since 1.9.8; `linkOpen`, 1.11.0: with `linkOpensViaDaemon`, a link in an app that is not a web browser is neither pressed nor opened by the helper — its URL comes back for the daemon to open).

- The helper NEVER takes the user to another desktop (Space) unless the request carries `desktopVisit: true` (the
  user's say, from the daemon's desktop-switch prompt). An act that can't land from this desktop while its window is
  on another one — rung 4 would bring it forward (even with `allowForeground`, even for an app held by
  `target.foreground`), it `needs_foreground`, or the window can't be reached there (`window_elsewhere`) — fails
  `needs_desktop_visit` (`why: "act"`; its message keeps what could not be done). With `desktopVisit: true` the act
  is STILL tried in the background first (the daemon sends it on every later act of a run once the user allowed the
  app); only when that attempt hits one of the above is it done again in a DESKTOP VISIT (§4.10), with
  `allowForeground` implied there. `inVisit: true` when the act ran inside (or opened) a visit. `visitMaxMs` (with
  `desktopVisit` only): how long that primitive may keep the visit — the guardian's visit mode covers at least it,
  clamped to 10…330 s.
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
  (where its keys go), else — for a window that is not its app's key window, or an app holding no key window at
  all — the element marked focused in the window's web content. Keys sent in a focus blip are read there too, while
  the app answers for the bound window: `input` is the focus the first blip found before its first key, and
  `focusNow` the one the last blip left when nothing is readable after it (a native window that is not key, and a
  web view's app once the blip handed the key focus back, answer no focused element).
- `pageNow`: the act changed the bound window's page — its web area's URL (or, with none, the window's title)
  is different after it: a link navigated, a tab switched; an in-page `#fragment` jump is not (a `#/…` or `#!…`
  route is). The page's title now; refs read before it are gone, and no `focusNow`/`focusLost` is sent with it
  (that read named the old page). A tab the act opened in the window's own tab bar is said in `detail`
  ("a new tab opened in …"), whether or not it is the one showing.
- A `key` chord that is a menu command (⌘L → Open Location…) is pressed only when the bound window is the
  app's main window after aiming (a menu command acts on the main window, which can be another of its windows —
  the user's); otherwise `unsupported`, nothing done. A `type`/`paste` with no `into` never goes into a focus
  that is provably in another window of the app. While another of the app's windows is its KEY window, a chord's
  menu item is pressed only in the focus blip (the bound window key), else `unsupported`. `Return` in a text field
  of the window's toolbar (a browser's address field) watches the page for a load; when none starts, its `detail`
  says so.
- A keyboard focus blip holds the window key a moment after its last key (the app takes queued keys then). In
  every focus blip, and before a window-targeted click in the background (not a Chromium app, a window on this
  desktop), the bound window is made its app's KEY window when it is not (posted to the app alone: nothing raised or
  activated, the user's key focus unchanged), so keys, a menu command and a first click reach that window — never while
  the app shows a menu, popover or sheet (or its window list can't be read to tell), never when another of its panels
  or dialogs holds the keys, never for a click that lands on another of its windows, and stopped if the app comes to
  the front meanwhile. Keys — and a menu command validated in the blip, which acts where the keys go — are then sent
  only when the app's keys reach the bound window anyway (its own focus, a popover or context menu of it, a sheet on
  it): otherwise nothing is sent and the act is `refused` — `focus_not_placed` naming what holds the keys (`its
  floating window "Inspector"`, `its dialog …`) or saying it can't be told, `app_in_front` when the app came to the
  front. A refusal after the blip's focus record ends the blip as every blip ends (the key focus handed back — with no
  readable window of the user's, naming none — the wait for their app, a second hand-back, the reroute removed only
  then, the guardian's restore if they are still not back), so the target never keeps the user's keys; what needs no
  focus record (the app's window list unreadable) is refused before it. A change of the user's front app or desktop
  while a blip lasts — during its make-key step, before EACH key, at its end — while a background click is prepared,
  or after an act, is judged by the one rule (§4.12). The user's (into the target, another app or desktop): the blip
  ends with nothing handed back or restored, their keys typed in the target they switched into stay there (never
  rerouted to the app they left), the guardian follows them, and the act stops `app_in_front` (a click — or the click
  that places a field's focus before typing — is not sent). The app's own (it activated itself): undone — the user's
  app put back, the focus records no longer used after a step that did it — and the act stops (`focus_not_placed`
  before any key; an uncertain `busy` once keys went, `data.typed` saying how far). A focused element with no window
  of its own (some Java, Qt and custom toolkits) counts as the bound window's when the app's focused window is the
  bound one. An attached list (a completion or autocomplete window) still open after a blip's hand-back left the app
  with no key window is no menu or popover: the window is named and the keys go. A Tab in a `type`'s text goes as
  keys, never an accessibility insert (it moves the focus) — except in text long or multi-line enough to go as a paste
  into a field that reads it back, whose tabs go in as characters (its `detail` says so).
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
| `hover` | `ref` or `point` (+ `shotId`), `ms?` (0–5000, default 600): the pointer rests there — window-targeted moves, never the user's cursor (with `click_only` access too); over a WebKit page that then shows nothing new, `detail` says so (such a page takes no hover from a synthetic pointer; a page too big to count claims nothing) |

A `point` is in image pixels of `shotId` (a screenshot of this target or of the screen), or of the target's
latest screenshot when `shotId` is absent. An unknown `kind` is `invalid_params`.

Errors include `stale_ref` (`ref`), `needs_foreground`, `window_elsewhere`, `refused` (the floors: §6),
`busy` (retryable), `busy` with `uncertain: true` (the action was sent but not confirmed — it may have
happened; never retried), `cancelled`, `unsupported`.

`target.foreground` — `{targetId, moveDesktop?, callId?}` → `{front, detail?}`: the user agreed (the daemon's card, the script's
`requestForeground(reason)`) that the app may come to the front and stay there until the session's script ends —
on the user's OWN desktop only. The helper brings it forward and holds it: its acts then run as with
`allowForeground: true`, the user-view guard and the Focus Guardian leave it alone, and at `script.active` `false`
(or `session.ended`) the front goes back to the app that had it — if the held app still has it (a switch the user
made meanwhile is left alone). `front: false` (with `detail`) when macOS did not bring it forward, or when its window
is on another desktop: holding it in front there would keep the user there until the script ends, so it is never
done — the `detail` says that an act needing the window on screen asks for a brief visit by itself (and brings the
user back) and that `screenshot({ live: true, reason })` gets a live picture. `moveDesktop` is accepted and ignored
since 1.7.0. A held app whose window later goes to another desktop is not followed there (`needs_desktop_visit`). A
hold whose script end is never heard is released after 330 s. A window on another desktop is bound with a `detail`
that says what working it there costs and names the ways out (a live screenshot, a visit asked for by an act).

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
| `target.scriptingDictionary` | `{targetId, search?, callId?}` | `{scriptable, text?, truncated?}` |
| `target.scriptingCommands` (1.8.0) | `{targetId, search?, callId?}` | `{scriptable, bundleVersion?, commands: [{name, suite, eventCode, description?, direct?: {type, optional, description?}, params: [{name, type, optional, description?, enumerators?}], result?: {type}}], truncated?}` |

`source` is 1…64,000 bytes and may address only the bound app; `language` may only be `"applescript"`
(the default). `timeoutMs` defaults to 10,000 and is clamped to 500…120,000 (plus 60 s when macOS will ask
the user for Automation consent). `result` is cut at 64,000 bytes. Refusals are `refused` with
`reason: "applescript"` (the script names another app, uses JXA, …) or `"automation_denied"`.

`target.scriptingCommands` is the same dictionary, structured, for a client's typed wrappers: the same parse and
cache as `target.scriptingDictionary` (the app's sdef, read from its bundle — the app is never asked anything; an
app whose `OSAScriptingDefinition` is `dynamic` is left unread and answers `scriptable: true` with no commands).
`eventCode` is the command's 8-character Apple Event code (`aevtodoc`); `bundleVersion` the app's `CFBundleVersion`;
`enumerators` lists an enumeration type's (non-hidden) enumerators. Left out: hidden commands, commands of a hidden
suite, every command a script could not send anyway (the refused events below, by code or class) and every
JavaScript door (a command whose name or a parameter's name says JavaScript). At most 300 commands (`truncated`), a
description at most 200 characters; `search` matches a command's name, description or parameter names.

Refused wherever a script sends them (§6): besides Standard Additions' doors, `activate`, `run`, `reopen`, `open
location` and Safari's `do JavaScript` (`sfri/dojs`), the Chromium family's `execute … javascript` (`CrSu/ExJa`, read
from Google Chrome's sdef; Chromium's own dictionary, which its forks ship) — and, per run, every JavaScript door the
BOUND app's own dictionary declares, whatever its code. The source check also refuses, in any app, a string literal that
begins with the `javascript:` scheme as a browser reads it (case aside, whitespace and control characters ignored).

### 4.8 Lifecycle and cancellation

| Method | Params | Result |
| --- | --- | --- |
| `cancel` | `{callId}` | `{}` |
| `turn.ended` | `{sessionId}` | `{}` |
| `session.ended` | `{sessionId}` | `{}` |

- `cancel` stops every unanswered request whose `params.callId` equals `callId`, on any connection: each is
  answered `cancelled` (a request that finished first keeps its answer). `target.act` always carries a
  `callId`; `target.snapshot`, `target.screenshot`, `target.waitIdle`, `target.waitFor`, `target.find`,
  `target.foreground`, `target.applescript`, `target.scriptingDictionary` and `target.scriptingCommands` take an
  optional one (a window watched through a full-screen or Space transition is waited for under it). `cancel`'s own `callId` names the call to stop, not itself.
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

### 4.10 Desktop visits

User rulings 2026-10-10: when an act can't land, or a live picture can't be had, without taking the user to the
window's desktop, the user is asked (§4.11 and the session's card), and — allowed, or unanswered in time — the helper
takes them there ONCE for the whole stretch of work that needs it, and brings them back right after the last of it:
never back and forth between their view and the window's, never held there to the script's end. Never otherwise.

- **Open.** The first `target.act` / `target.screenshot` with `desktopVisit: true` whose background attempt needs the
  window's desktop (or a live shot that needs it) opens the session's visit — one at a time, helper-wide. The user's
  place is recorded: the active Space, the front app (when it can't be read, nothing moves: `refused`,
  `front_unknown`) and that app's focused window. The WINDOW is brought forward — measured on macOS 26.6 with the
  app also having a window on the user's desktop: the window's element made main and raised, then the app made
  frontmost over accessibility (`AXFrontmost`), takes macOS to the window's desktop (activating the app alone, or
  bringing the window to the front by its id, keeps it on the user's). The element is the target's own, or — for a
  window bound capture-only — found at the visit by its id (macOS exposes one once the window has been shown on its
  desktop; with the private path, by remote token). With no element the app alone is brought forward, which reaches
  the window's desktop only when the app has no window on the user's: otherwise `unsupported`, nothing moved. A Mac
  set not to follow an app to its desktop (Desktop & Dock: "When switching to an application, switch to a Space with
  open windows for the application" off — `com.apple.dock` `workspaces-auto-swoosh`) is never visited: `unsupported`,
  nothing moved. The visit arrives when the window is on screen AND the desktop changed (about 1.5 s at most; the
  window is brought forward once more halfway), then waits for a painted frame (about 1 s at most). A window that
  never comes on screen: the user is brought back and the request fails `unsupported` ("macOS did not show <App>'s
  desktop — nothing was done there") with `data.visit` (the closed visit's report); a switch that comes after that (the
  app answering late) is watched for about 1.2 s and undone — unless the one rule (§4.12; the visit's mode ended, its
  target still touched) says it is the user's: then left alone and adopted as their place. The return raises the user's recorded window, a newer one of theirs, or — when theirs closed — another of their windows
  that was on their desktop; "theirs" is a window that was on their desktop when the visit began, or one on the Space
  they were on (its Space membership; when that can't be read, shown there once they are back and not shown while the
  visited one is) and not minimized — never the target's window, nor an alert or window the visit's act opened there;
  with none, their app alone. With several displays and separate Spaces each display's Space is recorded when the visit
  begins and must be back too: one still on the visited Space gets a window of the user's on its own Space raised, else
  the report says the other display stayed there — switching it back needs the user. A visit is refused before anything moves (`unsupported`)
  when the user's own window can't be told while their app has windows on other desktops (the return could not tell
  where to bring them).
- **While open.** Every primitive of that session on a window of the visited desktop runs there, with no further
  switch — acts (`inVisit: true`), screenshots (a live one is an on-screen capture), and reads and waits too, which
  keep it open. A primitive that does not need the visited desktop runs as ever and does not close it. One that needs
  ANOTHER desktop — the user's own, or a third — first closes the visit (the user returned), then runs where the user
  is: on the user's own desktop it simply runs (no `needs_desktop_visit`, no prompt); a third desktop opens a new
  visit with `desktopVisit: true`, else fails `needs_desktop_visit`. `needs_desktop_visit` is never answered while the
  session's visit is open: it is closed first. A failure inside the visit leaves it open; its error carries
  `data.inVisit: true` (a Swift cancellation is answered as `cancelled` with it).
- **Close**, at the first of: `visitCloseGraceMs` (1000 ms) after the last primitive that ran in it finished, with none
  started since; the session's `script.active` `false`, a `cancel` of a request that ran in it, Esc, `session.ended`,
  `visit.close`; a primitive needing another desktop (above); the user moving by themselves; the safety cap (60 s with
  nothing running in it; while a primitive runs, at least its `visitMaxMs`).
- **The return**: the user's recorded window raised and made main, and their app made frontmost over accessibility (under
  `SLSDisableUpdate` when the visit never left their desktop), their app activated and retried within the restore
  deadline, then VERIFIED (Space and front app as recorded); not back → one more attempt; still not back →
  `returned: false`, a `detail`, and a fault log. No event ever reaches the user's window (a key-window record
  arrives as a mouse down and up). The user
  moved by themselves ONLY when the one rule (§4.12) finds a change during the visit theirs — switch-capable input of
  theirs or a click into a window, after the visit began (never the click on "Switch now", never typing, scrolling or
  a pointer move, never the HID idle state) — and they are now neither on the window's desktop nor back where they
  were: then the visit closes at once and they are left there (`userMoved: true`), their new place adopted. Their input
  in the visited app itself is no move away. A visit that never arrived always brings them back.
- **Reports.** Each closed visit — `{visitId, targetId, app, why, actions, ms, returned, userMoved?, detail?}`:
  `visitId` helper-unique (`v<N>`), `why` what opened it (`act` | `live`), `actions` how many primitives ran in it,
  `ms` how long the user was away — is kept for its session until `visit.close` returns it (each exactly once; at most
  the last 32), and is announced at once with the `desktopVisited` notification (§7.1).

While a visit is open the Focus Guardian treats it as the agent's own: the switch there and back are neither undone
nor adopted (input is only noted), so a failed return can still be put right by it.

| Method | Params | Result |
| --- | --- | --- |
| `visit.close` | `{sessionId}` | `{visits: [{visitId, targetId, app, why, actions, ms, returned, userMoved?, detail?}]}` |

Daemon only. Closes the session's open visit, if any (the user returned — bounded by the restore deadlines), and
returns every closed, not yet claimed visit report of the session, each exactly once; an empty list when there are
none. It never fails for "nothing open".

### 4.11 The desktop-switch prompt

| Method | Params | Result |
| --- | --- | --- |
| `prompt.desktopVisit` | `{promptId, callId, sessionId, app, bundleId, reason, expiresAt?, timeoutMs?}` | `{answer: "switch" \| "refuse" \| "expired"}` |

Daemon only. `callId` must equal `promptId` (the daemon gives every prompt its own id, so `cancel {callId}` reaches
only it). The helper shows a panel on the user's CURRENT desktop — a non-activating panel that is never key, never in
a capture or a mirror frame (`sharingType = .none`), on every Space (a full-screen app's included), above ordinary
windows at the top centre of the user's screen — naming the app and its bundle id, the reason (one sanitized line, at
most 200 characters), "Winter will bring you back right after.", a countdown ("Switching in 42 s") and two buttons,
"Don't switch" and "Switch now". The countdown runs to `expiresAt` (epoch ms — the session card's own deadline, so
both doors end together), else for `timeoutMs` (clamped to 1 s…10 min); one of the two is required. It answers when
the user clicks (`switch` / `refuse`) or `expired` when the countdown runs out (the panel says "Switching…") — the daemon is the authority on the outcome and treats `expired` as its
own timeout. `cancel {callId}` (the session's card was answered first), or the connection closing, closes the panel at
once and the request is answered `cancelled`. Several prompts (several sessions) stack, each answering its own id; a
second request for an open `promptId` is `invalid_params`.

### 4.12 Whose move it is (the one rule)

**The contract.** While the agent acts, these hold — the model-based test (`GuardianModelTests`: the real engine in
simulated time over a simulated world, seeded random interleavings of the user's actions, the agent's, two sessions'
and the apps', checked after every event) asserts each of them. Its oracle never reads the engine: who caused each
change comes from the world's own event log, and where the engine cannot see the difference (below) every right answer
is kept, the engine is held to the one it took, and the share is reported. Its world has the helper's own windows, the
menu bar and status items, notification banners, picture in picture, non-activating panels, the empty desktop, a
second display, launches of the user's and the agent's, system dialogs, activation latency (~0.3 s across desktops),
refused activations, asynchronous restores, NSWorkspace's notifications late and reordered (measured: within 13 ms of
the change, run108; the world allows 120 ms, a stress sweep 400 ms) and Secure Event Input with the modifiers seen
(measured, run107) or not.

- **I1.** Only these are ever undone: a change that brought forward an app the agent TOUCHED, and an app the agent's
  action brought forward INDIRECTLY. Touched, per pid: the agent acted on it, sent it a synthetic event, raised it or
  made its window main, opened a document in it, is launching it (a process of that bundle started after the launch
  began), runs an operation on it (an AppleScript, a bind's window wait, `useWindow`), or restored the user to it a
  moment ago (its late landing: within 0.8 s of the attempt, once the user's place moved away) — within 1.5 s of that,
  or while it runs. What the agent does to an app while it is in front counts once it has left the front, as a cause
  at the time it was done. An app the agent never touched coming forward is the user's when their switch input
  explains it (a click on its window or its Dock tile counts for it whatever moved), or when the agent was not active.
  It is the agent's INDIRECT effect — undone the same way, silently, and said once ("<App> came forward after your
  action and was sent back — avoid that …") — ONLY when clearly the agent's (round 10, the user's ruling): no input of
  the user's the tap saw in the last 2.5 s (whatever the agent did in between), an action of the agent's that can open
  apps within 1.5 s (a click, a press, a menu command, Return/Space/Enter, a typed newline, an AppleScript, an open, a
  launch — never a read, plain typing, a scroll or a hover) and can open THAT app — its REACH (1.13.0, round 14; 1.15.0:
  an act in an app reaches the app itself; the default handler of mail links, and in an app that is not a web browser
  those of web links too; a menu command the same, plus the Help viewer; Finder only for an act named like "Show/Reveal
  in Finder"; the pressed element's own link's scheme handler (zoommtg:, x-apple.systempreferences:, …) — never a web
  link's in a browser; an act in Finder, the Dock or a launcher, an AppleScript, an open or a launch of an unnamed app,
  any app — an app outside every such act's reach
  is a third party's or the user's, never the agent's: another agent session's `open <url>` in Safari and its Terminal
  were undone after a click in Chrome), and no Secure Event Input. In every other case it is left in front, never adopted
  as their place, and said ("<App> came forward around your action — it may have been your action's doing or the user's;
  it was left in front"). THE LAUNCH RULE (ruled in round 16, 1.15.0) — an app coming to the front for the FIRST time
  after a process start that follows an agent opener act (any reach) or a pending launch of the agent's within 1.5 s:
  (1) the user's hardware input (a key, a click, a switch input) between that act and the start, or an interactive
  launcher (Spotlight's Return, a Dock click, a Finder double-click — the 2.5 s quiet below keeps those from any undo):
  THEIRS, adopted as their place; (2) no input of theirs in that interval, the app WITHIN the act's reach, and no input
  of theirs in the 2.5 s before the start: CLEARLY the agent's — undone when no input of the user's came since the start,
  and said; (3) otherwise — left in front and said, never adopted. "Any reach" decides only the never-adopt gate, never an
  undo. And a restore never pulls the user out of an app left in front once they have typed or clicked in it: their input
  there makes it their place. Never undone either: the first activation of an app after a launch the agent did not make
  (the user's own slow launch — told by the launch notice, or by its process having started within 60 s, not by the
  agent, never seen in front) — and a system dialog's process (never the user's own launch, however
  it started) (UserNotificationCenter, CoreServicesUIAgent, SecurityAgent — any app that is
  not a regular one): left in front for the user to answer, and said ("… (a system dialog) came up after your action —
  it was left in front for the user to answer …"). A background open is the agent's from BEFORE it starts (a launch of
  its opener, a running opener touched). The common indirect causes are prevented at the source: pressing an `AXLink`
  to another site (never one to the page's own site, never in an Electron/CEF app, which navigate in-app) in an app
  that is not a web browser opens its URL (`http`, `https`, `mailto` only) in the background (NSWorkspace, `activates: false`) instead —
  "opened <host> in <browser> in the background … it isn't bound"; documents open through `apps.open`, and Finder's
  Open is rerouted there. Bringing the user back to their own place never touches their app. During a desktop visit
  what comes forward is the visit's.
- **I2.** Once a change is the user's, nothing undoes it, and every restore goes to the user's place AS IT IS WHEN IT
  RUNS (a restore's retry included: another app coming forward while it waits is judged first, and their move ends
  it). A restore raises a window of their app on THEIR desktop (the one listed, else found by its id) — a desktop
  changed under their own app is put back too. A visit's return goes to the guardian's place (never a theft that was
  in front when it began, never the visit's own late landing after their move); a hold's give-back and rung 4's go to
  the guardian's place, only while the held app still has the front. No restore runs while a desktop visit is open (the
  visit's own return aside): the visit owns the view, and its end brings the user back.
- **I2′ — the user's ruling, NOT YET ENFORCED (round 10's MEDIUM #6; tried in round 12, reverted).** When an app was left
  in front around the agent's action (an `.unexplained` verdict — the user may have opened it) and then the agent's app
  jumps in, the restore returns the user to THAT app — what was in front just before — never to an older place. A
  narrow version (the theft's own `before` is the state left in front, no late restore landing, no hold) passed the
  default 20 seeds but failed 11 more of seeds 1000–1079. The engine and the model-based test's oracle disagree in four
  classes; which side is right, by the ruling (round 13):
  1. *A visit's return lands on what was in front when the visit began (itself left in front), then the agent's app
     jumps in* (seed 1009): the ruling restores to that app. **The oracle is wrong** — it marks only an untouched app's
     coming forward as "left there", never a visit's return to it; the engine was right only because it took its own
     late return landing for an unexplained change, which it must not (a visit's return landing is the engine's).
  2. *The user's own place, an app the agent touched, comes back by itself over the app left in front* (seed 1027): the
     agent's doing — undone, back to the app left in front. **The oracle is right; the engine is wrong**: its "back to
     their place" shortcut takes any return to the place as theirs, before weighing the agent's cause.
  3. *A second untouched app comes forward over the app left in front* (seeds 1041, 1044): when it is undone, the target
     is the app left in front (the engine is right on the target), but the engine and the oracle already disagree on
     whether it is CLEARLY the agent's at all (input of the user's the oracle counts and the engine does not) — a "clearly"
     disagreement of its own, to settle first.
  4. *The user's own move (a Dock click) not yet heard when an app comes forward and is left there* (seed 1028): the user's
     move wins — **the oracle is right**; the engine, never having heard it, restores to a stale state either way.
  So before I2′ can hold, the engine must (2) weigh the agent's cause before "back to their place" while a state left in
  front is current, (1) tell its own visit-return landing from an unexplained change, and (4) fold a move heard late
  before choosing a restore target; the oracle must (1) carry "left there" through a visit's return. The oracle is never
  loosened to pass.
- **I3.** A key the user types while a focus blip's reroute is on reaches their place by this rule: into the target
  only when they moved there themselves, never into a target that took the front without being judged their move,
  never into an app they left, never into a held app once its hold has ended; and the key focus is never handed back
  to an app they left (nor to a system dialog something of the agent's came over, nor to where the blip began when
  their place moved during it: to their place).
- **I4.** A touched app that comes forward with no switch-capable input of the user's since the agent's last cause on
  it is undone, and a typing act into it stops (at most the key already in flight); so is the agent's indirect effect.
- **I6.** (Round 10, the user's ruling.) Once the user WORKS in a bound target — a click into its window (counted once
  its own activation lands, within 1.5 s: a drag out of a background window is no work), a key with no ⌘/⌃ (a ⌘/⌃ chord
  may be the system's: ⌘-Space, ⌘-Tab, ⌃-arrows), nor ⌥-Space or Escape, that the window server delivers to the app
  itself (1.10.0: a key into Spotlight's, a launcher's, the emoji picker's or a status item's panel goes to that
  process — the annotated tap's target — and is no work in the app), a right or other click or a scroll in its window,
  while it is in front — the agent is hands-off it: every act and AppleScript on it is refused at once, `refused` with reason
  `user_working` ("the user is working in <App> right now — wait and retry, or ask them"), until it is no longer in
  front; reads (state, find, screenshot, waits) go on. Switching there to look blocks nothing. (1.11.0) The work is seen
  between scripts too — the WORK WATCHER, a narrow listen-only tap (keys, mouse downs, scrolls; no pointer moves, no
  content logged) that runs while any target is bound, a public API independent of the private event path — and it
  outlasts the guardian's stop: another app activating (the always-on activation observer) or the app leaving the front
  ends it. A process counts as the app only when it truly is part of it (the app is responsible for it, it is the app's
  child, or its executable lies inside the app's bundle — never another accessory or agent process). Under Secure Event
  Input held by the bound app in front itself, the user is taken to be working in it. A refused act is no operation on
  the app and no cause (the floors included).
- **I5.** Every path that can see the user's front app or desktop change — the guardian's activation and desktop
  observers, a focus blip's make-key step, each of its keys, its end and its waits, the reroute, a background click's
  preparation, the act's after-check and late check, a bind, `useWindow`, an AppleScript, making the bound window main,
  a restore's retries, a desktop visit's start, watch and return, the held foreground's and rung 4's start — asks this
  one rule with the time its own operation began, and nothing else. One state gets one verdict until new input of the
  user's or a new cause of the agent's arrives; a state judged again counts only the facts from before it was first
  seen (input, causes, hardware) — kept while that state stays in front unchanged, even when its verdict was cleared (a
  visit's or a hold's end), and given up once an activation of another app is heard (the front was elsewhere in
  between, unseen); a verdict of the user's is never taken back; an activation heard late, of an app that came
  forward before what is in front now, never takes back a place that is in front now and was judged theirs — unless
  they clicked into that app, or what is in front may be a restore of ours landing late (then the earlier change is
  judged, and what came after it from there). During a visit, a change heard late that a switch of theirs since the
  visit began explains is their move (the visit's end brings them back there), and so is coming back to their place
  (no restore runs then; the visit's own way back aside); the consented foreground's landing
  heard late is where a theft after it is put back. A visit, a
  hold and rung 4 judge what is in front before they take the user anywhere; a visit's start clears the last verdict
  (what it brings up is its own, never undone in the middle of it). The consented foreground (a hold, rung 4) is
  brought forward by an activation AND accessibility's frontmost (cooperative activation can refuse the first); rung 4
  inside a hold leaves the hold, its exemption and the front alone.

**The rule**, in order, for the front app and desktop as they are now:

0. They are the user's place (the guardian's view; the caller's starting view when it does not run): nothing moved. A
   change back there uses up the switch input that took them there (never a restore's landing, which no input caused).
1. The first activation of an app the user launched (not the agent; never a system dialog's process, nor a launch that
   was clearly the agent's at its process start — judged on the facts from before the start): the user's.
2. The app that came forward was not touched — and, for a desktop change with their own app still in front, no touched
   app with a cause that raises has a window shown there (not during a visit): a switch input of theirs that fits — the
   LATEST — makes it the user's (I1); else, the agent active and no hardware input of theirs since its last cause (with
   a session tap): a system dialog is left alone and said, anything else is the agent's indirect effect, undone and
   said; else the user's (using up the latest input for that very app, else of the change's own kind).
3. A click of theirs into its window (a claim, 1.5 s): the user's — using up that click's input.
4. A desktop change that follows their own move into that app, with no cause of the agent's on it since: the user's.
5. Switch-capable input of theirs after the agent's last RAISING cause on that app — and after its last cause of any
   kind, unless the change is heard within 0.45 s of the input (an act's cause landing between their input and the
   switch's landing never outranks it): the user's. Pairing: an input for that very app first (a click on its window),
   then the LATEST input of the change's own kind (an app switch for a change of the front app, a desktop switch for a
   change of the desktop alone), then the latest of any kind. Each input explains one change, and is used up by it —
   except that an untouched app's change heard within 0.1 s of its input leaves that input a second explanation until
   0.15 s after it (two apps landing together from one switch); never a restore's late landing or the consented
   foreground's. (So the user's ⌘-Tab into the app being held in front, released after the hold was issued, is theirs,
   and the hold's end gives nothing back.)
6. The consented foreground's own landing (within 0.8 s of its issue), with no input of theirs that explains it: allowed.
7. No session tap: a physical click of theirs within 0.4 s, after the agent's last cause: the user's.
8. A desktop visit in progress: the visit's — neither undone nor adopted (their input in the visited app included: the
   visit's end decides).
9. The consented foreground for that app: allowed.
10. Otherwise the agent's (or the app's own): undone, the user put back at their place.

**Switch input** (what the session tap, the gesture monitor and the click handler see): a ⌘-Tab switches at the RELEASE
— its Tabs, seen while ⌘ is held, explain nothing until then, and at the release become ONE input there (after anything
the agent did while the switcher was up); ⌘-` at its key. A ⌘ release with no key seen (the switcher took the Tab, or
Secure Event Input — the tap still sees the modifiers, measured run107): an app switch, explaining only a change heard
within 0.7 s. ⌃ held with no chord: a desktop switch for every desktop it passes while held and those heard within
0.45 s of its release (its arrows can't be counted then); its release with no key seen: a desktop switch within 0.7 s;
a seen ⌃-arrow: a desktop switch. A trackpad swipe, magnify, rotate or smart magnify: a desktop switch (never the
generic gesture event, type 29). A click on an app's Dock tile: ONE input for THAT app (the tile's `AXURL` names its
bundle), claimed like a click into its window. A click elsewhere in the Dock, on a status item or the menu bar, a
notification banner, picture in picture, a floating panel (any window not at layer 0, or of an app that is not
regular): an app switch of no known app.
A click on another app's window: ONE input, an app switch for THAT app (on another display too — the desktop comes
along); on the front app's own window on another display: a desktop switch for it. A click on the empty desktop:
Finder's (a claim). A click through one of the helper's own windows that let clicks through (the agent's cursor, its
glow): for the window under it. Typing, scrolling and moving the pointer never count; nor does a chord an app got (⌘S,
⌘-click, ⌃-scroll). Input counts from a second back while the guardian runs, else from the caller's own start and at
least a second back.

A click of theirs into a window claims that app's activation; their place moves there once the activation is SEEN (a
drag out of a background window activates nothing and moves nothing). A click into the window of the app already in
front (a held target, or one in front by a change not judged theirs yet) makes it their place at once.

**Results.** `target.act` carries `guardian` (the Focus Guardian's notes since the last act: the user put back after an
app took their front; an app sent back as the agent's indirect effect; a system dialog left in front) and
`viewMovedBy` (the apps that came forward after the agent's action with no input of the user's, by name) — the daemon
prints each note as an unfenced line and counts the apps in its metric (1.9.8). `target.bind` and `target.useWindow`
carry `webContent: true` when the bound window holds a web page (an `AXWebArea`, WebKit or Chromium): its pages take no
hover from a pointer that is not the real one while the app is in the background (measured: WebKit 2026-10-10;
Chromium run111, 2026-10-11 — the private path's moves reached the page, but neither a mouseenter nor a `:hover`) — the
daemon says so once per session per app (again after a compaction, a reset, a worker restart). A hover on a web page
with the app held in front (`target.foreground`) or under rung 4 moves the REAL pointer (and back), and says what
appeared while it rested there.

**What can't be attributed, by design** (kept as several right answers by the model-based test, its share reported):
the guardian hears of an activation only when told, with no time on it, so a change that lands just before the user's
own switch input and is heard of after it is taken as theirs; a cause of the agent's on an app between the user's input
and that app's change makes the change the agent's; a self-activation at the very edge of the 1.5 s causal window; an
input whose landing the engine took for the agent's (the consented foreground, a raise) stays unused for its life; two
landings before the engine heard the first are one change to it; a restore issued before the engine heard of a change
decides nothing between that change's answers; a ⌘-Tab or ⌃-arrow under Secure Event Input with the modifiers unseen
into a touched app is undone (the tap sees nothing). Unmeasured: hardware-origin modifiers under Secure Event Input
(run107 measured posted ones).

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
| `needs_desktop_visit` | `why`: `act` \| `live` | the act can't land, or a live picture can't be had, without taking the user to the window's desktop, and the request carried no `desktopVisit: true` — nothing was moved (§4.5, §4.4, §4.10) |
| `window_elsewhere` | — | the window is on another Space / in full screen and could not be reached |
| `no_window` | — | the app runs but has no open window |
| `refused` | `reason` (§6) | a floor refused it |
| `wait_timeout` | `seen`, `waitedMs` | `waitFor` ran out |
| `cancelled` | `typed?`, `total?` | `cancel`, or the connection closed; a type or paste stopped while typing keys says how many of its characters had gone out (`typed` of `total`): the field is partly filled |
| `invalid_params` | — | bad params, an unknown shot, an oversize line or result |
| `unsupported` | `axError?`, `visit?` | unknown method, an element that does not support it, an internal failure (or a desktop visit whose window never came on screen: `visit` is its report) |
| `busy` | `retryable` (default `true`), `uncertain?`, `axError?` | retry, unless `uncertain: true` (then `retryable: false`: it may have happened) |

`target_lost` reasons — what the helper observed, so a client never calls a closed window a quit app:

| `reason` | When |
| --- | --- |
| `app_quit` | the target's app is no longer running (checked on use, while typing, or when macOS reports it terminated) |
| `window_closed` | the app runs but the bound window is gone (a window the helper cannot find is classified by whether its app still runs; one the window server still lists but on no Space — a full-screen transition — is watched up to 1.5 s first) |
| `helper_restart` | the `targetId` was never issued by this helper run (`t<N>` past its counter): it came from before a restart |
| `unknown` | anything else, e.g. an id this run issued and has since released |

The same four values are the `targetLost` notification's `reason` (§7.1); a helper never sends another. The
daemon words each one ("Notes quit — open it again with apps.open()", "Notes's window closed — call apps.open or
useWindow to pick another", …) and reads an absent `reason` (an older helper) as `unknown`.

`refused` reasons: `secure_field`, `auth_dialog`, `privacy_pane`, `winter_itself`, `save_path`,
`focus_unknown`, `focus_not_placed`, `focus_not_editable`, `wrong_field_shape`, `focus_moved`, `front_unknown`, `applescript`,
`automation_denied`, `app_in_front`, `user_working`, `remote_debugging`. `remote_debugging` (1.10.0, Floor F; widened in
1.11.0, Chromium-based BROWSERS only in 1.12.0 — never an Electron or CEF app): in a Chromium-based browser, an act on an element inside an internal inspect page (host `inspect` under any scheme
that is not the web's — `chrome`, `edge`, `brave`, `vivaldi`, `opera`, `arc`, `comet`, … — matched by the web area's
`AXURL`, every UI language; with no element named, whenever the bound window shows one; a capture-only bind by its window
titles) or while the "Allow remote debugging?" dialog is up (matched by its English wording in a dialog, a sheet or a
window with no web page — a standard window only when a COMPLETE walk of it found none (1.12.0), for now) — refused before anything is sent, under every policy; the browser's own UI stays usable
to leave the page. `app_in_front` (1.11.0) also refuses a pointer event on the bound window while its app is in front
with ANOTHER of its windows key (it would raise the bound window over the user's and take their keys) — an
accessibility press or a value still go; a menu command is refused too (1.12.0: it would act on the window the user
is in, or bring the bound one over it), and every ⌘-chord (1.13.0, a sheet's or a panel's too), except inside the
session's own desktop visit once it has ARRIVED and only for the visit's own app and window (1.13.0). `user_working` (1.9.9): the user is working in the app (I6, §4.12) — every act
on it is refused until it leaves the front; retry later. Under Secure Keyboard Entry (the bound app in front holds Secure
Event Input) the tap sees no key: its text CHANGING since the agent's last act — the user's typing or a command's streaming
output, which can't be told apart — is work, by the user's ruling (round 14: keep the safe side), until it leaves the front,
refused "<App> is in front with Secure Keyboard Entry on and its text is changing — Winter waits until you switch away"; a
password field of it focused, "<App> is in front with a password field focused (Secure Event Input) — Winter waits until you
switch away". `front_unknown`: a desktop visit was not made because the app the user is in can't be read — they
could not have been brought back; nothing was moved. `app_in_front`: the app came to the front while a background act
was being prepared (the user may be using it): the keys or the click were not sent.

Any error of a primitive that ran inside a desktop visit carries `data.inVisit: true`.
`focus_moved` stops a `type` whose focus left the field partway (`data.typed` / `data.total` say how far it got).

## 6. Floors

Before an action reaches an app, and per character for text input, the engine refuses (`refused`, with the
reasons above): typing into a secure field, acting in an authentication dialog, the Privacy & Security
settings, any Winter window, saving to a protected location, typing with the focus unreadable while the window
holds a password or payment field, and typing when the named field could not be focused. AppleScript never runs a
page's JavaScript: Safari's `do JavaScript`, the Chromium family's `execute … javascript` and any JavaScript door the
bound app's dictionary declares are refused, and so is any `javascript:` URL literal (§4.7).

## 7. Notifications

Notifications are `{"jsonrpc":"2.0","method":…,"params":…}` lines with no `id`.

### 7.1 To the daemon

| Method | Params | When |
| --- | --- | --- |
| `escPressed` | `{sessionIds: [string]}` | the user pressed Esc while scripts ran; the ids of every session marked active by `script.active` (sorted) |
| `targetLost` | `{targetId, reason: "app_quit" \| "window_closed" \| "helper_restart" \| "unknown"}` | a bound target's app quit or its window closed (§5's reasons; the helper itself sends `app_quit` and `window_closed` here) |
| `permissionsChanged` | `{permissions: {accessibility, screenRecording}}` | a grant changed (each change once) |
| `desktopVisited` | `{visitId, sessionId, callId?, targetId, app, why, actions, ms, returned, userMoved?}` | a desktop visit CLOSED (§4.10), whatever its outcome — the work done, a failed primitive, a cancelled request, a window that never came on screen; `callId` is the request that opened it |

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
  Winter Dev, and answers these extra daemon methods:

| Method | Params | Result |
| --- | --- | --- |
| `test.activate` | `{pid, asUser?}` | `{frontmostSet, raised, frontmost}` — puts the suite's own "user's app" in front; `asUser` (1.9.9): first records what the USER's switch would leave (hardware input, a switch for that app, claimed), so the guardian treats it as theirs |
| `test.userInput` | `{pid}` | `{}` — (1.9.9) records the user's work in that app (I6), as their click into its window would |
| `test.capture` | `{windowId, source: "skylight"\|"stream", path, rect?: [x, y, w, h]}` | `{width, height, frameAgeMs?}` — writes one PNG (inside the instance's home only) of a window: the off-Space still path (`skylight`) or the latest frame of the test stream (`stream`); `rect` in the window's points |
| `test.stream` | `{windowId, on, fps?}` | `{running}` — starts/stops a desktop-independent ScreenCaptureKit stream on that window (the freshness measurement) |
| `test.automation` | `{pid?, bundleId?}` | `{status: "granted" \| "would_ask" \| "denied" \| "not_running" \| "unknown", code}` — may this helper already send the app Apple Events; asked with `AEDeterminePermissionToAutomateTarget(…, askUserIfNeeded: false)`, so it NEVER raises macOS's Automation question (the suite runs an AppleScript-backed scenario only on `granted`) |

## 10. Compatibility and versioning

### 10.1 Checking at `hello`

Both clients send their protocol number in `hello` and compare the helper's answer: the `protocol` of the
result, or `data.expected` of a `protocol_mismatch` refusal. A helper protocol lower than the client's means
the helper is too old; higher, too new. Either way the fix is the same — Winter and its helper ship together.

- **The daemon** also requires helper **1.7.0** or later (`HELPER_MIN_VERSION` in
  `packages/core/src/computer-use/protocol.ts`, compared with `hello`'s `helperVersion`): an older helper — one that
  would take the user to another desktop without asking — is closed and relaunched once (the app was updated under
  a running helper), then refused typed (`helper_unavailable`, "… update Winter").
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

- **Protocol number:** bumped only for a BREAKING change — a method removed or renamed, a param or result
  field removed or changed in meaning, a new REQUIRED param, an error code or notification whose meaning
  changed — in every place listed at the top, together (the repo test fails until they agree).
- **Additive changes keep the number:** a new method, a new optional param, a new result or `data` field, a
  new error code or notification an older client never has to handle. Each is a **minor** helper version and is
  listed in the changelog below. A client that RELIES on an addition checks the helper's version at `hello`
  (a minimum-version constant on the client side), never the protocol number.
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
| 1 | 1.6.0 | Additive: `target.foreground` (§4.5; the script's `requestForeground`); `refused` gains `focus_moved` (a `type` stopped when the focus left the field, `data.typed`/`data.total`); `screen.screenshot` results carry `detail` (Winter's own windows in the image); `target.find` results carry `page` and `note`; a snapshot header ends with `page N · state N` (and a cut-short read); `type` details begin `received: …` or `as a paste (…)`; a gone `within` ref says "the page changed" only when it did; off-screen window shots begin with a freshness label; `pageNow` ignores an in-page `#fragment` jump and comes without `focusNow`; a chord's menu item is pressed only when the bound window is main, and only in the focus blip while another window is key; `target.foreground` brings a window on another desktop forward only with `moveDesktop`; `menu` falls back to the page's own menu bar. The live-test-only `test.capture` route's path guard compares realpaths of the parent (no wire change). |
| 1 | 1.7.0 | Additive — desktop visits (§4.10): `target.act` takes `desktopVisit` and `visitMaxMs`, `target.screenshot` takes `live`, `desktopVisit` and `visitMaxMs`, both results carry `inVisit`; ONE open visit per stretch of work (closed a grace after its last primitive, at the script's end, a cancel, Esc, the session's end, another desktop needed, the user's own move, or the cap), the user brought back by window id; the daemon-only `visit.close` (each closed visit's report once) and the `desktopVisited` notification; the error `needs_desktop_visit` (`why: act \| live`) — an act that would need the user moved to another desktop (rung 4 off this desktop even with `allowForeground` or a held app; `needs_foreground` / `window_elsewhere` off this desktop) now fails with it instead of moving them, and never while the session's visit is open; `refused` gains `front_unknown`; errors of primitives in a visit carry `data.inVisit`; `budget.maxBytes` (re-encode the same capture down a quality ladder); the daemon-only `prompt.desktopVisit` panel (§4.11, never captured; its countdown runs to the card's `expiresAt`); `target.foreground` never holds a window on another desktop and ignores `moveDesktop`; the off-desktop bind detail names the live screenshot and the visit instead of `requestForeground`. The daemon requires helper ≥ 1.7.0 (§10.1). |
| 1 | 1.8.0 | Additive — app adapters: `target.scriptingCommands` (§4.7: the bound app's dictionary commands, structured, with event codes, enumerators and `bundleVersion`; hidden, refused and JavaScript commands left out; a dynamic dictionary left unread); `target.bind` results carry `app.path` and `app.version`; AppleScript refuses the Chromium family's `execute … javascript` (`CrSu/ExJa`) everywhere and, per run, every JavaScript door the bound app's dictionary declares, and its source check refuses any `javascript:` URL literal; the live-test-only `test.automation` (§9). The daemon still requires ≥ 1.7.0 and uses `scriptingCommands` only from a helper ≥ 1.8.0 (its version at `hello`). |
| 1 | 1.9.0 | No wire change: the bundle carries `winter-browser-host` (`Contents/MacOS`), the native-messaging host behind Winter for Chrome — its own protocol is [`WinterBrowserHost/PROTOCOL.md`](WinterBrowserHost/PROTOCOL.md). |
| 1 | 1.9.1 | No wire change — the live gate's fixes: a web page's state is never one folded line (WebKit's `AXDisclosing = 0` on every element no longer reads as collapsed; `full` has its own hard cap and says where it cut; a page's content folds last); a desktop visit raises the window's element and makes its app frontmost over accessibility (the by-id front and the key-window records are gone: they never switched desktops on macOS 26 and reached the user's window as a click), finds a capture-only window's element at the visit, refuses before anything moves when it can't get there, and returns the same way; the guardian counts only input a person makes (the window server's own events at an activation or a desktop change made a delayed self-activation "the user's switch"). |
| 1 | 1.9.2 | No wire change — the live gate's second round: a window in a full-screen transition (listed, on no Space for a moment) is not a closed one; an explicit `full` state is held to 48 KB as well; a desktop visit that switched late is undone, returns to the user's own window (made main), and is refused before anything moves when the user's window can't be told; in every focus blip and before a background window-targeted click the bound window is made its app's key window (after a blip's hand-back an app held no key window and later blips left it so: keys went nowhere, Edit › Paste stayed disabled, a first click only made the window key); a page menu WebKit keeps alive after closing counts as closed; a hover over a WebKit page that shows nothing new says so. Its review: the key-window step only when the window is not key (an app's focused element tells; a blip's hand-back is remembered as none), never over a menu, popover, sheet or a panel holding the keys, never for a click landing on another window, Chromium excluded (measured), the front re-read before it acts; a visit's late-switch watch undoes only the target's own switch and never fights a window the user changed; the window-gone watch suspends under the call's cancel, coalesced per pid; a diff surfaces what its folded base never showed. |
| 1 | 1.9.3 | Additive: `refused` gains `app_in_front` (the app came to the front while a background act was prepared: the keys or the click were not sent); `target.find`, `target.foreground`, `target.scriptingDictionary` and `target.scriptingCommands` take an optional `callId` (`cancel` reaches them; every call that can wait on a window's transition registers its cancel first). Behaviour — the live gate's third round and its review: a focus blip whose make-key step could not make the bound window the one the keys go to (a panel, a dialog or another window holds them; the app's window list unreadable; the app come to the front) sends nothing and refuses (`focus_not_placed` naming what holds the keys), while a popover or context menu of the bound window still takes them; the key-window read is made every time (a stale "stranded" mark never skips it, and is forgotten when the guardian stops and with the app's last target); `input` and `focusNow` are read where the app answers — inside the blip, and in the page when the app holds no key window — and a Tab in a `type` goes as keys; a diff counts as seen only the lines it keeps, and a whole new screen of rows is the state again; a visit's late switch is the user's only on input that can switch (⌘/⌃ chords, gestures, a click on the target or the Dock), and its return never anchors on the target's window. |
| 1 | 1.9.4 | No wire change — the live gate's fourth round: an app a blip's hand-back left with no key window is remembered until it is really activated (by anyone — seen by an always-on activation observer, no tap, no timer), its last target is lost or its pid dies; 1.9.3 forgot it when the guardian stopped, 3 s after a script, so the next script's first background click read the stale "key" answer, sent no make-key records and only made the window key (a page's own menu never opened). |
| 1 | 1.9.5 | No wire change — the review of round 4: a refused focus blip ends the ordinary way (the key focus handed back — naming no window when the user's can't be read — waited for, handed back again, the reroute removed only then, the guardian's restore), and what needs no focus record is refused before it; the user bringing the target forward during a blip or a focus click is their move (`app_in_front`, nothing undone or retired, never pulled back out), the app activating ITSELF on the focus record is undone and nothing is typed (`focus_not_placed`), and a refused focus click stops the typing; a focus with no window of its own counts when the app's focused window is the bound one; an attached list after a blip's hand-back no longer refuses the next burst; a visit's return never anchors on a window shown on the visited desktop; the late-switch watch counts a ⌘/⌃ hold with no chord seen, from the watch's start, the input source read at each change; a long or multi-line `type` with tabs says they went in as characters; `focusNow` takes the blip's answer only when nothing is readable after the act; off-screen additions no longer tip a diff into the full print. |
| 1 | 1.9.6 | No wire change — one rule decides whose move a change of the user's front app or desktop is (§4.12), asked by every path that used to decide on its own (the guardian, a blip's step, each key and its end, a click's preparation, the after-check, a visit's watch), each path that finds it the user's telling the guardian. So: a switch the user makes during a typing burst stops the typing with nothing handed back or restored, their keys in the target they switched into stay there; typing in their own app no longer makes a target's self-activation theirs; their ⌘-Tab right after a synthetic event is theirs; the hand-back with no readable window of theirs names none (the app takes back its own key window); a ⌘/⌃ hold with a mouse chord is no switch, a seen ⌘-Tab is one, a hold counts only from when it began; with no input source a late switch of the target is undone; a visit's return checks Space membership and each display's Space. |
| 1 | 1.9.7 | No wire change — the one rule's contract (§4.12: invariants I1–I5, checked after every event by a model-based test of the real engine in simulated time) and the code made to satisfy it: the rule owns every fact it reads — the agent's causes PER APP (a synthetic mark on the target never makes another app's change the agent's: an app the agent never touched coming forward is always the user's), causes that raise, operations still running (an AppleScript, a bind's window wait, `useWindow`) and pending launches; switch input as instants that explain one change only, only after the agent's last cause on that app, of a kind that fits (an app switch, a desktop switch, a click for its own app), never the generic gesture event, no ⌘/⌃ hold under Secure Event Input; a click's claim used up and gone once the user moves; one verdict per state until new facts. Every restore goes to the user's place as it is when it runs (a retry never lands over a move of theirs); the reroute sends each user key to their place by the rule; bind, `useWindow`, AppleScript and making the bound window main are judged from their start; a click on another app's window makes it their place at once; a late-heard activation of an untouched app is their place; an act's or an operation's end, and what is done to an app while it is in front, never outrank the user's input; a blip ended by its bound is no blip; the target coming forward before an act's first key stops it; the blip's end asks again while it waits; during a visit what the agent brings up is the visit's; the other display's return is followed by the ordinary return. |
| 1 | 1.9.8 | Additive: `target.act` results carry `guardian` (the Focus Guardian's notes since the last act) and `viewMovedBy`; `target.bind` and `target.useWindow` results carry `webContent` (§4.12). The model-based test made honest (its oracle reads only the world's own record; a faithful world — the helper's own windows, the menu bar, banners, picture in picture, panels, the desktop, a second display, launches, system dialogs, activation latency and refusals, async restores, late and reordered notifications, Secure Event Input) and what it found fixed: the agent's INDIRECT effect (an untouched app coming forward right after its action, with no hardware input of the user's since) is undone and said — never the first activation after the user's own launch, never a system dialog (left in front, said); a link pressed in an app that is not a browser opens in the background; a click through the helper's own click-through windows counts for the window under it, a click on the menu bar, a status item, a banner, PiP or a panel is no place, a click on the empty desktop is Finder's; a ⌘-Tab switches at its release, a release with no key seen explains only 0.7 s, a ⌃ hold explains what it passes and 0.45 s after its release, one input per click, inputs pair with the change they landed for (latest first), a claim uses its click, a second explanation only within 0.1/0.15 s; an act's cause never outranks the user's switch heard within 0.45 s; a restore's late landing (0.8 s) is undone and never a switch's second explanation; the consented foreground's own landing is consented unless a switch of the user's after it was issued explains it (their ⌘-Tab into the held app is theirs, never given back), it is brought forward over accessibility too, and rung 4 inside a hold leaves the hold alone; facts are judged as of when a state was first seen and a verdict of the user's is never taken back; a visit, a hold and rung 4 judge what is in front first, a visit never undoes what came before it and returns to the guardian's place, its end leaves the user only where they went; a desktop-only theft is put back, onto their window on their own desktop; Chrome for Testing is Chromium; a hover on a web page with the app held in front uses the real pointer; WebKit's lazily built accessibility tree is waited for at bind (≤ ~160 ms); no restore runs during a desktop visit (its own return aside); a Dock click is input for the tile's app, claimed; a switch of the user's heard late during a visit is their move, the consented foreground's landing heard late is where a theft goes back; an untouched app theirs by their input uses that input up; facts as of first seen survive a cleared verdict until another app's activation is heard; after a hold ends, a key in a blip goes to their place, and a blip hands back to their place when it moved during the blip; coming back to their place during a visit is their move. |
| 1 | 1.9.9 | Additive: `refused` gains `user_working` (I6: once the user works in a bound target — a click into its window, a key with no ⌘/⌃, a right/other click or a scroll while it is in front — every act and AppleScript on it is refused until it leaves the front; reads go on); the live-test-only `test.activate` takes `asUser` and `test.userInput` exists. Round 10, the user's rulings and the review of round 9: an untouched app is sent back only when CLEARLY the agent's (no input of the user's for 2.5 s, an opener action of the agent's within 1.5 s, no Secure Event Input) — else left in front, never adopted, said "<App> came forward around your action — the user's view may have moved"; background opens are the agent's from before they start; an app started within the last 60 s, not by the agent and never seen in front, is the user's own launch on its first activation even if its launch notice was missed; only an `AXLink` to another site is rerouted, never in an Electron/CEF app; one consented-foreground exemption per app; a visit whose user moved on the way back keeps the rule's place; a restore's retries stop on anything the rule leaves alone; a hold's end moves the place at that time; a consented app's explaining input stays a short second explanation; an activation heard of another app clears the kept verdict; a past change heard late, its desktop unknown, is never a desktop switch's; the daemon fences the guardian's notes (they name apps by their own names). |
| 1 | 1.10.0 | Additive: `refused` gains `remote_debugging` (Floor F, the Phase 4 spine §2.4: no act on a Chromium browser's inspect page or its "Allow remote debugging?" dialog). Round 11 — the live Web Store report and the review of round 10: a window-targeted click goes to the BOUND window wherever another of the app's document windows covers the point (only a menu, popover, sheet or page popup over it takes the click — a Chrome window behind another sent every click into the user's front window); a web click sent as events, and a click at a point, that showed no effect say so ("no visible effect") instead of nothing; an app the agent's own action cold-launches is not the user's launch (judged at its process start), a system dialog started on demand never is; I6 counts a key only when the window server delivers it to the bound app (not ⌥-Space, not Escape), a click's pending work waits 1.5 s, the work is forgotten when the guardian stops; "clearly the agent's" reads only the opener acts and launches from before the moment judged; a refused act opens no span and records no cause; on another desktop, a web press that changed nothing and typing whose field could not be given the focus answer `needs_desktop_visit` (the visit is offered) instead of a note or `focus_not_placed`; a hover on a native view in the background that showed nothing says so, as for a web page (an AppKit tracking area follows the real cursor); a check box's or radio's checked state is claimed only from 1/0. |
| 1 | 1.11.0 | Additive (`target.act`'s `linkOpensViaDaemon` → `linkOpen`). The review of round 11: on another desktop a press's check runs outside the press's own catch (the visit offer was swallowed and the ancestors pressed); a process is part of an app only when it truly is (Spotlight's or a launcher's panel never marks the front app worked in); with the bound app in front and another of its windows key no pointer event goes to the bound window (`app_in_front`); a click's window is decided by z-order (another document window never takes it; a popup of the user's window neither); the desktop visit is offered after an unconfirmed press only when it can matter (not for an element already in its pressed state, nor a copy or refresh) and the element is never pressed again (clicked once in the visit); the user's work outlasts the guardian until another app activates; a click's effect check counts windows at every layer, and a right, other or modified click at a point is not judged; Floor F widened (any Chromium app, any non-web scheme, capture-only binds, dialog windows with no page, the cache keyed on every layer); the floors refuse before the guardian span; a late launch notice judges nothing clearly. Round 10's rulings: the work watcher (I6 between scripts, with the private event path off too); Electron/CEF links to another site rerouted (same site = registrable domain) and `action(ref, "press")` on a link too — additive: `target.act` takes `linkOpensViaDaemon` and then answers the link in `linkOpen` instead of opening it, for the daemon to open through its own door (the opener's access and per-app card, not bound); Secure Event Input held by the front bound app counts as work. |
| 1 | 1.12.0 | No wire change — round 13. The review of round 12: the work watcher starts and stops under one lock; the agent's own activation of another app never ends the user's work mark (only an app in front with no live agent cause does); Secure Event Input held by the front bound app counts as work only when corroborated (a secure field focused, or the user's input in the last 2.5 s); `menu()` and a menu shortcut are refused `app_in_front` before aiming when another window of the front app is key (not inside the session's own desktop visit); Floor F covers Chromium-based browsers only, a standard window is a dialog candidate only after a complete walk found no web area, its scan cache keys on the normal and dialog levels, its title rules are anchored; the work and CPS taps are re-enabled when the system disables them and their run loops end; a scroll's work check is throttled to 4 a second; the unconfirmed-press mark is on the element the act named; the same site compares whole IP addresses and treats shared-hosting suffixes as separate sites; `action(ref, "open")` on a link is rerouted too; a popup the agent's own act opened takes its next click even in a covered bound window; a second hold of one app inherits the first's place to give back, given back only when the last ends. The dogfood queue: a bind by title prefers an exact standard window (never a find bar's partial match), an exact title on another desktop over a partial one here; a shortcut into a sheet or panel is not resolved to the app's menu (⌘⇧G in an Open panel is not Find Previous); an accessibility action refused whose effect is seen is reported done, with no pointer fallback; a row or list item in a sheet or panel is selected over accessibility; after an unconfirmed press, the desktop visit looks first and never clicks an element twice. The user's click brings the bound window forward only on a mouse-up within 4 pt (a drag brings nothing); a click into the app already in front records a quiet switch instant (seed 1067). §4.12 documents I2′ (where the engine and the model test's oracle disagree, and which is right). The dogfood queue, part 2 (a Material web app): a paste into a field that shows its text and does not show the paste is `busy` + `uncertain` (Uncertain), never a success; a page's hidden text input is a zero-size stand-in or one parked off the window sideways — never a field scrolled out of view, nor a combo box; a field scrolled out of view is scrolled to before the focus click (never a click outside the window); a value longer than 200 characters says its length and that `state({within})` shows it whole, and a read within one element shows values up to 8,000 characters. |
| 1 | 1.13.0 | No wire change — round 14. Queue item 1: an opener act says which apps it can open (the app acted in; a non-browser's default web and mail handlers; a menu command's Help viewer and default browser; Finder, the Dock and launchers any app), an open or a launch only the app it opens, and an untouched app outside every such reach is never clearly the agent's — left in front and said (a third party's `open <url>` and its Terminal were undone after a click in Chrome); the user's click into the app held in front drops the hold's give-back. Measured: a type-21 notification names the activated app, never who asked. The review of round 13: the visit's look-first compares the NAMED element's own state only (never an ancestor's evidence, a frame, a title or the neighbourhood — a new dialog near it counts); an agent popup is a window over the bound one that a click, press, key or selection opened, for the next act only; the visit's exception needs the visit arrived and made for that app and window; the focus click scrolls only after its guards, contained in the window that takes the click there; a paste is looked for as sent and as a rich target renders it, a field changed otherwise is done and said, only an unchanged one is `uncertain`; under Secure Event Input recent hardware input is no work, the focused element's text changing since the agent's last act is (sticky until the app leaves the front); a title bind never moves a window (the remote token, else the window here); Floor F's walk tells a page (too many nodes) from a walk out of time (still a candidate, never cached); every ⌘-chord refused `app_in_front` before the sheet/menu split; a multi-selection row must be the selection; a refused action's effect is looked for in the bound window only; the inspect title allows a profile tail; an editable web element still outside the window after scrolling to it is the page's stand-in. Also: Space or Return INTO a control a press acts on (a check box, a button) is one press, never a focusing press and the key (a check box toggled twice); a key with the focus in a sheet or panel is never its app's menu shortcut; a hover that revealed elements says how many; find() says a cut value's length. |
| 1 | 1.14.0 | No wire change — round 15. The review of round 14: a COLD launch is judged with any opener's reach, and an app whose process started within 1.5 s after an opener act (or while a launch of the agent's was pending) is never the user's own launch and never adopted — undone when clearly the agent's, else left in front and said; an act reaches Finder and the mail handler always, a non-browser's web handlers, the pressed link's own scheme handler, a menu command the same list plus the Help viewer, an AppleScript any app; a bind of a running app names its bundle; a press's effect counts a new window of the app anywhere; the Secure Event Input base is refreshed however an act ends; an unshown paste succeeds only when what changed holds the pasted text's letters and digits, and "held it already" only when the caret moved by its length; an agent popup survives acts that open nothing for 5 s; default handlers cached a minute; Floor F walks a slow window again at most every 5 s; a drag's button-down claims nothing. The live run's one failure (round 14's one-press rule): a navigation key aimed INTO a button or other press-acted control goes to where the focus is — no focusing press, never refused (End into a web button scrolls the page again); Space, or Return on anything but a check box or radio, is one press through the click's own press path; Return into a check box is refused. The user's ruling (round 14): under Secure Keyboard Entry a front bound app whose text changes is the user working until it leaves the front, refused "<App> is in front with Secure Keyboard Entry on and its text is changing — Winter waits until you switch away". |
| 1 | 1.15.0 | No wire change — round 16. The live run's I6 regression: an act already in flight checks the user's work mark before every focus placement, every key and every paste — nothing moves the focus inside a bound app once the user works in it (a type act's focus placement took them from Name back to Email 242 ms after their click). Only a NAVIGATION key (the arrows, Home/End, Page Up/Down, Tab, Escape, at most with ⇧) aimed at a press-acted control goes to where the focus is, said; any other key is refused. With the keyboard focus outside the control's page, the page gets it by a click on a blank spot (never the control's press), and End, Home, Page Up/Down are done over accessibility when it still has none (a background WKWebView). THE LAUNCH RULE written in §4.12: the user's input between the agent's act and a launch makes it theirs; within reach and clearly the agent's, undone; else left and said; a left app the user types or clicks in is their place; "any reach" only gates never-adopt, and only the first sighting. Finder in reach only for a reveal; a web link's handler never in a browser. |
