# Winter Computer Use helper protocol

**Protocol version: 1**

Helper version: `1.20.1` (the contents of [`VERSION`](VERSION))

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
| `daemon` | every method except `view.*` | `escPressed`, `targetLost`, `permissionsChanged`, `desktopVisited`, `watchEvent` |
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
is kept, the engine is held to the one it took, and the share is reported. THE FROZEN REFERENCE (the user's process
ruling, round 17): the oracle — `GuardianSim*`, `GuardianSimRun`, `GuardianModelTests`' expectation lists — and its
world's fakes (`FakeAX`, `RecordingPoster`, the fakes' user key) change only in commits of their own, each citing a ruling,
never with engine code; and the WHOLE surveyed seed ranges pass but for a known-failing list that only shrinks (the
ratchet — since 1.18.0 the default seeds 1–20 too, each known-failing seed pinned to its violation class, and a child
of the survey that crashes or hangs fails it; since 1.19.0 every range runs a second time with the user clicking into
the target's window while an act on it runs, against its own known-failing list, and the named regression tests' seeds
run once, in child processes, each test asserting its scenario's trace signature or verdict). Round 19's oracle widenings,
stated with what they flip: an act refused because the user works in T is kept as right when their work there ended only
by T leaving the front for a moment no notification showed the engine — bounded to a departure no longer than a
notification can be late in the world (120 ms; 400 ms in the stress sweep) — which turned five mid-act seeds from
failing to passing when it came (1032, 1052, 1069 and, with an ordinary target, 31 and 60) and, on this version's engine
and world, two (1069 and ordinary 60: the other three pass without it); a click on an app's window or Dock tile whose own
landing has not come yet explains that app coming forward (the ordinary target's mid-act 56). The world's click on the
empty desktop brings Finder forward — with an ordinary target Finder is its own process — never T. Its world has the helper's own windows, the
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
  were undone after a click in Chrome), and no Secure Event Input at any moment of those 2.5 s (1.15.0: the guardian keeps
  its readings — one on before the window and none off since counts; the user's keys in a Secure Keyboard Entry Terminal
  that had just left the front were taken for quiet; 1.16.0: it is read on every session-tap event too, a reading kept
  when it changes, so a password field's span with no change of the front app is seen; 17b: and polled 4 times a second
  while the guardian runs — a keyboard-only secure period brings no tap event — never read for a synthetic event). In every other case it is left in front, never adopted
  as their place, and said ("<App> came forward around your action — it may have been your action's doing or the user's;
  it was left in front"). THE LAUNCH RULE (ruled in round 16, 1.15.0) — an app coming to the front for the FIRST time
  after a process start that follows an agent opener act (any reach) or a pending launch of the agent's within 1.5 s:
  (1) the user's LAUNCH-CAPABLE input between that act and the start (1.18.0, R17-d: a click, Return/Enter, a chord with
  ⌘/⌃/⌥, a function key — never plain typing, a key-up or a scroll), or an INTERACTIVE LAUNCHER within the causal window
  before the start and AFTER the agent's latest act that reaches the app (R18-a; strictly before the start — R18 L1),
  whose destination LAUNCHES (a Return the tap delivers to Spotlight's or a launcher's panel, a click on the Dock tile of
  an app not running or Launchpad, a Finder double-click on an application or a document — never the Trash, a stack, a
  folder, or a tile accessibility can't read): THEIRS, adopted as their place; (2) no input of theirs in that interval, the app WITHIN the act's reach, and no input
  of theirs in the 2.5 s before the start: CLEARLY the agent's — undone when no input of the user's came since the start,
  and said; (3) otherwise — left in front and said, never adopted. "Any reach" decides only the never-adopt gate, never an
  undo. Under that gate ((2) and (3)) the user's switch input adopts the app only when it is SEEN and TARGETED at it
  (1.18.0, the controller's ruling: a click on its window or its Dock tile, a ⌘-Tab whose Tab the tap saw — it lands on
  what comes forward); a swipe, a ⌃-arrow, a click on a status item, a banner or a panel, a ⌘ release with no Tab seen
  adopt nothing there, and the table's own verdict decides — never the running app's "clearly the agent's". And a
  restore never pulls the user out of an app left in front once they have typed, clicked or scrolled in it (1.18.0: a
  scroll in its window is work per I6, so it is using it): their input there makes it their place. A launch LEFT in front has had its first activation: a later coming forward of it (a
  visit's return) is never read as the first activation of a launch of the user's. The rule is a decision table in the
  helper (`CULaunchRule`, facts → verdict, its first matching row deciding), a test walking every row and every
  combination of its facts; every path that attributes a launch decides through it (1.18.0) — the never-adopt gate, the
  undo and the adoption — every fact read from the world (a process start's facts kept from its launch notice; the first
  sighting as of when the state was first seen), and a fact-flip test flips each fact in the world and sees the verdict
  change as the table says.
  Never undone either: the first activation of an app after a launch the agent did not make
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
  visit's own return aside): the visit owns the view, and its end brings the user back — except where they went
  themselves: a switch of theirs INTO the visited desktop after the visit's own way there (a swipe, a ⌃-arrow, a ⌘-Tab)
  makes that desktop their place, and the visit's end does not return them to where it began (1.19.0, the controller's
  ruling); it is judged once — its input used up there — so the visit's end and a later key read the same verdict. The
  visit's own way there is never such a switch: only once the visit had arrived (its app seen in front on a desktop
  other than the one it began from — their place's, else the one active then; macOS activating it on their desktop
  before the switch lands is no arrival) and
  after that another app was seen in front on ANOTHER desktop, with no raise of the agent's on it in the last 1.5 s —
  they left it, or were returned (whatever that state's verdict: a late restore landing on their own desktop while they
  are there counts); another app in front on the visited desktop, the agent's own included, and the visited app moved
  to another desktop by the agent's act are no leaving it (the review of round 19, M1, and its final review, HIGH 1),
  and the visit's end judges what is in front FIRST, so a switch of theirs that landed but is not heard yet is found
  before any return is issued — and judges again whatever changed during that judge, so its decision is made on a
  view the guardian has judged.
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
  process — the annotated tap's target — and is no work in the app; 1.15.0: nor a key the focus blip's reroute sends to
  the user's place while the app is in front by the agent's doing, not their place), a right or other click or a scroll in its window,
  while it is in front — the agent is hands-off it: every act and AppleScript on it is refused at once, `refused` with reason
  `user_working` ("the user is working in <App> right now — wait and retry, or ask them"), until it is no longer in
  front; reads (state, find, screenshot, waits) go on. Switching there to look blocks nothing. (1.11.0) The work is seen
  between scripts too — the WORK WATCHER, a narrow listen-only tap (keys, mouse downs, scrolls; no pointer moves, no
  content logged) that runs while any target is bound, a public API independent of the private event path — and it
  outlasts the guardian's stop: another app activating (the always-on activation observer) or the app leaving the front
  ends it. A process counts as the app only when it truly is part of it (the app is responsible for it, it is the app's
  child, or its executable lies inside the app's bundle — never another accessory or agent process). Under Secure Event
  Input held by the bound app in front itself, the user is taken to be working in it. A refused act is no operation on
  the app and no cause (the floors included). IN FLIGHT (1.15.0: before every focus placement, key and paste; 1.16.0,
  round 17 — at ONE chokepoint): an act already running stops the moment the user works in the app — every
  accessibility write or action on the app's elements (or of a process of it; an element whose process can't be told
  counts as the app's) and every input event that STARTS or CONTINUES something (a key down, a button down, a drag's
  move, a scroll, a pointer move) is checked, and none is sent: the act ends `refused` `user_working` ("… so the rest of
  it was not sent"), a burst keeping its own "typed N of M"; a drag or a click stopped part-way releases its button where
  it stopped (every rung's pointer check asks the work mark — round 17b). The up of a down already sent still goes
  (nothing is left held down in the app); no lone up goes for a down that was not sent. STICKY (round 17b): once the
  act was stopped, or the user's work mark landed on the app at any moment since the act began, the rest of the act is
  refused — the user leaving the app meanwhile reopens nothing; an AppleScript once stopped refuses the rest of its run. Writes to ANOTHER app inside the act (a restore of the user's app) go. A
  menu command checks again, right before its press, that the bound window is the one it would act on and that the
  user does not work in the app (the walk before it can take a second). An AppleScript's send hook asks before EVERY
  Apple Event: once the user works in the bound app, no further event is sent and the run ends `user_working` (what it
  did before stays done).
- **I5.** Every path that can see the user's front app or desktop change — the guardian's activation and desktop
  observers, a focus blip's make-key step, each of its keys, its end and its waits, the reroute, a background click's
  preparation, the act's after-check and late check, a bind, `useWindow`, an AppleScript, making the bound window main,
  a restore's retries, a desktop visit's start, watch and return, the held foreground's and rung 4's start, the guarded
  `AXFocused` write's check (1.19.0, the review of round 19's M3: it undid a click of the user's into the target that
  landed during the write, before the guardian had heard it) — asks this
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
3. A click of theirs into its window (a claim, 1.5 s) after the agent's last cause on that app, or heard within 0.45 s
   of the click (1.19.0: a click that activated nothing never covers the agent's own act a second later; within the
   0.45 s band — the same every switch input gets — it can still cover an activation of the agent's after a click that
   activated nothing, a hung Dock tile or a non-activating panel, an accepted residual): the user's —
   using up that click's input. And the activation that
   brings the window they clicked into forward with its app (the helper's bring at the release), landing late — within
   0.8 s of the bring, its claim used by an earlier landing — with no switch input of theirs since the click: the
   user's, ONLY on the clicked window's own desktop (the release records it), only with no raise of the agent's on that
   app since the click (a cause, or for the front app an act's raise), and used up by its one landing (1.19.0; the review
   of round 19, H1: an act in flight raising another of its windows on another desktop is the agent's).
4. A desktop change that follows their own move into that app, with no cause of the agent's on it since — nor a raise
   of the agent's on it, the front app's included, unless an unused switch instant of theirs after that raise explains
   it — for that app or for none, of a kind that fits (an app switch fits a desktop change of the app already in front
   only when it is a ⌘ release whose Tab the tap did not see — never a seen ⌘-Tab, which picked its app) — and is used
   up by it (1.19.0, H1 and the final review's HIGH 2): the user's. An accepted residual: a bare ⌘ tap with no key looks
   like such a release (seed 1068's missed Tab), so it can adopt the agent's raise of the front app onto its other
   desktop — bounded: only after the raise, within 0.7 s of the release and 1.5 s of their own move into the app, and
   used up once.
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
bundle), claimed like a click into its window; on the tile of the app ALREADY in front (1.16.0, round 17): their place
at the click, as a click into its window in front is — no activation will come to claim it. A click elsewhere in the Dock, on a status item or the menu bar, a
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
into a touched app is undone (the tap sees nothing); and WHERE a seen ⌘-Tab landed (round 19, the review of round 18's
L5 — a deliberate widening of the launch rule's "a ⌘-Tab landing on it"): the release comes 10–70 ms before the landing,
an activation's notification carries no time and may be heard after the next change, and the CPS tap that names the
activated app runs only while a script runs — the model-based test's seed 1017 has the launched app come forward 3 ms
BEFORE the ⌘-Tab's release and be heard after it, so "the activation that follows the release" would name the wrong
change. The seen ⌘-Tab's instant therefore counts as targeted at whatever app comes forward while it is alive and
unused, and the oracle reads it the same way, keeping both answers where it can't tell. THE RESIDUAL, plainly: a ⌘-Tab
after the launch that changed nothing (it landed on the app already in front), or whose change has not been heard yet,
stays alive and unused for up to 10 s, and an app the AGENT launched that comes forward in that time is adopted as the
user's place (`targetedExplanation` takes it) — a move of the agent's taken for theirs. It was weighed against the other
error: a narrowing that misses the real landing undoes a move of the user's. Unmeasured: hardware-origin modifiers under Secure Event Input
(run107 measured posted ones); and — UNVERIFIED (the review of round 18) — that SkyLight keeps the user's app as the
front PROCESS during a focus blip's focus records: the menu command's pre-press re-check (round 17's H2) reads the front
process, so it depends on that.

### 4.13 Watches (wake triggers)

User rulings 2026-10-12: the agent can arm a trigger — "wake me when the user clicks Submit", "when “Sent” appears" —
and end its turn; the daemon wakes the session when it happens. On an app, the helper does the watching: the daemon arms
a WATCH on a bound target and the helper sends ONE `watchEvent` (§7.1) when it fires or can no longer fire. A watch never
acts: it only looks.

| Method | Params | Result |
| --- | --- | --- |
| `watch.arm` (1.17.0) | `{targetId, watchId, condition, expiresAt?}` | `{element?: {role, name}, targetLabel}` |
| `watch.cancel` (1.17.0) | `{watchId}` | `{}` — idempotent: an unknown or ended watch is no error |

- `watchId` is the daemon's own id for the trigger (at most 64 characters); every `watchEvent` names it. `expiresAt`
  (epoch ms) is the daemon's: it expires the trigger itself; the helper only drops the watch silently 10 s after it, as a
  backstop (with none, after 8 h).
- `condition` is exactly one of: `{kind: "clicked", ref}` — the user clicks the element (or something inside it);
  `{kind: "appeared", text}` — the text comes to be shown in the window; `{kind: "gone", ref}` / `{kind: "gone", text}` —
  the element, or the text, is no longer shown; `{kind: "changed", ref, settleMs?}` — the user changes the field's value,
  fired once it has stayed the same `settleMs` (default 1,500, at most 60,000); `{kind: "titled", title}` — the window's
  title comes to contain the text. A `ref` is a `target.snapshot` ref; a text or title is 1…500 characters, matched as
  `target.waitFor` matches (names and non-secure values, case and diacritics folded, the first 1,500 elements read).
  `submitted` and `navigated` are for browser tabs only: refused `invalid_params`.
- **Arming** checks, in this order, and arms nothing when one fails: the params' shape — `watchId`, `targetId`, the
  condition (`invalid_params`); a `watchId` already armed (`invalid_params`); more than 64 watches in the helper
  (`busy`); the Accessibility grant (`permission_missing`); the target bound (`target_lost`) and alive (`target_lost`);
  never Winter (`refused`, `winter_itself`); the window exposes accessibility (a capture-only bind: `unsupported`,
  `data.reason: "no_accessibility"`); never System Settings' Privacy & Security (`refused`, `privacy_pane`); the ref's
  element exists (`stale_ref`); never a password or payment field, nor anything inside one (`refused`, `secure_field`);
  a STATE condition (`appeared`, `gone`, `titled`) that already holds (`not_allowed`, `reason: "already_met"` — the
  controller's ruling: only a false→true transition after arming fires); last, the arming daemon connection still open
  and the request not given up (`cancelled` — an arm that would outlive its connection arms nothing). An engine that is
  going away answers `unsupported` with `data.reason: "engine_gone"`; an older helper answers `unsupported` ("unknown
  method"). A refused arm keeps nothing.
- **The answer**: `element` — the watched element as `target.snapshot` names it: its role words and its title, else its
  description, else its placeholder; `targetLabel` — "<App> — <window title>" (the title as the state header prints it:
  app window titles are not redacted). Both are screen text: the daemon fences them for the model.
- **A watch lives on its own** (the controller's ruling: better than keeping the target bound). It holds the target's
  pid, window and element itself (and reads the window through its own element and ref cache, never touching the
  target's refs), so `target.release`, `session.ended` (a script's reset, a worker restart, the worker's idle end) never
  end it. It ends on `watch.cancel`, on its one `watchEvent`, when the
  daemon connection that armed it closes (silently — the daemon reads its connection closing as the helper gone and ends
  each trigger itself), or at its backstop (silently). An armed watch keeps the helper running (§8.1).
- **What fires it** — only what the USER did, never Winter's own input:
  - `clicked`: a HARDWARE LEFT mouse-down (the controller's ruling: no other button) on the element or inside it. The
    helper's own listen-only session tap for the left mouse-down alone (no other button, no keys, no moves) runs only
    while a `clicked` or `changed` watch is armed — the same public API as the work watcher (§4.12), covered by the
    Accessibility grant: no other permission, no prompt. A click outside every watched window (as last read) is judged
    with no window-server query; one in the watched app's window (the window under the point) is the element's when it
    lies in the element's frame read in the last 1.5 s; else the app's own hit test (`AXUIElementCopyElementAtPosition`)
    is asked directly — never queued behind the app's work — and asked again while the app is busy; an element GONE
    right after a click in its window (the click closed its sheet) counts, unless a fresh frame of it puts the click
    elsewhere. An event with a source process (the helper's own stamped ones, another process's synthetic ones) never
    counts — except, on a live-test instance only, the live suite's test click (§9). A hardware click is the user's by
    its source alone: Winter's own input in flight never drops one. The point is dropped once judged; nothing of it is
    logged or sent.
  - `changed`: the user's input must explain the change. Keys can't be seen without Input Monitoring (never asked for),
    so a change counts as the user's when the field (or something inside it) holds the keyboard focus while its app is
    frontmost, or when their hardware click went to the field within the last 30 s (to its window within 3 s). A change
    no input of theirs explains becomes the new baseline; one back to the arming value is no change; a field that goes
    away while a change of theirs is settling fires.
  - `appeared`, `gone`, `titled`: any false→true transition — "Upload complete" appearing after the user's action, a
    build finishing — that Winter's own input did not cause.
  - **Winter's own input**: a change that lands while a request that can send input to that app is in flight —
    `target.act`, `target.applescript`, `target.foreground`, `target.useWindow` on any target of that app; `target.bind`
    and `apps.openDocument` for EVERY app (their app is known only once they answer) — or within 500 ms after it, is
    Winter's: a state transition becomes the baseline (it must go and come back to fire), a `changed` value too, and a
    `gone` element removed by it is lost. A change is dated by the FIRST notification of its burst (a look after the
    grace judges what landed after it as the user's); a look no notification asked for (the fallback, a settle) judges
    the whole interval since the last look.
- **When it looks**: an `AXObserver` per watched app (creations, destructions, values, titles, layout, focus, window
  creation — no moved or resized notifications), debounced 250 ms and at most 1 s apart while notifications keep coming;
  a text watch (`appeared`, `gone` with a text) reads the window's tree at most once per 2 s (the looks in between wait
  for the 2 s to end, keeping their date), a `titled` one reads the title alone; a fallback look every 10 s; a `changed`
  field's settle. Every look reads the window afresh on the app's own queue. Timers carry leeway, and while any watch is
  armed the helper holds off App Nap (a user-initiated activity that still allows idle system sleep). Measured (2026-10-12,
  a screen-free fixture of 300+ elements, one watch of each kind): idle, the watching engine 0.13–0.27 % of one core and
  +0.3 wake-ups/s, the watched app 0.4–0.5 % (the text watches' fallback reads); a storm of 10 changes a second, the
  engine 0.6 % and ~5 wake-ups/s, the text watch reading its tree 14–16 times in 30 s.
- **Lost** (`watchEvent` `outcome: "lost"`), with the helper's `reason`: "the app quit"; "the window closed" (a window
  that reads as gone is looked at again 1.5 s later — a full-screen or Space transition); "the element is gone (the
  window changed under it)"; "the element went away while Winter was acting in the app"; "Winter Computer Use lost its
  Accessibility permission".
- **The user can see that Winter waits** (the spine's rule): while a watch is armed and its app is frontmost with the
  watched window its front window on the active Space, the helper draws a ring around the element (clipped to the
  window) and a pill with a FIXED sentence that names only the element's own label — "Winter continues when you click
  “Submit”", "… when you change “Name”", "… when “Uploading” goes away"; the window-wide kinds name nothing ("Winter
  continues when this window changes") — never the text the model waits for, never its note. Click-through, never key,
  never activating, `sharingType = .none` (never in a capture); followed every 0.5 s while shown, gone with the watch.
  The front window is the app's top normal-level window on screen — or the watched window still, when a window of the
  app's own is above it and accessibility says the watched window is the app's key window: the window macOS attaches
  above a window being captured (Winter's own view of it resuming does that) and a popover never take the ring away.

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
| `watchEvent` (1.17.0) | `{watchId, outcome: "fired" \| "lost", at, detail?, reason?}` | a watch ended (§4.13), once: `at` is epoch ms; `fired` carries `detail` ("clicked", "appeared", "gone", "changed", "title now “…”" — screen text the daemon fences), `lost` its `reason` |

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
- **Idle quit:** after 10 minutes with no bound target, no active script and no armed watch (§4.13), the helper quits
  (if a request is still in flight, the countdown starts over). Open connections do not keep it running; the daemon relaunches
  it on its next call.
- `SIGTERM` quits the same way. On quit the socket file is removed (if it is still the helper's) and every
  connection closed.
- **Socket watchdog:** every 2 s (and whenever LaunchServices re-opens the running app) the helper re-binds
  if its socket file was deleted.

### 8.2 Sessions and connections

- A `daemon` connection that sends a request with `params.sessionId` owns that session. When the last
  connection that owned a session closes, the helper cancels that connection's in-flight requests, waits for
  them to wind down (at most 2 s), and runs `session.ended` for the session.
- A `daemon` connection closing also ends the watches it armed (§4.13), silently.
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
| `test.activate` | `{pid, asUser?, window?}` | `{frontmostSet, raised, frontmost}` — puts the suite's own "user's app" in front; `asUser` (1.9.9): first records what the USER's switch would leave (hardware input, a switch for that app, claimed), so the guardian treats it as theirs | — `window` (1.17.0): the title of the app's window to raise and make main instead of its front one
| `test.userInput` | `{pid}` | `{}` — (1.9.9) records the user's work in that app (I6), as their click into its window would |
| `test.capture` | `{windowId, source: "skylight"\|"stream", path, rect?: [x, y, w, h]}` | `{width, height, frameAgeMs?}` — writes one PNG (inside the instance's home only) of a window: the off-Space still path (`skylight`) or the latest frame of the test stream (`stream`); `rect` in the window's points |
| `test.stream` | `{windowId, on, fps?}` | `{running}` — starts/stops a desktop-independent ScreenCaptureKit stream on that window (the freshness measurement) |
| `test.automation` | `{pid?, bundleId?}` | `{status: "granted" \| "would_ask" \| "denied" \| "not_running" \| "unknown", code}` — may this helper already send the app Apple Events; asked with `AEDeterminePermissionToAutomateTarget(…, askUserIfNeeded: false)`, so it NEVER raises macOS's Automation question (the suite runs an AppleScript-backed scenario only on `granted`) |
| `test.userClick` | `{pid, name, stamp?}` | `{clicked}` — (1.17.0) the USER's click for the wake-trigger rows: a real left click posted at the HID level (the pointer moves there and is put back) at the centre of the first element of that app whose title or description is `name`, stamped `CUWatchTestStamp` — the one synthetic input a live-test instance's watches count as the user's (nothing else counts it, and no other helper has the route); `stamp: "winter"` stamps it as the helper's own instead (the converse row: a watch must ignore it). Its element search never runs on the main actor |

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
| 1 | 1.15.0 | No wire change — round 16. The live run's I6 regression: an act already in flight checks the user's work mark before every focus placement, every key and every paste — nothing moves the focus inside a bound app once the user works in it (a type act's focus placement took them from Name back to Email 242 ms after their click). Only a NAVIGATION key (the arrows, Home/End, Page Up/Down, Tab, Escape, at most with ⇧) aimed at a press-acted control goes to where the focus is, said; any other key is refused. With the keyboard focus outside the control's page, the page gets it by a click on a blank spot (never the control's press), and End, Home, Page Up/Down are done over accessibility when it still has none (a background WKWebView). THE LAUNCH RULE written in §4.12: the user's input between the agent's act and a launch makes it theirs; within reach and clearly the agent's, undone; else left and said; a left app the user types or clicks in is their place; "any reach" only gates never-adopt, and only the first sighting. Finder in reach only for a reveal; a web link's handler never in a browser. The launch rule as a decision table (`CULaunchRule`; the never-adopt gate reads it). Secure Event Input on at ANY moment of the 2.5 s quiet window is never quiet (the guardian keeps its readings). A launch left in front is never adopted later as the user's launch. A key the focus blip's reroute sends to the user's place is no work in the target in front (it stole the front mid-burst; the user's keys never reached it). |
| 1 | 1.16.0 | No wire change — round 17. I6 IN FLIGHT at one chokepoint (the review of round 16, H1): once the user works in the bound app, no accessibility write or action on its elements and no key down, button down, scroll or pointer move the act posts to it is sent — whatever path the act took (a caret-placing selection write after a web wait, an accessibility insert after the focus placement, setValue's writes, the selection holds, the End/Home fallback); the act ends `refused` `user_working`, a burst keeping its "typed N of M"; the up of a down already sent still goes. An AppleScript's send hook asks before EVERY Apple Event. A menu command checks again, right before its press, that the bound window is the one it would act on (H2). The focus blip's reroute marks the user's work itself when it lets their key through into the target (it was guessed from the front app). A navigation key aimed at a press-acted control is never sent to a focus just shown to be outside the control's page (refused `focus_not_placed`), and goes once per call; the accessibility fallback's "scrolled into view" is verified; a blank spot is proven blank over every node of the page. Secure Event Input is read on every session-tap event (R17-a). A click on the front app's Dock tile is their place at the click (R17-b). A late launch notice re-arms no "the user's launch". ROUND 17b (the independent review of round 17, same version): a drag stops at its next step once the user works in the app (every rung's pointer check asks the work mark; its moves are guarded like a start; the button released where it stopped) and a click stopped between its down and up still releases; the guard is STICKY for the rest of the act (stopped once, or the user's work mark landed since the act began), the AppleScript hook for the rest of its run; Secure Event Input polled at 4 Hz while the guardian runs and never read for a synthetic event; a blank spot by the app's own hit test at each candidate (no walk of the page); the reroute's work mark from hardware keys only; a navigation-key refusal with no focus reported says the app doesn't say where its focus is; the scroll-into-view check settles for 300 ms. |
| 1 | 1.17.0 | Additive — wake triggers on apps (§4.13): `watch.arm` and `watch.cancel`, the `watchEvent` notification (§7.1). A watch holds its own window and element, so a release or a session's end never ends it; it ends on `watch.cancel`, its one event, the arming daemon connection closing (silently) or a backstop past `expiresAt`. Only the user's action fires one: `clicked` on a hardware LEFT mouse-down on the element (the helper's own listen-only tap for the left mouse-down alone, running only while a click or change watch is armed — no new permission; never dropped for Winter's own input); `changed` when the field is focused in the frontmost app or the user clicked it; the state kinds on a false→true transition; a state or `changed` change never within Winter's own input to the app (in flight, or 500 ms after — dated by its notification burst's first time). A state condition already true at arming is `not_allowed` (`already_met`). The ring and the pill while the watched window is in front; an armed watch holds off the idle quit (§8.1); the live-test-only `test.userClick` (§9). The daemon arms only on a helper ≥ 1.17.0 (`HELPER_WATCH_VERSION`). <br><br>Also (the leftovers lane, no wire change): Floor F knows the "Allow remote debugging?" dialog in EVERY UI language: by the browser's own words for it, read from its locale packs (the open data-pack format, versions 4 and 5) under the resource ids whose English text is the dialog's title or first sentence — found again in each version, so renumbered ids follow — in every locale it ships, every installed version's folder, read once per version and ahead of need (off the act's path); the English rule stays one input. Fail closed: when no lexicon can be read and the browser does not show English, any dialog of it Winter can't tell apart is refused (`remote_debugging`, its own sentence: "… shows a dialog Winter can't tell apart from its "Allow remote debugging?" prompt … — ask the user to answer or close the dialog"); a slow page's window is no dialog for that rule. The lexicon knows which locale folders gave words: a browser showing a language outside them (or one that can't be read) is read fail-closed too; a capture-only bind fails closed on a dialog-like window (above the normal level, or an untitled normal window) of such a browser; the words are read ahead from the moment a Chromium browser is bound. Web selects (a pop-up button, or a combo box whose value can't be set, inside a page): a click on the select's hidden text input presses the select; `setValue` opens it, clicks the matching option (exact, then a unique prefix, then a unique "contains") and checks the shown value — EQUAL to the option's text, never one containing it — a page's own `<select>` is chosen in place, never opened; no match is `invalid_params` naming the options. A click on a web check box's or radio's wrapper, label or inner text presses that one control (verified by its value) — a label only when it is the control's own (its title element, or linked); a hidden input stands for a select only when it is the select's own zero-size stand-in in the same container. Tab, Space and ⌘A into web content, and a key aimed into a sheet or panel, say in `detail` when nothing visibly changed (the focus, the check box, the selection; no new sheet or window, no selected row or text changed; a Tab the field took itself is said as that); a click with no effect on a web button named like a file picker names `key("return", { into })`. An off-desktop `target.screenshot` within 1.5 s of an act waits (bounded, ~700 ms) for a picture that differs from the one before the act; otherwise its `detail` adds that it may predate the last action and names `screenshot({ live: true, reason })`; the wait stops on the call's cancel. A value over 8,000 characters says that `state({within})` shows its first 8,000. |
| 1 | 1.18.0 | No wire change — round 18 (1.17.0 is another lane's). THE LAUNCH RULE wired for real (R17-d, the controller's rulings): only LAUNCH-CAPABLE input of the user's between the agent's act and the process start counts for its (1) — a click, Return/Enter, a ⌘/⌃/⌥ chord, a function key; never plain typing, a key-up or a scroll — and an INTERACTIVE LAUNCHER within the causal window before the start makes the launch theirs too (Return into Spotlight's or a launcher's panel, a click in the Dock not on a running app's tile, a Finder double-click; the tap passes the click state). Every fact of the decision table is read from the world (a start's facts kept from its launch notice, the first sighting as of when the state was first seen) and the never-adopt gate, the undo and the adoption all decide through it: a gated first sighting gets the table's verdict, never the running app's "clearly the agent's" (an app launched half a second after the user's drag was undone as quiet three seconds later). Under the gate only a SEEN, TARGETED switch adopts (a click on its window or Dock tile, a ⌘-Tab whose Tab the tap saw). A scroll in the window of an app left in front makes it the user's place (the controller's ruling: it is work per I6). I6's pending click mark follows the order of the user's input: another app's activation heard before the clicked app's, with no switch input of theirs since the click, no longer takes it back (the agent typed into the app they had just clicked into); the clicked app's own activation heard once another app is in front spends it. The model-based test: R17-d's oracle; the in-flight invariant exercised (an agent drag; every event that starts or continues something watched, to the target or its content process; a counter that must be positive; a mid-act click of the user's, opt-in); the ratchet's runner (a per-child deadline, stderr kept, known-failing seeds pinned to their violation class, the default seeds 1–20 checked); named regression tests per review scenario. THE LEFTOVERS LANE (folded in): Floor F knows the "Allow remote debugging?" dialog in EVERY UI language: by the browser's own words for it, read from its locale packs (the open data-pack format, versions 4 and 5) under the resource ids whose English text is the dialog's title or first sentence — found again in each version, so renumbered ids follow — in every locale it ships, every installed version's folder, read once per version and ahead of need (off the act's path); the English rule stays one input. Fail closed: when no lexicon can be read and the browser does not show English, any dialog of it Winter can't tell apart is refused (`remote_debugging`, its own sentence: "… shows a dialog Winter can't tell apart from its "Allow remote debugging?" prompt … — ask the user to answer or close the dialog"); a slow page's window is no dialog for that rule. The lexicon knows which locale folders gave words: a browser showing a language outside them (or one that can't be read) is read fail-closed too; a capture-only bind fails closed on a dialog-like window (above the normal level, or an untitled normal window) of such a browser; the words are read ahead from the moment a Chromium browser is bound. Web selects (a pop-up button, or a combo box whose value can't be set, inside a page): a click on the select's hidden text input presses the select; `setValue` opens it, clicks the matching option (exact, then a unique prefix, then a unique "contains") and checks the shown value — EQUAL to the option's text, never one containing it — a page's own `<select>` is chosen in place, never opened; no match is `invalid_params` naming the options. A click on a web check box's or radio's wrapper, label or inner text presses that one control (verified by its value) — a label only when it is the control's own (its title element, or linked); a hidden input stands for a select only when it is the select's own zero-size stand-in in the same container. Tab, Space and ⌘A into web content, and a key aimed into a sheet or panel, say in `detail` when nothing visibly changed (the focus, the check box, the selection; no new sheet or window, no selected row or text changed; a Tab the field took itself is said as that); a click with no effect on a web button named like a file picker names `key("return", { into })`. An off-desktop `target.screenshot` within 1.5 s of an act waits (bounded, ~700 ms) for a picture that differs from the one before the act; otherwise its `detail` adds that it may predate the last action and names `screenshot({ live: true, reason })`; the wait stops on the call's cancel. A value over 8,000 characters says that `state({within})` shows its first 8,000. ROUND 18b (the review of round 18, same version): an interactive launcher only where its destination launches (the Dock tile of an app not running, Launchpad, a Finder double-click on an app or a document; an unreadable tile is no launcher) and only after the agent's latest act that reaches the app (R18-a); no slack at the start (input at or after it is not between); 'no input since the start' is a table fact; a scroll is use only for a gesture begun after the app came forward, never momentum (R18-b). |
| 1 | 1.19.0 | No wire change — round 19 (the review of round 18's leftovers, and the review of round 19). I6's pending click mark: the clicked app's own activation, heard once another app is in front, is judged as of its OWN moment — with no switch input of the user's after the click, what is in front came from input before it and landed after the clicked app, so the landing counts (an act in flight on that app stops) and the mark is spent; with switch input after the click nothing counts (L8). The helper's bring of the window the user clicked into (a bound target's background window, at the button's release) is the click's: landing late, within the restore-late window, with no switch input of theirs since the click, it is theirs, never undone as the agent's — only on the clicked window's own desktop, only with no raise of the agent's on the app since the click, and used up by its one landing; a desktop change after their move into an app is never theirs over a raise of the agent's on it since, unless their switch input came after the raise (the review of round 19, H1). A switch of the user's into the visited desktop, after the visit's way there, makes it their place and the visit's end leaves them there — judged once, so the end and a later key agree; the visit's end judges what is in front first and reads it again after (the controller's ruling; L2); a visit arrives only on a desktop other than the one it began from, and is left only by another app, not raised by the agent, seen on another desktop — never by another app on the visited desktop or the visited app moved by the agent (M1, the final review's HIGH 1); a desktop change over the agent's raise is theirs only through an unused, fitting instant after it, used up — an app switch fitting a desktop change of the app in front only as a ⌘ release whose Tab was not seen (HIGH 2, the re-review's HIGH; a bare ⌘ tap its stated residual); a visit begun with their desktop unknown begins on the one active then; a click's claim counts only after the agent's last cause on the app or within 0.45 s (MEDIUM); the visit's end judges again whatever changed during its judge. The guarded AXFocused write's check asks the one rule: a click of the user's into the target landing during the write is theirs, never undone (M3, mid-act seed 1067). L5 decided as a stated widening (§4.12, its residual). The model-based test: T's field starts unfocused and the focus and press-watch waits run at their live values (M2); the mid-act click is a standing run of the ratchet (every range again, never skipped, its own known-failing lists); the world's click on the empty desktop brings Finder forward (with an ordinary target Finder is its own process); oracle gaps closed (an app left in front stays left when the user's first use of it beat the engine's hearing; a refusal is right when the user's work ended only by a departure from the front no notification showed, bounded by a notification's lateness; a pending click on an app's own window or tile explains it); R18-a's Finder legs, with a test that tells a folder from an application or a document; pins by class: mid-act 1014 (I2), the same app on two desktops — the mid-act list's baseline {1014, 1022, 1062, 1067} only shrinks, 1067 leaving it on M3's fix; named regression tests for rounds 10–12 by trace signature or verdict, and every named seed run once in child processes (M3). |
| 1 | 1.19.1 | No wire change. The watch ring and pill stay while the watched window is its app's key window even when a window of the app's own sits above it — macOS attaches one above a window being captured (a session's view of it resuming), and a popover sits there too; before, the ring vanished the moment the view resumed capturing the watched window (§4.13). |
| 1 | 1.20.0 | No wire change — the leftover probes on a real Chrome (2026-10-13). A Chromium BROWSER's page reaches the tree: `AXManualAccessibility` (Electron's and CEF's switch) is still set first, and when no web area appears within ~1 s, `AXEnhancedUserInterface` too (the one Chrome builds its web tree on, what VoiceOver sets) — once per process, browsers only, never an Electron or CEF app. Measured on Chrome for Testing 156 windowed behind the user's app: `AXManualAccessibility` answered `kAXErrorAttributeUnsupported` and no page appeared — before, in front, behind again — until `AXEnhancedUserInterface`, after which it was there within 3 s. A web combo box that takes no typed text (none of a text entry's attributes: `AXNumberOfCharacters`, `AXSelectedTextRange`, `AXInsertionPointLineNumber`) is a select even when its value reads settable: `setValue` opens it and presses the option. Chrome reads a `<div role="combobox">` select that way; the value write did nothing and the answer said "set the value". A key with `{ into }` is watched like one with the focus already there: a Tab that left the focus where it was, and a ⌘A that left the field not wholly selected, say so (the watch was armed only for keys with no `into`; `key("tab", { into })` said "pressed tab" with the focus unmoved). Floor F with no page URL to read (the page absent from the tree): the bound window's title, or its selected tab's, naming the inspect page refuses the act (a key went through with chrome://inspect shown). `AXEnhancedUserInterface`, its cost and its end (the controller's ruling, and the review's): it is what VoiceOver sets — per PROCESS, kept while the process runs until a client turns it off. It moves and resizes nothing itself, and Winter never moves a browser's windows; its known side effect is that window frame changes made through accessibility can animate or land in steps (window managers turn it off around their own moves). Chrome builds and keeps the accessibility tree of every tab of that process while it is on (CPU and memory); the user's browsing in it is otherwise unchanged. "A browser" here is Floor F's own test (a known bundle, or a Chromium app that declares http(s): Brave Beta, Opera GX, Comet — never Electron or CEF). Winter sets it only when the page did not appear otherwise, and it is WINTER'S only when the app answered the read just before with OFF (Chrome for Testing 156 answers it: false, then true once set — measured; an app that does not answer still gets it, never as Winter's). Winter's flag goes off again — re-read ON just before (unanswered or off: left as it is), and never while VoiceOver, Switch Control, Full Keyboard Access or Voice Control is on — when the last target in that process is released (a release, a session's end, a lost target) and when the helper ends (a quit, the idle quit, SIGTERM: `applicationWillTerminate`). The flags Winter set are recorded as `{pid, process start time}` in `<home>/run/computer-use-ax-flags.json` (0600); a helper that ended without clearing them (a crash, a kill) is followed by one that, at its start, clears each only in THAT process (same pid AND start time) still answering ON, then drops the record. Residual: another assistive tool macOS does not name (a keyboard-driven clicker reading the tree) that came to rely on a flag Winter set may lose it at Winter's release until it sets it again. The after-act picture window (1.17.0's ~1.5 s, and its label's) runs from when the act's RESULT returned, not from its input: an act whose answer came seconds later (Chrome activated itself and was put back) had its window spent before the next screenshot. A Chromium window on ANOTHER desktop may not update its accessibility (nor its picture) until it is seen: an act's "nothing changed" there (no visible effect, a key not taken, a box that did not change) gets "…'s page is on another desktop, where it may not update its accessibility until it is seen — what it reads may predate the action, so this is unverified; screenshot({ live: true, reason }) shows the window now", and `find()` within 10 s of an act there says the same in its note. Measured: Chrome full screen on its own Space — the page toggled while the answer said the press did nothing, and find() read the box unchecked. |
| 1 | 1.20.1 | No wire change — the leftover fixes, from the measured evidence (2026-10-14). A web combo box is a select when it has no editable ancestor (`AXEditableAncestor` / `AXHighestEditableAncestor` — a field is its own), whatever text attributes it carries: Chrome for Testing 156 gives a select-only `<div role="combobox">` `AXNumberOfCharacters`, `AXSelectedTextRange` and `AXInsertionPointLineNumber` too (measured), so 1.20.0's rule left it a value write that did nothing. The element's attribute NAMES are read (twice: a failed read is unknown, never "none"); still unknown, the text-attribute rule decides, so a field never turns into a select on a read that failed. Safari's select-only combo box is unmeasured (WebKit's attributes for it not read on a real page yet). A picture's label names the app in at most 60 characters, so the label and its after-act tail always fit the daemon's 800 (the daemon now keeps a target screenshot's detail to 800 characters and an act's to 1,000: the 300 cut the "may predate the last action" tail). Measured, no change: `key("tab", { into })` into a background Chrome page moves the focus (the app's focus on the next field ~120 ms after the key) while the page fires no focus event (its window is not key) — the answer saying nothing of it was right. |

**Pending** (the open panel, 2026-10-14; no wire change — the controller folds it into the next helper version's row):
- Measured on a live session (Chrome's Open panel from a page's upload button): the panel is drawn by macOS's
  `com.apple.appkit.xpc.openAndSavePanelService` (its own process, launchd its parent, started the second of the click),
  shown in Chrome's sheet window and bridged into Chrome's tree as a `sheet`. Keys are posted to Chrome's pid; ⌘⇧G with the
  panel's file list focused never opened Go to folder — in the background, after `requestForeground`, and after a live
  screenshot — and once ran Chrome's own Find.
- Keys, typed characters and a paste's ⌘V into a SHEET drawn by that service go to the service's own process (`target.act`
  `key`/`type`/`paste`, and `setValue`'s typing fallback; `keyboardTarget`'s other uses unchanged) — only when
  accessibility names a running instance as the owner of the element or of an ancestor up to its sheet, never by
  elimination and never one serving another app: an IN-PROCESS sheet (its elements the app's own) keeps its keys in the
  app whatever service runs for another window (the review, MED-1). UNMEASURED: which pid accessibility reports for the
  remote panel's elements, and whether the service takes a posted ⌘⇧G and the typed path — the cu-live chrome rows "a
  native Open panel — ⌘⇧G and the path …" and "… — the skill's §19 recipe …" measure both against `input.files[0].name`
  (the §19 row goes on in the Go to folder field when `type` stops there; both close the sheet in a `finally`).
- File panels' floors (the reviews, MED-2 and the security re-review; `Core/CUCore+FilePanel.swift`), each closing a way
  around the others. A protected location: the save floor's names anywhere (shell startup files, agent config files,
  `.ssh`, `LaunchAgents`, `LaunchDaemons`, `.winter`, `.winter-dev`, `.claude`), and under the home any hidden folder or
  file and `Library/Keychains` / `Library/Cookies` — the SAME set `upload-paths.ts` uses (a test reads the Swift lists and
  keeps them equal) — judged on the CANONICAL path: `~` expanded, a relative path made absolute against the panel's folder
  when it says (`AXDocument`/`AXURL`), else judged by its names alone (`../.aws` is protected), `.` and `..` resolved,
  symlinks resolved by `realpath` on the longest existing prefix, `/System/Volumes/Data` dropped, compared without case.
  (1) Text for ANY sheet or panel (`type`, `paste`, `setValue`, a typing `key`) is refused `save_path` BEFORE it is sent
  when it names one alone, after the field's current value, or after what was typed into that panel since its last choice
  (per target, so a path split over calls into a Go to folder field accessibility doesn't show is judged whole); (2) after
  the write, the named field's and the focus's VALUE is judged, cleared when it takes a value, and refused; (3) an act
  that CHOOSES — the default button (any but Cancel when it names none), Return, Enter, ⌘O or ⌘↓ into the panel, a Return
  inside typed or pasted text, a double-click or Open/Confirm on an item — first reads what it would choose (selected
  items' `AXURL`/`AXFilename`/title/description/value, fields, pop-ups, what was typed) and a protected one refuses it;
  when nothing can be judged (nothing readable, the 600-element cap, or relative text onto a folder it can't see) and text
  was sent into that panel, it fails CLOSED ("the user can pick the file themselves") — with nothing typed (the user's own
  navigation) it goes ahead; (4) a `drag` whose source is a file item (an `AXURL` on it, two parents or two levels of
  children) is refused for a protected file before anything moves.
- The third security pass: ⌘V into a sheet or panel judges the clipboard's string (with the field's value and the panel's
  typed text) and each file URL on it before the key is sent, and records the string as typed; ANY agent act in a panel
  (a click, a key, the sidebar, ⌘⇧., a disclosure triangle) arms its fail-closed choice — only the user's own navigation
  (no agent act there since it opened) passes unreadable; an item with no URL gets a path from its row and its
  `AXDisclosedByRow` parents (`.ssh/id_ed25519`); a double-click whose point nothing answers for, or a choosing key with
  the focus not shown in the panel, while a sheet is open on the bound window, is judged as a choice in that sheet and
  fails closed when unreadable; a drag's source is judged by its name too, and a file item in Finder or a panel whose
  path can't be read is refused; a relative path's names always count, the panel's folder known or not. The resolver
  never stats or resolves anything under `~/Desktop`, `~/Documents`, `~/Downloads`, `~/Library/Mobile Documents`,
  `~/Library/CloudStorage`, `/Volumes`, `/Network`, `/net` or `/home` (macOS would ask the user before the helper reads
  there): such a path is judged LEXICALLY. Residual: a symlink planted INSIDE one of those folders (e.g.
  `~/Downloads/x` → `~/.ssh`) is not followed, so a path through it is judged by its own names only. `upload` refuses a
  file with another hard link (`nlink > 1`), at the check and again at the private copy's open.
- The fourth pass (over-refusal): every file-panel floor and the fail-closed arming apply to REAL file panels only — a
  sheet or panel that names itself `NSOpenPanel`/`NSSavePanel` (`AXIdentifier`), is drawn by the panel service, has a
  Save panel's name field, or hosts a file browser (an item with a file `AXURL`, or a search field, a folder pop-up and
  an outline or browser); an alert ("Don't ask again" and OK), Print, or Return with any other sheet up act exactly as
  before. The choice reads the SELECTION first, from the browsers themselves (the focus and its parents, the panel's
  first three levels; `AXSelectedRows`/`AXSelectedChildren`): a readable selection or field is enough, whatever the
  600-element walk reached; it fails closed only when neither can be read. A bare "Cookies" or "Keychains" is no
  protected name (the Library rule is for paths under `~/Library` only). Edit ▸ Paste (or Paste and Match Style) through
  `menu` into a file panel judges the clipboard as ⌘V does.
- The fifth pass: the text, value and protected-path floors (and the Return-in-text choice check on the typed path)
  judge in ANY sheet or dialog again — a real in-process Open panel can show none of a file panel's marks; they refuse
  only protected paths, and in a sheet that is no recognised file panel the choice judges only what reads as a path (an
  alert's or Print's labels and pop-ups are no file names). Only the fail-closed arming, the open-sheet choice and the
  unreadable-choice refusal need a recognised file panel. The OUTERMOST sheet on the window is the panel (a nested Go to
  folder sheet is judged with the panel's typed text). The file-panel verdict is cached per sheet: a yes for its life, a
  no for a second.
- The sixth pass: outside a recognised file panel, text and values are judged only by their path-like tokens (starting
  with / or ~, or holding a /; a `.pem`, `.p12` or `.key` among them; any component exactly a secret name) and by bare
  tokens EXACTLY one of `.ssh`, `.aws`, `.gnupg`, `.kube`, `.docker`, `.netrc`, `.npmrc`, `.pgpass`, `id_rsa`,
  `id_ed25519`, `id_ecdsa`, `id_dsa`, `credentials`, `login.keychain-db` — never the names-only rule on a bare word
  ("Update .gitignore", "see .env.example", "wait...", ".NET 8" are typed); a field there is NEVER cleared (refused, left
  as it is). The choice outside a recognised panel also judges the selected item's name, its parent rows' names and the
  folder pop-up against that exact list (a click-only way into `.ssh`); a Find panel's ".gitignore" goes ahead.
- The seventh pass: outside a recognised file panel a bare word counts only when it is exactly a secret dot-name (`.ssh`,
  `.aws`, `.gnupg`, `.kube`, `.docker`, `.netrc`, `.npmrc`, `.pgpass`, `.git-credentials`, `.azure`), an `id_*` key name
  (`id_rsa`, `id_ed25519`, `id_ecdsa`, `id_dsa`) or a `*.keychain-db` — "credentials" is an ordinary word ("fix login
  credentials", OK on a "Credentials" row), protected only as a component of an absolute or `~` path under `.aws`; the
  full path rules apply only to tokens starting with / or ~, a relative token with a / only by its components' exact
  secret names (".github/workflows/ci.yml", "src/.eslintrc", "https://site/.well-known/…", "certs/server.key" pass;
  "foo/.ssh/id_ed25519" does not). The choice's ROW path outside a recognised panel (never text) also counts `.config/gh`
  and anything under `Library/Keychains`. Residual: a panel that fails the scope test, reached by clicks alone, with no
  `AXURL` and a secret that matches none of these names (a project's `.env`, a token file under another name) is not
  refused — the scope test recognises every file panel measured so far.
- The eighth pass: outside a recognised file panel the floors judge only what the agent itself types or pastes there
  (and the choice also its selection, rows and folder pop-up) — never a value the sheet already held: a Git client's
  settings sheet prefilled with "SSH key: ~/.ssh/id_ed25519" takes OK and Return, and text added to that field is judged
  alone. The panel state (typed text per target, file-panel verdicts per sheet) is read and written under one lock: acts
  on two apps' queues at once share it.
- Still UNMEASURED on the remote view: which pid accessibility reports for the service-drawn panel's elements (the
  routing needs the service's), whether a Go to folder field it opens is in the app's tree at all (the floors' typed-text
  record covers one that isn't), whether the panel says its folder (`AXDocument`/`AXURL` — relative text is otherwise
  judged by names alone and fails closed at the choice), and whether `realpath` on a path inside a TCC-protected folder
  (Desktop, Documents, Downloads) raises a privacy prompt for the helper.
- A key with the keyboard focus already in a sheet or panel (no `into`) is watched like one aimed there with `into`: no
  sheet or window opened, focus, value, selection and caret range unchanged → "nothing new appeared in the panel after …".
  Both only in a FILE panel (a Save panel's name field, a service-drawn sheet, or the shape: a search field, a pop-up and an
  outline or browser), never for a caret move (arrows, ⌘-arrows), ⌘C, Space or ⌘⇧. (the review, LOW-1). A chord
  with ⌘, ⌃ or ⌥ adds that it went to the app itself, which may run its own command or drop it while a panel is up, and
  names the way into an Open or Save panel: the full path typed into its file list (Go to folder opens on "/" or "~"),
  then Return.
- A new window that is a sheet on the bound window (not in the app's accessibility windows; a sheet child of the bound
  window with that window id or the same frame) is said to be in the state already — never "useWindow(id)", which bound
  it with no accessibility. On a web browser bound as an app it adds the tab route: `browsers.tab({ url })` and
  `upload(ref, paths)` on the page's file input, no dialog (a file from outside the working folder copied into $TMPDIR
  first, never a key, credential or dotfile — `upload`'s own refusal says so, and only for a file no floor protects: a
  file in Winter's home, on the read-deny list, or in a hidden folder of the home or a keychain is refused plainly —
  the review, MED-3).
- Typing into an element that is not a text field (no text role, not editable, no editable ancestor, not a page's hidden
  input) says "… is not a text field, so the characters went to it as keys and nothing can be read back" — never "<App>
  doesn't expose this editor's text".
