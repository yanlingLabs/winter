// The guide for Notes (id `notes@1`), shown with the app's extras block. Winter's own reviewed prose: every claim
// is about an extra Winter implements or a behaviour the ComputerV2 description already states — checked against the
// app's dictionary and, at the live gate, the app itself. A content change bumps the rev (`notes@2`). ≤ 2,000 bytes.
export const NOTES_GUIDE = `Notes' extras work without bringing Notes forward or changing what it shows:
- list() returns notes in Notes' own order — id, name, folder and last change (local time); { folder: "Name" } one folder, { limit } up to 200 (default 30);
- read(id) returns a note's name and plain text (ids come from list() or search()); a locked note can't be read;
- search(text) finds notes whose name or text contains it (at most 50);
- create({ title, body, folder }) makes a new note — in the default folder unless { folder } names one — and returns its id. The body is plain text; its lines become the note's paragraphs, under the title.
A note's name is normally its first line. Use the UI (bind a Notes window) to edit an existing note in place.`;
