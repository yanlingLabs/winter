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
| Extension | Chrome Web Store and Edge Add-ons (publisher yanlingLabs); the dev build unpacked | Store ids assigned at the first upload. Dev: `jikdcokcpbacalfeipkognejnlnobbbf`, fixed by the dev manifest's `key` (`extensions/winter-for-chrome/keys/dev.pub`, a public key) |
| Native host | `Winter Computer Use.app/Contents/MacOS/winter-browser-host` (the dist helper inside Winter.app, and the dev helper `bun run dev:helper` builds) | codesign identifier `com.winter.browserhost` / `com.winter.browserhost.dev`, Winter's team, hardened runtime, no entitlements, a **stated** designated requirement: `identifier "<id>" and anchor apple generic and certificate leaf[subject.OU] = "37N77U9RSZ"` |
| Native-messaging host name | the host manifests (§8) | `com.winter.browser` (dist), `com.winter.browser.dev` (dev) |
| Daemon endpoint | `<home>/run/browser.sock`, mode `0600`, created by the daemon at boot (a stale file unlinked first) | `winter-core` (dist) / `com.winter.core.dev` (dev), Winter's team |

**The extension-id allowlist** is defined once per language and kept equal by the parity test: the daemon's
`extension-ids.ts`, the host's `ExtensionIds.swift`, Winter.app's manifest writer
(`apple/Winter/Sources/BrowserExtension/BrowserHostManifest.swift`), and the id the dev key derives. Dist holds the two
store ids — none until the first upload, so until then the user's browsers stay "not connected" on dist.

**The host's home** comes from its enclosing app's bundle id: `com.winter.computeruse` → `~/.winter`,
`com.winter.computeruse.dev` → `~/.winter-dev`. Anything else (a bare binary, another app) refuses to start unless it is
a test build (§9). The host never launches Winter, the daemon or the helper.

## 2. Hop 1 — extension ⇄ host (Chrome native messaging)

- **Start:** the extension calls `chrome.runtime.connectNative("com.winter.browser[.dev]")`; Chrome starts the host with
  `argv[1]` = the caller's origin, `chrome-extension://<id>/`. The host exits with status 1 unless that id is in its
  profile's allowlist (Chrome's `allowed_origins` already restricts this; this is the second look). Its parent process
  is the browser's main process: the host reports that app's bundle id and pid in `host.hello`.
- **Framing:** each message is a 4-byte little-endian length, then that many bytes of UTF-8 JSON.
- **Caps:** extension → host at most **16 MiB** per message (the host drops a larger one, keeping the stream in step);
  host → extension at most **1 MiB** (Chrome's limit for a host).
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

**Retries:** no daemon → every **2 s**; unverified, or `host.hello` refused → every **30 s** (so turning Computer Use
back on, or starting Winter, needs no browser restart).

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

The pid check is **not load-bearing**: a same-user impostor can name the real host's pid (the daemon's sockets give it
no peer pid of its own). It is stated, as it is for the helper; the host's audit-token check of the daemon (§3.2) is
the direction that guards. A first message that is not `host.hello` is answered `protocol_mismatch` and closed; no
`host.hello` within 10 s closes the connection.

### 3.4 Browser families

| Family | Bundle ids |
| --- | --- |
| chrome | `com.google.Chrome`, `.beta`, `.dev`, `.canary`; `com.google.chrome.for.testing` |
| edge | `com.microsoft.edgemac`, `.Beta`, `.Dev`, `.Canary` |
| brave | `com.brave.Browser` |
| vivaldi | `com.vivaldi.Vivaldi` |
| opera | `com.operasoftware.Opera` |
| arc | `company.thebrowser.Browser` |
| chromium | `org.chromium.Chromium` |

The browser app is what Winter's per-app approval and access settings name: one grant covers the browser as an app and
its tabs.

### 3.5 The relay

After `host.hello` succeeds the host forwards every object **unchanged** between its two framings, reading only the size
and the envelope (a JSON-RPC 2.0 object, and whether it is a request, notification or response). Raw CR/LF bytes —
only ever insignificant whitespace in valid JSON — become spaces on the way to the daemon. The host does **not** enforce
the CDP allowlist (the extension does, §7.3; the daemon never sends outside it). While no daemon is connected, a request
from the extension is answered by the host with `data.code: "disconnected"`; anything else is dropped.

## 4. The extension's `hello` (relayed)

On `host.status { daemon: "connected" }` the extension sends:

```ts
"hello" { protocol: 1, extensionVersion: string, instanceId: string /* a UUID kept in chrome.storage.local */ }
  → { protocol: 1, backend: { id: string, name: string } }      // id: "chrome", "chrome#2", "edge", …
```

- **Mismatch:** `protocol_mismatch` `{ expected }`, message `"update Winter for Chrome"` (the extension is older) or
  `"update Winter"` (newer). The daemon lists the browser as not connected with the same advice; the extension shows it
  on its badge and popup. The connection stays open: a later matching `hello` registers.
- **No browser engine in this daemon:** `unavailable`; the extension says `hello` again 30 s later.
- **Registration:** one transport per `instanceId`. The engine's registry gives an instance the same backend id for the
  daemon's lifetime, across reconnects (an MV3 service worker restarts often), so `chrome:418` stays valid; only a
  different instance of the same family gets `#2`, `#3`, … A second connection from the same instance retires the first.

## 5. Messages after `hello`

### 5.1 Daemon → extension (requests)

| Method | Params | Result |
| --- | --- | --- |
| `tabs.list` | `{}` | `{ tabs: Tab[] }` — every tab of the browser profile, never a private window's |
| `tabs.create` | `{ url, sessionId, sessionTitle }` | `{ tab: Tab }` — `chrome.tabs.create({ active: false })` in the session's group "Winter · <title>" (created in the window the user used last, never a private one); `url` is http(s) or `about:blank` |
| `tabs.close` | `{ tabKey }` | `{}` — only an agent tab (`not_allowed` otherwise); taken out of its group first, so a group's last tab leaves no group (nor a saved group) behind |
| `tabs.keep` | `{ tabKey }` | `{}` — hands an agent tab to the user for good: no longer an agent tab, out of its Winter group, never closed by Winter |
| `debugger.attach` | `{ tabKey }` | `{ viewport: [w, h], dpr }` — idempotent; the CSS viewport and the device pixel ratio from `Page.getLayoutMetrics` |
| `debugger.detach` | `{ tabKey }` | `{}` — idempotent; never closes the tab |
| `cdp.send` | `{ tabKey, method, params, cdpSessionId? }` | `{ result }` — `cdpSessionId` addresses a flattened child target (an out-of-process iframe) |
| `cdp.subscribe` | `{ tabKey, events }` | `{}` — replaces the tab's forwarded set (a subset of the allowlist's events) |
| `overlay` | `{ tabKey, active, cursor?: { x, y, kind } }` | `{}` — best effort (§7.4) |
| `ping` | `{}` | `{}` |

`Tab` is `{ tabKey, url, title, active, agent, sessionId? }`: `tabKey` the `chrome.tabs` id as a string; `agent` true for
a tab `tabs.create` opened, by tab id — Chrome's own pin (which takes a tab out of its group) or a drag changes nothing,
only `tabs.keep` does; `sessionId` its Winter session. A tab the user drags into a Winter group stays the user's.

**Which agent tabs close, and when, is the engine's decision** (at its session's turn end unless marked; the user's
ruling): the extension only carries out `tabs.close` and `tabs.keep`, and never closes anything by itself. Agent tabs and
groups are remembered in `chrome.storage.session` — across service-worker and daemon restarts, so the `tabs.list` the
engine makes at the next registration reports every agent tab with its session; not across a browser restart, after
which Winter knows none of its old tabs and they are the user's.

### 5.2 Extension → daemon (notifications)

| Method | Params | When |
| --- | --- | --- |
| `cdp.event` | `{ tabKey, method, params, cdpSessionId? }` | a subscribed, allowlisted event of an attached tab; Network events carry only `requestId`, `timestamp`, `type` |
| `tab.gone` | `{ tabKey, reason: "closed" \| "crashed" }` | the tab closed (once per tab), or its renderer crashed |
| `debugger.detached` | `{ tabKey, reason: "canceled_by_user" \| "target_closed" \| "idle" }` | the user dismissed the browser's debugging bar; the page went where the debugger cannot follow; or 5 minutes without a command |
| `stop.pressed` | `{ tabKey }` | the user pressed the overlay's Stop button |

The daemon reads `canceled_by_user` as the user taking the tab back ("the user stopped Winter from controlling this tab"),
and the other two as a tab that can be attached again.

### 5.3 Notes for the engine

- An `Input.*` event that runs a handler which opens a JavaScript dialog is answered only once the dialog is handled: send
  it without waiting, handle `Page.javascriptDialogOpening` with `Page.handleJavaScriptDialog`, then collect its answer.
- The overlay's one element is `<winter-agent-overlay>` (light DOM, under `documentElement`; pointer events pass through
  it except over the Stop button). A page-runtime tree walk should skip it; its arrival and departure are the only DOM
  mutations the overlay causes (cursor moves happen inside its closed shadow root).
- `debugger.detached { reason: "idle" | "target_closed" }` leaves a tab that `debugger.attach` can make drivable again
  (the transport reports it as `stopped`); `canceled_by_user` is the user taking the tab back (`detached_by_user`).

### 5.4 Errors

JSON-RPC errors (`code: -32000`) whose `data.code` is one of `disconnected`, `tab_gone`, `attach_refused`, `not_allowed`,
`cdp_error` (with `data.cdpCode` / `data.cdpMessage` when the browser answered one), `timeout`. An unknown method is
`-32601`.

## 6. Timeouts and sizes (the daemon's side)

`cdp.send` 15 s (`Page.captureScreenshot` 20 s), `tabs.create` and `debugger.attach` 20 s, everything else 10 s; a late
answer is dropped by id. The daemon refuses to send a command over 1 MiB (`not_allowed`) and refuses a method or event
outside the allowlist before sending.

## 7. The extension's rules

### 7.1 Permissions

Exactly `debugger`, `tabs`, `tabGroups`, `nativeMessaging`, `scripting`, `storage`, and host `<all_urls>`. No declared
content scripts. `incognito: "not_allowed"`.

### 7.2 Never move the user's view

Tabs open with `active: false` only. The extension never calls `tabs.update`, `tabs.highlight`, `windows.update` or
`windows.create`. `Emulation.setFocusEmulationEnabled(true)` at attach keeps a background tab behaving as focused. The
build fails if its bundle contains any of those calls, `active: true`, `focused: true`, a main-world script, or a read
of cookies or site storage.

### 7.3 The CDP allowlist and the world rules

The daemon's `packages/core/src/computer-use/browser/cdp-allowlist.ts` is bundled into the extension from source.
Before a command reaches the browser the extension refuses (`not_allowed`):

- any method outside `CDP_ALLOWED_METHODS`; a subscription outside `CDP_ALLOWED_EVENTS`;
- `Runtime.evaluate` without a `contextId` it knows as a "winter" world, or with a `uniqueContextId`;
- `Runtime.callFunctionOn` without such an `executionContextId` or an `objectId` minted in one, or with an argument
  `objectId` that was not;
- `DOM.resolveNode` without such an `executionContextId`;
- `Page.createIsolatedWorld` with a `worldName` other than `"winter"`, or with universal access;
- any other method naming an `objectId` that was not minted in a "winter" world.

A "winter" context is one `Page.createIsolatedWorld` answered for, or one `Runtime.executionContextCreated` announced
with name `"winter"` and type `isolated`. Contexts and objects are tracked per CDP session (the tab's, or a child
target's) and dropped when destroyed. `Runtime.releaseObject` of an object the world no longer holds is answered `{}`
without being sent.

### 7.4 The debugger and the overlay

- **Attach** only while the daemon has the tab bound; refused (`attach_refused`) on `chrome:`, `edge:`, `brave:`,
  `vivaldi:`, `opera:`, `arc:`, `chrome-extension:`, `devtools:`, `view-source:` and other `about:` pages than
  `about:blank`, on the Chrome Web Store and Edge Add-ons, on the extension's own pages, and while another debugger
  (DevTools, another extension) holds the tab. The browser's "started debugging this browser" bar is accepted.
- **Detach** on `debugger.detach`, after **5 minutes** without a command (`debugger.detached { reason: "idle" }`), and
  for every tab whenever the link to Winter drops (`host.status` not connected, or the port closed).
- **The overlay** — a glow around the page, Winter's cursor and a Stop button — is injected on demand with
  `chrome.scripting.executeScript({ world: "ISOLATED" })`: the extension's own content-script world, never the page's
  main world. Everything sits in a closed shadow root under one `<winter-agent-overlay>` element (pointer events pass
  through it, except the button); a page observing its DOM sees only that element arrive and leave. Stop counts only for
  a trusted click.
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
`chrome.debugger` (allowed for the unpacked dev build).

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
`Google/Chrome Beta`, `Google/Chrome Dev`, `Google/Chrome Canary`, `Chromium`, `Microsoft Edge`, `Microsoft Edge Beta`,
`Microsoft Edge Dev`, `Microsoft Edge Canary`, `BraveSoftware/Brave-Browser`, `Vivaldi`, `com.operasoftware.Opera`,
`Arc/User Data`.

## 9. Test builds

Compiled only with `WINTER_CU_TEST_BUILD` (the helper's test flavor, or `swift build -Xswiftc -DWINTER_CU_TEST_BUILD`);
a dev or release binary contains neither variable name (`checkSignedBrowserHost` and the release scan look for them):

- `WINTER_BROWSER_HOST_HOME` — the home to serve, when the host is not inside an installed Winter.app;
- `WINTER_CU_TEST_DAEMON_REQUIREMENT` — the requirement the daemon must satisfy instead (a fake daemon identity; the
  same variable the helper's test build reads).

A test build serves the dev extension ids.

## 10. Compatibility and versioning

- **Bump either number** on any observable change to what it covers, in all three places together (the parity test
  fails until they agree).
- The host ships inside the Winter Computer Use helper and carries the helper's version
  ([`../VERSION`](../VERSION)); the extension has its own semver (`manifest.json`, starting at 1.0.0).

### Changelog

| Browser-host | Extension | Helper | Extension version | Change |
| --- | --- | --- | --- | --- |
| 1 | 1 | 1.9.0 | 1.0.0 | Initial. |
