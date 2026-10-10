// Notes (`com.apple.Notes`): list, read and search notes, and create one — through its dictionary (`name`, `plaintext`,
// `modification date`, `container` of a note; `make new note`). A password-protected note's text cannot be read.
import type { AppAdapter } from "../types";
import { appScript, intArg, optsArg, rows, stringArg, text } from "./common";
import { NOTES_GUIDE } from "../guides/notes";

const bad = (message: string): TypeError => Object.assign(new TypeError(message), { name: "TypeError" });


/** A note id as Notes gives it (`x-coredata://…/ICNote/p123`). */
function noteId(v: unknown): string {
  const id = stringArg(v, "read(id)", 300).trim();
  if (!/^[A-Za-z][A-Za-z0-9+.-]*:\/\/[A-Za-z0-9/._-]+$/.test(id)) throw bad("read(id) takes a note id from list() or search()");
  return id;
}

/** `folder "<name>"`, Notes' own lookup across accounts. */
const folderRef = (name: string): string => `folder ${text(name)}`;

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** The note's HTML: the title as a heading, then one paragraph per line of the body. */
export function noteHtml(title: string, body: string): string {
  const lines = body.split(/\r?\n|\r/);
  return `<div><h1>${escapeHtml(title)}</h1></div>${lines.map((l) => `<div>${l.length === 0 ? "<br>" : escapeHtml(l)}</div>`).join("")}`;
}

const NOTE_ROW = "my winterText(id of x) & winterTAB & my winterISO(modification date of x) & winterTAB & my winterText(name of container of x) & winterTAB & my winterText(name of x) & winterLF";

export const notesAdapter: AppAdapter = {
  bundleIds: ["com.apple.Notes"],
  guide: { id: "notes@1", text: NOTES_GUIDE },
  extras: [
    {
      name: "list", access: "view",
      signature: "list(o?: { folder?: string; limit?: number }): Promise<{ id: string; name: string; folder: string; modified: string }[]>",
      summary: "notes in Notes' own order: id, name, folder, last change",
      doc: "The first notes in Notes' own order (sort by modified for the newest), from every account unless { folder } names one. { limit } 1–200, default 30. Names and dates only — read(id) for the text.",
      async run(scope, args) {
        const o = optsArg(args[0], "list()", ["folder", "limit"]);
        const limit = o.limit === undefined ? 30 : intArg(o.limit, "list({ limit })", 1, 200);
        const from = o.folder === undefined ? "" : ` of ${folderRef(stringArg(o.folder, "list({ folder })", 200))}`;
        const result = await scope.applescript(appScript(scope.app.bundleId, [
          `set n to my winterMin(count of notes${from}, ${limit})`,
          "set out to \"\"",
          "repeat with i from 1 to n",
          `  set x to note i${from}`,
          `  set out to out & ${NOTE_ROW}`,
          "end repeat",
          "return out",
        ], { handlers: ["text", "iso", "min"] }), { timeoutMs: 30_000 });
        return rows(result, 4).map(([id, modified, folder, name]) => ({ id: id ?? "", name: name ?? "", folder: folder ?? "", modified: modified ?? "" }));
      },
    },
    {
      name: "read", access: "view",
      signature: "read(id: string): Promise<{ id: string; name: string; text: string }>",
      summary: "a note's name and plain text",
      doc: "The note's plain text (Notes' plaintext: no formatting, no attachments). A locked (password-protected) note fails.",
      async run(scope, args) {
        const id = noteId(args[0]);
        const result = await scope.applescript(appScript(scope.app.bundleId, [
          `set x to note id ${text(id)}`,
          "return my winterText(name of x) & winterLF & my winterText(plaintext of x)",
        ], { handlers: ["text"] }), { timeoutMs: 20_000 });
        const all = result ?? "";
        const nl = all.indexOf("\n");
        return { id, name: nl < 0 ? all : all.slice(0, nl), text: nl < 0 ? "" : all.slice(nl + 1) };
      },
    },
    {
      name: "search", access: "view",
      signature: "search(text: string): Promise<{ id: string; name: string; folder: string; modified: string }[]>",
      summary: "notes whose name or text contains the words (at most 50)",
      doc: "Case-insensitive, as Notes' own scripting compares text. Falls back to names only when Notes can't search the text.",
      async run(scope, args) {
        const q = stringArg(args[0], "search(text)", 500).trim();
        if (q.length === 0) throw bad("search(text) takes the words to look for");
        const result = await scope.applescript(appScript(scope.app.bundleId, [
          "try",
          `  set found to (notes whose name contains ${text(q)} or plaintext contains ${text(q)})`,
          "on error",
          `  set found to (notes whose name contains ${text(q)})`,
          "end try",
          "set n to my winterMin(count of found, 50)",
          "set out to \"\"",
          "repeat with i from 1 to n",
          "  set x to item i of found",
          `  set out to out & ${NOTE_ROW}`,
          "end repeat",
          "return out",
        ], { handlers: ["text", "iso", "min"] }), { timeoutMs: 30_000 });
        return rows(result, 4).map(([id, modified, folder, name]) => ({ id: id ?? "", name: name ?? "", folder: folder ?? "", modified: modified ?? "" }));
      },
    },
    {
      name: "create", access: "full",
      signature: "create(o: { title: string; body: string; folder?: string }): Promise<{ id: string }>",
      summary: "makes a new note (title, plain-text body) in the default folder or a named one",
      doc: "The title becomes the note's first line (a heading), the body's lines its paragraphs. In Notes' default folder unless { folder } names a folder. Returns the new note's id.",
      async run(scope, args) {
        const o = optsArg(args[0], "create()", ["title", "body", "folder"]);
        const title = stringArg(o.title, "create({ title })", 500).trim();
        if (title.length === 0) throw bad("create() takes a { title }");
        const body = stringArg(o.body ?? "", "create({ body })", 100_000);
        const at = o.folder === undefined ? "default folder of default account" : folderRef(stringArg(o.folder, "create({ folder })", 200));
        const result = await scope.applescript(appScript(scope.app.bundleId, [
          `set x to make new note at ${at} with properties {body:${text(noteHtml(title, body))}}`,
          "return my winterText(id of x)",
        ], { handlers: ["text"] }), { timeoutMs: 20_000 });
        scope.say("made a new note");
        return { id: (result ?? "").trim() };
      },
    },
  ],
};
