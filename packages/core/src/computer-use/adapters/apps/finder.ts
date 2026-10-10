// Finder (`com.apple.finder`): reveal, the selection, the Trash and "open with" — the file work Finder's own UI does only
// with Finder in front (its Move to Trash item stays disabled in the background), done through its dictionary and, for
// `openWith`, the service's background document open (the opener gets its own card).
//
// The window an extra works in is the BOUND one (`Finder window id <it>` — a Finder window's scripting id is its
// window-server id), never Finder's front window, which may be the user's. Finder's `selection` is that of where the
// user's focus is in Finder — its frontmost window, or the DESKTOP — so `selection()` reads it, and `reveal()` selects,
// only when the bound window is PROVEN to hold it: it is Finder's frontmost window, it does not show the Desktop folder,
// and Finder's insertion location is its folder (with the desktop focused, the insertion location is the Desktop).
// `trash` and `openWith` act on the paths the agent named, never on a window.
//
// `trash` never follows a link (Finder would trash what it points to), weighs the REAL path against its floor
// case-insensitively (the disk is), and is refused — "ask the user" — wherever Finder would raise a dialog instead of
// quietly using the Trash: a folder the user can't write (an administrator password), a sticky folder whose item is not
// theirs, a volume that is not local (Finder deletes there at once, after asking).
import { accessSync, constants, existsSync, lstatSync, realpathSync, statSync, type Stats } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { AutomationFailure } from "../../errors";
import { FINDER_GUIDE } from "../guides/finder";
import type { AppAdapter } from "../types";
import { appScript, pathArg, posixFile, stringArg } from "./common";

const bad = (message: string): TypeError => Object.assign(new TypeError(message), { name: "TypeError" });

/** The user's home as the disk spells it (a link resolved), for the floor. */
function realHome(): string {
  try { return realpathSync(homedir()); } catch { return homedir(); }
}

/** Folders Winter never trashes (or anything below the second list): the system, the user's home and its key folders,
 *  the credential stores and Winter's own homes. Compared CASE-INSENSITIVELY (macOS disks are): pass the real path. */
export function trashRefusal(path: string, home: string = realHome()): string | undefined {
  const p = path.toLowerCase();
  const h = home.toLowerCase();
  const exact = new Set(["/", "/users", "/volumes", "/applications", "/library", "/system", "/private", h,
    ...["library", "desktop", "documents", "downloads", "applications", "pictures", "movies", "music"].map((d) => `${h}/${d}`)]);
  if (exact.has(p)) return `Winter doesn't trash ${path} — it is a system or home folder; ask the user`;
  const below = ["/system/", "/usr/", "/bin/", "/sbin/", "/etc/", "/private/etc/", "/private/var/db/", "/library/keychains/",
    `${h}/library/keychains/`, `${h}/.ssh/`, `${h}/.gnupg/`, `${h}/.winter`];
  for (const b of below) if (p === b.replace(/\/$/, "") || p.startsWith(b)) return `Winter doesn't trash anything in ${b.replace(/\/$/, "")} — ask the user`;
  return undefined;
}

/** One line of `mount`'s output: where, and its flags (`local`, `read-only`, …). */
export interface MountEntry { point: string; flags: string[] }

/** `/dev/disk3s1 on / (apfs, local, journaled)` → `{ point: "/", flags: ["apfs", "local", "journaled"] }`. */
export function parseMounts(output: string): MountEntry[] {
  const out: MountEntry[] = [];
  for (const line of output.split("\n")) {
    const m = /^.+? on (\/.*) \(([^()]*)\)\s*$/.exec(line);
    if (m !== null) out.push({ point: m[1]!, flags: m[2]!.split(",").map((f) => f.trim().toLowerCase()) });
  }
  return out;
}

/** The mount holding `path`: the longest mount point it is at or below. */
export function mountFor(path: string, mounts: readonly MountEntry[]): MountEntry | undefined {
  let best: MountEntry | undefined;
  for (const m of mounts) {
    const at = m.point === "/" ? true : path === m.point || path.startsWith(`${m.point}/`);
    if (at && (best === undefined || m.point.length > best.point.length)) best = m;
  }
  return best;
}

export interface TrashDeps {
  /** May the user write `dir` (`accessSync(dir, W_OK)`)? */
  writable?(dir: string): boolean;
  stat?(path: string): Pick<Stats, "mode" | "uid">;
  uid?: number;
  /** `mount`'s output (where each volume is, and whether it is local). */
  mounts?(): string;
}

/**
 * Why Finder would NOT quietly move this item to the Trash — a dialog (an administrator password, "delete immediately?")
 * in front of the user instead — or undefined when it would. `real`: the item's real path; `item`: its own `lstat`.
 */
export function trashDialogReason(real: string, item: Pick<Stats, "uid">, deps: TrashDeps = {}): string | undefined {
  const parent = dirname(real);
  const writable = deps.writable ?? ((d: string) => { try { accessSync(d, constants.W_OK); return true; } catch { return false; } });
  const stat = deps.stat ?? ((p: string) => statSync(p));
  const uid = deps.uid ?? (typeof process.getuid === "function" ? process.getuid() : -1);
  const name = basename(real);
  if (!writable(parent)) return `the folder holding ${name} isn't writable by the user, so moving it to the Trash would ask for an administrator's password — ask the user to do it`;
  const ps = stat(parent);
  if ((ps.mode & 0o1000) !== 0 && item.uid !== uid && ps.uid !== uid) {
    return `${name} belongs to another user in a shared folder, so moving it to the Trash would ask for an administrator's password — ask the user to do it`;
  }
  const mounts = parseMounts((deps.mounts ?? (() => spawnSync("/sbin/mount", [], { encoding: "utf8", timeout: 5_000 }).stdout ?? ""))());
  const m = mountFor(real, mounts);
  if (m === undefined || !m.flags.includes("local")) {
    return `${name} is on a volume that is not local (a network share or the like), where Finder deletes at once instead of using the Trash, after asking — ask the user to do it`;
  }
  return undefined;
}

function notBound(app: string): AutomationFailure {
  return new AutomationFailure("NoWindow", `${app} has no window with the bound window's id — it may have closed, or it is not a Finder window; bind a Finder window again (apps.open with a folder path). Nothing was done.`);
}

function existing(path: string, what: string): Stats {
  try { return lstatSync(path); } catch { /* below */ }
  if (existsSync(path)) return statSync(path);
  throw new Error(`${what}: there is no file or folder at ${path}`);
}

/**
 * The lines that PROVE Finder's selection is the bound window's (else they return a sentinel): the bound window exists,
 * is Finder's frontmost window, does not show the Desktop folder, and Finder's insertion location is its folder — with
 * the desktop focused it would be the Desktop instead.
 */
export function selectionIsBound(w: number): string[] {
  return [
    `if not (exists Finder window id ${w}) then return "NOWINDOW"`,
    `if (id of Finder window 1) is not ${w} then return "NOTFRONT"`,
    "try",
    `  set boundURL to URL of (target of Finder window id ${w})`,
    "  set desktopURL to URL of desktop",
    "  set insertionURL to URL of (insertion location)",
    "on error",
    "  return \"UNPROVEN\"",
    "end try",
    "if boundURL is desktopURL then return \"DESKTOP\"",
    "if insertionURL is not boundURL then return \"NOTFOCUSED\"",
  ];
}

/** A sentinel of `selectionIsBound` as `NoWindow`, with what to do instead. */
function selectionRefusal(app: string, r: string): AutomationFailure | undefined {
  switch (r) {
    case "NOWINDOW": return notBound(app);
    case "NOTFRONT": return new AutomationFailure("NoWindow", "Finder's scripting reads the selection of its frontmost window only, and the bound window is behind another Finder window — read what is selected with state() (selected items are marked)");
    case "DESKTOP": return new AutomationFailure("NoWindow", "the bound Finder window shows the Desktop folder, so Finder's selection could be the desktop's rather than this window's — read what is selected with state()");
    case "NOTFOCUSED": return new AutomationFailure("NoWindow", "Finder's selection is not the bound window's right now (the user's focus in Finder is elsewhere, the desktop perhaps) — read what is selected with state()");
    case "UNPROVEN": return new AutomationFailure("NoWindow", "Winter could not prove Finder's selection is the bound window's (its folder could not be read) — read what is selected with state()");
    default: return undefined;
  }
}

export const finderAdapter: AppAdapter = {
  bundleIds: ["com.apple.finder"],
  guide: { id: "finder@3", text: FINDER_GUIDE },
  extras: [
    {
      name: "reveal", access: "click",
      signature: "reveal(path: string): Promise<{ selected: boolean }>",
      summary: "shows the item's folder in the bound Finder window and selects the item, in the background",
      doc: "The BOUND Finder window shows the item's folder; the item is selected only when Finder's selection is provably that window's (it is Finder's frontmost window and the user's focus in Finder is on it) — selected: false otherwise, the folder shown all the same. The path must exist. Finder stays in the background.",
      async run(scope, args) {
        const path = pathArg(args[0], "reveal(path)");
        existing(path, "reveal(path)");
        const w = scope.window();
        const result = await scope.applescript(appScript(scope.app.bundleId, [
          `if not (exists Finder window id ${w}) then return "NOWINDOW"`,
          `set target of Finder window id ${w} to (${posixFile(dirname(path))} as alias)`,
          // Select only where the selection is proven to be the bound window's; else the folder alone is shown.
          ...selectionIsBound(w).map((l) => l.replace(/return "(NOWINDOW|NOTFRONT|UNPROVEN|DESKTOP|NOTFOCUSED)"/, "return \"SHOWN\"")),
          `select (${posixFile(path)} as alias)`,
          "return \"SELECTED\"",
        ]));
        const r = (result ?? "").trim();
        if (r === "NOWINDOW") throw notBound(scope.app.name);
        const selected = r === "SELECTED";
        scope.say(selected ? "the bound Finder window shows the item's folder, the item selected (Finder stays in the background)"
          : "the bound Finder window shows the item's folder; the item is not selected (Finder's selection isn't provably the bound window's) — click it there if needed");
        return { selected };
      },
    },
    {
      name: "selection", access: "view",
      signature: "selection(): Promise<string[]>",
      summary: "POSIX paths selected in the bound Finder window (when its selection is provably that window's)",
      doc: "What is selected in the BOUND window, as POSIX paths; [] when nothing is. Finder's selection is that of where the user's focus is in Finder (its frontmost window, or the desktop), so this refuses (NoWindow) unless it is provably the bound window's — read the selection with state() then. Read-only.",
      async run(scope) {
        const w = scope.window();
        const result = await scope.applescript(appScript(scope.app.bundleId, [
          ...selectionIsBound(w),
          "set out to \"SEL:\"",
          "repeat with i in (get selection)",
          "  set out to out & (URL of i) & winterLF",
          "end repeat",
          "return out",
        ]));
        const refusal = selectionRefusal(scope.app.name, (result ?? "").trim());
        if (refusal !== undefined) throw refusal;
        const paths: string[] = [];
        for (const line of (result ?? "").replace(/^SEL:/, "").split(/\r?\n|\r/)) {
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
      doc: "Finder's delete, which moves the items to the Trash (the user can put them back). Every path must exist and not be a link; system folders, the home folder and its main folders, ~/.ssh and the Keychains are refused, and so is anything Finder would ask about (a password, a network volume). At most 100 paths.",
      async run(scope, args) {
        const raw = args[0];
        const list = Array.isArray(raw) ? raw : [raw];
        if (list.length === 0 || list.length > 100) throw bad("trash(paths) takes 1 to 100 paths");
        const paths = list.map((p, i) => pathArg(p, `trash(paths)[${i}]`));
        const reals: string[] = [];
        let mountOutput: string | undefined;
        for (const p of paths) {
          const st = existing(p, "trash(paths)");
          // Finder trashes what a link points to: never a link.
          if (st.isSymbolicLink()) throw new AutomationFailure("Refused", `${p} is a symbolic link — Winter doesn't trash links (Finder would trash what it points to); ask the user`);
          let real: string;
          try { real = realpathSync(p); } catch { throw new Error(`trash(paths): ${p} could not be resolved`); }
          const why = trashRefusal(real);
          if (why !== undefined) throw new AutomationFailure("Refused", why);
          const dialog = trashDialogReason(real, st, { mounts: () => (mountOutput ??= spawnSync("/sbin/mount", [], { encoding: "utf8", timeout: 5_000 }).stdout ?? "") });
          if (dialog !== undefined) throw new AutomationFailure("Refused", dialog);
          reals.push(real);
        }
        const items = reals.map((p) => `(${posixFile(p)} as alias)`).join(", ");
        await scope.applescript(appScript(scope.app.bundleId, [`delete {${items}}`]), { timeoutMs: 30_000 });
        scope.say(`moved ${reals.length} item${reals.length === 1 ? "" : "s"} to the Trash`);
        return { trashed: reals.length };
      },
    },
    {
      name: "openWith", access: "full",
      signature: "openWith(path: string, app: string): Promise<{ opened: string; app?: App }>",
      summary: "opens a file in another app, in the background, and binds its window",
      doc: "apps.open(path, { app }) for a file: the app (a name, bundle id or .app path) opens it without coming forward, and its window is bound — its state follows, and app is its handle. The app is asked for like any app you bind.",
      async run(scope, args) {
        const path = pathArg(args[0], "openWith(path, app)");
        const app = stringArg(args[1], "openWith(path, app)'s app", 300).trim();
        if (app.length === 0) throw bad("openWith(path, app) takes the app to open it with");
        existing(path, "openWith(path, app)");
        const opened = await scope.openDocument(path, app);
        // The opener's bound window comes back as a handle the worker turns into an App.
        return { opened: opened.name, ...(opened.handle === undefined ? {} : { app: { $app: opened.handle } }) };
      },
    },
  ],
};
