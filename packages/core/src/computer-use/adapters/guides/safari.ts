// The guide for Safari (id `safari@3`), shown with the app's extras block. Winter's own reviewed prose: every claim
// is about an extra Winter implements or a behaviour the ComputerV2 description already states — checked against the
// app's dictionary and, at the live gate, the app itself. A content change bumps the rev. ≤ 2,000 bytes.
export const SAFARI_GUIDE = `Safari's extras work on the BOUND window only — never on whichever Safari window is in front, which may be the user's:
- tabs() lists the bound window's tabs: index, whether it is current, URL and title;
- currentURL() is the URL of the bound window's current tab; pageText() is its readable text, pageText({ tab }) another of its tabs — text only, no links or form values;
- openURL(url) opens a new tab at the end of the bound window and keeps its current tab as it was ({ newTab: false } replaces the current tab's page instead);
- openWindow(url) opens a NEW Safari window of your own and returns its id: bind it with apps.open("Safari", { window: id }) and work there. Use it only when the user wants the work done in Safari; for your own browsing, prefer Winter's built-in browser (browsers.open).
To click or type in a page, use state() refs in the bound window; a tab you opened with openURL must be made the current tab first (click it in the tab bar).
The extras never run JavaScript in a page.`;
