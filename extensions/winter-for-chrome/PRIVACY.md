# Winter for Chrome / Winter for Edge — Privacy Policy

Effective 12 October 2026 (version 1.2.0) · Publisher: yanlingLabs

Winter for Chrome is a browser extension for Google Chrome and other Chromium-based browsers; on Microsoft Edge
Add-ons it is published as Winter for Edge, the same extension under another name. It lets **Winter**, an assistant app
that runs on your Mac, work in the browser's tabs when you ask it to. This policy covers the extension in every browser.
It is short because the extension does very little with your data: it passes what Winter asks for to the Winter app on
the same Mac, and nothing else.

## In short

- The extension has no servers, no accounts, no analytics and no advertising. It makes no network requests of its own.
- What it reads from a page goes only to the Winter app installed on your Mac, through the browser's native-messaging
  channel. yanlingLabs does not receive it.
- It reads pages only in tabs Winter is working in, and only while it is working there.
- It never reads cookies, saved passwords, or a site's stored data.

## What the extension reads, and when

The extension acts only on requests from the Winter app on your Mac, which makes them when you have asked Winter to do
something in your browser. Depending on the task, it may:

- **List your open tabs** — each tab's address (URL) and title, and whether it is the active tab — so Winter can find
  the tab you mean. Tabs in private (incognito) windows are never listed; the extension cannot run there.
- **Read pages in tabs Winter is working in** — the page's structure and text, the position of elements on the page,
  and screenshots of the tab — so Winter can see what is on the page.
- **Act on those pages** — clicks, typing, scrolling, choosing files you asked Winter to upload, and answering the
  page's pop-up dialogs — as Winter's task requires.
- **Watch page loading and the page's own messages** — while Winter works in a tab, the extension passes on the page's
  network requests (each one's address, method, status, type and timing — never its headers, cookies or the data sent
  with it) and the messages the page writes to its developer console, so Winter knows when the page has finished
  loading and can help you debug a page you are building. The page addresses and message text are cleaned of anything
  that looks like a password, token or key before Winter reads them.
- **Read one response on request** — when Winter asks for the content of one of those network responses (for
  example, to check a page's data while debugging), the browser hands over that response as it received it; Winter
  removes anything that looks like a secret before reading it. The data a page sends is never read.
- **Save a file you asked for** — when you ask Winter to download a file, the extension lets Winter catch it as the
  browser receives it and saves it into the folder Winter works in on your Mac, instead of your Downloads folder.
- **Wait for you** (version 1.2.0) — when Winter needs you to do something in a tab before it can go on (fill in a form
  and press Submit, for example), it can ask the extension to watch for that one thing: a click on one button, a form
  being sent, a field being changed, a text or a title appearing or going away, or the page moving to another address.
  While it watches, the page shows a small pill saying what Winter is waiting for ("Winter continues when you click
  “Submit”") and a ring around that element. When it happens, the extension tells Winter only which watch it was, when it
  happened, and where the page is: its site and path, never the part of the address after "?" or "#", where a page can
  carry what you typed into a form (and, for a title, the title). To tell whether the page moved on to the address
  Winter waits for, the extension compares the whole address itself and passes on only the answer and a short digest
  that tells one address from another. It never passes on what you typed, where you clicked, or the rest of the page.
  The watching ends when it happens, when Winter or you stop waiting, when the tab closes, or when the connection to
  Winter drops. For an element of the page itself, or for the page as a whole, it does not use the debugging
  interface: the little code that watches runs in the extension's own isolated context in that one tab, so the browser
  shows no debugging notice while Winter waits. For an element inside a frame embedded in the page, Winter keeps the
  debugging interface attached to the tab while it waits (the browser shows its notice), changing nothing else in the
  page: your file pickers, dialogs and focus stay yours. A page's own script can keep the watcher from seeing your click
  (by stopping the browser from passing it on); Winter then simply stops waiting when the wait runs out.

To do this it uses the browser's debugging interface (`chrome.debugger`), attached only to a tab Winter is working in and
detached when Winter is done with it, after five minutes without use, or as soon as the connection to Winter drops.
The browser shows its own notice while it is attached. The extension refuses to work on the browser's own pages,
extension store pages, local files (`file:`), and `data:`, `blob:` and `filesystem:` documents. Winter does not type into
fields for passwords, one-time codes or payment cards, and their values are never passed to it.

## Optional permissions (only if you switch them on)

Three things are off until you switch them on in the extension's toolbar menu, and can be switched off there again at
any time:

- **Find pages in your history** — the extension searches your browsing history (read only) when Winter needs to find
  a page you visited, and passes the matching pages' addresses, titles and visit times to Winter. It never adds to,
  changes or deletes your history.
- **Find pages in your bookmarks** — the same for your bookmarks (their addresses, titles and folders), read only.
- **Save files a page makes** — some pages create a file themselves (an export), which the method above cannot catch.
  With this switched on, such a file — only when Winter asked for it, in a tab it is working in — is saved by the
  browser into a "Winter" folder inside your Downloads folder, handed to Winter on your Mac, and moved from there into
  the folder Winter works in; the entry is then removed from the browser's downloads list. Other downloads are never
  touched. macOS may ask you once whether Winter may access your Downloads folder.

## A second app: opensky (only if you switch it on)

From the next version the extension can also serve **opensky**, a separate computer-use app on your Mac, through opensky's
own native host (`com.opensky.browser`). It is **off** until you turn on "Let opensky use this browser too" in the
extension's toolbar menu; installing opensky does not turn it on, and while it is off the extension never connects to
opensky at all. Turning it off disconnects opensky at once, detaches from its tabs, takes them out of opensky's tab groups and hands them to you.

While it is on, opensky gets much less than Winter:

- it works only in the tabs it opens itself (in background tab groups named "opensky · …"), never in your tabs and
  never in Winter's, and it does not see your other tabs listed. Its tabs are ordinary tabs of your browser profile, so
  a site you are signed in to is signed in there too, and opensky can read and act on it as you;
- it cannot bring a tab or window to the front, list your windows, search your history or bookmarks, use the browser's
  downloads (your Downloads folder or its list), or set up watches. Like Winter, it can read a file that a page in one
  of its own tabs sends, as the page receives it;
- the same pages are off limits as for Winter, and it reads and acts on its own tabs the same way Winter does (the
  debugging interface, the browser's notice, the same allowed commands).

What opensky does with what it reads is covered by opensky's own privacy policy, not this one. Winter never sees
opensky's tabs, and opensky never sees Winter's.

## Where it goes

Everything the extension reads is sent to one place: the Winter app installed on the same Mac, over the browser's native
messaging channel (to the native host `com.winter.browser`, which is part of Winter) — or, only for opensky's own tabs
and only while you have switched opensky on, to the opensky app on the same Mac (its host `com.opensky.browser`). It is
not sent to yanlingLabs or to any other server by the extension.

## What it stores on your device

The extension keeps a few small records in the browser's extension storage on your device:

- a random identifier for this browser profile, so Winter recognises the same browser after a restart;
- the identifiers of the tabs and tab groups Winter opened, so it never mistakes one of your tabs for its own (this
  record is cleared when the browser restarts);
- which tabs it is currently attached to, so it can detach from them cleanly (cleared when the browser quits);
- if you use opensky: whether you switched it on, and a separate identifier, tab record and attachment record of its own
  (never shared with Winter's).

What Winter waits for in a tab is kept only in the extension's memory while it waits, never stored.

It stores no page content, no addresses and no history. Removing the extension deletes these records. (A file you
asked Winter to download passes through your Downloads folder only when "Save files a page makes" is on, and is moved
out of it at once.)

## What Winter, the app, does with it

Winter uses what the extension reads to carry out the task you gave it. Winter runs on the AI model provider **you**
choose and configure in Winter (with your own account or API key), so the content of your conversation with Winter —
which can include text and screenshots from the pages it worked on — is sent to that provider to produce Winter's
responses, under that provider's terms and privacy policy. yanlingLabs does not operate a server in that path and does
not receive your conversations or page content. Winter keeps its session history on your Mac.

## What the extension never does

- It does not sell, share or transfer your data to anyone.
- It does not use your data for advertising, profiling, credit or lending decisions, or anything other than the task you
  asked Winter to do.
- It does not read cookies, saved passwords, or a site's local storage.
- It does not run code in a page's own context; the little code it uses to read pages and draw Winter's on-page
  indicator runs in an isolated context of its own.
- It does not switch your active tab or bring a window to the front — with one exception you choose: when a page needs
  you (a sign-in, a code, a CAPTCHA), Winter asks you first in its own window, and only if you choose "Show me the tab"
  does the extension bring that tab to the front for you. While Winter waits, the toolbar menu offers Done and Stop
  waiting.
- It does not close your tabs. It closes only the tabs Winter itself opened, when Winter's task ends, unless you keep
  them.

## Your controls

- **Stop:** while Winter is working in any tab, the extension's toolbar button turns into a red STOP button. One click
  stops Winter in every tab of this browser.
- **opensky:** off unless you switch it on in the toolbar menu; switching it off disconnects it at once. STOP stops
  opensky in its tabs too.
- **Winter's settings:** in the Winter app you choose whether Winter may use computer and browser control at all, and
  which apps and browsers it may use.
- **Remove it:** uninstalling the extension ends all of the above and deletes its stored records.

## Children

The extension is not directed at children under 13 and does not knowingly collect data from them.

## Changes

If this policy changes, the new version will be published at this address with a new effective date. A change that
lets the extension handle data in a new way will come with an update of the extension and its store listing.

## Contact

Questions about this policy: open an issue at <https://github.com/yanlingLabs/winter/issues>.
Security reports: <https://github.com/yanlingLabs/winter/security/advisories/new>.
