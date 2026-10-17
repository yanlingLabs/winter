// Code-mode image input: the ONE place a `user_message` becomes the text the MODEL is given.
//
// A code session's composer keeps `[Image #n]` placeholders in the message text (the user's bubble
// shows them) and names each placeholder's file in `user_message.images` — a copy the daemon staged in
// the session's temp folder, or the user's own original image file (raw image paths, 2026-10-10). Only
// the model sees the paths: every door that feeds a user message to a runtime child — the live send/steer push, the
// held queue, the resume replay of unconsumed messages, a legacy-session import — goes through
// `modelTextOf`. Display and metadata readers (titles, the cleaner, the dreamer, history, the remote
// stream, the session list's first message, the CLI's `-p` echo) read `text` as is.
//
// One token grammar for every reader (the daemon's validator, this substitution, the TUI): the
// number is parsed with `Number`, so `[Image #01]` is placeholder 1 everywhere.
//
// Code-mode FILE attachments (2026-10-13) ride the same way: `[File #n]` placeholders in `text`, the user's
// own file or folder named in `user_message.files`, the path substituted here and nowhere else.
import type { UserMessageFileRef, UserMessageImageRef } from "@yanlinglabs/winter-protocol";

const IMAGE_TOKEN_RE = /\[Image #(\d+)\]/g;
const FILE_TOKEN_RE = /\[File #(\d+)\]/g;

/** The placeholder numbers `text` contains, first-appearance order, each once. */
export function imageTokenNumbers(text: string): number[] {
  const seen = new Set<number>();
  for (const m of text.matchAll(IMAGE_TOKEN_RE)) seen.add(Number(m[1]));
  return [...seen];
}

/** Every placeholder whose number `paths` knows is replaced by that path; any other is left as typed. */
export function substituteImageTokens(text: string, paths: ReadonlyMap<number, string>): string {
  if (paths.size === 0) return text;
  return text.replace(IMAGE_TOKEN_RE, (whole, n: string) => paths.get(Number(n)) ?? whole);
}

/** The `[File #n]` numbers `text` contains, first-appearance order, each once. */
export function fileTokenNumbers(text: string): number[] {
  const seen = new Set<number>();
  for (const m of text.matchAll(FILE_TOKEN_RE)) seen.add(Number(m[1]));
  return [...seen];
}

/** Every `[File #n]` whose number `paths` knows is replaced by that path; any other is left as typed. */
export function substituteFileTokens(text: string, paths: ReadonlyMap<number, string>): string {
  if (paths.size === 0) return text;
  return text.replace(FILE_TOKEN_RE, (whole, n: string) => paths.get(Number(n)) ?? whole);
}

/** The text the MODEL is given for a user message: `text` with each `[Image #n]` that `images` names and
 *  each `[File #n]` that `files` names replaced by its path. A message with neither is its `text`,
 *  unchanged (the same string). One pass over both grammars, so a substituted path that happens to spell
 *  a token is never rewritten again. */
export function modelTextOf(message: {
  text: string;
  images?: readonly UserMessageImageRef[] | undefined;
  files?: readonly UserMessageFileRef[] | undefined;
}): string {
  const images = message.images ?? [];
  const files = message.files ?? [];
  if (images.length === 0 && files.length === 0) return message.text;
  const imagePaths = new Map(images.map((i) => [i.n, i.path]));
  const filePaths = new Map(files.map((f) => [f.n, f.path]));
  return message.text.replace(/\[(Image|File) #(\d+)\]/g, (whole, kind: string, n: string) =>
    (kind === "Image" ? imagePaths : filePaths).get(Number(n)) ?? whole);
}
