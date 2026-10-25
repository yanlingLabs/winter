// The guide for the Chromium family's browsers (id `chromium@2`), shown with the app's block. Winter's own reviewed
// prose: every claim is about a behaviour Winter implements or the ComputerV2 description already states. A content
// change bumps the rev. ≤ 2,000 bytes.
export const CHROMIUM_GUIDE = `For work inside a page — reading it, clicking, typing — bind the tab with browsers.tab(…, { browser }) (its id from browsers.tabs()) instead of this app's window: that drives the page itself, in the background.
This browser's own scripting cannot name the window you bound (it numbers windows its own way), so Winter has no extras for it: never script "front window" or "window 1" here — that may be the user's window. Work in the bound window's UI (state() refs), or in a tab bound with browsers.tab.
Its scripting never runs JavaScript in a page: execute … javascript is refused.`;

/** The guide while Winter for Chrome is NOT connected in this browser (id `chromium-noext@1`): its tabs can't be bound,
 *  so it never points at `browsers.tab`. */
export const CHROMIUM_GUIDE_WITHOUT_EXTENSION = `Winter for Chrome is not connected in this browser, so its tabs can't be bound (browsers.tab would fail). Work in the bound window's own UI: read it with state() and find(), click by ref, type into the address bar to go to a page, and use the tab strip and menus there. If the user wants Winter to work inside pages directly, they can install Winter for Chrome — say so rather than retrying browsers.tab.
This browser's own scripting cannot name the window you bound (it numbers windows its own way), so Winter has no extras for it: never script "front window" or "window 1" here — that may be the user's window.
Its scripting never runs JavaScript in a page: execute … javascript is refused.`;
