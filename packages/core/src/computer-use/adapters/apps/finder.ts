// Finder (`com.apple.finder`): reveal, the selection, the Trash and "open with" — the file work Finder's own UI does only
// with Finder in front (its Move to Trash item stays disabled in the background), done through its dictionary (reveal,
// selection, delete) and, for `openWith`, the service's background document open (the opener gets its own card).
import { existsSync, lstatSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { AutomationFailure } from "../../errors";
import type { AppAdapter } from "../types";
import { appScript, pathArg, posixFile, stringArg } from "./common";
import { FINDER_GUIDE } from "../guides/finder";

const bad = (message: string): TypeError => Object.assign(new TypeError(message), { name: "TypeError" });

/** Folders Winter never trashes (or anything below the second list): the system, the user's home and its key folders,
 *  the credential stores and Winter's own homes. */
export function trashRefusal(path: string, home: string = homedir()): string | undefined {
  const exact = new Set(["/", "/Users", "/Volumes", "/Applications", "/Library", "/System", "/private", home,
    ...["Library", "Desktop", "Documents", "Downloads", "Applications", "Pictures", "Movies", "Music"].map((d) => `${home}/${d}`)]);
  if (exact.has(path)) return `Winter doesn't trash ${path} — it is a system or home folder; ask the user`;
  const below = ["/System/", "/usr/", "/bin/", "/sbin/", "/etc/", "/private/etc/", "/private/var/db/", "/Library/Keychains/",
    `${home}/Library/Keychains/`, `${home}/.ssh/`, `${home}/.gnupg/`, `${home}/.winter`, `${home}/.norma`];
  for (const p of below) if (path === p.replace(/\/$/, "") || path.startsWith(p)) return `Winter doesn't trash anything in ${p.replace(/\/$/, "")} — ask the user`;
  return undefined;
}

function existing(path: string, what: string): void {
  let ok = false;
  try { lstatSync(path); ok = true; } catch { ok = existsSync(path); }
  if (!ok) throw new Error(`${what}: there is no file or folder at ${path}`);
}


export const finderAdapter: AppAdapter = {
  bundleIds: ["com.apple.finder"],
  guide: { id: "finder@1", text: FINDER_GUIDE },
  extras: [
    {
      name: "reveal", access: "click",
      signature: "reveal(path: string): Promise<void>",
      summary: "selects the item in a Finder window, in the background",
      doc: "Finder's own reveal: it shows the item's folder in a Finder window and selects the item, without bringing Finder forward. The path must exist.",
      async run(scope, args) {
        const path = pathArg(args[0], "reveal(path)");
        existing(path, "reveal(path)");
        await scope.applescript(appScript(scope.app.bundleId, [`reveal (${posixFile(path)} as alias)`]));
        scope.say("revealed the item in a Finder window (Finder stays in the background)");
        return undefined;
      },
    },
    {
      name: "selection", access: "view",
      signature: "selection(): Promise<string[]>",
      summary: "POSIX paths selected in Finder's front window",
      doc: "What is selected in Finder's frontmost window (or on the desktop), as POSIX paths; [] when nothing is. Read-only.",
      async run(scope) {
        const result = await scope.applescript(appScript(scope.app.bundleId, [
          "set out to \"\"",
          "repeat with i in (get selection)",
          "  set out to out & (URL of i) & winterLF",
          "end repeat",
          "return out",
        ]));
        const paths: string[] = [];
        for (const line of (result ?? "").split(/\r?\n|\r/)) {
          const url = line.trim();
          if (!url.startsWith("file://")) continue;
          try { paths.push(fileURLToPath(url).replace(/(.)\/$/, "$1")); } catch { /* not a file URL */ }
        }
        return paths;
      },
    },
    {
      name: "trash", access: "full",
      signature: "trash(paths: string | string[]): Promise<{ trashed: number }>",
      summary: "moves the items to the Trash",
      doc: "Finder's delete, which moves the items to the Trash (the user can put them back). Every path must exist; system folders, the home folder and its main folders, ~/.ssh and the Keychains are refused. At most 100 paths.",
      async run(scope, args) {
        const raw = args[0];
        const list = Array.isArray(raw) ? raw : [raw];
        if (list.length === 0 || list.length > 100) throw bad("trash(paths) takes 1 to 100 paths");
        const paths = list.map((p, i) => pathArg(p, `trash(paths)[${i}]`));
        for (const p of paths) {
          const why = trashRefusal(p);
          if (why !== undefined) throw new AutomationFailure("Refused", why);
          existing(p, "trash(paths)");
        }
        const items = paths.map((p) => `(${posixFile(p)} as alias)`).join(", ");
        await scope.applescript(appScript(scope.app.bundleId, [`delete {${items}}`]), { timeoutMs: 30_000 });
        scope.say(`moved ${paths.length} item${paths.length === 1 ? "" : "s"} to the Trash`);
        return { trashed: paths.length };
      },
    },
    {
      name: "openWith", access: "full",
      signature: "openWith(path: string, app: string): Promise<{ opened: string }>",
      summary: "opens a file in another app, in the background",
      doc: "apps.open(path, { app }) for a file: the app (a name, bundle id or .app path) opens it without coming forward, and its window is bound — its state follows. The app is asked for like any app you bind.",
      async run(scope, args) {
        const path = pathArg(args[0], "openWith(path, app)");
        const app = stringArg(args[1], "openWith(path, app)'s app", 300).trim();
        if (app.length === 0) throw bad("openWith(path, app) takes the app to open it with");
        existing(path, "openWith(path, app)");
        const opened = await scope.openDocument(path, app);
        return { opened: opened.name };
      },
    },
  ],
};
