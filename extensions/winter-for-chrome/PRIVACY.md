# Winter for Chrome / Winter for Edge — Privacy Policy

Effective 11 October 2026 · Publisher: yanlingLabs

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
- **Watch page loading** — while Winter works in a tab, the extension notes when the page's network requests start and
  finish (only an internal request number, a time and the kind of resource; never their addresses, headers, cookies or
  contents), so Winter knows when the page has finished loading.

To do this it uses the browser's debugging interface (`chrome.debugger`), attached only to a tab Winter is working in and
detached when Winter is done with it, after five minutes without use, or as soon as the connection to Winter drops.
The browser shows its own notice while it is attached. The extension refuses to work on the browser's own pages,
extension store pages, local files (`file:`), and `data:`, `blob:` and `filesystem:` documents. Winter does not type into
fields for passwords, one-time codes or payment cards, and their values are never passed to it.

## Where it goes

Everything the extension reads is sent to one place: the Winter app installed on the same Mac, over the browser's native
messaging channel (to the native host `com.winter.browser`, which is part of Winter). It is not sent to yanlingLabs or
to any other server by the extension.

## What it stores on your device

The extension keeps a few small records in the browser's extension storage on your device:

- a random identifier for this browser profile, so Winter recognises the same browser after a restart;
- the identifiers of the tabs and tab groups Winter opened, so it never mistakes one of your tabs for its own (this
  record is cleared when the browser restarts);
- which tabs it is currently attached to, so it can detach from them cleanly (cleared when the browser quits).

It stores no page content, no addresses and no history. Removing the extension deletes these records.

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
- It does not switch your active tab or bring a window to the front.
- It does not close your tabs. It closes only the tabs Winter itself opened, when Winter's task ends, unless you keep
  them.

## Your controls

- **Stop:** while Winter is working in any tab, the extension's toolbar button turns into a red STOP button. One click
  stops Winter in every tab of this browser.
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
