# Winter for Chrome protocol

**Browser-host protocol: 1**

**Extension protocol: 1**

This is the wire contract between the three pieces that let Winter's browser engine drive tabs in the user's own
Chromium browsers: the **Winter for Chrome** extension (`extensions/winter-for-chrome`), the native host
**`winter-browser-host`** (this package), and the Winter daemon (`winter-core`,
`packages/core/src/computer-use/browser/extension/`). Where this file and the code disagree, the code is right and
this file is a bug.

The two numbers above must equal, at all times:

| Where | Browser-host protocol | Extension protocol |
| --- | --- | --- |
| `Sources/WinterBrowserHostCore/HostProtocol.swift` (the host) | `HostProtocol.browserHost` | `HostProtocol.extensionProtocol` |
| `packages/core/src/computer-use/browser/extension/protocol.ts` (the daemon) | `BROWSER_HOST_PROTOCOL` | `EXTENSION_PROTOCOL` |
| `extensions/winter-for-chrome/src/protocol.ts` (the extension) | `BROWSER_HOST_PROTOCOL` | `EXTENSION_PROTOCOL` |

`packages/core/test/computer-use/extension/parity.test.ts` reads the two lines above and all six constants and fails
until they agree; keep the lines' exact format.

## 1. Pieces and identities

| Piece | Where | Identity |
| --- | --- | --- |
| Extension | Chrome Web Store ("Winter for Chrome") and Edge Add-ons ("Winter for Edge", the same build under another name), publisher yanlingLabs; the dev build unpacked | The store ids (`ExtensionIds.dist`), each assigned by its store at the first upload. Dev: `jikdcokcpbacalfeipkognejnlnobbbf`, fixed by the dev manifest's `key` (`extensions/winter-for-chrome/keys/dev.pub`, a public key) |
| Native host | `Winter Computer Use.app/Contents/MacOS/winter-browser-host` (the dist helper inside Winter.app, and the dev helper `bun run dev:helper` builds) | codesign identifier `com.winter.browserhost` / `com.winter.browserhost.dev`, Winter's team, hardened runtime, no entitlements, a **stated** designated requirement: `identifier "<id>" and anchor apple generic and certificate leaf[subject.OU] = "37N77U9RSZ"` |
| Native-messaging host name | the host manifests (§8) | `com.winter.browser` (dist), `com.winter.browser.dev` (dev) |
| Daemon endpoint | `<home>/run/browser.sock`, mode `0600`, created by the daemon at boot (a stale file unlinked first) | `winter-core` (dist) / `com.winter.core.dev` (dev), Winter's team |

**The extension-id allowlist** is defined once per language and kept equal by the parity test: the daemon's
`extension-ids.ts`, the host's `ExtensionIds.swift`, Winter.app's manifest writer
(`apple/Winter/Sources/BrowserExtension/BrowserHostManifest.swift`), and the id the dev key derives. Dist holds the two
store ids, each assigned by its store at the first upload: Edge Add-ons' `bapmmpefcbjabfdfeehimdhldpjaoemd` and the
Chrome Web Store's `flfkppajaamjgfmdljlklfdffkdcmicc` (one line in each list). A Release Winter.app allows exactly these in the dist
host manifest it writes.

**The host's home** comes from its enclosing app's bundle id: `com.winter.computeruse` → `~/.winter`,
`com.winter.computeruse.dev` → `~/.winter-dev`. Anything else (a bare binary, another app) refuses to start unless it is
a test build (§9). The host never launches Winter, the daemon or the helper.

## 2. Hop 1 — extension ⇄ host (Chrome native messaging)

- **Start:** the extension calls `chrome.runtime.connectNative("com.winter.browser[.dev]")`; Chrome starts the host with
  `argv[1]` = the caller's origin, `chrome-extension://<id>/`. The host exits with status 1 unless that id is in its
  profile's allowlist (Chrome's `allowed_origins` already restricts this; this is the second look). Its parent process
  is the browser's main process: the host reports that app's bundle id and pid in `host.hello`.
- **Framing:** each message is a 4-byte little-endian length, then that many bytes of UTF-8 JSON.
- **Caps:** extension → host at most **16 MiB** per message; host → extension at most **1 MiB** (Chrome's limit for a
  host). The extension never sends a larger answer: it sends the request's answer as a typed `cdp_error` instead (a
  larger notification is dropped). Should one arrive anyway, the host skips it (keeping the stream in step) and, when its
  start shows it answers a daemon request (`"id":"d…"`), answers the daemon with that typed error at once.
- **stdout carries nothing but framed messages.** Every log line goes to stderr (Chrome keeps it in its own log), and
  never carries a message's content.
- **End:** Chrome closing the host's stdin (the port closed, the extension reloaded, the browser quit) ends the host.
- **`host.status`** — the host's own notification to the extension, never sent to the daemon:

  ```ts
  "host.status" { daemon: "connected" }                                   // host.hello answered: say hello now
              | { daemon: "unavailable" }                                 // nothing on the socket, or it closed
              | { daemon: "unverified" }                                  // the socket's process is not Winter's daemon
              | { daemon: "refused", code?: string, reason: string }      // host.hello refused (§3.3)
  ```

  Sent when the state changes; `connected` every time (each new daemon connection needs a new extension `hello`).

## 3. Hop 2 — host ⇄ daemon

### 3.1 Transport

- `<home>/run/browser.sock`, NDJSON: one JSON-RPC 2.0 object per line.
- **Caps:** host → daemon lines at most **16 MiB**; daemon → host at most **1 MiB** (one line becomes one native
  message). A daemon line over 1 MiB is a protocol violation: the host drops the connection.
- **Ids are strings, prefixed by their sender:** `d…` the daemon, `e…` the extension, `h…` the host. Both ends of the
  relay may send requests; responses are matched by id.

### 3.2 The daemon check (load-bearing)

Before the host writes a byte it verifies the process on the socket: `getsockopt(LOCAL_PEERTOKEN)` →
`SecCodeCopyGuestWithAttributes(kSecGuestAttributeAudit)` → `SecCodeCheckValidity` against the daemon's designated
requirement — dist `identifier "winter-core"`, dev `identifier "com.winter.core.dev"`, each plus Winter's team. On
failure it closes, sends nothing, and tells the extension `host.status { daemon: "unverified" }`. With no daemon it
says `unavailable`.

**Retries:** no daemon → after **2 s**, doubling to at most **60 s** while Winter isn't running, back to 2 s once
connected; unverified, or `host.hello` refused → every **30 s** (so turning Computer Use back on, or starting Winter,
needs no browser restart).

### 3.3 `host.hello` — the host's first request

```ts
"host.hello" { protocol: 1, client: "browser-host", hostVersion: string, hostPid: number, origin: string,
               browserBundleId: string, browserPid: number }
  → { protocol: 1, daemonVersion: string }
```

`hostVersion` is the enclosing helper's version. The daemon checks, **in this order**, and answers the first failure
with a JSON-RPC error whose `data.code` names it, then closes the connection:

1. the protocol → `protocol_mismatch` `{ expected }`;
2. `origin`'s id in the daemon profile's allowlist → `not_allowed` `{ reason: "origin" }`;
3. `browserBundleId` a known Chromium family → `not_allowed` `{ reason: "browser" }` (§3.4);
4. the host's code, **by the pid it reports** (`SecCodeCopyGuestWithAttributes(kSecGuestAttributePid)` against the
   host's stated requirement) → `not_allowed` `{ reason: "signature" }`;
5. `computerUse.enabled` → `disabled`.

**What the pid check is, exactly.** It checks that the process the connection says it is runs Winter's signed host — it
catches a host that is not Winter's (another build, a stale copy). It is no defence against a process of the SAME user,
which can name the real host's pid (the daemon's sockets give it no peer pid of its own) or open the 0600 socket
itself: **same-user code is outside this protocol's threat model**, as it is for the helper's socket and the daemon's
own — a process running as the user can already reach everything the user can. The host's audit-token check of the
daemon (§3.2) is what keeps the host, and so the extension's debugger, from talking to anything but Winter's signed
daemon. A first message that is not `host.hello` is answered `protocol_mismatch` and closed; no `host.hello` within
10 s closes the connection.

### 3.4 Browser families

| Family | Bundle ids |
| --- | --- |
| chrome | `com.google.Chrome`, `.beta`, `.dev`, `.canary`; `com.google.chrome.for.testing` (matched case-insensitively, as everywhere here) |
| edge | `com.microsoft.edgemac`, `.Beta`, `.Dev`, `.Canary` |
| brave | `com.brave.Browser`, `com.brave.Browser.beta`, `com.brave.Browser.nightly` |
| vivaldi | `com.vivaldi.Vivaldi`, `com.vivaldi.Vivaldi.snapshot` |
| opera | `com.operasoftware.Opera`, `com.operasoftware.OperaGX`, `com.operasoftware.OperaNext`, `com.operasoftware.OperaDeveloper` |
| arc | `company.thebrowser.Browser` |
| chromium | `org.chromium.Chromium` |

The browser app is what Winter's per-app approval and access settings name: one grant covers the browser as an app and
its tabs. The table is the engine's own (`packages/core/src/computer-use/browser/families.ts`); the host server reads it,
and a repo test keeps this list equal to it.

### 3.5 The relay

After `host.hello` succeeds the host forwards every object **unchanged** between its two framings, reading only the size
and the envelope (a JSON-RPC 2.0 object, and whether it is a request, notification or response). Raw CR/LF bytes —
only ever insignificant whitespace in valid JSON — become spaces on the way to the daemon. The host does **not** enforce
the CDP allowlist (the extension does, §7.3; the daemon never sends outside it). While no daemon is connected, a request
from the extension is answered by the host with `data.code: "disconnected"`; anything else is dropped.

## 4. The extension's `hello` (relayed)

On `host.status { daemon: "connected" }` the extension sends:

```ts
"hello" { protocol: 1, extensionVersion: string, instanceId: string /* a UUID kept in chrome.storage.local */, features?: string[] }
  → { protocol: 1, backend: { id: string, name: string } }      // id: "chrome", "chrome#2", "edge", …
```

- **Features** (1.1.0, additive — the protocol stays 1): what this build can do beyond 1.0.0's requests. The daemon
  offers a member only when its feature is named, so an older build answers "update Winter for Chrome" instead of an
  unknown method. `cdp3` — its bundled allowlist is Phase 3's (without it the engine subscribes to 1.0.0's events only);
  `present` (`tabs.present`); `userDone` (`user.done`); `mute`; `group` (`group.update`); `keepGroup` (`tabs.keep` with
  `group`); `windows`; `history`; `bookmarks`; `downloads` (`downloads.arm`/`downloads.release`, `download`); `tabFacts`
  (`Tab`'s `lastAccessed`, `group`, `windowId`); (1.2.0) `watch` (`watch.arm`/`watch.cancel`, `watch.event` — §5.5). The daemon's list (`EXTENSION_FEATURES`) names every one it knows; a
  repo test holds the extension's names to it.

- **Mismatch:** `protocol_mismatch` `{ expected }`, message `"update Winter for Chrome"` (the extension is older) or
  `"update Winter"` (newer). The daemon lists the browser as not connected with the same advice; the extension shows it
  on its badge and popup. The connection stays open: a later matching `hello` registers.
- **No browser engine in this daemon:** `unavailable`; the extension says `hello` again 30 s later.
- **Registration:** one transport per `instanceId`. The engine's registry gives an instance the same backend id for the
  daemon's lifetime, across reconnects (an MV3 service worker restarts often), so `chrome:418` stays valid; only a
  different instance of the same family gets `#2`, `#3`, … A second connection from the same instance retires the first.
  The id is the FAMILY's; the name is the browser app's own channel ("Google Chrome Beta", "Microsoft Edge Dev", "Google
  Chrome for Testing" — the engine's `browserForBundleId`), what the model and the per-app card show.

## 5. Messages after `hello`

### 5.1 Daemon → extension (requests)

| Method | Params | Result |
| --- | --- | --- |
| `tabs.list` | `{}` | `{ tabs: Tab[] }` — every tab of the browser profile, never a private window's |
| `tabs.create` | `{ url, sessionId, sessionTitle }` | `{ tab: Tab }` — `chrome.tabs.create({ active: false })` in the session's group "Winter · <title>" (created in the window the user used last, never a private one); `url` is http(s) or `about:blank`. Grouping is best effort: the tab is Winter's, and returned, even if the group step fails |
| `tabs.close` | `{ tabKey }` | `{}` — only an agent tab (`not_allowed` otherwise). The tab is ungrouped first (a group's last tab leaves no group, nor a saved group, behind), then DISCARDED (its page unloads with no `beforeunload`) and removed: a page's "leave this page?" prompt can neither be left as a native dialog nor bring anything forward — the browser brings a tab forward to show that prompt whatever raises it, a close or a navigation (measured on Chrome for Testing 156), and activates a neighbour once it is gone. Only a tab the browser will not discard (the active one, already in front) is closed with the debugger held and Page events on, accepting that agent tab's own prompt — never a user tab's, never outside a close. It answers once the tab is removed, or `timeout` if the page still holds out (10 s) |
| `tabs.keep` | `{ tabKey, group? }` | `{}` — hands an agent tab to the user for good: no longer an agent tab, out of its Winter group, never closed by Winter. With `group` (feature `keepGroup`): into the user's group of that name in its window (an existing one joined — never a Winter group — else a new one) |
| `tabs.present` | `{ tabKey }` | `{}` — feature `present`, the sign-in hand-off, sent only after the user chose "Show me the tab" on Winter's card: the tab becomes its window's active one and the window is focused — the ONE place the extension moves the user's view (§7.2). The tab is marked waiting: the overlay's waiting pill, a "!" on the toolbar button, and Done / Stop waiting in the popup (`user.done`). The wait ends with Done or Stop waiting, `debugger.attach` of the tab, `overlay {active: false}` from Winter, or the tab closing |
| `tabs.mute` | `{ tabKey, muted }` | `{}` — feature `mute`; only an agent tab (`not_allowed` otherwise) |
| `group.update` | `{ sessionId, title?, color?, collapsed? }` | `{}` — feature `group`: the session's own Winter group; the title keeps its "Winter · " prefix; never folded while the user has one of its tabs in front (the browser would switch them away: `not_allowed`) |
| `windows.list` | `{}` | `{ windows: [{ id, focused, tabs }] }` — feature `windows`; normal windows only, never a private one |
| `history.search` | `{ text, startTime?, endTime?, maxResults }` | `{ items: [{ url, title, lastVisitTime }] }` — feature `history`, read only; web pages only; `not_allowed` with `data.permission: "history"` until the user grants the optional permission (§7.1) |
| `bookmarks.search` | `{ text?, maxResults }` | `{ items: [{ url, title, folder }] }` — feature `bookmarks`, read only (no `text`: the most recent); folders and `javascript:`/`data:` bookmarks left out; `not_allowed` with `data.permission: "bookmarks"` until granted |
| `downloads.arm` | `{ tabKey, subdir, until, maxBytes }` or `{ tabKey, subdir: null }` | `{}` — feature `downloads`: the tab's next download that its page made (its URL or final URL is one the tab's own debugger sessions — its frames' too — announced with `Page.downloadWillBegin` after the arm, and the browser created it after the arm; a same-site item that comes before that announcement is held, its name undecided, for at most 3 s) is named `<subdir>/<name>` in the browser's download folder (`subdir` is `Winter/<hex>`, the daemon's) and reported (`download`); past `maxBytes` or `until` it is cancelled. Every other download is answered at once and left as the browser would have it. `not_allowed` with `data.permission: "downloads"` until granted |
| `downloads.release` | `{ id }` | `{}` — the daemon took the file: the item leaves the browser's downloads list (never the file itself) |
| `watch.arm` | `{ tabKey, spec }` | the watcher's answer `{ ok: true, installed, doc, met? }` or `{ ok: false, reason: "met" \| "gone" \| "doc" \| "noform" }` — feature `watch` (1.2.0), §5.5; refused `not_allowed` with `data.reason` `"page"` (a page that takes no script) or `"malformed"` |
| `watch.cancel` | `{ tabKey, watchId }` | `{}` — idempotent; the watcher (its ring and pill) leaves the page |
| `debugger.attach` | `{ tabKey }` | `{ viewport: [w, h], dpr }` — idempotent; the CSS viewport and the device pixel ratio from `Page.getLayoutMetrics` |
| `debugger.detach` | `{ tabKey }` | `{}` — idempotent; never closes the tab |
| `cdp.send` | `{ tabKey, method, params, cdpSessionId? }` | `{ result }` — `cdpSessionId` addresses a flattened child target (an out-of-process iframe). A top-level `Page.navigate` / `Page.reload` / `Page.navigateToHistoryEntry` of a background agent tab whose page may ask "leave this page?" first DISCARDS the page, then runs as asked (§5.3) |
| `cdp.subscribe` | `{ tabKey, events }` | `{}` — replaces the tab's forwarded set (a subset of the allowlist's events) |
| `overlay` | `{ tabKey, active, cursor?: { x, y, kind } }` | `{}` — best effort (§7.4) |
| `ping` | `{}` | `{}` |

`Tab` is `{ tabKey, url, title, active, agent, sessionId?, lastAccessed?, group?, windowId? }` (the last three with
`tabFacts`: when the tab was last in front, its group's title, its window): `tabKey` the `chrome.tabs` id as a string; `agent` true for
a tab `tabs.create` opened, by tab id — Chrome's own pin (which takes a tab out of its group) or a drag changes nothing,
only `tabs.keep` does; `sessionId` its Winter session. A tab the user drags into a Winter group stays the user's.

**Which agent tabs close, and when, is the engine's decision** (at its session's turn end unless marked; the user's
ruling): the extension only carries out `tabs.close` and `tabs.keep`, and never closes anything by itself — a restart's
orphans included (the engine closes those from the `tabs.list` it makes at the next registration, which reports every
agent tab with its session). Agent tabs and groups are remembered in `chrome.storage.local`, so a service-worker
restart, a daemon restart AND an update of the extension keep them. The record is cleared when the browser itself starts
(`runtime.onStartup`; a worker start with no word in 3 s on why counts as one — forgetting is the safe side): tab and
group ids last only one browser session, and an old id must never be taken for a new, restored tab — which is the
user's from then on.

### 5.2 Extension → daemon (notifications)

| Method | Params | When |
| --- | --- | --- |
| `cdp.event` | `{ tabKey, method, params, cdpSessionId? }` | a subscribed, allowlisted event of an attached tab, its params REDUCED by `cdp-reduce.ts` (`CDP_EVENT_PARAMS`: never headers, cookies, post data, initiators or page objects; strings cut at 4,096, arrays at 32; `Fetch.requestPaused`'s response headers only `content-type`, `content-disposition`, `content-length`). Before 1.1.0: Network events carried only `requestId`, `timestamp`, `type` |
| `user.done` | `{ tabKey, done }` | feature `userDone`: the popup's Done (`true`) or Stop waiting (`false`) for a tab Winter handed to the user |
| `download` | `{ tabKey, download: { id, state, name, url?, path?, bytes, totalBytes?, mime?, error? } }` | feature `downloads`: an armed tab's download `started`, `progress` (its bytes so far), `done` (the absolute `path`, and `url`: the http(s) address it came from after its redirects, which the daemon holds to its dangerous-domain floor before taking the file), or `failed` |
| `tab.gone` | `{ tabKey, reason: "closed" \| "crashed" }` | the tab closed (once per tab), or its renderer crashed |
| `debugger.detached` | `{ tabKey, reason: "canceled_by_user" \| "target_closed" \| "idle" }` | the user dismissed the browser's debugging bar; the page went where the debugger cannot follow; or 5 minutes without a command |
| `stop.pressed` | `{ tabKey }` | the user clicked the extension's toolbar button while Winter was driving that tab (one per driven tab) |
| `watch.event` | `{ tabKey, watchId, outcome: "fired" \| "pressed" \| "lost" \| "url", at, cause?, url?, key?, match?, title?, reason?, own? }` | feature `watch` (1.2.0): what a watch saw (§5.5) |

The daemon reads `canceled_by_user` as the user taking the tab back ("the user stopped Winter from controlling this tab",
a lost tab). For `idle` and `target_closed` the tab is still open: the transport hands the engine the debugger's own
`Inspector.detached` event for the tab's top-level session (whatever the subscription), and the engine attaches again
when it next needs the tab. Only a tab really closed or crashed is reported gone.

### 5.3 Notes for the engine

- An `Input.*` event that runs a handler which opens a JavaScript dialog is answered only once the dialog is handled: send
  it without waiting, handle `Page.javascriptDialogOpening` with `Page.handleJavaScriptDialog`, then collect its answer.
- The overlay's one element is `<winter-agent-overlay>` (light DOM, under `documentElement`). It takes no pointer event
  at all, so an `Input.*` click reaches the page element underneath; the engine leaves it out of its tree walk and hit
  tests. Its arrival and departure are the only DOM mutations it causes (cursor moves happen inside its closed shadow
  root).
- An idle or `target_closed` detach arrives as `Inspector.detached` (§5.2): attach again. `canceled_by_user` is
  `detached_by_user`.
- **Leaving a page that may ask "leave this page?"** The browser brings a tab forward to show that prompt, whatever
  raises it — a close, `Page.navigate`, `Page.reload` or a history move — even when the prompt is reported and answered
  over CDP (measured, Chrome for Testing 156). So for a top-level `Page.navigate` (no `frameId`), `Page.reload` or
  `Page.navigateToHistoryEntry` of an AGENT tab that is NOT the active tab and whose page may ask — Winter sent it any
  `Input.*`, or the user made it the active tab, since its last cross-document load (`Page.frameNavigated` of the top
  frame with `type: "Navigation"`; a page restored from the back/forward cache keeps its state; after a service-worker
  start every agent tab counts) — the extension first discards the page (`chrome.tabs.discard`: it unloads with no
  `beforeunload`), waits for the discarded page's stand-in document to load (at most 1 s), and then sends the engine's
  own command, unchanged, on the SAME debugger session. A discard keeps the session (measured: no detach, the enabled
  domains and auto-attach stay on, history entry ids are unchanged), so the engine gets the browser's own answer
  (`{ frameId, loaderId }` for `Page.navigate`) and the browser's own events, in this order:
  1. the discard's: `Page.frameDetached` and `Target.detachedFromTarget` for the old subframes and their sessions,
     `Runtime.executionContextsCleared`, a main-world `Runtime.executionContextCreated`, and a stand-in document's
     `Page.lifecycleEvent` init/DOMContentLoaded/load/networkIdle, `Page.domContentEventFired` and `Page.loadEventFired`
     — carrying the OLD document's loaderId, with NO `Page.frameNavigated`;
  2. then the navigation's own, as for any navigation: `Page.frameNavigated` (`type: "Navigation"`, the answer's
     loaderId), its contexts, its lifecycle, newly auto-attached subframe sessions.

  The engine needs nothing new for this: its world ends with `executionContextsCleared`, a navigation counts only from a
  `Page.frameNavigated`, and a DOMContentLoaded counts only for the committed loaderId — the stand-in's events are all
  in before the command is sent. Unchanged, straight to the browser: the active tab (the prompt shows where the user
  already is; the engine answers it), the user's own tabs (their prompt protects the user's unsaved work), a page with no
  input since it loaded, a subframe's navigation (`frameId`, or a child session), and a tab the browser will not
  discard. Two answers exist only for browsers that behave otherwise (not seen on Chrome for Testing 156):
  - the discard ENDED the debugger session: the engine gets `debugger.detached { reason: "target_closed" }` (so
    `Inspector.detached`), the extension attaches again and runs the command there, and the call fails `cdp_error` with
    `data: { navigated: true, cdpMessage: "the page was navigated, but the browser started a new debugging session for
    it — read the page again" }`: navigated, the events went to a session the engine no longer follows — treat it as
    navigated and read the page again;
  - the browser gave the discarded tab a NEW id: the old `tabKey` is `tab.gone { reason: "closed" }`, the new tab is the
    same session's agent tab, the navigation is made there, and the call fails `tab_gone` with
    `data: { navigated, tabKey: "<new>" }`.

### 5.4 Errors

JSON-RPC errors (`code: -32000`) whose `data.code` is one of `disconnected`, `tab_gone`, `attach_refused`, `not_allowed`,
`cdp_error` (with `data.cdpCode` / `data.cdpMessage` when the browser answered one), `timeout`. An unknown method is
`-32601`.

### 5.5 Watches (1.2.0, feature `watch`)

A wake trigger waits for the USER to do something in a tab (click an element, submit a form, change a field, a text or
a title appearing or going away, the page moving) — and the extension keeps it with NO debugger, so the browser shows
no debugging bar while Winter waits. The engine reads the element once, while the tab is attached, in the "winter" world:
its role and name, the secure-field floor (a password, one-time-code or payment field, or anything in a payment
provider's frame, is never watched), and a LOCATOR (`performance.timeOrigin` of its document, its path from `<html>`
through open shadow roots, and its steady identifying attributes). `spec` is the daemon's `WatchSpec`
(`packages/core/src/computer-use/browser/page-runtime/watch.ts`): `{ watchId: "wk_<12 hex>", kind, locator?, text?,
title?, url?, anyForm?, settleMs?, pill, expiresAt }` (`url`: a `navigated` watch's words, which the EXTENSION matches).
An element inside a child frame is kept on the engine's debugger path instead (the extension never injects into a
subframe).

- **Injection:** the page watcher — `wakeWatcher`, the daemon's own source bundled in, the same function the engine's
  page runtime runs in the winter world — with `chrome.scripting.executeScript({ world: "ISOLATED" })` into the
  extension's own isolated world in the tab's TOP frame (never the page's main world, never the winter world, never a
  declared content script). `watch.arm` injects it with `initial: "refuse"`: a state condition already true answers
  `met`. The extension injects it again into each new document of the tab (`tabs.onUpdated` `status: "complete"`):
  `initial: "fire"` (a new document that shows it is the transition), or `"baseline"` when the navigation came within
  500 ms of the extension's own debugger input or navigation. A watch of an element whose document went answers `doc`
  there: the extension drops it and sends `watch.event { outcome: "lost", reason: "doc" }`, `at` the time that load
  began (`status: "loading"`). `"loading"` alone never loses one — Chrome says it for a same-document change too (a
  pushState, a new fragment: measured, Chrome for Testing 156) — but an element's watch is never left silent: a load
  that does not complete is looked at 10 s after it began, a new document that takes no script (a browser page, a store
  page) loses it at once (`reason: "doc"`), and a tab whose watcher has not been heard from for 65 s (its heartbeat
  comes every 20 s, every minute in a throttled background tab; a renderer that crashed sends none) is injected again
  — where no script runs any more, its element watches are lost. A tab the browser replaces under a new id to navigate
  it (§5.3) takes its watches along (the new id's next document: `"baseline"`).
- **Reports:** the watcher sends the extension a runtime message from that world (`winter.wake.event`; the page cannot —
  there is no `externally_connectable`); the extension relays it, from frame 0 of a tab it keeps that watch for, with
  only these fields: `outcome` `fired` (the user's trusted event, or a false→true transition of a state condition),
  `pressed` (a trusted press of the watched element or form — a navigation right after it is the user's own), `lost`
  (`reason` `gone`: the element went and could not be found again; `at` when it went); `at` (the page's clock); `cause`
  (`fired` of a submit or a change: when the user's trusted pointer or key event on the submitter, in the form or in the
  field landed — within about a second before; a page script's own `requestSubmit()` or `execCommand()` has none and
  fires nothing; Enter counts as a press only in a text-like field or on a submit button, a click only on its `click` or
  its release over the element); `url` (the top document's ORIGIN AND PATH, "?…" where it had a query and "#…" where it
  had a fragment — never the rest, ≤ 4,096 characters); `title` (a title watch, ≤ 300); and `own: true` when the
  extension's own debugger sent the tab any `Input.*`, `Page.navigate`, `Page.reload` or `Page.navigateToHistoryEntry`
  in flight at `at` (or at `cause`) or within 500 ms before. A `navigated` watch has no page part beyond its pill: the
  extension sends `outcome: "url"` on every `tabs.onUpdated` URL change (a same-document one too) with the new
  address's shape as `url`, `key` (a 16-hex digest of the WHOLE address, `watchUrlKey`: another key is another
  address) and, for a watch with words, `match` (whether the whole address contains them — matched here, so the query
  never leaves). Never a value the user typed, never coordinates.
- **Residual:** a page whose own capture listener on the window, registered before the watcher's, stops an event's
  propagation (`stopImmediatePropagation`) keeps the watcher from seeing it; the wait then ends by its expiry or the
  model's cancel.
- **What the user sees:** while armed, a pill at the page's bottom left with the daemon's fixed words ("Winter continues
  when you click “Submit for review”" — only the element's own label) and a ring around the element, in a closed shadow
  root under one `<winter-wake-overlay>` element that takes no pointer event (the engine leaves it out of its tree walk
  and hit tests). Watches of one page in different worlds (this extension's and the engine's debugger path's) share ONE
  pill list: each overlay host names its watches (`data-pills`) and only the first draws them all.
- **Ending:** `watch.cancel`; the tab closing; the link to Winter dropping (every watcher is taken down, and the daemon
  reads each watch as lost); and the watcher itself, at its 20-second heartbeat (`winter.wake.alive`), takes down any
  watch the extension no longer knows (a service-worker restart), and removes itself a little after its `expiresAt`.

An extension without `watch` (1.1.0 and older) gets no `watch.*`: the engine keeps such a wait on its debugger path
(holding the debugger, with its bar) and tells the model to suggest updating Winter for Chrome.

## 6. Timeouts and sizes (the daemon's side)

`cdp.send` 15 s (`Page.captureScreenshot` 20 s), `tabs.create` and `debugger.attach` 20 s, everything else 10 s; a late
answer is dropped by id. The daemon refuses to send a command over 1 MiB (`not_allowed`) and refuses a method or event
outside the allowlist before sending.

## 7. The extension's rules

### 7.1 Permissions

Exactly `debugger`, `tabs`, `tabGroups`, `nativeMessaging`, `scripting`, `storage`, and host `<all_urls>`. No declared
content scripts. `incognito: "not_allowed"`.

OPTIONAL (1.1.0): `history`, `bookmarks`, `downloads` — requested only from the toolbar popup, on the user's own click
(`chrome.permissions.request`), and given back there; never at install, so an update from 1.0.0 carries no new warning
(a new REQUIRED permission with one would disable the extension until each user re-approved it). Their APIs exist only
while granted, and the extension asks the browser before each use. A request that needs one the user has not granted
is refused `not_allowed` with `data.permission`; the toolbar shows a "!" and the popup highlights that switch.

### 7.2 Never move the user's view

Tabs open with `active: false` only. The extension never calls `tabs.highlight` or `windows.create`, and calls
`tabs.update` / `windows.update` in exactly three spellings, all in `background.ts`: `tabs.update(tabId, { muted })`
(`tabs.setMuted`, a tab's sound only), and `tabs.update(tabId, { active: true })` + `windows.update(windowId, { focused:
true })` (`tabs.bringForward`) — the sign-in hand-off, reached only from `tabs.present`, which Winter sends only after the
user's OK on its card. `Emulation.setFocusEmulationEnabled(true)` at attach keeps a background tab behaving as focused.

What keeps those calls out: every module but `background.ts` reaches the browser only through the `ChromeApi` interface
(`src/chrome-api.ts`), which has none of them, and `background.ts` (which binds the real `chrome`, typed `any`) is
reviewed by hand. Behind that, the build runs a regex over its bundles (`background.js` and `popup.js`) — and the unit
tests over the sources — and fails on any of those calls, `active: true`, `focused: true`, a main-world script, or a
read of cookies or site storage, once the three allowed spellings above (`ALLOWED_EXACT_CALLS`) are taken out; a test
pins each allowed spelling to `background.ts`, once per bundle. The regex is a backstop against a slip, not a proof: a
call spelled another way would pass it.

### 7.3 The CDP allowlist and the world rules

The daemon's `packages/core/src/computer-use/browser/cdp-allowlist.ts` is bundled into the extension from source.
Before a command reaches the browser the extension refuses (`not_allowed`):

- any method outside `CDP_ALLOWED_METHODS`; a subscription outside `CDP_ALLOWED_EVENTS`;
- `Runtime.evaluate` not in a "winter" context, named by `contextId` and/or `uniqueContextId` (both, if given, must be
  the same context);
- `Runtime.callFunctionOn` not in such a context (`executionContextId` / `uniqueContextId`) or on an `objectId` minted
  in one, or with an argument `objectId` that was not;
- `DOM.resolveNode` without such an `executionContextId`;
- `Page.createIsolatedWorld` with a `worldName` other than `"winter"`, with universal access, or before `Runtime.enable`
  in that session;
- `Page.reload` carrying `scriptToEvaluateOnLoad`, and `Page.navigate` to anything but http, https or exactly
  `about:blank` (both would run code in the page's own world);
- any other method naming an `objectId` that was not minted in a "winter" world;
- (1.1.0) `Network.enable` keeping post data, or response buffers over 1 MiB a response / 8 MiB in all; `Fetch.enable`
  with `handleAuthRequests`, or a pattern not at the Response stage; `Fetch.continueRequest` with anything but its
  `requestId`; `Fetch.failRequest` with any reason but `Aborted`; `Fetch.takeResponseBodyAsStream` for a request this
  extension did not see paused at the Response stage in that session, or a second time; `IO.read` / `IO.close` on a
  stream this extension did not hand out, an `IO.read` over 1 MiB or with an `offset`; `Emulation.setDeviceMetricsOverride`
  with anything but a screen size. `Network.getResponseBody`'s answer is cut at 1 MiB of text.

A "winter" context is one THIS extension's own `Page.createIsolatedWorld` returned — never one recognised by its name,
which another extension's world could share. The Runtime domain must be on in that session (so every context's coming
and going is seen); contexts are also matched by the browser's `uniqueId`, and an id handed out again to another context
(a cross-process navigation reuses them) stops being "winter" at once; a new document in the world's frame,
`Runtime.disable`, `Runtime.executionContextsCleared` and its destruction end it. A command naming a "winter" context
that has ENDED is refused with a message beginning with the browser's own words, `Cannot find context with specified
id` — the daemon may send it before it sees the ending, and it reads that as "make a fresh world and try again", as it
would the browser's own answer; a context that never was "winter" gets the plain refusal. Contexts and objects are
tracked per CDP session (the tab's, or a child target's). `Runtime.releaseObject` of an object the world no longer
holds is answered `{}` without being sent.

### 7.4 The debugger and the overlay

- **Attach** only while the daemon has the tab bound; refused (`attach_refused`) on `chrome:`, `edge:`, `brave:`,
  `vivaldi:`, `opera:`, `arc:`, `chrome-extension:`, `devtools:`, `view-source:` and other `about:` pages than
  `about:blank`, on local and opaque documents (`file:`, `data:`, `blob:`, `filesystem:`), on the Chrome Web Store and
  Edge Add-ons, on the extension's own pages, and while another debugger (DevTools, another extension) holds the tab.
  The browser's "started debugging this browser" bar is accepted.
- **Detach** on `debugger.detach`, after **5 minutes** without a command (`debugger.detached { reason: "idle" }`), and
  for every tab whenever the link to Winter drops (`host.status` not connected, or the port closed). Attached tabs are
  kept in `chrome.storage.session`: a restarted service worker detaches whatever its predecessor left attached, and
  removes those overlays.
- **The overlay** — a glow around the page, Winter's cursor and a small "Winter is working" pill — is an INDICATOR only,
  injected on demand with `chrome.scripting.executeScript({ world: "ISOLATED" })`: the extension's own content-script
  world, never the page's main world. Everything sits in a closed shadow root under one `<winter-agent-overlay>` element
  whose own styles are `!important` (a page's CSS cannot hide or move it) and which takes no pointer event anywhere.
- **Stop is the toolbar button.** While any tab is driven (its overlay on), the extension's button shows a red `STOP`
  badge and has no popup; a click sends `stop.pressed` for every driven tab. Otherwise the button opens the status
  popup. Nothing in the page can stop Winter, or pretend to.
- **The port** is kept open while the browser runs (an open native port keeps an MV3 service worker alive) and
  reconnected with a 1 s → 30 s backoff.

### 7.5 Browser facts the extension relies on

| Fact | Since | |
| --- | --- | --- |
| `chrome.debugger` flat child sessions (`DebuggerSession.sessionId`, for out-of-process iframes) | Chrome 125 | |
| An open `runtime.connectNative` port keeps an MV3 service worker alive | Chrome 105 | |

`minimum_chrome_version` is **125**, the later of the two; no `alarms` keepalive is needed.

Measured on Chrome for Testing 156 (the opt-in e2e, `scripts/browser-e2e/extension/`): the flat child session of a
cross-site iframe, input, focus emulation and screenshots in a background tab, and `DOM.setFileInputFiles` through
`chrome.debugger` (allowed for the unpacked dev build). Also measured there: a page with a `beforeunload` handler and a
user gesture brings its background tab forward for a close, `Page.navigate` and `Page.reload` alike; `chrome.tabs.discard`
keeps the tab's id and its `chrome.debugger` session; a discarded tab navigates, reloads and moves in its history over
CDP with no prompt and nothing activated — while `chrome.tabs.goBack`/`goForward` fail on it ("Cannot find a next page
in history").

## 8. Host manifests

```json
{ "name": "com.winter.browser", "description": "Winter for Chrome", "type": "stdio",
  "path": "<Winter.app>/Contents/Helpers/Winter Computer Use.app/Contents/MacOS/winter-browser-host",
  "allowed_origins": ["chrome-extension://<chrome store id>/", "chrome-extension://<edge store id>/"] }
```

- **dist:** Winter.app (Release) writes it at every launch from its own bundle path (never a versioned path), atomically
  (temp file and rename), only when the content differs, into each directory below whose browser support directory
  exists; it never deletes. While dist has no extension id it writes nothing.
- **dev:** `com.winter.browser.dev.json`, pointing at `<repo>/dist/dev/Winter Computer Use Dev.app/Contents/MacOS/winter-browser-host`
  with the dev id, written by `bun run dev:helper` after it builds and signs the dev helper.
- **tests:** only into a temp `--user-data-dir`'s own `NativeMessagingHosts/`, which Chromium reads for that profile
  (measured on Chrome for Testing 156).

Directories, under `~/Library/Application Support/`, each with `NativeMessagingHosts/`: `Google/Chrome`,
`Google/Chrome Beta`, `Google/Chrome Dev`, `Google/Chrome Canary`, `Google/Chrome for Testing`, `Google/ChromeForTesting`,
`Chromium`, `Microsoft Edge`, `Microsoft Edge Beta`, `Microsoft Edge Dev`, `Microsoft Edge Canary`,
`BraveSoftware/Brave-Browser`, `BraveSoftware/Brave-Browser-Beta`, `BraveSoftware/Brave-Browser-Nightly`, `Vivaldi`,
`Vivaldi Snapshot`, `com.operasoftware.Opera`, `com.operasoftware.OperaGX`, `com.operasoftware.OperaNext`,
`com.operasoftware.OperaDeveloper`, `Arc/User Data`.

## 9. Test builds

Compiled only with `WINTER_CU_TEST_BUILD` (the helper's test flavor, or `swift build -Xswiftc -DWINTER_CU_TEST_BUILD`);
a dev or release binary contains neither variable name (`checkSignedBrowserHost` and the release scan look for them):

- `WINTER_BROWSER_HOST_HOME` — the home to serve, when the host is not inside an installed Winter.app;
- `WINTER_CU_TEST_DAEMON_REQUIREMENT` — the requirement the daemon must satisfy instead (a fake daemon identity; the
  same variable the helper's test build reads).

A test build serves the dev extension ids.

## 10. A second client: opensky (extension, next version; unreleased)

The extension can serve one more native host besides Winter's: **opensky**, a separate computer-use app. It is opt-in
and isolated by construction; nothing in hops 2–5 above changes for Winter.

- **Consent.** The worker opens a port to opensky's host only while `storage.local.openskyConsent` is `true`, set
  only by the popup's own switch ("Let opensky use this browser too"; `winter.setOpensky`, accepted only from the
  extension's `popup.html`, never from a content script). It is off by default; installing opensky's host manifest grants
  nothing. Turning it off closes the port (no reconnect), detaches every debugger and overlay of opensky's, and clears
  opensky's tab record, taking its tabs out of its "opensky · …" groups (as `keep` does) — they become the user's. Requests already being answered finish first (at most 10 s); one that would still take
  something after that undoes what it got (a tab it was
  opening is closed again, a debugger it was attaching detached). Connecting and each flip of the switch run in one
  queue, in order.
- **Host names.** `com.opensky.browser` (store and Edge builds) and `com.opensky.browser.dev` (the dev build). opensky
  writes its own host manifest; its `allowed_origins` lists this extension's ids — `chrome-extension://flfkppajaamjgfmdljlklfdffkdcmicc/`
  (Chrome Web Store), `chrome-extension://bapmmpefcbjabfdfeehimdhldpjaoemd/` (Edge Add-ons) and, for the dev host only,
  `chrome-extension://jikdcokcpbacalfeipkognejnlnobbbf/`. The extension cannot verify who answers that name (unlike
  Winter's host, which code-sign-checks the daemon): the user's switch and the restrictions below are the whole gate.
  Chrome tells an extension nothing about the process behind a host name, and Winter's own host name has the same gap
  at this hop. The planned closing of it is pairing: the host holds a private key in the Keychain that only code signed
  by its team may use, the extension stores the public half on the first connect, and every later connect answers a
  fresh challenge signed with that key.
- **Wire.** The same JSON-RPC as §4–§5 — the same `hello` (with its own `instanceId`, kept under
  `storage.local.openskyInstanceId`), the same `host.status`, the same errors — over its own port.
- **Its own controller.** A second `ExtensionController` (`OPENSKY_CLIENT`): its own agent-tab book
  (`openskyAgents`), attached record (`openskyAttached`), alive mark (`openskyAlive`), group prefix ("opensky · …") and
  working pill ("opensky is working — stop it from the toolbar"). Debugger events reach a controller only for tabs it
  attached.
- **Methods.** Only `ping`, `tabs.list`, `tabs.create`, `tabs.close`, `tabs.mute`, `tabs.keep` (without `group`),
  `group.update`, `debugger.attach`, `debugger.detach`, `cdp.send`, `cdp.subscribe` and `overlay`
  (`SECOND_CLIENT_METHODS`); everything else is `not_allowed`. Withheld: `tabs.present` (the one view-moving call),
  `windows.list`, `history.search`, `bookmarks.search`, `downloads.*` and `watch.*`. The library and watch arms are
  never started for it, and its `hello` offers only `SECOND_CLIENT_FEATURES` (`cdp3`, `mute`, `group`, `tabFacts`). The
  CDP allowlist is the same as Winter's, so a file a page in its own tab sends can still be read through `Fetch` / `IO`
  as it arrives; only the browser's downloads (`downloads.*`) are withheld. Its tabs carry the profile's signed-in
  sessions.
- **Tabs.** Every `tabKey` must name a tab opensky opened (its book) or holds (attached); `tabs.list` lists only those;
  `tab.gone` reaches it only for those. Each controller refuses (`not_allowed`) and leaves out of `tabs.list` and
  `tab.gone` every tab the OTHER holds — or held until the browser closed or replaced it, so which controller hears a
  close first does not matter — so Winter never sees, drives or closes opensky's tabs either. Winter's
  `tabs.keep { group }` never joins one of opensky's groups. Winter's port opens once Winter has started and opensky's
  record is loaded (tabs opensky is still detaching from a previous worker count as opensky's until they are);
  opensky's port, and every flip of its switch, waits until both have fully started. The CDP allowlist
  and the world rules (§7.3) are the same for both.
- **Stop.** The toolbar's STOP counts both clients' driven tabs and names who is working; one click sends `stop.pressed`
  to each client for its own driven tabs. The badge otherwise stays Winter's: opensky's link state shows only in the
  popup, under its switch.

## 11. Compatibility and versioning

- **Bump either number** on any observable change to what it covers, in all three places together (the parity test
  fails until they agree).
- The host ships inside the Winter Computer Use helper and carries the helper's version
  ([`../VERSION`](../VERSION)); the extension has its own semver (`manifest.json`, starting at 1.0.0).

### Changelog

| Browser-host | Extension | Helper | Extension version | Change |
| --- | --- | --- | --- | --- |
| 1 | 1 | 1.9.0 | 1.0.0 | Initial. |
| 1 | 1 | (unchanged) | 1.1.0 | ComputerV2 Phase 3, additive behind `hello.features`: the Phase 3 allowlist (`cdp3`), the hand-off (`tabs.present`, `user.done`), `tabs.mute`, `group.update`, `tabs.keep { group }`, `windows.list`, `Tab` facts, and under the optional permissions `history.search`, `bookmarks.search`, `downloads.arm`/`release` and `download`. More browser channels and their manifest directories. |
| 1 | 1 | (unchanged) | next (unreleased) | The opt-in second client opensky (§10): its own native host, consent-gated in the popup, a restricted method set on its own tabs only, separate storage; Winter's protocol unchanged. |
| 1 | 1 | (unchanged) | 1.2.0 | Wake triggers, additive behind `hello.features` (`watch`): `watch.arm`, `watch.cancel` and `watch.event` — the page watcher injected with `chrome.scripting` into the extension's own isolated world, no debugger, no new permission (§5.5). |
