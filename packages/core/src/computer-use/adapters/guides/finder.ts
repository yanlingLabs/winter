// The guide for Finder (id `finder@1`), shown with the app's extras block. Winter's own reviewed prose: every claim
// is about an extra Winter implements or a behaviour the ComputerV2 description already states — checked against the
// app's dictionary and, at the live gate, the app itself. A content change bumps the rev (`finder@2`). ≤ 2,000 bytes.
export const FINDER_GUIDE = `Finder's windows show folders: state() lists the bound window's items. To open a file or folder, use apps.open(path) (it opens in the background), never a double-click or Finder's Open.
For files, prefer the extras — they work while Finder stays in the background and take POSIX paths (/Users/…; ~/ is expanded):
- reveal(path) selects the item in a Finder window;
- selection() returns the paths selected in Finder's front window (the user's own selection, unless you just revealed something);
- trash(paths) moves items to the Trash — the user can put them back from there. Finder's Move to Trash menu item stays disabled while Finder is in the background, so use trash() rather than menu();
- openWith(path, app) opens a file in another app in the background and binds that app's window.
Menu commands act on Finder's active window, which may not be the bound one. A Finder dictionary command (.dict) or applescript() addresses an item by its path instead of what is selected.`;
