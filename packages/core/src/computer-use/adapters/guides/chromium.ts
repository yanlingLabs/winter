// The guide for the Chromium family's browsers (id `chromium@1`), shown with the app's extras block. Winter's own reviewed prose: every claim
// is about an extra Winter implements or a behaviour the ComputerV2 description already states — checked against the
// app's dictionary and, at the live gate, the app itself. A content change bumps the rev (`chromium@2`). ≤ 2,000 bytes.
export const CHROMIUM_GUIDE = `This browser's extras list its tabs and open a URL without touching any page or bringing the browser forward:
- tabs() lists every tab: its window id, its index, whether it is the window's active tab, its URL and title;
- openURL(url) opens a new tab at the end of the front window and keeps that window's active tab as it was; it returns where the new tab is ({ window, tab }).
For work inside a page — reading it, clicking, typing — bind the tab with browsers.tab(…, { browser }) (its id from browsers.tabs()) instead of this app's window: that drives the page itself, in the background.
The extras never run JavaScript in a page.`;
