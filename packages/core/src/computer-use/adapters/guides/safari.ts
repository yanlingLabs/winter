// The guide for Safari (id `safari@1`), shown with the app's extras block. Winter's own reviewed prose: every claim
// is about an extra Winter implements or a behaviour the ComputerV2 description already states — checked against the
// app's dictionary and, at the live gate, the app itself. A content change bumps the rev (`safari@2`). ≤ 2,000 bytes.
export const SAFARI_GUIDE = `Safari's page content is in state() like any window's, and its extras read and open pages without touching the page or bringing Safari forward:
- tabs() lists every tab: its window id, its index, whether it is the window's current tab, its URL and title;
- currentURL() is the URL of Safari's front document (the current tab of its frontmost browser window);
- pageText() is the readable text of that page; pageText({ window, tab }) reads another tab, with the ids tabs() gives — text only, no links or form values;
- openURL(url) opens a new tab at the end of the front window and keeps that window's current tab as it was; it returns where the new tab is ({ window, tab }); { newTab: false } loads the URL in the current tab instead, replacing its page.
To work in a page (click, type), bind the window and use state() refs; a tab you opened with openURL must be made the current tab first (click it in the tab bar).
The extras never run JavaScript in a page.`;
