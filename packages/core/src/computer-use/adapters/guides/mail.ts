// The guide for Mail (id `mail@1`), shown with the app's extras block. Winter's own reviewed prose: every claim
// is about an extra Winter implements or a behaviour the ComputerV2 description already states — checked against the
// app's dictionary and, at the live gate, the app itself. A content change bumps the rev (`mail@2`). ≤ 2,000 bytes.
export const MAIL_GUIDE = `Mail's extras read headers and write drafts without bringing Mail forward:
- messages() lists message headers of the inbox (all accounts) in Mail's own order — id, read, date received (local time), mailbox, sender, subject (sort by date for the newest); { unread: true } only unread ones, { mailbox: "Name" } another mailbox, { limit } up to 100 (default 20). Message bodies are not read;
- unreadCount() is the inbox's unread count;
- compose({ to, cc, subject, body }) saves a new message to Drafts without opening a window and never sends it — tell the user it is in Drafts.
Sending is the user's step: never send mail for them, by any route, unless they asked for exactly that message to be sent.`;
