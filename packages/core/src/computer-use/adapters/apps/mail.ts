// Mail (`com.apple.mail`): message headers, the unread count, and a DRAFT — through its dictionary. Nothing here reads a
// message body or sends anything: `compose` makes an outgoing message with no window and saves it to Drafts.
import type { AppAdapter } from "../types";
import { appScript, intArg, optsArg, rows, stringArg, text, yes } from "./common";
import { MAIL_GUIDE } from "../guides/mail";

const bad = (message: string): TypeError => Object.assign(new TypeError(message), { name: "TypeError" });


/** `mailbox "<name>"` (Mail's own), else the first account mailbox of that name; `inbox` for none. */
function mailboxLines(name: string | undefined): string[] {
  if (name === undefined || name.trim().toLowerCase() === "inbox") return ["set mb to inbox"];
  const n = text(name.trim());
  return [
    "set mb to missing value",
    `try`,
    `  set mb to mailbox ${n}`,
    `end try`,
    "if mb is missing value then",
    "  repeat with a in accounts",
    "    try",
    `      set mb to mailbox ${n} of a`,
    "      exit repeat",
    "    end try",
    "  end repeat",
    "end if",
    `if mb is missing value then error "no mailbox named " & ${n}`,
  ];
}

function addresses(v: unknown, what: string, required: boolean): string[] {
  if (v === undefined || v === null) {
    if (required) throw bad(`${what} takes an address or a list of addresses`);
    return [];
  }
  const list = Array.isArray(v) ? v : [v];
  if (list.length > 50) throw bad(`${what} takes at most 50 addresses`);
  return list.map((a, i) => {
    const s = stringArg(a, `${what}[${i}]`, 320).trim();
    if (s.length === 0 || /[\u0000-\u001f\u007f]/.test(s)) throw bad(`${what}[${i}] is not an address`);
    return s;
  });
}

export const mailAdapter: AppAdapter = {
  bundleIds: ["com.apple.mail"],
  guide: { id: "mail@1", text: MAIL_GUIDE },
  extras: [
    {
      name: "messages", access: "view",
      signature: "messages(o?: { mailbox?: string; unread?: boolean; limit?: number }): Promise<{ id: number; read: boolean; date: string; mailbox: string; from: string; subject: string }[]>",
      summary: "message headers of the inbox (or a mailbox), in Mail's order — no bodies",
      doc: "Headers only, in Mail's own order (sort by date for the newest): id, read, date received (local time, ISO), mailbox, sender, subject. The inbox of every account by default; { mailbox } is a mailbox name (Mail's own, else the first account's of that name). { unread: true } keeps unread ones; { limit } 1–100 (default 20).",
      async run(scope, args) {
        const o = optsArg(args[0], "messages()", ["mailbox", "unread", "limit"]);
        const limit = o.limit === undefined ? 20 : intArg(o.limit, "messages({ limit })", 1, 100);
        if (o.unread !== undefined && typeof o.unread !== "boolean") throw bad("messages({ unread }) takes true or false");
        const mailbox = o.mailbox === undefined ? undefined : stringArg(o.mailbox, "messages({ mailbox })", 200);
        const result = await scope.applescript(appScript(scope.app.bundleId, [
          ...mailboxLines(mailbox),
          ...(o.unread === true
            ? ["set ms to (messages of mb whose read status is false)"]
            : ["set total to count of messages of mb", "if total = 0 then return \"\"", `set ms to (messages 1 thru (my winterMin(${limit}, total)) of mb)`]),
          "set n to my winterMin(count of ms, " + String(limit) + ")",
          "set out to \"\"",
          "repeat with i from 1 to n",
          "  set m to item i of ms",
          // One message Mail can't read (moved or deleted meanwhile) is skipped, never the whole list's failure.
          "  try",
          "    set out to out & (id of m) & winterTAB & (read status of m) & winterTAB & my winterISO(date received of m) & winterTAB & my winterText(name of mailbox of m) & winterTAB & my winterText(sender of m) & winterTAB & my winterText(subject of m) & winterLF",
          "  end try",
          "end repeat",
          "return out",
        ], { handlers: ["text", "iso", "min"] }), { timeoutMs: 30_000 });
        return rows(result, 6).map(([id, read, date, mb, from, subject]) => ({ id: Number(id), read: yes(read), date: date ?? "", mailbox: mb ?? "", from: from ?? "", subject: subject ?? "" }));
      },
    },
    {
      name: "unreadCount", access: "view",
      signature: "unreadCount(): Promise<number>",
      summary: "the inbox's unread count",
      async run(scope) {
        const result = await scope.applescript(appScript(scope.app.bundleId, ["return unread count of inbox"]));
        const n = Number((result ?? "").trim());
        return Number.isFinite(n) ? n : 0;
      },
    },
    {
      name: "compose", access: "full",
      signature: "compose(o: { to: string | string[]; cc?: string | string[]; subject: string; body: string }): Promise<{ draft: true; id: number }>",
      summary: "saves a new message to Drafts — no window, never sent",
      doc: "Makes an outgoing message with no window, adds the recipients, saves it to Drafts and closes it (the draft stays in Drafts): it is never sent (sending is the user's step). Plain-text body.",
      async run(scope, args) {
        const o = optsArg(args[0], "compose()", ["to", "cc", "subject", "body"]);
        const to = addresses(o.to, "compose({ to })", true);
        const cc = addresses(o.cc, "compose({ cc })", false);
        const subject = stringArg(o.subject ?? "", "compose({ subject })", 1_000);
        const body = stringArg(o.body ?? "", "compose({ body })", 100_000);
        const result = await scope.applescript(appScript(scope.app.bundleId, [
          `set m to make new outgoing message with properties {subject:${text(subject)}, content:${text(body)}, visible:false}`,
          "tell m",
          ...to.map((a) => `  make new to recipient at end of to recipients with properties {address:${text(a)}}`),
          ...cc.map((a) => `  make new cc recipient at end of cc recipients with properties {address:${text(a)}}`),
          "end tell",
          "set mid to id of m",
          "save m",
          // Close the hidden message so it doesn't linger: an outgoing message responds to `close` (Mail's sdef), and
          // `saving yes` keeps the draft — never `ask`, which would put a dialog in front of the user.
          "close m saving yes",
          "return mid",
        ]), { timeoutMs: 20_000 });
        scope.say("saved the message to Mail's Drafts (no window, not sent)");
        return { draft: true as const, id: Number((result ?? "").trim()) || 0 };
      },
    },
  ],
};
