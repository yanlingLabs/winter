// Code-mode image input: the ONE place a `user_message` becomes the text the MODEL is given.
//
// A code session's composer keeps `[Image #n]` placeholders in the message text (the user's bubble
// shows them) and names each placeholder's staged file in `user_message.images`. Only the model sees
// the paths: every door that feeds a user message to a runtime child — the live send/steer push, the
// held queue, the resume replay of unconsumed messages, a legacy-session import — goes through
// `modelTextOf`. Display and metadata readers (titles, the cleaner, the dreamer, history, the remote
// stream, the session list's first message, the CLI's `-p` echo) read `text` as is.
//
// One token grammar for every reader (the daemon's validator, this substitution, the TUI): the
// number is parsed with `Number`, so `[Image #01]` is placeholder 1 everywhere.
import type { UserMessageImageRef } from "@yanlinglabs/winter-protocol";

const IMAGE_TOKEN_RE = /\[Image #(\d+)\]/g;

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

/** The text the MODEL is given for a user message: `text` with each `[Image #n]` that `images` names
 *  replaced by its path. A message with no `images` is its `text`, unchanged (the same string). */
export function modelTextOf(message: { text: string; images?: readonly UserMessageImageRef[] | undefined }): string {
  const images = message.images;
  if (images === undefined || images.length === 0) return message.text;
  return substituteImageTokens(message.text, new Map(images.map((i) => [i.n, i.path])));
}
